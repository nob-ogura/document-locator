import { Command, InvalidArgumentError } from "commander";
import type { GoogleDriveClient, SupabaseClient } from "../clients.ts";
import { logCrawlerSummary, syncSupabaseIndex } from "../crawler.ts";
import { type CrawlerMode, loadEnv } from "../env.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createMockOpenAIClient } from "../openai-provider.ts";

const MODES: CrawlerMode[] = ["auto", "full", "diff"];

const parseMode = (value: string): CrawlerMode => {
  const normalized = value.toLowerCase();
  if (MODES.includes(normalized as CrawlerMode)) {
    return normalized as CrawlerMode;
  }
  throw new InvalidArgumentError(`mode must be one of: ${MODES.join(", ")}`);
};

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }
  return parsed;
};

const shouldUseMockSupabase = (): boolean =>
  process.env.CRAWLER_USE_MOCK_SUPABASE === "1" ||
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.JEST_WORKER_ID !== undefined ||
  process.env.NODE_ENV === "test";

const createMockSupabaseClient = (
  logger: Logger,
  options: { driveModifiedAt?: string; status?: number } = {},
): SupabaseClient => {
  const { driveModifiedAt, status = 200 } = options;
  const rows = driveModifiedAt ? [{ id: "global", drive_modified_at: driveModifiedAt }] : [];

  const body = status === 200 ? JSON.stringify(rows) : JSON.stringify({ error: "mock failure" });
  const headers = { "Content-Type": "application/json" };

  return {
    logger,
    credentials: { url: "mock://supabase", serviceRoleKey: "mock-service-role-key" },
    // Ignore input/init; return consistent mock rows sufficient for drive_sync_state reads.
    request: async () => new Response(body, { status, headers }),
  };
};

const createMockGoogleDriveClient = (logger: Logger): GoogleDriveClient => {
  const emptyList = new Response(JSON.stringify({ files: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  return {
    logger,
    targetFolderIds: ["mock-folder"],
    credentials: {
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
      refreshToken: "mock-refresh-token",
    },
    request: async () => emptyList,
    auth: { fetchAccessToken: async () => "mock-access-token" },
    folders: { ensureTargetsExist: async () => undefined },
    files: {
      list: async () => emptyList,
      export: async () => emptyList,
      get: async () => emptyList,
    },
  };
};

const program = new Command();

program
  .name("crawler")
  .description("Crawl Google Drive content and sync metadata into the local index.")
  .option<CrawlerMode>("-m, --mode <mode>", "crawl mode: auto | full | diff", parseMode)
  .option<number>("-l, --limit <number>", "limit number of files processed in one run", parseLimit)
  .action(async (options: { mode?: CrawlerMode; limit?: number }) => {
    let logger: Logger | undefined;
    try {
      const config = loadEnv();
      const mode: CrawlerMode = options.mode ?? config.crawlerMode;
      const limit = options.limit;

      logger = createLogger(config.logLevel);
      logger.info("crawler: starting", { mode, limit: limit ?? null });

      const useMock = shouldUseMockSupabase();
      const mockStatusRaw = process.env.MOCK_SUPABASE_STATUS;
      const mockStatus = mockStatusRaw ? Number.parseInt(mockStatusRaw, 10) : undefined;

      const supabase = useMock
        ? createMockSupabaseClient(logger, {
            driveModifiedAt: process.env.MOCK_DRIVE_MODIFIED_AT,
            status: Number.isFinite(mockStatus) ? mockStatus : undefined,
          })
        : undefined;
      const googleDrive = useMock ? createMockGoogleDriveClient(logger) : undefined;
      const openai = useMock ? createMockOpenAIClient({ logger }) : undefined;

      const result = await syncSupabaseIndex({
        config,
        mode,
        limit,
        deps: {
          logger,
          supabase,
          googleDrive,
          openai,
        },
      });

      logger.info("crawler: mode resolved", {
        requestedMode: mode,
        effectiveMode: result.effectiveMode,
        driveQuery: result.driveQuery ?? null,
        driveModifiedAt: result.syncState?.drive_modified_at ?? null,
      });

      logger.info("crawler: drive files enumerated", {
        total: result.files.length,
        processable: result.processable.length,
        skipped: result.skipped.length,
        limit: limit ?? null,
      });

      logCrawlerSummary(result, logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (logger) {
        logger.error("crawler: fatal error", { error: message });
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    }
  });

program.parse();
