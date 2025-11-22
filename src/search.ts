import type { OpenAIClient, SupabaseClient } from "./clients.ts";
import { createSupabaseClient } from "./clients.ts";
import type { DriveFileIndexRow } from "./drive_file_index_repository.ts";
import { vectorSearchDriveFileIndex } from "./drive_file_index_repository.ts";
import type { AppConfig } from "./env.ts";
import { createLogger, type Logger } from "./logger.ts";
import { extractKeywords, generateEmbedding } from "./openai.ts";
import { resolveOpenAIClient } from "./openai-provider.ts";

export type SearchFilters = {
  after?: string;
  before?: string;
  mime?: string;
};

export type SearchRequest = {
  query: string;
  filters: SearchFilters;
  searchMaxLoopCount: number;
  limit: number;
  similarityThreshold: number;
  overrideKeywords?: string[];
};

export type HitCountBucket = "none" | "single" | "few" | "mid" | "tooMany";

export type SearchOutcome = {
  initial: {
    keywords: string[];
    similarityThreshold: number;
    hitCount: number;
    bucket: HitCountBucket;
    topSimilarity: number;
    iteration: number;
  };
  finalBucket: HitCountBucket;
  finalSimilarityThreshold: number;
  finalKeywords: string[];
  results: DriveFileIndexRow[];
  vectorSearchApplied: boolean;
  reranked: boolean;
  loopLimitReached: boolean;
  topSimilarity: number;
};

export type SearchDeps = {
  supabase?: SupabaseClient;
  openai?: OpenAIClient;
  logger?: Logger;
  askUser?: (question: string) => Promise<string>;
  vectorSearch?: typeof vectorSearchDriveFileIndex;
};

const DISPLAY_RESULT_LIMIT = 10;
const SECONDARY_RESULT_LIMIT = 20;

export const SIMILARITY_HIGH = 0.82;
export const SIMILARITY_MEDIUM = 0.75;
export const SIMILARITY_LOW = 0.6;
const SIMILARITY_FLOOR = 0.5;

const normalizeKeywords = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

export const classifyHitCount = (hitCount: number): HitCountBucket => {
  if (hitCount <= 0) return "none";
  if (hitCount === 1) return "single";
  if (hitCount <= 9) return "few";
  if (hitCount <= 49) return "mid";
  return "tooMany";
};

const resolveSimilarity = (row: DriveFileIndexRow): number => {
  if (typeof row.similarity === "number" && Number.isFinite(row.similarity)) {
    return row.similarity;
  }

  if (typeof row.distance === "number" && Number.isFinite(row.distance)) {
    const similarity = 1 - row.distance;
    return Math.max(0, Math.min(1, similarity));
  }

  return 0;
};

const buildQueryEmbeddingText = (query: string, keywords: string[]): string => {
  const keywordLine = keywords.length > 0 ? `Keywords: ${keywords.join(", ")}` : "";
  return [query.trim(), keywordLine].filter((value) => value.length > 0).join("\n");
};

