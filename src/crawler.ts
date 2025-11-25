import type { GoogleDriveClient, OpenAIClient, SupabaseClient } from "./clients.ts";
import { createExternalClients } from "./clients.ts";
import { type CrawlMode, type DriveFileEntry, listDriveFilesPaged } from "./drive.ts";
import {
  type DriveFileIndexUpsertRow,
  upsertDriveFileIndexOne,
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

const MAX_PARALLEL_FILE_PROCESSING = 5;

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<R[]> => {
  if (items.length === 0) return [];

  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    while (nextIndex < items.length && shouldContinue()) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);

  results.length = Math.min(results.length, nextIndex);
  return results;
};

type InterruptController = {
  shouldStop: () => boolean;
  wasInterrupted: () => boolean;
  cleanup: () => void;
  markInterrupted: (signal: NodeJS.Signals) => void;
};

const createInterruptController = (logger?: Logger): InterruptController => {
  let interrupted = false;

  const markInterrupted = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    logger?.info("crawler: received stop signal; draining in-flight tasks", { signal });
  };

  process.on("SIGINT", markInterrupted);
  process.on("SIGTERM", markInterrupted);

  const cleanup = (): void => {
    process.off("SIGINT", markInterrupted);
    process.off("SIGTERM", markInterrupted);
  };

  return {
    shouldStop: () => interrupted,
    wasInterrupted: () => interrupted,
    cleanup,
    markInterrupted,
  } satisfies InterruptController;
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

  const extracted = await mapWithConcurrency(
    enumeration.processable,
    MAX_PARALLEL_FILE_PROCESSING,
    async (file) => {
      try {
        const text = await extractTextOrSkip({
          driveClient: googleDrive,
          fileMeta: file,
          logger,
        });
        return { ...file, text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.info("text extraction failed; continuing", {
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          error: message,
        });
        return { ...file, text: null, error: message };
      }
    },
  );

  return { ...enumeration, extracted };
};

export type AiProcessedDriveFile = ExtractedDriveFile & {
  summary: string | null;
  keywords: string[] | null;
  embedding: number[] | null;
  aiError?: string;
};

export type RunAiPipelineResult = EnumerateDriveFilesResult & {
  processed: AiProcessedDriveFile[];
};

export type SupabaseUpsertFailure = {
  fileId: string;
  error: string;
};

export type SyncSupabaseResult = EnumerateDriveFilesResult & {
  processed: AiProcessedDriveFile[];
  upsertedCount: number;
  failedUpserts: SupabaseUpsertFailure[];
  latestDriveModifiedAt: string | null;
  interrupted: boolean;
};

export const latestModifiedAt = (
  current: string | null,
  candidate: string | null,
): string | null => {
  if (!candidate) return current;
  if (!current) return candidate;
  return isAfter(candidate, current) ? candidate : current;
};

