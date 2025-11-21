import { Command, InvalidArgumentError } from "commander";

import { loadEnv } from "../env.ts";

export type SearchFilters = {
  after?: string;
  before?: string;
  mime?: string;
};

export type SearchRequest = {
  query: string;
  filters: SearchFilters;
  searchMaxLoopCount: number;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeArgv = (argv: string[]): string[] =>
  argv.length > 2 && argv[2] === "--" ? [argv[0], argv[1], ...argv.slice(3)] : argv;

const parseIsoDate = (value: string): string => {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new InvalidArgumentError("date must be in ISO format YYYY-MM-DD");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("date must be a valid calendar date");
  }

  return value;
};

const parseMime = (value: string): string => {
  const trimmed = value.trim();
  if (!/^.+\/.+$/.test(trimmed)) {
    throw new InvalidArgumentError("mime must be a valid MIME type string");
  }
  return trimmed;
};

type SearchCliOptions = SearchFilters & {
  json?: boolean;
};

const buildQueryString = (parts: string | string[]): string => {
  if (Array.isArray(parts)) {
    return parts.join(" ").trim();
  }
  return parts.trim();
};

const program = new Command();

program
  .name("search")
  .description("Query indexed documents with semantic search.")
  .argument("<query...>", "search query text")
  .option("--after <date>", "filter results modified after date (YYYY-MM-DD)", parseIsoDate)
  .option("--before <date>", "filter results modified before date (YYYY-MM-DD)", parseIsoDate)
  .option("--mime <type>", "filter by MIME type", parseMime)
  .option("--json", "output parsed payload as JSON (debug)")
  .action(async (queryParts: string[], options: SearchCliOptions) => {
    try {
      const config = loadEnv();

      const query = buildQueryString(queryParts);
      if (!query) {
        throw new InvalidArgumentError("query must not be empty");
      }

      const filters: SearchFilters = {
        after: options.after,
        before: options.before,
        mime: options.mime,
      };

      const request: SearchRequest = {
        query,
        filters,
        searchMaxLoopCount: config.searchMaxLoopCount,
      };

      if (options.json) {
        console.log(JSON.stringify(request, null, 2));
        return;
      }

      console.log(
        [
          `query="${request.query}"`,
          `after=${filters.after ?? "-"}`,
          `before=${filters.before ?? "-"}`,
          `mime=${filters.mime ?? "-"}`,
          `loops=${request.searchMaxLoopCount}`,
        ].join(" "),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  });

await program.parseAsync(normalizeArgv(process.argv));