const extractKeywordsSafe = async (
  openai: OpenAIClient,
  query: string,
  overrideKeywords: string[] | undefined,
  logger?: Logger,
): Promise<string[]> => {
  if (overrideKeywords) return normalizeKeywords(overrideKeywords);

  try {
    const extracted = await extractKeywords({ openai, text: query, logger });
    return normalizeKeywords(extracted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.info("search: keyword extraction failed; fallback to query", { error: message });
    return [];
  }
};

const rerankResultsWithLLM = async (options: {
  openai: Pick<OpenAIClient, "chat">;
  query: string;
  candidates: DriveFileIndexRow[];
  logger?: Logger;
}): Promise<DriveFileIndexRow[]> => {
  const { openai, query, candidates, logger } = options;
  if (candidates.length <= 1) return candidates;

  const validIds = new Set(candidates.map((row) => row.file_id));
  const candidatesText = candidates
    .map((row, index) => {
      const parts = [
        `#${index + 1}: ${row.file_name}`,
        `id: ${row.file_id}`,
        `summary: ${row.summary}`,
        row.keywords && row.keywords.length > 0 ? `keywords: ${row.keywords.join(", ")}` : "",
      ].filter((part) => part.length > 0);
      return parts.join("\n");
    })
    .join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: [
          "You are a ranking model.",
          "Sort the provided documents in order of relevance to the user's query.",
          "Respond ONLY with a JSON array of file_id values in the desired order. Include all ids.",
        ].join(" "),
      },
      {
        role: "user",
        content: [`User query: ${query.trim()}`, "Documents:", candidatesText].join("\n"),
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content ?? "";

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const rankedIds = parsed
        .map((value) => (typeof value === "string" ? value : String(value)))
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && validIds.has(value));

      if (rankedIds.length > 0) {
        const rankedSet = new Set(rankedIds);
        const ranked = rankedIds
          .map((id) => candidates.find((row) => row.file_id === id))
          .filter((row): row is DriveFileIndexRow => Boolean(row));
        const remaining = candidates.filter((row) => !rankedSet.has(row.file_id));
        return [...ranked, ...remaining].slice(0, DISPLAY_RESULT_LIMIT);
      }
    }
  } catch {
    // fall through to fallback order
  }

  logger?.info("search: rerank fallback to original order", { returned: content });
  return candidates.slice(0, DISPLAY_RESULT_LIMIT);
};

const performVectorSearchRound = async (options: {
  openai: OpenAIClient;
  supabase: SupabaseClient;
  vectorSearch: typeof vectorSearchDriveFileIndex;
  query: string;
  keywords: string[];
  filters: SearchFilters;
  limit: number;
  similarityThreshold: number;
  logger?: Logger;
}): Promise<{
  filtered: DriveFileIndexRow[];
  all: DriveFileIndexRow[];
  topSimilarity: number;
}> => {
  const {
    openai,
    supabase,
    vectorSearch,
    query,
    keywords,
    filters,
    limit,
    similarityThreshold,
    logger,
  } = options;

  const embeddingInput = buildQueryEmbeddingText(query, keywords);
  const embedding = await generateEmbedding({ openai, input: embeddingInput });

  const rows = await vectorSearch(supabase, embedding, {
    limit,
    filters,
  });

  const withSimilarity = rows.map((row) => ({ ...row, similarity: resolveSimilarity(row) }));
  const filtered = withSimilarity.filter((row) => resolveSimilarity(row) >= similarityThreshold);
  const topSimilarity = withSimilarity.length > 0 ? (withSimilarity[0].similarity ?? 0) : 0;

  logger?.info("search: vector search completed", {
    retrieved: withSimilarity.length,
    filtered: filtered.length,
    limit,
    similarityThreshold,
  });

  return { filtered, all: withSimilarity, topSimilarity };
};

const buildFollowupQuestion = (hitCount: number, query: string): string =>
  [
    `検索結果が ${hitCount} 件あります。`,
    "キーワードや期間を追加して絞り込みたいので、1 行で入力してください。",
    `現在のクエリ: ${query}`,
  ].join("\n");

