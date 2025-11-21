import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command, InvalidArgumentError } from "commander";

import type { GoogleDriveClient, SupabaseClient } from "../clients.ts";
import type { DriveFileIndexRow } from "../drive_file_index_repository.ts";
import { loadEnv } from "../env.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createMockOpenAIClient } from "../openai-provider.ts";
import { runSearchWithRanking, type SearchFilters, type SearchRequest } from "../search.ts";

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

const buildDriveLink = (fileId: string): string =>
  `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`;

const truncateSummary = (summary: string, limit: number): string =>
  summary.length > limit ? summary.slice(0, limit) : summary;

const formatResultLines = (results: DriveFileIndexRow[], summaryMaxLength: number): string[] => {
  const lines: string[] = [];
  results.forEach((row, index) => {
    lines.push(`[${index + 1}] ${row.file_name}`);
    lines.push(`    要約: ${truncateSummary(row.summary, summaryMaxLength)}`);
    lines.push(`    Link: ${buildDriveLink(row.file_id)}`);
  });
  return lines;
};

const shouldUseMockClients = (): boolean =>
  process.env.SEARCH_USE_MOCK_CLIENTS === "1" ||
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.JEST_WORKER_ID !== undefined ||
  process.env.NODE_ENV === "test";

const parseMockDriveCount = (): number => {
  const raw = process.env.SEARCH_MOCK_DRIVE_FILE_COUNT;
  if (!raw) return 0;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
};

const buildMockDriveFiles = () => {
  const count = parseMockDriveCount();
  return Array.from({ length: count }, (_, index) => {
    const suffix = index + 1;
    return {
      id: `mock-file-${suffix}`,
      name: `mock-file-${suffix}.pdf`,
      mimeType: "application/pdf",
      modifiedTime: new Date(0).toISOString(),
    };
  });
};

const createMockGoogleDriveClient = (logger: Logger): GoogleDriveClient => {
  const headers = { "Content-Type": "application/json" };
  const emptyList = () => new Response(JSON.stringify({ files: [] }), { status: 200, headers });
  const mockFiles = buildMockDriveFiles();

  const listResponse = () =>
    mockFiles.length > 0
      ? new Response(JSON.stringify({ files: mockFiles }), { status: 200, headers })
      : emptyList();

  return {
    logger,
    targetFolderIds: ["mock-folder"],
    credentials: {
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
      refreshToken: "mock-refresh-token",
    },
    request: async () => emptyList(),
    auth: { fetchAccessToken: async () => "mock-access-token" },
    folders: { ensureTargetsExist: async () => undefined },
    files: {
      list: async () => listResponse(),
      export: async () => emptyList(),
      get: async () => emptyList(),
    },
  };
};

const createMockSupabaseClient = (logger: Logger): SupabaseClient => {
  const headers = { "Content-Type": "application/json" };

  return {
    logger,
    credentials: { url: "mock://supabase", serviceRoleKey: "mock-service-role" },
    request: async (input) => {
      const raw = typeof input === "string" ? input : "";
      if (raw.startsWith("/rest/v1/drive_file_index")) {
        const params = new URL(raw, "https://mock.supabase").searchParams;
        const filter = params.get("file_id") ?? "";
        const decoded = decodeURIComponent(filter);
        const ids = Array.from(decoded.matchAll(/"([^"]+)"/g)).map(([, id]) => id);

        const rows: DriveFileIndexRow[] = ids.map((id) => ({
          file_id: id,
          file_name: `mock-${id}`,
          summary: `mock summary for ${id}`,
          keywords: ["mock"],
          drive_modified_at: new Date(0).toISOString(),
          mime_type: "application/pdf",
        }));
        return new Response(JSON.stringify(rows), { status: 200, headers });
      }

      return new Response(JSON.stringify([]), { status: 200, headers });
    },
  };
};

const promptUserRefinement = async (question: string): Promise<string> => {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question}\n> `);
  rl.close();
  return answer.trim();
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
      const supabase = useMock ? createMockSupabaseClient(logger) : undefined;

      const result = await runSearchWithRanking({
        config,
        request,
        deps: {
          googleDrive,
          openai,
          supabase,
          logger,
          askUser: promptUserRefinement,
        },
      });

      logger.info("search: branching outcome", {
        keywordCount: result.initial.keywords.length,
        driveQuery: result.initial.driveQuery,
        hits: result.initial.hitCount,
        bucket: result.initial.bucket,
        iteration: result.initial.iteration,
        loopLimitReached: result.initial.loopLimitReached,
        mock: useMock,
        vectorApplied: result.vectorSearchApplied,
        finalBucket: result.finalBucket,
      });

      const keywordsLine =
        result.initial.keywords.length > 0
          ? `keywords: ${result.initial.keywords.join(", ")}`
          : "keywords: (fallback to raw query)";

      const lines = [
        keywordsLine,
        `hits: ${result.initial.hitCount} (bucket=${result.initial.bucket})`,
        result.vectorSearchApplied
          ? `vector hits: ${result.results.length} (bucket=${result.finalBucket})`
          : undefined,
        result.initial.loopLimitReached && result.initial.bucket === "tooMany"
          ? "10 件以下に絞り込めませんでした"
          : undefined,
        result.initial.bucket === "none" &&
        result.initial.hitCount === 0 &&
        result.initial.keywords.length <= 1
          ? "見つかりませんでした"
          : undefined,
      ].filter((line): line is string => Boolean(line));

      if (result.results.length > 0) {
        lines.push(...formatResultLines(result.results, config.summaryMaxLength));
      }

      console.log(lines.join("\n"));
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