export const toDriveFileIndexRow = (file: AiProcessedDriveFile): DriveFileIndexUpsertRow | null => {
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

const runAiPipelineForFile = async (
  file: DriveFileEntry,
  clients: { googleDrive: GoogleDriveClient; openai: OpenAIClient },
  config: AppConfig,
  logger?: Logger,
): Promise<AiProcessedDriveFile> => {
  let text: string | null = null;

  try {
    logger?.debug("crawler: process start", {
      fileId: file.id,
      mimeType: file.mimeType,
      fileName: file.name,
    });

    text = await extractTextOrSkip({
      driveClient: clients.googleDrive,
      fileMeta: file,
      logger,
    });

    if (!text || text.trim().length === 0) {
      logger?.info("ai pipeline skipped: empty text", {
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
      });

      return {
        ...file,
        text,
        summary: null,
        keywords: null,
        embedding: null,
        aiError: "text is empty",
      } satisfies AiProcessedDriveFile;
    }

    const summary = await summarizeText({
      openai: clients.openai,
      text,
      summaryMaxLength: config.summaryMaxLength,
      logger,
    });

    const keywords = await extractKeywords({
      openai: clients.openai,
      text,
      logger,
    });

    const embeddingInput = buildEmbeddingInput({
      summary,
      keywords,
      fileName: file.name ?? file.id ?? "unknown",
    });

    const embedding = await generateEmbedding({
      openai: clients.openai,
      input: embeddingInput,
    });

    logger?.debug("ai pipeline succeeded", {
      fileId: file.id,
      mimeType: file.mimeType,
      fileName: file.name,
    });

    return {
      ...file,
      text,
      summary,
      keywords,
      embedding,
    } satisfies AiProcessedDriveFile;
  } catch (error) {
    const aiError = error instanceof Error ? error.message : String(error);

    logger?.info("ai pipeline failed; continuing", {
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      error: aiError,
    });

    return {
      ...file,
      text,
      summary: null,
      keywords: null,
      embedding: null,
      aiError,
    } satisfies AiProcessedDriveFile;
  }
};

export const runAiPipeline = async (options: RunCrawlerOptions): Promise<RunAiPipelineResult> => {
  const enumeration = await enumerateDriveFiles(options);
  const { googleDrive, openai } = enumeration.clients;
  const logger = options.deps?.logger ?? openai.logger;

  const processed = await mapWithConcurrency(
    enumeration.processable,
    MAX_PARALLEL_FILE_PROCESSING,
    (file) => runAiPipelineForFile(file, { googleDrive, openai }, options.config, logger),
  );

  return { ...enumeration, processed } satisfies RunAiPipelineResult;
};

export const syncSupabaseIndex = async (
  options: RunCrawlerOptions,
): Promise<SyncSupabaseResult> => {
  const enumeration = await enumerateDriveFiles(options);
  const { googleDrive, openai, supabase } = enumeration.clients;
  const logger = options.deps?.logger ?? supabase.logger;

  const interrupt = createInterruptController(logger);
  const processed: AiProcessedDriveFile[] = [];
  const failedUpserts: SupabaseUpsertFailure[] = [];
  let upsertedCount = 0;
  let latestDriveModifiedAt: string | null = enumeration.syncState?.drive_modified_at ?? null;

  const shouldContinue = (): boolean => !interrupt.shouldStop();

  await mapWithConcurrency(
    enumeration.processable,
    MAX_PARALLEL_FILE_PROCESSING,
    async (file) => {
      const processedFile = await runAiPipelineForFile(
        file,
        { googleDrive, openai },
        options.config,
        logger,
      );

      processed.push(processedFile);

      const row = toDriveFileIndexRow(processedFile);
      if (!row) {
        logger?.info("supabase upsert skipped: missing data", {
          fileId: processedFile.id ?? null,
          hasSummary: typeof processedFile.summary === "string",
          hasEmbedding: Array.isArray(processedFile.embedding),
          mimeType: processedFile.mimeType ?? null,
          modifiedTime: processedFile.modifiedTime ?? null,
        });
        return processedFile;
      }

      try {
        await upsertDriveFileIndexOne(supabase, row);
        upsertedCount += 1;

        const nextLatest = latestModifiedAt(latestDriveModifiedAt, row.drive_modified_at);
        if (nextLatest && nextLatest !== latestDriveModifiedAt) {
          latestDriveModifiedAt = nextLatest;
          await upsertDriveSyncState(supabase, nextLatest);
        }

        logger?.info("supabase upsert succeeded", {
          fileId: row.file_id,
          mimeType: row.mime_type,
          modifiedTime: row.drive_modified_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedUpserts.push({ fileId: row.file_id, error: message });
        logger?.error("supabase upsert failed", { fileId: row.file_id, error: message });
      }

      return processedFile;
    },
    shouldContinue,
  );

  interrupt.cleanup();
  if (interrupt.wasInterrupted()) {
    process.exitCode = 1;
  }

  return {
    ...enumeration,
    processed,
    upsertedCount,
    failedUpserts,
    latestDriveModifiedAt,
    interrupted: interrupt.wasInterrupted(),
  } satisfies SyncSupabaseResult;
};

export type CrawlerSummaryInput = Pick<
  SyncSupabaseResult,
  "processed" | "skipped" | "upsertedCount" | "failedUpserts"
>;

export type CrawlerSummary = {
  processed: number;
  skipped: number;
  upserted: number;
  failed: number;
};

export const logCrawlerSummary = (result: CrawlerSummaryInput, logger?: Logger): CrawlerSummary => {
  const processed = result.processed.length;
  const skipped = result.skipped.length;
  const upserted = result.upsertedCount;
  const failedUpserts = result.failedUpserts?.length ?? 0;
  const failed = Math.max(processed - upserted, failedUpserts);

  const message = `crawler: summary processed=${processed} skipped=${skipped} upserted=${upserted} failed=${failed}`;
  logger?.info(message, { processed, skipped, upserted, failed });

  return { processed, skipped, upserted, failed } satisfies CrawlerSummary;
};
