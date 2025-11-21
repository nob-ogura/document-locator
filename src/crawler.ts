import type { GoogleDriveClient, OpenAIClient, SupabaseClient } from "./clients.ts";
import { createExternalClients } from "./clients.ts";
import { type CrawlMode, type DriveFileEntry, listDriveFilesPaged } from "./drive.ts";
import {
  type DriveFileIndexUpsertRow,
  upsertDriveFileIndex,
} from "./drive_file_index_repository.ts";
import type { DriveSyncStateRow } from "./drive_sync_state_repository.ts";
import { getDriveSyncState, upsertDriveSyncState } from "./drive_sync_state_repository.ts";
import type { AppConfig, CrawlerMode } from "./env.ts";
import { createLogger, type Logger } from "./logger.ts";
import { isTextSupportedMime } from "./mime.ts";
import {
  buildEmbeddingInput,
  extractKeywords,
  generateEmbedding,
  summarizeText,
} from "./openai.ts";
import { extractTextOrSkip } from "./text_extraction.ts";
import { isAfter } from "./time.ts";

export type ResolvedCrawlMode = Exclude<CrawlMode, "auto">;

export type CrawlContext = {
  requestedMode: CrawlerMode;
  effectiveMode: ResolvedCrawlMode;
  driveQuery?: string;
  syncState: DriveSyncStateRow | null;
};

export type CrawlerDeps = {
  googleDrive?: GoogleDriveClient;
  supabase?: SupabaseClient;
  openai?: OpenAIClient;
  logger?: Logger;
};

const buildModifiedTimeFilter = (mode: ResolvedCrawlMode, syncState: DriveSyncStateRow | null) => {
  if (mode !== "diff") return undefined;
  return syncState?.drive_modified_at
    ? `modifiedTime > '${syncState.drive_modified_at}'`
    : undefined;
};

export const resolveCrawlContext = async (
  requestedMode: CrawlerMode,
  supabase: SupabaseClient,
  logger?: Logger,
): Promise<CrawlContext> => {
  const syncState = await getDriveSyncState(supabase);

  if (requestedMode === "full") {
    return {
      requestedMode,
      effectiveMode: "full",
      driveQuery: undefined,
      syncState,
    };
  }

  if (requestedMode === "diff") {
    if (!syncState) {
      logger?.info("drive_sync_state is empty; falling back to full crawl");
      return {
        requestedMode,
        effectiveMode: "full",
        driveQuery: undefined,
        syncState: null,
      };
    }

    return {
      requestedMode,
      effectiveMode: "diff",
      driveQuery: buildModifiedTimeFilter("diff", syncState),
      syncState,
    };
  }

  // requestedMode === "auto"
  if (!syncState) {
    logger?.debug("drive_sync_state not found; running full crawl (auto mode)");
    return {
      requestedMode,
      effectiveMode: "full",
      driveQuery: undefined,
      syncState: null,
    };
  }

  return {
    requestedMode,
    effectiveMode: "diff",
    driveQuery: buildModifiedTimeFilter("diff", syncState),
    syncState,
  };
};

export type RunCrawlerOptions = {
  config: AppConfig;
  mode?: CrawlerMode;
  limit?: number;
  deps?: CrawlerDeps;
};

export type RunCrawlerResult = CrawlContext & {
  limit?: number;
  clients: {
    googleDrive: GoogleDriveClient;
    supabase: SupabaseClient;
    openai: OpenAIClient;
  };
};

export const runCrawler = async (options: RunCrawlerOptions): Promise<RunCrawlerResult> => {
  const { config, deps } = options;
  const requestedMode = options.mode ?? config.crawlerMode;
  const logger = deps?.logger ?? createLogger(config.logLevel);

  const defaultClients = createExternalClients(config, { logger });
  const supabase = deps?.supabase ?? defaultClients.supabase;
  const googleDrive = deps?.googleDrive ?? defaultClients.googleDrive;
  const openai = deps?.openai ?? defaultClients.openai;

  const context = await resolveCrawlContext(requestedMode, supabase, logger);

  return {
    ...context,
    limit: options.limit,
    clients: {
      googleDrive,
      supabase,
      openai,
    },
  };
};

