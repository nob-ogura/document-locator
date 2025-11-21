import type { GoogleDriveClient, OpenAIClient, SupabaseClient } from "./clients.ts";
import { createGoogleDriveClient, createSupabaseClient } from "./clients.ts";
import type { DriveFileEntry } from "./drive.ts";
import {
  type DriveFileIndexRow,
  fetchDriveFileIndexByIds,
  vectorSearchDriveFileIndex,
} from "./drive_file_index_repository.ts";
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
  /**
   * Optional override for keywords when re-trying after zero hits.
   * When provided, keyword extraction is skipped.
   */
  overrideKeywords?: string[];
};

export type InitialSearchDeps = {
  googleDrive?: GoogleDriveClient;
  openai?: Pick<OpenAIClient, "chat">;
  logger?: Logger;
};

export type InitialDriveSearchResult = {
  keywords: string[];
  driveQuery: string;
  files: DriveFileEntry[];
};

export type HitCountBucket = "none" | "single" | "few" | "many" | "tooMany";

export type HitCountResult = {
  hitCount: number;
  bucket: HitCountBucket;
  indexedFiles: DriveFileIndexRow[];
};

export type SearchLoopResult = HitCountResult & {
  keywords: string[];
  driveQuery: string;
  files: DriveFileEntry[];
  iteration: number;
  loopLimitReached: boolean;
  query: string;
};

export type SearchLoopDeps = InitialSearchDeps & {
  supabase?: SupabaseClient;
  /**
   * Hook for asking the user to narrow the query when hits exceed 100.
   * When omitted, the loop stops at the current iteration.
   */
  askUser?: (question: string) => Promise<string>;
  /**
   * Test seam to override the Drive+OpenAI search step.
   */
  initialSearch?: typeof runInitialDriveSearch;
};

type RelaxationFilters = {
  after?: string | null;
  before?: string | null;
  mime?: string | null;
};

type RelaxationProposal = {
  keywords?: string[];
  filters?: RelaxationFilters;
};

export type SearchExecutionDeps = SearchLoopDeps & {
  openai?: OpenAIClient;
  vectorSearch?: typeof vectorSearchDriveFileIndex;
};

export type SearchOutcome = {
  initial: SearchLoopResult;
  finalBucket: HitCountBucket;
  results: DriveFileIndexRow[];
  vectorSearchApplied: boolean;
  reranked: boolean;
};

type FilesListResponse = {
  files?: DriveFileEntry[];
  nextPageToken?: string;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_FIELDS = "files(id,name,mimeType,modifiedTime),nextPageToken";

const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "\\'");

const normalizeKeywords = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const hasFilters = (filters: SearchFilters): boolean =>
  Boolean(filters.after ?? filters.before ?? filters.mime);

const filtersEqual = (a: SearchFilters, b: SearchFilters): boolean =>
  (a.after ?? null) === (b.after ?? null) &&
  (a.before ?? null) === (b.before ?? null) &&
  (a.mime ?? null) === (b.mime ?? null);

const collectJsonCandidates = (content: string): string[] => {
  const trimmed = content.trim();
  const candidates = new Set<string>(trimmed ? [trimmed] : []);

  const codeMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeMatch?.[1]) candidates.add(codeMatch[1].trim());

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) candidates.add(objectMatch[0].trim());

  return Array.from(candidates).filter((value) => value.length > 0);
};

const normalizeRelaxationProposal = (raw: unknown): RelaxationProposal | null => {
  if (!raw || typeof raw !== "object") return null;

  const proposal: RelaxationProposal = {};
  const keywordsRaw = (raw as Record<string, unknown>).keywords;

  if (Array.isArray(keywordsRaw)) {
    proposal.keywords = normalizeKeywords(keywordsRaw.map((value) => String(value)));
  } else if (typeof keywordsRaw === "string") {
    proposal.keywords = normalizeKeywords([keywordsRaw]);
  }

  const filtersRaw = (raw as Record<string, unknown>).filters;
  if (filtersRaw && typeof filtersRaw === "object") {
    const relaxed: RelaxationFilters = {};
    const record = filtersRaw as Record<string, unknown>;

    relaxed.after =
      record.after === null
        ? null
        : typeof record.after === "string"
          ? record.after.trim()
          : undefined;

    relaxed.before =
      record.before === null
        ? null
        : typeof record.before === "string"
          ? record.before.trim()
          : undefined;

    relaxed.mime =
      record.mime === null
        ? null
        : typeof record.mime === "string"
          ? record.mime.trim()
          : undefined;

    proposal.filters = relaxed;
  }

  return proposal.keywords || proposal.filters ? proposal : null;
};

