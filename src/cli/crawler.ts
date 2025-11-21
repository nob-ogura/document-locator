import { Command, InvalidArgumentError } from "commander";
import type { SupabaseClient } from "../clients.ts";
import { runCrawler } from "../crawler.ts";
import { type CrawlerMode, loadEnv } from "../env.ts";
import { createLogger, type Logger } from "../logger.ts";

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

const createMockSupabaseClient = (logger: Logger, driveModifiedAt?: string): SupabaseClient => {
  const rows = driveModifiedAt ? [{ id: "global", drive_modified_at: driveModifiedAt }] : [];

  const body = JSON.stringify(rows);
  const headers = { "Content-Type": "application/json" };

  return {
    logger,
    credentials: { url: "mock://supabase", serviceRoleKey: "mock-service-role-key" },
    // Ignore input/init; return consistent mock rows sufficient for drive_sync_state reads.
    request: async () => new Response(body, { status: 200, headers }),
  };
};

const program = new Command();

program
  .name("crawler")
  .description("Crawl Google Drive content and sync metadata into the local index.")
  .option<CrawlerMode>("-m, --mode <mode>", "crawl mode: auto | full | diff", parseMode)
  .option<number>("-l, --limit <number>", "limit number of files processed in one run", parseLimit)
  .action(async (options: { mode?: CrawlerMode; limit?: number }) => {
    try {
      const config = loadEnv();
      const mode: CrawlerMode = options.mode ?? config.crawlerMode;
      const limit = options.limit;

      const logger = createLogger(config.logLevel);
      logger.info("crawler: starting", { mode, limit: limit ?? null });

      const supabase = shouldUseMockSupabase()
        ? createMockSupabaseClient(logger, process.env.MOCK_DRIVE_MODIFIED_AT)
        : undefined;

      const result = await runCrawler({
        config,
        mode,
        limit,
        deps: {
          logger,
          supabase,
        },
      });

      logger.info("crawler: mode resolved", {
        requestedMode: mode,
        effectiveMode: result.effectiveMode,
        driveQuery: result.driveQuery ?? null,
        driveModifiedAt: result.syncState?.drive_modified_at ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  });

program.parse();
