import { describe, expect, it, vi } from "vitest";

import { runSearchWithRanking, type SearchRequest } from "../src/search.ts";
import { baseConfig } from "./fixtures/config.ts";
import { driveFilesForSearch } from "./fixtures/drive.ts";
import { createOpenAIMock } from "./fixtures/openai.ts";
import { buildIndexRows, createSupabaseSearchMock } from "./fixtures/supabase.ts";

describe("search mock e2e", () => {
  it("shared fixtures でベクトル検索とリランキングを検証できる", async () => {
    const indexRows = buildIndexRows(driveFilesForSearch, {
      keywords: ["alpha", "beta"],
      summary: "summary from fixture",
      driveModifiedAt: "2024-10-15T00:00:00Z",
    });

    const vectorResults = indexRows.slice(0, 3).map((row, index) => ({
      ...row,
      distance: 0.01 + index / 100,
    }));

    const supabaseMock = createSupabaseSearchMock({
      rows: indexRows,
      vectorResults,
      onMatchRequest: (body) => {
        expect(body.match_count).toBe(20);
        expect(Array.isArray(body.filter_file_ids)).toBe(true);
        expect(body.filter_file_ids).toHaveLength(indexRows.length);
      },
    });

    const { openai, embeddingsCreate, chatCreate } = createOpenAIMock({
      rerankOrder: vectorResults.map((row) => row.file_id),
    });

    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["alpha", "beta"],
      driveQuery: `drive:${request.query}`,
      files: indexRows.map((row) => ({ id: row.file_id, name: row.file_name })),
    }));

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: {
        query: "vector query",
        filters: {},
        searchMaxLoopCount: baseConfig.searchMaxLoopCount,
      },
      deps: {
        supabase: supabaseMock.supabase,
        openai,
        initialSearch,
        logger: supabaseMock.logger,
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(1);
    expect(supabaseMock.requests.index).toHaveLength(1);
    expect(supabaseMock.requests.match).toHaveLength(1);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(result.vectorSearchApplied).toBe(true);
    expect(result.results.map((row) => row.file_id)).toEqual(
      vectorResults.map((row) => row.file_id),
    );
  });
});