const parseRelaxationProposal = (content: string, logger?: Logger): RelaxationProposal | null => {
  const candidates = collectJsonCandidates(content);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeRelaxationProposal(parsed);
      if (normalized) return normalized;
    } catch (error) {
      logger?.debug("search: failed to parse relaxation candidate", {
        candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
};

const mergeRelaxedFilters = (
  current: SearchFilters,
  relaxed?: RelaxationFilters,
): SearchFilters => {
  if (!relaxed) return { ...current };

  const merged: SearchFilters = { ...current };
  const apply = (key: keyof SearchFilters, value?: string | null) => {
    if (value === null) {
      delete merged[key];
      return;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      merged[key] = value.trim();
      return;
    }
    if (value !== undefined) {
      delete merged[key];
    }
  };

  apply("after", relaxed.after);
  apply("before", relaxed.before);
  apply("mime", relaxed.mime);

  return merged;
};

const buildFallbackRelaxationPlan = (
  keywords: string[],
  filters: SearchFilters,
): { keywords: string[]; filters: SearchFilters } | null => {
  if (hasFilters(filters)) {
    return { keywords, filters: {} };
  }

  if (keywords.length > 1) {
    return { keywords: keywords.slice(0, -1), filters };
  }

  return null;
};

const relaxSearchConstraints = async (options: {
  openai?: Pick<OpenAIClient, "chat">;
  query: string;
  keywords: string[];
  filters: SearchFilters;
  logger?: Logger;
}): Promise<{ keywords: string[]; filters: SearchFilters } | null> => {
  const { openai, query, keywords, filters, logger } = options;

  let proposal: RelaxationProposal | null = null;

  if (openai) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "The previous search returned zero hits. " +
              "Provide ONE relaxed search plan by either dropping less important keywords " +
              "or removing date/MIME filters. " +
              "Respond ONLY with JSON: " +
              '{"keywords":["kw1","kw2"],"filters":{"after":null,"before":null,"mime":null}}. ' +
              "Use null to remove a filter.",
          },
          {
            role: "user",
            content: JSON.stringify({ query, keywords, filters }),
          },
        ],
      });

      const content = response.choices?.[0]?.message?.content ?? "";
      proposal = parseRelaxationProposal(content, logger);

      if (!proposal) {
        logger?.info("search: relaxation proposal could not be parsed; applying fallback", {
          returned: content,
        });
      }
    } catch (error) {
      logger?.info("search: relaxation proposal request failed; applying fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const merged = proposal
    ? {
        keywords: proposal.keywords ? normalizeKeywords(proposal.keywords) : keywords,
        filters: mergeRelaxedFilters(filters, proposal.filters),
      }
    : null;

  const fallback = buildFallbackRelaxationPlan(keywords, filters);
  const plan = merged ?? fallback;

  if (!plan) return null;

  const keywordsReduced = plan.keywords.length < keywords.length;
  const filtersChanged = !filtersEqual(filters, plan.filters);

  if (!keywordsReduced && !filtersChanged && fallback) {
    return fallback;
  }

  return plan;
};

const uniqueDriveFileIds = (files: DriveFileEntry[]): string[] =>
  Array.from(
    new Set(
      files
        .map((file) => file.id?.trim())
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

const toDateBoundary = (date: string, endOfDay: boolean): string => {
  const suffix = endOfDay ? "T23:59:59Z" : "T00:00:00Z";
  return `${date}${suffix}`;
};

const buildFolderScope = (folderIds: string[]): string | null => {
  const scopes = folderIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => `'${escapeSingleQuotes(id)}' in parents`);

  if (scopes.length === 0) return null;
  return scopes.join(" or ");
};

const scopeQueryToFolders = (query: string, folderIds: string[]): string => {
  const folderScope = buildFolderScope(folderIds);
  if (!folderScope) return query;
  if (!query || query.trim() === "") {
    return `(${folderScope})`;
  }
  return `(${folderScope}) and (${query})`;
};

export const buildDriveSearchQuery = (options: {
  query: string;
  keywords: string[];
  filters: SearchFilters;
}): string => {
  const { query, keywords, filters } = options;
  const conditions: string[] = [];

  if (filters.after) {
    conditions.push(`modifiedTime >= '${toDateBoundary(filters.after, false)}'`);
  }

  if (filters.before) {
    conditions.push(`modifiedTime <= '${toDateBoundary(filters.before, true)}'`);
  }

  if (filters.mime) {
    conditions.push(`mimeType='${escapeSingleQuotes(filters.mime)}'`);
  }

  conditions.push("trashed = false");

  const terms = keywords.length > 0 ? keywords : [query];
  for (const term of terms) {
    const sanitized = escapeSingleQuotes(term.trim());
    if (sanitized.length === 0) continue;
    conditions.push(`fullText contains '${sanitized}'`);
  }

  return conditions.join(" and ");
};

const ensureOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let detail = "";
  try {
    const body = await response.text();
    detail = body ? ` body=${body}` : "";
  } catch {
    // ignore parse errors
  }

  throw new Error(
    `Google Drive request failed: ${response.status} ${response.statusText}${detail}`,
  );
};

const parseListResponse = async (response: Response): Promise<FilesListResponse> => {
  const data = (await response.json()) as unknown;
  return data as FilesListResponse;
};

const listDriveSearchResults = async (
  driveClient: GoogleDriveClient,
  query: string,
  logger?: Logger,
): Promise<DriveFileEntry[]> => {
  const files: DriveFileEntry[] = [];
  let pageToken: string | undefined;

  do {
    const response = await driveClient.files.list({
      q: query,
      pageSize: DEFAULT_PAGE_SIZE,
      pageToken,
      fields: DEFAULT_FIELDS,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    await ensureOk(response);
    const parsed = await parseListResponse(response);
    if (parsed.files && parsed.files.length > 0) {
      files.push(...parsed.files);
    }
    pageToken = parsed.nextPageToken ?? undefined;
  } while (pageToken);

  logger?.debug("drive search completed", { query, files: files.length });
  return files;
};

export const runInitialDriveSearch = async (options: {
  config: AppConfig;
  request: SearchRequest;
  deps?: InitialSearchDeps;
}): Promise<InitialDriveSearchResult> => {
  const { config, request } = options;
  const logger = options.deps?.logger ?? createLogger(config.logLevel);

  const defaultGoogleDrive =
    options.deps?.googleDrive ??
    createGoogleDriveClient(config, {
      logger,
    });

  const defaultOpenAI = options.deps?.openai
    ? { openai: options.deps.openai, mode: "injected" }
    : resolveOpenAIClient(config, { logger });

  const googleDrive = options.deps?.googleDrive ?? defaultGoogleDrive;
  const openai = options.deps?.openai ?? defaultOpenAI.openai;

  let extracted: string[] = [];
  const useOverride = Array.isArray(request.overrideKeywords);

  if (useOverride) {
    extracted = request.overrideKeywords ?? [];
    logger.info("search: using override keywords", { count: extracted.length });
  } else {
    try {
      extracted = await extractKeywords({
        openai,
        text: request.query,
        logger,
      });
      logger.info("search: keywords extracted", { count: extracted.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.info("search: keyword extraction failed; falling back to raw query", {
        error: message,
      });
    }
  }

  const normalizedKeywords = normalizeKeywords(extracted);
  const driveQuery = buildDriveSearchQuery({
    query: request.query,
    keywords: normalizedKeywords,
    filters: request.filters,
  });

  const scopedQuery = scopeQueryToFolders(driveQuery, googleDrive.targetFolderIds);

  const files = await listDriveSearchResults(googleDrive, scopedQuery, logger);

  logger.info("search: initial drive search finished", {
    keywords: normalizedKeywords.length,
    driveQuery: scopedQuery,
    hits: files.length,
  });

  return {
    keywords: normalizedKeywords,
    driveQuery: scopedQuery,
    files,
  };
};

export const classifyHitCount = (hitCount: number): HitCountBucket => {
  if (hitCount <= 0) return "none";
  if (hitCount === 1) return "single";
  if (hitCount <= 10) return "few";
  if (hitCount <= 100) return "many";
  return "tooMany";
};

const buildFollowupQuestion = (hitCount: number, query: string): string =>
  [
    `検索結果が ${hitCount} 件あります。`,
    "キーワードや期間を追加して絞り込みたいので、" + "1 行で入力してください。",
    `現在のクエリ: ${query}`,
  ].join("\n");

const ensureSupabaseClient = (
  config: AppConfig,
  deps: { supabase?: SupabaseClient; logger?: Logger },
): SupabaseClient => deps.supabase ?? createSupabaseClient(config, { logger: deps.logger });

const evaluateHitsWithIndex = async (options: {
  supabase: SupabaseClient;
  files: DriveFileEntry[];
  logger?: Logger;
}): Promise<HitCountResult> => {
  const { supabase, files, logger } = options;
  const ids = uniqueDriveFileIds(files);
  if (ids.length === 0) {
    logger?.info("search: no drive ids to intersect", { candidates: 0, hits: 0 });
    return { hitCount: 0, bucket: "none", indexedFiles: [] };
  }

  const indexedFiles = await fetchDriveFileIndexByIds(supabase, ids);
  const hitCount = indexedFiles.length;
  const bucket = classifyHitCount(hitCount);

  logger?.info("search: drive_file_index intersection", {
    candidates: ids.length,
    hits: hitCount,
    bucket,
  });

  return { hitCount, bucket, indexedFiles };
};

export const runSearchWithBranching = async (options: {
  config: AppConfig;
  request: SearchRequest;
  deps?: SearchLoopDeps;
}): Promise<SearchLoopResult> => {
  const { config } = options;
  const logger = options.deps?.logger ?? createLogger(config.logLevel);
  const supabase = ensureSupabaseClient(config, {
    supabase: options.deps?.supabase,
    logger,
  });
  const performInitialSearch: typeof runInitialDriveSearch =
    options.deps?.initialSearch ??
    ((params) =>
      runInitialDriveSearch({
        ...params,
        deps: {
          googleDrive: options.deps?.googleDrive,
          openai: options.deps?.openai,
          logger,
        },
      }));

  const askUser = options.deps?.askUser;

  let iteration = 0;
  let currentRequest = options.request;

  while (true) {
    iteration += 1;

    const initial = await performInitialSearch({ config, request: currentRequest });
    const hitResult = await evaluateHitsWithIndex({
      supabase,
      files: initial.files,
      logger,
    });

    logger.info("search: hit count evaluated", {
      iteration,
      hitCount: hitResult.hitCount,
      bucket: hitResult.bucket,
      driveResults: initial.files.length,
    });

    const loopLimitReached =
      (hitResult.bucket === "tooMany" || hitResult.bucket === "none") &&
      iteration >= options.request.searchMaxLoopCount;

    if (hitResult.bucket === "none") {
      const keywordCount = initial.keywords.length;
      const exhaustedKeywords = keywordCount <= 1;

      if (exhaustedKeywords || loopLimitReached) {
        return {
          ...hitResult,
          keywords: initial.keywords,
          driveQuery: initial.driveQuery,
          files: initial.files,
          iteration,
          loopLimitReached: loopLimitReached || exhaustedKeywords,
          query: currentRequest.query,
        };
      }

      const relaxed = await relaxSearchConstraints({
        openai: options.deps?.openai,
        query: currentRequest.query,
        keywords: initial.keywords,
        filters: currentRequest.filters,
        logger,
      });

      if (!relaxed) {
        logger.info("search: no relaxation plan available; stopping");
        return {
          ...hitResult,
          keywords: initial.keywords,
          driveQuery: initial.driveQuery,
          files: initial.files,
          iteration,
          loopLimitReached: true,
          query: currentRequest.query,
        };
      }

      const previousFilters = currentRequest.filters;

      currentRequest = {
        ...currentRequest,
        filters: relaxed.filters,
        overrideKeywords: relaxed.keywords,
      };

      logger.info("search: retrying with relaxed constraints", {
        iteration: iteration + 1,
        keywords: relaxed.keywords.length,
        filtersChanged: !filtersEqual(previousFilters, relaxed.filters),
      });

      continue;
    }

    if (hitResult.bucket !== "tooMany" || loopLimitReached) {
      return {
        ...hitResult,
        keywords: initial.keywords,
        driveQuery: initial.driveQuery,
        files: initial.files,
        iteration,
        loopLimitReached,
        query: currentRequest.query,
      };
    }

    if (!askUser) {
      return {
        ...hitResult,
        keywords: initial.keywords,
        driveQuery: initial.driveQuery,
        files: initial.files,
        iteration,
        loopLimitReached: true,
        query: currentRequest.query,
      };
    }

    const answer = (
      await askUser(buildFollowupQuestion(hitResult.hitCount, currentRequest.query))
    ).trim();
    if (!answer) {
      logger.info("search: user did not provide refinement; stopping");
      return {
        ...hitResult,
        keywords: initial.keywords,
        driveQuery: initial.driveQuery,
        files: initial.files,
        iteration,
        loopLimitReached: true,
        query: currentRequest.query,
      };
    }

    currentRequest = {
      ...currentRequest,
      query: `${currentRequest.query} ${answer}`.trim(),
    };
    logger.info("search: retrying with refined query", {
      iteration: iteration + 1,
      query: currentRequest.query,
    });
  }
};

const DISPLAY_RESULT_LIMIT = 10;
const VECTOR_SEARCH_LIMIT = 20;

const buildQueryEmbeddingText = (query: string, keywords: string[]): string => {
  const keywordLine = keywords.length > 0 ? `Keywords: ${keywords.join(", ")}` : "";
  return [query.trim(), keywordLine].filter((value) => value.length > 0).join("\n");
};

const parseIdRanking = (content: string, validIds: Set<string>): string[] => {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => (typeof value === "string" ? value : String(value)))
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && validIds.has(value));
    }
  } catch {
    // ignore parse errors and fall back to original order
  }
  return [];
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
  const rankedIds = parseIdRanking(content, validIds);

  if (rankedIds.length === 0) {
    logger?.info("search: rerank fallback to original order", { returned: content });
    return candidates;
  }

  const rankedSet = new Set(rankedIds);
  const ranked = rankedIds
    .map((id) => candidates.find((row) => row.file_id === id))
    .filter((row): row is DriveFileIndexRow => Boolean(row));
  const remaining = candidates.filter((row) => !rankedSet.has(row.file_id));

  const ordered = [...ranked, ...remaining].slice(0, DISPLAY_RESULT_LIMIT);
  logger?.info("search: rerank completed", { count: ordered.length });
  return ordered;
};

const runVectorSearchStep = async (options: {
  openai: OpenAIClient;
  supabase: SupabaseClient;
  query: string;
  keywords: string[];
  filterFileIds: string[];
  logger?: Logger;
  vectorSearch?: typeof vectorSearchDriveFileIndex;
}): Promise<DriveFileIndexRow[]> => {
  const { openai, supabase, query, keywords, filterFileIds, logger } = options;
  if (filterFileIds.length === 0) return [];

  const input = buildQueryEmbeddingText(query, keywords);
  const embedding = await generateEmbedding({ openai, input });
  const vectorSearch = options.vectorSearch ?? vectorSearchDriveFileIndex;
  const candidates = await vectorSearch(supabase, embedding, {
    limit: VECTOR_SEARCH_LIMIT,
    filterFileIds,
  });

  const limited = candidates.slice(0, DISPLAY_RESULT_LIMIT);
  logger?.info("search: vector search completed", {
    retrieved: candidates.length,
    limited: limited.length,
  });
  return limited;
};

export const runSearchWithRanking = async (options: {
  config: AppConfig;
  request: SearchRequest;
  deps?: SearchExecutionDeps;
}): Promise<SearchOutcome> => {
  const { config, request } = options;
  const logger = options.deps?.logger ?? createLogger(config.logLevel);
  const supabase = ensureSupabaseClient(config, {
    supabase: options.deps?.supabase,
    logger,
  });

  const resolvedOpenAI = options.deps?.openai ?? resolveOpenAIClient(config, { logger }).openai;

  const branching = await runSearchWithBranching({
    config,
    request,
    deps: {
      ...options.deps,
      supabase,
      openai: resolvedOpenAI,
      logger,
    },
  });

  const outcome: SearchOutcome = {
    initial: branching,
    finalBucket: branching.bucket,
    results: [],
    vectorSearchApplied: false,
    reranked: false,
  };

  if (branching.bucket === "tooMany") {
    return outcome;
  }

  if (branching.bucket === "single") {
    outcome.results = branching.indexedFiles.slice(0, 1);
    return outcome;
  }

  if (branching.bucket === "few") {
    outcome.results = await rerankResultsWithLLM({
      openai: resolvedOpenAI,
      query: branching.query,
      candidates: branching.indexedFiles.slice(0, DISPLAY_RESULT_LIMIT),
      logger,
    });
    outcome.reranked = outcome.results.length > 1;
    outcome.finalBucket = classifyHitCount(outcome.results.length);
    return outcome;
  }

  if (branching.bucket === "many") {
    outcome.vectorSearchApplied = true;
    const filterFileIds = branching.indexedFiles.map((row) => row.file_id);
    const vectorResults = await runVectorSearchStep({
      openai: resolvedOpenAI,
      supabase,
      query: branching.query,
      keywords: branching.keywords,
      filterFileIds,
      logger,
      vectorSearch: options.deps?.vectorSearch,
    });

    outcome.results = vectorResults;
    outcome.finalBucket = classifyHitCount(vectorResults.length);

    if (outcome.finalBucket === "few" && outcome.results.length > 1) {
      outcome.results = await rerankResultsWithLLM({
        openai: resolvedOpenAI,
        query: branching.query,
        candidates: outcome.results,
        logger,
      });
      outcome.reranked = true;
      outcome.finalBucket = classifyHitCount(outcome.results.length);
    }

    return outcome;
  }

  // bucket === "none"
  return outcome;
};
