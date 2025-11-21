import { describe, expect, it, vi } from "vitest";
import type { OpenAIClient, SupabaseClient } from "../src/clients.js";
import type { DriveFileIndexRow } from "../src/drive_file_index_repository.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { classifyHitCount, runSearchWithBranching, type SearchRequest } from "../src/search.js";

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

const buildSupabaseMock = (): SupabaseClient => {
  const headers = { "Content-Type": "application/json" };
  return {
    logger: createLogger("debug"),
    credentials: { url: "mock://supabase", serviceRoleKey: "mock" },
    request: async (input) => {
      const raw = typeof input === "string" ? input : "";
      const params = new URL(raw, "https://mock.supabase").searchParams;
      const filter = params.get("file_id") ?? "";
      const decoded = decodeURIComponent(filter);
      const ids = Array.from(decoded.matchAll(/"([^"]+)"/g)).map(([, id]) => id);
      const rows: DriveFileIndexRow[] = ids.map((id) => ({
        file_id: id,
        file_name: `mock-${id}`,
        summary: `summary for ${id}`,
        keywords: ["mock"],
        drive_modified_at: "2024-01-01T00:00:00Z",
        mime_type: "application/pdf",
      }));

      return new Response(JSON.stringify(rows), { status: 200, headers });
    },
  };
};

const buildInitialSearchStub = (counts: number[]) => {
  let call = 0;
  return vi.fn(async ({ request }: { request: SearchRequest }) => {
    const count = counts[Math.min(call, counts.length - 1)];
    const files = Array.from({ length: count }, (_, index) => ({
      id: `file-${call}-${index}`,
      name: `mock-file-${index}`,
    }));
    const suffix = call;
    call += 1;
    return {
      keywords: [`kw-${suffix}`],
      driveQuery: `drive-query-${suffix}-${request.query}`,
      files,
    };
  });
};

describe("classifyHitCount", () => {
  it("maps ranges to buckets", () => {
    expect(classifyHitCount(0)).toBe("none");
    expect(classifyHitCount(1)).toBe("single");
    expect(classifyHitCount(5)).toBe("few");
    expect(classifyHitCount(50)).toBe("many");
    expect(classifyHitCount(120)).toBe("tooMany");
  });
});

describe("runSearchWithBranching", () => {
  it("retries with user refinement when hits exceed 100 and stops at the loop limit", async () => {
    const initialSearch = buildInitialSearchStub([120, 110]);
    const askUser = vi.fn<() => Promise<string>>().mockResolvedValue("refine filter");

    const result = await runSearchWithBranching({
      config: baseConfig,
      request: { query: "original query", filters: {}, searchMaxLoopCount: 2 },
      deps: {
        supabase: buildSupabaseMock(),
        initialSearch,
        askUser,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(2);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result.bucket).toBe("tooMany");
    expect(result.loopLimitReached).toBe(true);
    expect(result.hitCount).toBe(110);
    expect(result.iteration).toBe(2);
  });

  it("applies user refinement and exits when hit count drops below 101", async () => {
    const initialSearch = buildInitialSearchStub([120, 5]);
    const askUser = vi.fn<() => Promise<string>>().mockResolvedValue("narrow term");

    const result = await runSearchWithBranching({
      config: baseConfig,
      request: { query: "base query", filters: {}, searchMaxLoopCount: 3 },
      deps: {
        supabase: buildSupabaseMock(),
        initialSearch,
        askUser,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(2);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result.bucket).toBe("few");
    expect(result.loopLimitReached).toBe(false);
    expect(result.hitCount).toBe(5);
    expect(result.iteration).toBe(2);

    const secondCallArgs = initialSearch.mock.calls[1]?.[0]?.request.query ?? "";
    expect(secondCallArgs).toContain("narrow term");
  });

  it("ヒット0件なら緩和案を適用して再検索する", async () => {
    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => {
      const keywords = request.overrideKeywords ?? ["alpha", "beta", "gamma"];
      const hitCount = keywords.length === 1 ? 2 : 0;
      const files = Array.from({ length: hitCount }, (_, index) => ({
        id: `file-${keywords.length}-${index}`,
        name: `mock-${index}`,
      }));

      return {
        keywords,
        driveQuery: `drive-query-${keywords.length}`,
        files,
      };
    });

    const chatCreate = vi.fn<OpenAIClient["chat"]["completions"]["create"]>().mockResolvedValue({
      id: "relax-chat",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify({ keywords: ["alpha"] }) },
        },
      ],
    });

    const openai = {
      chat: { completions: { create: chatCreate } },
    } satisfies Pick<OpenAIClient, "chat">;

    const result = await runSearchWithBranching({
      config: baseConfig,
      request: { query: "zero hit case", filters: {}, searchMaxLoopCount: 3 },
      deps: {
        supabase: buildSupabaseMock(),
        initialSearch,
        openai,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(2);
    expect(chatCreate).toHaveBeenCalledTimes(1);

    const secondRequest = initialSearch.mock.calls[1]?.[0]?.request;
    expect(secondRequest?.overrideKeywords).toEqual(["alpha"]);
    expect(result.bucket).toBe("few");
    expect(result.hitCount).toBe(2);
    expect(result.iteration).toBe(2);
  });

  it("キーワードが1件になっても0件なら即終了する", async () => {
    const initialSearch = vi.fn(async ({ request }: { request: SearchRequest }) => {
      const keywords = request.overrideKeywords ?? ["alpha", "beta"];
      return {
        keywords,
        driveQuery: `drive-query-${keywords.length}`,
        files: [],
      };
    });

    const chatCreate = vi.fn<OpenAIClient["chat"]["completions"]["create"]>().mockResolvedValue({
      id: "relax-chat",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify({ keywords: ["alpha"] }) },
        },
      ],
    });

    const openai = {
      chat: { completions: { create: chatCreate } },
    } satisfies Pick<OpenAIClient, "chat">;

    const result = await runSearchWithBranching({
      config: baseConfig,
      request: { query: "still none", filters: {}, searchMaxLoopCount: 3 },
      deps: {
        supabase: buildSupabaseMock(),
        initialSearch,
        openai,
        logger: createLogger("debug"),
      },
    });

    expect(initialSearch).toHaveBeenCalledTimes(2);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(result.bucket).toBe("none");
    expect(result.hitCount).toBe(0);
    expect(result.iteration).toBe(2);
    expect(result.loopLimitReached).toBe(true);
    expect(result.keywords).toEqual(["alpha"]);
  });
});
