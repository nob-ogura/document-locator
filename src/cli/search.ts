import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command, InvalidArgumentError } from "commander";

import type { SupabaseClient } from "../clients.ts";
import type { DriveFileIndexRow } from "../drive_file_index_repository.ts";
import { loadEnv } from "../env.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createMockOpenAIClient } from "../openai-provider.ts";
import {
  runSearchWithRanking,
  type SearchFilters,
  type SearchRequest,
  SIMILARITY_HIGH,
} from "../search.ts";

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

const parseSimilarity = (value: string): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new InvalidArgumentError("similarity must be a float between 0 and 1");
  }
  return parsed;
};

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }
  return parsed;
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

const parseMockVectorCount = (): number => {
  const raw = process.env.SEARCH_MOCK_VECTOR_HITS ?? process.env.SEARCH_MOCK_DRIVE_FILE_COUNT;
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
};

const parseMockTopSimilarity = (): number => {
  const raw = process.env.SEARCH_MOCK_TOP_SIMILARITY;
  if (!raw) return 0.9;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return 0.9;
  return parsed;
};

const buildMockVectorRows = (count: number, topSimilarity: number): DriveFileIndexRow[] =>
  Array.from({ length: count }, (_, index) => {
    const similarity = Math.max(0, Math.min(1, topSimilarity - index * 0.001));
    const distance = 1 - similarity;
    const suffix = index + 1;
    return {
      file_id: `mock-file-${suffix}`,
      file_name: `mock-file-${suffix}.pdf`,
      summary: `mock summary for file ${suffix}`,
      keywords: ["mock"],
      drive_modified_at: new Date(0).toISOString(),
      mime_type: "application/pdf",
      similarity,
      distance,
    } satisfies DriveFileIndexRow;
  });

const createMockSupabaseClient = (logger: Logger): SupabaseClient => {
  const headers = { "Content-Type": "application/json" };
  const mockCount = parseMockVectorCount();
  const topSimilarity = parseMockTopSimilarity();

  return {
    logger,
    credentials: { url: "mock://supabase", serviceRoleKey: "mock-service-role" },
    request: async (input, init) => {
      const url = typeof input === "string" ? input : "";

      if (url.includes("match_drive_file_index")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const limit = Number.isInteger(body?.match_count) ? body.match_count : mockCount;
        const rows = buildMockVectorRows(Math.min(mockCount, limit ?? mockCount), topSimilarity);
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
  similarity?: number;
  limit?: number;
};

const buildQueryString = (parts: string | string[]): string =>
  Array.isArray(parts) ? parts.join(" ").trim() : parts.trim();

const program = new Command();

program
  .name("search")
  .description("Query indexed documents with semantic search.")
  .argument("<query...>", "search query text")
  .option("--after <date>", "filter results modified after date (YYYY-MM-DD)", parseIsoDate)
  .option("--before <date>", "filter results modified before date (YYYY-MM-DD)", parseIsoDate)
  .option("--mime <type>", "filter by MIME type", parseMime)
  .option(
    "--similarity <float>",
    `initial similarity threshold (default: ${SIMILARITY_HIGH.toFixed(2)})`,
    parseSimilarity,
  )
  .option("--limit <n>", "maximum candidates to fetch (default: 80)", parseLimit)
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

      const similarityThreshold = options.similarity ?? SIMILARITY_HIGH;
      const limit = options.limit ?? 80;

      const request: SearchRequest = {
        query,
        filters,
        searchMaxLoopCount: config.searchMaxLoopCount,
        limit,
        similarityThreshold,
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
        similarity: request.similarityThreshold,
        limit: request.limit,
      });

      const useMock = shouldUseMockClients();
      const openai = useMock ? createMockOpenAIClient({ logger }) : undefined;
      const supabase = useMock ? createMockSupabaseClient(logger) : undefined;

      const result = await runSearchWithRanking({
        config,
        request,
        deps: {
          openai,
          supabase,
          logger,
          askUser: promptUserRefinement,
        },
      });

      logger.info("search: outcome", {
        keywordCount: result.initial.keywords.length,
        hits: result.initial.hitCount,
        bucket: result.initial.bucket,
        branch: `${result.initial.bucket}->${result.finalBucket}`,
        iteration: result.initial.iteration,
        loopLimitReached: result.loopLimitReached,
        mock: useMock,
        vectorApplied: result.vectorSearchApplied,
        reranked: result.reranked,
        topSimilarity: result.topSimilarity,
      });

      const keywordsLine =
        result.initial.keywords.length > 0
          ? `keywords: ${result.initial.keywords.join(", ")}`
          : "keywords: (fallback to raw query)";

      const lines = [
        keywordsLine,
        `hits: ${result.initial.hitCount} (bucket=${result.initial.bucket}, top=${result.initial.topSimilarity.toFixed(2)}, threshold=${result.initial.similarityThreshold.toFixed(2)})`,
        result.results.length > 0
          ? `vector hits: ${result.results.length} (bucket=${result.finalBucket})`
          : undefined,
        result.loopLimitReached ? "10 件以下に絞り込めませんでした" : undefined,
        result.results.length === 0 && result.finalKeywords.length <= 1
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
