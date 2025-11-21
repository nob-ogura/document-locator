import { Command, InvalidArgumentError } from "commander";

import type { GoogleDriveClient } from "../clients.ts";
import { loadEnv } from "../env.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createMockOpenAIClient } from "../openai-provider.ts";
import { runInitialDriveSearch, type SearchFilters, type SearchRequest } from "../search.ts";

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

const shouldUseMockClients = (): boolean =>
  process.env.SEARCH_USE_MOCK_CLIENTS === "1" ||
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.JEST_WORKER_ID !== undefined ||
  process.env.NODE_ENV === "test";

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
    let logger: Logger | undefined;
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

      logger = createLogger(config.logLevel);
      logger.info("search: starting", {
        query: request.query,
        after: filters.after ?? null,
        before: filters.before ?? null,
        mime: filters.mime ?? null,
        loops: request.searchMaxLoopCount,
      });

      const useMock = shouldUseMockClients();
      const googleDrive = useMock ? createMockGoogleDriveClient(logger) : undefined;
      const openai = useMock ? createMockOpenAIClient({ logger }) : undefined;

      const result = await runInitialDriveSearch({
        config,
        request,
        deps: { googleDrive, openai, logger },
      });

      logger.info("search: initial drive search", {
        keywordCount: result.keywords.length,
        driveQuery: result.driveQuery,
        hits: result.files.length,
        mock: useMock,
      });

      const keywordsLine =
        result.keywords.length > 0
          ? `keywords: ${result.keywords.join(", ")}`
          : "keywords: (fallback to raw query)";

      console.log([keywordsLine, `initialHits: ${result.files.length}`].join("\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (logger) {
        logger.error("search: fatal error", { error: message });
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    }
  });

await program.parseAsync(normalizeArgv(process.argv));
