import { describe, expect, it, vi } from "vitest";

import {
  createOpenAIClient,
  type OpenAIChatResponse,
  type OpenAIEmbeddingResponse,
} from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import type { FetchWithRetryOptions } from "../src/http.js";

const baseConfig: AppConfig = {
  crawlerMode: "diff",
  searchMaxLoopCount: 3,
  summaryMaxLength: 400,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  openaiOrg: "org-test",
  logLevel: "debug",
};

type RequestInfo = Parameters<typeof fetch>[0];
type Retrier = (input: RequestInfo, options?: FetchWithRetryOptions) => Promise<Response>;

const createJsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

describe("createOpenAIClient", () => {
  it("OPENAI_API_KEY が欠落している場合は例外を送出する", () => {
    const invalidConfig: AppConfig = { ...baseConfig, openaiApiKey: "" };
    expect(() => createOpenAIClient(invalidConfig)).toThrow(/OPENAI_API_KEY/);
  });

  it("chat/embeddings にデフォルト設定と共通バックオフを適用し token 使用量を DEBUG 出力する", async () => {
    const logger = createMockLogger();

    const retrier = vi
      .fn<Retrier>()
      .mockResolvedValueOnce(
        createJsonResponse({
          id: "chat-1",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        } satisfies OpenAIChatResponse),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        } satisfies OpenAIEmbeddingResponse),
      );

    const client = createOpenAIClient(baseConfig, { logger, fetchWithRetry: retrier });

    await client.chat.completions.create({ messages: [{ role: "user", content: "hello" }] });

    const chatCall = retrier.mock.calls[0];
    expect(chatCall).toBeDefined();
    if (!chatCall) throw new Error("chat call was not recorded");
    const [chatUrl, chatOptions] = chatCall;
    expect(String(chatUrl)).toContain("/v1/chat/completions");
    const chatBody = JSON.parse(String(chatOptions?.body ?? "{}")) as Record<string, unknown>;
    expect(chatBody.model).toBe("gpt-4o-mini");
    expect(chatBody.temperature).toBe(0);
    expect(chatBody.max_tokens).toBe(200);
    expect(chatOptions?.baseDelayMs).toBe(1000);
    expect(chatOptions?.maxRetries).toBe(5);

    expect(logger.debug).toHaveBeenCalledWith(
      "openai usage",
      expect.objectContaining({
        endpoint: "chat",
        model: "gpt-4o-mini",
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      }),
    );

    await client.embeddings.create({ input: "keyword" });

    const embeddingCall = retrier.mock.calls[1];
    expect(embeddingCall).toBeDefined();
    if (!embeddingCall) throw new Error("embedding call was not recorded");
    const [embUrl, embOptions] = embeddingCall;
    expect(String(embUrl)).toContain("/v1/embeddings");
    const embBody = JSON.parse(String(embOptions?.body ?? "{}")) as Record<string, unknown>;
    expect(embBody.model).toBe("text-embedding-3-small");
    expect(embOptions?.baseDelayMs).toBe(1000);
    expect(embOptions?.maxRetries).toBe(5);

    expect(logger.debug).toHaveBeenCalledWith(
      "openai usage",
      expect.objectContaining({
        endpoint: "embeddings",
        model: "text-embedding-3-small",
        promptTokens: 5,
        completionTokens: undefined,
        totalTokens: 5,
      }),
    );
  });
});
