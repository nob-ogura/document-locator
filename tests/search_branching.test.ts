import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "../src/clients.js";
import type { DriveFileIndexRow } from "../src/drive_file_index_repository.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { classifyHitCount, runSearchWithRanking, SIMILARITY_HIGH } from "../src/search.js";
import { createOpenAIMock } from "./fixtures/openai.ts";

const baseConfig: AppConfig = {
  crawlerMode: "auto",
  searchMaxLoopCount: 2,
  summaryMaxLength: 400,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

const buildRows = (count: number, similarity = 0.9): DriveFileIndexRow[] =>
  Array.from({ length: count }, (_, index) => {
    const sim = Math.max(0, Math.min(1, similarity - index * 0.001));
    return {
      file_id: `file-${count}-${index}`,
      file_name: `name-${index}`,
      summary: `summary-${index}`,
      keywords: ["kw"],
      drive_modified_at: "2024-01-01T00:00:00Z",
      mime_type: "application/pdf",
      similarity: sim,
      distance: 1 - sim,
    } satisfies DriveFileIndexRow;
  });

const createSupabaseStub = (): SupabaseClient => ({
  logger: createLogger("debug"),
  credentials: { url: "mock://supabase", serviceRoleKey: "mock" },
  request: vi.fn(),
});

const buildVectorSearchStub = (
  steps: { count: number; similarity?: number }[],
): NonNullable<Parameters<typeof runSearchWithRanking>[0]["deps"]>["vectorSearch"] => {
  let call = 0;
  return vi.fn(async (_supabase, _embedding, { limit }) => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    const count = Math.min(step.count, limit ?? step.count);
    return buildRows(count, step.similarity ?? 0.9);
  });
};

describe("classifyHitCount", () => {
  it("maps new ranges to buckets", () => {
    expect(classifyHitCount(0)).toBe("none");
    expect(classifyHitCount(1)).toBe("single");
    expect(classifyHitCount(5)).toBe("few");
    expect(classifyHitCount(35)).toBe("mid");
    expect(classifyHitCount(120)).toBe("tooMany");
  });
});

describe("runSearchWithRanking branching", () => {
  it("asks refinement when hits are 50+ and narrows to few", async () => {
    const vectorSearch = buildVectorSearchStub([
      { count: 120, similarity: 0.9 },
      { count: 5, similarity: 0.9 },
    ]);

    const askUser = vi.fn<() => Promise<string>>().mockResolvedValue("追加フィルタ");
    const { openai } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: {
        query: "original query",
        filters: {},
        limit: 80,
        similarityThreshold: 0.7,
        searchMaxLoopCount: 2,
      },
      deps: {
        supabase: createSupabaseStub(),
        openai,
        vectorSearch,
        askUser,
        logger: createLogger("debug"),
      },
    });

    expect(vectorSearch).toHaveBeenCalledTimes(2);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result.finalBucket).toBe("few");
    expect(result.loopLimitReached).toBe(false);
    expect(result.results).toHaveLength(5);
  });

  it("stops when loop limit is reached without refinement", async () => {
    const vectorSearch = buildVectorSearchStub([{ count: 120 }]);
    const { openai } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config: { ...baseConfig, searchMaxLoopCount: 1 },
      request: {
        query: "no refinement",
        filters: {},
        limit: 50,
        similarityThreshold: 0.7,
        searchMaxLoopCount: 1,
      },
      deps: {
        supabase: createSupabaseStub(),
        openai,
        vectorSearch,
        logger: createLogger("debug"),
      },
    });

    expect(vectorSearch).toHaveBeenCalledTimes(1);
    expect(result.loopLimitReached).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(10);
    expect(result.finalBucket).toBe("mid");
  });

  it("relaxes similarity and keywords when zero hits", async () => {
    const vectorSearch = buildVectorSearchStub([{ count: 0 }, { count: 0 }, { count: 0 }]);
    const { openai } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config: { ...baseConfig, searchMaxLoopCount: 3 },
      request: {
        query: "zero hit",
        filters: {},
        limit: 20,
        similarityThreshold: 0.7,
        searchMaxLoopCount: 3,
      },
      deps: {
        supabase: createSupabaseStub(),
        openai,
        vectorSearch,
        logger: createLogger("debug"),
      },
    });

    expect(vectorSearch).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(0);
    expect(result.finalBucket).toBe("none");
    expect(result.loopLimitReached).toBe(false);
    expect(result.finalSimilarityThreshold).toBeLessThanOrEqual(SIMILARITY_HIGH);
  });

  it("triggers refinement when top similarity is below 0.75", async () => {
    const vectorSearch = buildVectorSearchStub([
      { count: 5, similarity: 0.74 },
      { count: 3, similarity: 0.9 },
    ]);
    const askUser = vi.fn<() => Promise<string>>().mockResolvedValue("絞り込み");
    const { openai } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: {
        query: "low similarity",
        filters: {},
        limit: 30,
        similarityThreshold: 0.7,
        searchMaxLoopCount: 2,
      },
      deps: {
        supabase: createSupabaseStub(),
        openai,
        vectorSearch,
        askUser,
        logger: createLogger("debug"),
      },
    });

    expect(vectorSearch).toHaveBeenCalledTimes(2);
    expect(result.initial.topSimilarity).toBeLessThan(0.75);
    expect(result.finalBucket).toBe("few");
    expect(result.results).toHaveLength(3);
    expect(result.loopLimitReached).toBe(false);
  });

  it("does not ask for refinement when a single hit is found", async () => {
    const vectorSearch = buildVectorSearchStub([{ count: 1, similarity: 0.65 }]);
    const askUser = vi.fn<() => Promise<string>>();
    const { openai } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: {
        query: "single result",
        filters: {},
        limit: 30,
        similarityThreshold: 0.7,
        searchMaxLoopCount: 3,
      },
      deps: {
        supabase: createSupabaseStub(),
        openai,
        vectorSearch,
        askUser,
        logger: createLogger("debug"),
      },
    });

    expect(askUser).not.toHaveBeenCalled();
    expect(result.finalBucket).toBe("single");
    expect(result.results).toHaveLength(1);
    expect(result.loopLimitReached).toBe(false);
  });
});
