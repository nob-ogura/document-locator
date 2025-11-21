import { Command, InvalidArgumentError } from "commander";

import { type CrawlerMode, loadEnv } from "../env.ts";
import { createLogger } from "../logger.ts";

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

const program = new Command();

program
  .name("crawler")
  .description("Crawl Google Drive content and sync metadata into the local index.")
  .option<CrawlerMode>("-m, --mode <mode>", "crawl mode: auto | full | diff", parseMode)
  .option<number>("-l, --limit <number>", "limit number of files processed in one run", parseLimit)
  .action((options: { mode?: CrawlerMode; limit?: number }) => {
    try {
      const config = loadEnv();
      const mode: CrawlerMode = options.mode ?? config.crawlerMode;
      const limit = options.limit;

      const logger = createLogger(config.logLevel);
      logger.info("crawler: starting", { mode, limit: limit ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  });

program.parse();
