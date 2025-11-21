import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "../src/clients.js";
import type { DriveFileIndexRow } from "../src/drive_file_index_repository.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { runSearchWithRanking, type SearchRequest } from "../src/search.js";

const baseConfig: AppConfig = {
  crawlerMode: "auto",
  searchMaxLoopCount: 2,
  summaryMaxLength: 200,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

const buildRows = (count: number, iteration = 0): DriveFileIndexRow[] =>
  Array.from({ length: count }, (_, index) => ({
    file_id: `file-${iteration}-${index}`,
    file_name: `name-${index}`,
    summary: `summary-${index}`,
    keywords: ["kw"],
    drive_modified_at: "2024-01-01T00:00:00Z",
    mime_type: "application/pdf",
  }));

type RequestInput = Parameters<typeof fetch>[0];

describe("runSearchWithRanking", () => {
  it("2〜10件の候補を LLM でリランキングする", async () => {
    const initialRows = buildRows(5);

    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["kw"],
      driveQuery: `drive:${request.query}`,
      files: initialRows.map((row) => ({ id: row.file_id, name: row.file_name })),
    }));

    const supabaseRequest = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async (input: RequestInput) => {
        const url = typeof input === "string" ? input : "";
        if (url.includes("drive_file_index")) {
          return new Response(JSON.stringify(initialRows), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    );

    const rerankOrder = ["file-0-2", "file-0-4", "file-0-1", "file-0-0", "file-0-3"];
    const chatCreate = vi.fn().mockResolvedValue({
      id: "chat-rerank",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(rerankOrder) } }],
    });

    const openai = {
      logger: createLogger("debug"),
      apiKey: "sk",
      request: vi.fn(),
      chat: { completions: { create: chatCreate } },
      embeddings: { create: vi.fn() },
    };

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: { query: "test query", filters: {}, searchMaxLoopCount: 2 },
      deps: {
        supabase: {
          request: supabaseRequest,
          logger: createLogger("debug"),
          credentials: { url: "", serviceRoleKey: "" },
        },
        openai,
        initialSearch,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(1);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);

    expect(result.finalBucket).toBe("few");
    expect(result.reranked).toBe(true);
    expect(result.vectorSearchApplied).toBe(false);
    expect(result.results.map((row) => row.file_id)).toEqual(rerankOrder);
  });

  it("11〜100件はベクトル検索で絞り込みリランキングする", async () => {
    const initialRows = buildRows(50);

    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["kw1", "kw2"],
      driveQuery: `drive:${request.query}`,
      files: initialRows.map((row) => ({ id: row.file_id, name: row.file_name })),
    }));

    const vectorResults = [
      { ...initialRows[10], distance: 0.01 },
      { ...initialRows[5], distance: 0.02 },
      { ...initialRows[1], distance: 0.03 },
    ];

    const supabaseRequest = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async (input: RequestInput, init?: RequestInit) => {
        const url = typeof input === "string" ? input : "";
        if (url.includes("match_drive_file_index")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          expect(body.match_count).toBe(20);
          expect(Array.isArray(body.filter_file_ids)).toBe(true);
          expect(body.filter_file_ids).toHaveLength(initialRows.length);

          return new Response(JSON.stringify(vectorResults), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("drive_file_index")) {
          return new Response(JSON.stringify(initialRows), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    );

    const embeddingVector = Array.from({ length: 1536 }, (_, index) => (index + 1) / 1536);
    const embeddingsCreate = vi.fn().mockResolvedValue({
      object: "list",
      data: [{ index: 0, embedding: embeddingVector }],
      model: "text-embedding-3-small",
    });

    const rerankOrder = [
      vectorResults[1].file_id,
      vectorResults[0].file_id,
      vectorResults[2].file_id,
    ];
    const chatCreate = vi.fn().mockResolvedValue({
      id: "chat-rerank",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(rerankOrder) } }],
    });

    const openai = {
      logger: createLogger("debug"),
      apiKey: "sk",
      request: vi.fn(),
      chat: { completions: { create: chatCreate } },
      embeddings: { create: embeddingsCreate },
    };

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: { query: "vector query", filters: {}, searchMaxLoopCount: 2 },
      deps: {
        supabase: {
          request: supabaseRequest,
          logger: createLogger("debug"),
          credentials: { url: "", serviceRoleKey: "" },
        },
        openai,
        initialSearch,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(1);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(supabaseRequest).toHaveBeenCalledTimes(2);

    expect(result.vectorSearchApplied).toBe(true);
    expect(result.finalBucket).toBe("few");
    expect(result.results.map((row) => row.file_id)).toEqual(rerankOrder);
  });

  it("1件なら即時出力してリランキングしない", async () => {
    const initialRows = buildRows(1);

    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["kw"],
      driveQuery: `drive:${request.query}`,
      files: [{ id: initialRows[0].file_id, name: initialRows[0].file_name }],
    }));

    const supabaseRequest = vi.fn<NonNullable<SupabaseClient["request"]>>(async (input) => {
      const url = typeof input === "string" ? input : "";
      if (url.includes("drive_file_index")) {
        return new Response(JSON.stringify(initialRows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const openai = {
      logger: createLogger("debug"),
      apiKey: "sk",
      request: vi.fn(),
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn() },
    };

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: { query: "single hit", filters: {}, searchMaxLoopCount: 2 },
      deps: {
        supabase: {
          request: supabaseRequest,
          logger: createLogger("debug"),
          credentials: { url: "", serviceRoleKey: "" },
        },
        openai,
        initialSearch,
        logger: createLogger("debug"),
      },
    });

    expect(result.results).toHaveLength(1);
    expect(result.finalBucket).toBe("single");
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.embeddings.create).not.toHaveBeenCalled();
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
  });

  it("0件なら追加呼び出しを行わず終了する", async () => {
    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["solo"],
      driveQuery: `drive:${request.query}`,
      files: [],
    }));

    const supabaseRequest = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async (input: RequestInput) => {
        const url = typeof input === "string" ? input : "";
        if (url.includes("drive_file_index")) {
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    );

    const openai = {
      logger: createLogger("debug"),
      apiKey: "sk",
      request: vi.fn(),
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn() },
    };

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: { query: "no hits", filters: {}, searchMaxLoopCount: 1 },
      deps: {
        supabase: {
          request: supabaseRequest,
          logger: createLogger("debug"),
          credentials: { url: "", serviceRoleKey: "" },
        },
        openai,
        initialSearch,
        logger: createLogger("debug"),
      },
    });

    expect(result.initial.bucket).toBe("none");
    expect(result.initial.loopLimitReached).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.vectorSearchApplied).toBe(false);
    expect(result.reranked).toBe(false);
    expect(supabaseRequest).not.toHaveBeenCalled();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.embeddings.create).not.toHaveBeenCalled();
  });

  it("101件以上でループ上限に達した場合は追加処理を行わない", async () => {
    const initialRows = buildRows(120);

    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => ({
      keywords: ["kw1", "kw2"],
      driveQuery: `drive:${request.query}`,
      files: initialRows.map((row) => ({ id: row.file_id, name: row.file_name })),
    }));

    const supabaseRequest = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async (input: RequestInput) => {
        const url = typeof input === "string" ? input : "";
        if (url.includes("drive_file_index")) {
          return new Response(JSON.stringify(initialRows), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    );

    const openai = {
      logger: createLogger("debug"),
      apiKey: "sk",
      request: vi.fn(),
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn() },
    };

    const result = await runSearchWithRanking({
      config: baseConfig,
      request: { query: "too many hits", filters: {}, searchMaxLoopCount: 1 },
      deps: {
        supabase: {
          request: supabaseRequest,
          logger: createLogger("debug"),
          credentials: { url: "", serviceRoleKey: "" },
        },
        openai,
        initialSearch,
        logger: createLogger("debug"),
      },
    });

    expect(result.initial.bucket).toBe("tooMany");
    expect(result.initial.loopLimitReached).toBe(true);
    expect(result.finalBucket).toBe("tooMany");
    expect(result.results).toHaveLength(0);
    expect(result.vectorSearchApplied).toBe(false);
    expect(result.reranked).toBe(false);
    expect(initialSearch).toHaveBeenCalledTimes(1);
    expect(supabaseRequest).toHaveBeenCalledTimes(1);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.embeddings.create).not.toHaveBeenCalled();
  });
});