export type EnumerateDriveFilesResult = RunCrawlerResult & {
  files: DriveFileEntry[];
  processable: DriveFileEntry[];
  skipped: DriveFileEntry[];
};

export type ExtractedDriveFile = DriveFileEntry & {
  text: string | null;
  error?: string;
};

export type ExtractDriveTextsResult = EnumerateDriveFilesResult & {
  extracted: ExtractedDriveFile[];
};

export const enumerateDriveFiles = async (
  options: RunCrawlerOptions,
): Promise<EnumerateDriveFilesResult> => {
  const context = await runCrawler(options);
  const { googleDrive, supabase } = context.clients;
  const { limit } = options;
  const logger = options.deps?.logger ?? googleDrive.logger;

  await googleDrive.folders.ensureTargetsExist();

  const files = await listDriveFilesPaged({
    driveClient: googleDrive,
    supabaseClient: supabase,
    mode: context.effectiveMode,
    logger,
  });

  const processable: DriveFileEntry[] = [];
  const skipped: DriveFileEntry[] = [];

  for (const file of files) {
    if (isTextSupportedMime(file.mimeType)) {
      if (limit === undefined || processable.length < limit) {
        processable.push(file);
      }
      continue;
    }
    logger?.info("skip: unsupported mime_type", {
      mimeType: file.mimeType,
      fileId: file.id,
      fileName: file.name,
    });
    skipped.push(file);
  }

  return {
    ...context,
    files,
    processable,
    skipped,
  };
};

