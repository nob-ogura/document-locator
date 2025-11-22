import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { runSearchWithRanking } from "../src/search.js";
import { baseConfig } from "./fixtures/config.ts";
import { createOpenAIMock } from "./fixtures/openai.ts";
import { buildIndexRows, createSupabaseSearchMock } from "./fixtures/supabase.ts";

const config: AppConfig = { ...baseConfig, searchMaxLoopCount: 2 };

describe("runSearchWithRanking - ranking and vector", () => {
  it("reranks when 2-9 hits are returned", async () => {
    const rows = buildIndexRows(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
        { id: "d", name: "D" },
        { id: "e", name: "E" },
      ],
      { summary: "summary" },
    );

    const supabaseMock = createSupabaseSearchMock({ rows });
    const rerankOrder = rows.map((row) => row.file_id).reverse();
    const { openai, chatCreate } = createOpenAIMock({ rerankOrder });

    const result = await runSearchWithRanking({
      config,
      request: {
        query: "few hits",
        filters: {},
        limit: 10,
        similarityThreshold: 0.7,
        searchMaxLoopCount: config.searchMaxLoopCount,
      },
      deps: {
        supabase: supabaseMock.supabase,
        openai,
        logger: createLogger("debug"),
      },
    });

    expect(supabaseMock.requests.match).toHaveLength(1);
    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(result.finalBucket).toBe("few");
    expect(result.reranked).toBe(true);
    expect(result.results.map((row) => row.file_id)).toEqual(rerankOrder);
  });

  it("limits 10-49 hits to top 10 and sets k to limit", async () => {
    const rows = buildIndexRows(
      Array.from({ length: 35 }, (_, index) => ({ id: `id-${index}`, name: `file-${index}` })),
      { summary: "vector" },
    );

    const supabaseMock = createSupabaseSearchMock({
      rows,
      onMatchRequest: (body) => {
        expect(body.match_count).toBe(20);
      },
    });

    const { openai, embeddingsCreate, chatCreate } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config,
      request: {
        query: "mid bucket",
        filters: {},
        limit: 20,
        similarityThreshold: 0.7,
        searchMaxLoopCount: config.searchMaxLoopCount,
      },
      deps: {
        supabase: supabaseMock.supabase,
        openai,
        logger: createLogger("debug"),
      },
    });

    expect(supabaseMock.requests.match).toHaveLength(1);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(result.results.length).toBeLessThanOrEqual(10);
    expect(result.finalBucket === "mid" || result.finalBucket === "few").toBe(true);
  });

  it("returns immediately for a single hit without rerank", async () => {
    const rows = buildIndexRows([{ id: "solo", name: "single" }], { summary: "only" });
    const supabaseMock = createSupabaseSearchMock({ rows });
    const { openai, chatCreate, embeddingsCreate } = createOpenAIMock();

    const result = await runSearchWithRanking({
      config,
      request: {
        query: "single",
        filters: {},
        limit: 5,
        similarityThreshold: 0.7,
        searchMaxLoopCount: config.searchMaxLoopCount,
      },
      deps: {
        supabase: supabaseMock.supabase,
        openai,
        logger: createLogger("debug"),
      },
    });

    expect(result.results).toHaveLength(1);
    expect(result.finalBucket).toBe("single");
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
  });
});