export const runSearchWithRanking = async (options: {
  config: AppConfig;
  request: SearchRequest;
  deps?: SearchDeps;
}): Promise<SearchOutcome> => {
  const { config, request } = options;
  const logger = options.deps?.logger ?? createLogger(config.logLevel);
  const supabase = options.deps?.supabase ?? createSupabaseClient(config, { logger });
  const openai = options.deps?.openai ?? resolveOpenAIClient(config, { logger }).openai;
  const vectorSearch = options.deps?.vectorSearch ?? vectorSearchDriveFileIndex;

  let iteration = 0;
  let loopLimitReached = false;
  let currentQuery = request.query.trim();
  let currentSimilarityThreshold = request.similarityThreshold;
  let keywordOverride = request.overrideKeywords;
  let initialSummary: SearchOutcome["initial"] | null = null;
  let finalResults: DriveFileIndexRow[] = [];
  let finalKeywords: string[] = [];
  let topSimilarity = 0;
  let reranked = false;

  while (true) {
    iteration += 1;

    const keywords = await extractKeywordsSafe(openai, currentQuery, keywordOverride, logger);
    const round = await performVectorSearchRound({
      openai,
      supabase,
      vectorSearch,
      query: currentQuery,
      keywords,
      filters: request.filters,
      limit: request.limit,
      similarityThreshold: currentSimilarityThreshold,
      logger,
    });

    const bucket = classifyHitCount(round.filtered.length);
    topSimilarity = round.topSimilarity;
    finalKeywords = keywords;

    if (!initialSummary) {
      initialSummary = {
        keywords,
        similarityThreshold: currentSimilarityThreshold,
        hitCount: round.filtered.length,
        bucket,
        topSimilarity,
        iteration,
      };
    }

    logger.info("search: vector bucket evaluated", {
      iteration,
      hitCount: round.filtered.length,
      bucket,
      topSimilarity,
      similarityThreshold: currentSimilarityThreshold,
    });

    const lowTopSimilarity = round.filtered.length > 0 && topSimilarity < SIMILARITY_MEDIUM;
    const shouldAskUserForRefinement =
      bucket !== "single" && (bucket === "tooMany" || lowTopSimilarity);

    if (shouldAskUserForRefinement && iteration < request.searchMaxLoopCount) {
      const answer = options.deps?.askUser
        ? (
            await options.deps.askUser(buildFollowupQuestion(round.filtered.length, currentQuery))
          ).trim()
        : "";

      if (answer.length > 0) {
        currentQuery = `${currentQuery} ${answer}`.trim();
        keywordOverride = undefined;
        currentSimilarityThreshold = SIMILARITY_HIGH;
        continue;
      }

      loopLimitReached = true;
      finalResults = round.filtered.slice(0, DISPLAY_RESULT_LIMIT);
      break;
    }

    if (shouldAskUserForRefinement && iteration >= request.searchMaxLoopCount) {
      loopLimitReached = true;
      finalResults = round.filtered.slice(0, DISPLAY_RESULT_LIMIT);
      break;
    }

    if (bucket === "none") {
      const canRelaxSimilarity = currentSimilarityThreshold > SIMILARITY_FLOOR;
      const shouldRelaxSimilarity =
        canRelaxSimilarity && topSimilarity > 0 && topSimilarity < currentSimilarityThreshold;

      if (shouldRelaxSimilarity) {
        const nextThreshold = Math.max(SIMILARITY_FLOOR, currentSimilarityThreshold - 0.1);
        currentSimilarityThreshold = nextThreshold;
        keywordOverride = keywords;
        continue;
      }

      if (currentSimilarityThreshold <= SIMILARITY_LOW && keywords.length <= 1) {
        finalResults = [];
        break;
      }

      keywordOverride = keywords.length > 1 ? keywords.slice(0, -1) : keywords;
      currentSimilarityThreshold = SIMILARITY_LOW;
      continue;
    }

    if (bucket === "single") {
      finalResults = round.filtered.slice(0, 1);
      break;
    }

    if (bucket === "few") {
      const candidates = round.filtered.slice(0, DISPLAY_RESULT_LIMIT);
      finalResults = await rerankResultsWithLLM({
        openai,
        query: currentQuery,
        candidates,
        logger,
      });
      reranked = finalResults.length > 1;
      break;
    }

    if (bucket === "mid") {
      const filtered = round.filtered.filter((row) => resolveSimilarity(row) >= SIMILARITY_MEDIUM);
      const limited = filtered.slice(0, Math.min(SECONDARY_RESULT_LIMIT, filtered.length));
      finalResults = limited.slice(0, DISPLAY_RESULT_LIMIT);
      break;
    }
  }

  const finalBucket = classifyHitCount(finalResults.length);

  return {
    initial: initialSummary ?? {
      keywords: finalKeywords,
      similarityThreshold: currentSimilarityThreshold,
      hitCount: finalResults.length,
      bucket: finalBucket,
      topSimilarity,
      iteration,
    },
    finalBucket,
    finalSimilarityThreshold: currentSimilarityThreshold,
    finalKeywords,
    results: finalResults,
    vectorSearchApplied: true,
    reranked,
    loopLimitReached,
    topSimilarity,
  };
};