export const extractDriveTexts = async (
  options: RunCrawlerOptions,
): Promise<ExtractDriveTextsResult> => {
  const enumeration = await enumerateDriveFiles(options);
  const { googleDrive } = enumeration.clients;
  const logger = options.deps?.logger ?? googleDrive.logger;

  const extracted: ExtractedDriveFile[] = [];

  for (const file of enumeration.processable) {
    try {
      const text = await extractTextOrSkip({
        driveClient: googleDrive,
        fileMeta: file,
        logger,
      });
      extracted.push({ ...file, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.info("text extraction failed; continuing", {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        error: message,
      });
      extracted.push({ ...file, text: null, error: message });
    }
  }

  return { ...enumeration, extracted };
};

export type AiProcessedDriveFile = ExtractedDriveFile & {
  summary: string | null;
  keywords: string[] | null;
  embedding: number[] | null;
  aiError?: string;
};

export type RunAiPipelineResult = ExtractDriveTextsResult & {
  processed: AiProcessedDriveFile[];
};

export type SupabaseUpsertFailure = {
  fileId: string;
  error: string;
};

export type SyncSupabaseResult = RunAiPipelineResult & {
  upsertedCount: number;
  failedUpserts: SupabaseUpsertFailure[];
  latestDriveModifiedAt: string | null;
};

export const runAiPipeline = async (options: RunCrawlerOptions): Promise<RunAiPipelineResult> => {
  const extraction = await extractDriveTexts(options);
  const { openai } = extraction.clients;
  const logger = options.deps?.logger ?? openai.logger;

  const processed: AiProcessedDriveFile[] = [];

  for (const file of extraction.extracted) {
    const text = file.text;
    const hasText = typeof text === "string" && text.trim().length > 0;

    if (!hasText) {
      processed.push({
        ...file,
        summary: null,
        keywords: null,
        embedding: null,
        aiError: file.error ?? "text is empty",
      });

      logger?.info("ai pipeline skipped: empty text", {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
      });

      continue;
    }

    try {
      const summary = await summarizeText({
        openai,
        text,
        summaryMaxLength: options.config.summaryMaxLength,
        logger,
      });

      const keywords = await extractKeywords({
        openai,
        text,
        logger,
      });

      const embeddingInput = buildEmbeddingInput({
        summary,
        keywords,
        fileName: file.name ?? file.id ?? "unknown",
      });

      const embedding = await generateEmbedding({
        openai,
        input: embeddingInput,
      });

      processed.push({
        ...file,
        summary,
        keywords,
        embedding,
      });
    } catch (error) {
      const aiError = error instanceof Error ? error.message : String(error);

      logger?.info("ai pipeline failed; continuing", {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        error: aiError,
      });

      processed.push({
        ...file,
        summary: null,
        keywords: null,
        embedding: null,
        aiError,
      });
    }
  }

  return { ...extraction, processed };
};

const toDriveFileIndexRow = (file: AiProcessedDriveFile): DriveFileIndexUpsertRow | null => {
  if (!file.id || !file.modifiedTime || !file.mimeType) return null;
  if (typeof file.summary !== "string" || !Array.isArray(file.embedding)) return null;

  return {
    file_id: file.id,
    file_name: file.name ?? file.id,
    summary: file.summary,
    keywords: file.keywords ?? null,
    embedding: file.embedding,
    drive_modified_at: file.modifiedTime,
    mime_type: file.mimeType,
  } satisfies DriveFileIndexUpsertRow;
};

const latestModifiedAt = (rows: DriveFileIndexUpsertRow[]): string | null =>
  rows.reduce<string | null>((latest, row) => {
    if (!latest) return row.drive_modified_at;
    return isAfter(row.drive_modified_at, latest) ? row.drive_modified_at : latest;
  }, null);

export const upsertProcessedFiles = async (
  processed: AiProcessedDriveFile[],
  supabase: SupabaseClient,
  logger?: Logger,
): Promise<{
  upsertedCount: number;
  failedUpserts: SupabaseUpsertFailure[];
  latestDriveModifiedAt: string | null;
}> => {
  const rows: DriveFileIndexUpsertRow[] = [];

  for (const file of processed) {
    const row = toDriveFileIndexRow(file);
    if (row) {
      rows.push(row);
      continue;
    }

    logger?.info("supabase upsert skipped: missing data", {
      fileId: file.id ?? null,
      hasSummary: typeof file.summary === "string",
      hasEmbedding: Array.isArray(file.embedding),
      mimeType: file.mimeType ?? null,
      modifiedTime: file.modifiedTime ?? null,
    });
  }

  if (rows.length === 0) {
    return { upsertedCount: 0, failedUpserts: [], latestDriveModifiedAt: null };
  }

  const failedUpserts: SupabaseUpsertFailure[] = [];
  const succeeded: DriveFileIndexUpsertRow[] = [];

  for (const row of rows) {
    try {
      await upsertDriveFileIndex(supabase, [row]);
      succeeded.push(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedUpserts.push({ fileId: row.file_id, error: message });
      logger?.error("supabase upsert failed", { fileId: row.file_id, error: message });
    }
  }

  if (failedUpserts.length > 0) {
    throw new Error(`Supabase upsert failed for ${failedUpserts.length} file(s)`);
  }

  const latest = latestModifiedAt(succeeded);
  if (latest) {
    await upsertDriveSyncState(supabase, latest);
  }

  return {
    upsertedCount: succeeded.length,
    failedUpserts,
    latestDriveModifiedAt: latest ?? null,
  };
};

export const syncSupabaseIndex = async (
  options: RunCrawlerOptions,
): Promise<SyncSupabaseResult> => {
  const aiResult = await runAiPipeline(options);
  const { supabase } = aiResult.clients;
  const logger = options.deps?.logger ?? supabase.logger;

  const stats = await upsertProcessedFiles(aiResult.processed, supabase, logger);

  return {
    ...aiResult,
    ...stats,
  } satisfies SyncSupabaseResult;
};
