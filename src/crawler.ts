import type { GoogleDriveClient, SupabaseClient } from "./clients.ts";
import { createExternalClients } from "./clients.ts";
import { type CrawlMode, type DriveFileEntry, listDriveFilesPaged } from "./drive.ts";
import type { DriveSyncStateRow } from "./drive_sync_state_repository.ts";
import { getDriveSyncState } from "./drive_sync_state_repository.ts";
import type { AppConfig, CrawlerMode } from "./env.ts";
import { createLogger, type Logger } from "./logger.ts";
import { isTextSupportedMime } from "./mime.ts";

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
  };
};

export const runCrawler = async (options: RunCrawlerOptions): Promise<RunCrawlerResult> => {
  const { config, deps } = options;
  const requestedMode = options.mode ?? config.crawlerMode;
  const logger = deps?.logger ?? createLogger(config.logLevel);

  const defaultClients = createExternalClients(config, { logger });
  const supabase = deps?.supabase ?? defaultClients.supabase;
  const googleDrive = deps?.googleDrive ?? defaultClients.googleDrive;

  const context = await resolveCrawlContext(requestedMode, supabase, logger);

  return {
    ...context,
    limit: options.limit,
    clients: {
      googleDrive,
      supabase,
    },
  };
};

export type EnumerateDriveFilesResult = RunCrawlerResult & {
  files: DriveFileEntry[];
  processable: DriveFileEntry[];
  skipped: DriveFileEntry[];
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
    skipped.push(file);
  }

  return {
    ...context,
    files,
    processable,
    skipped,
  };
};
