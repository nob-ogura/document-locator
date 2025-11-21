import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type {
  GoogleDriveClient,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIClient,
  OpenAIEmbeddingResponse,
  SupabaseClient,
} from "../src/clients.js";
import { runAiPipeline } from "../src/crawler.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";
import type { AppConfig } from "../src/env.js";
import * as textExtraction from "../src/text_extraction.js";

const baseConfig: AppConfig = {
  crawlerMode: "auto",
  searchMaxLoopCount: 3,
  summaryMaxLength: 120,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

const createListResponse = (files: unknown[]): Response =>
  new Response(JSON.stringify({ files }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const createDriveClient = (listMock: Mock<GoogleDriveClient["files"]["list"]>): GoogleDriveClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    targetFolderIds: ["folderA"],
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn() },
    folders: { ensureTargetsExist: vi.fn() },
    files: { list: listMock, export: vi.fn(), get: vi.fn() },
  }) satisfies GoogleDriveClient;

const createSupabaseClient = (): SupabaseClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request: vi.fn(),
  }) satisfies SupabaseClient;

const createOpenAIMock = () => {
  type ChatCreate = OpenAIClient["chat"]["completions"]["create"];
  type EmbeddingsCreate = OpenAIClient["embeddings"]["create"];

  const summaryContent = "S".repeat(500);
  const keywordsContent = JSON.stringify(["alpha", "beta", "gamma"]);

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  const chatCreate = vi.fn<ChatCreate>().mockImplementation(async (payload: OpenAIChatRequest) => {
    const systemMessage = payload.messages[0]?.content ?? "";
    const isKeywordRequest =
      typeof systemMessage === "string" && /Extract 3 to 5 short keywords/i.test(systemMessage);

    const content = isKeywordRequest ? keywordsContent : summaryContent;

    return {
      id: isKeywordRequest ? "chat-keywords" : "chat-summary",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content } }],
    } satisfies OpenAIChatResponse;
  });

  const embeddingVector = Array.from({ length: 1536 }, (_, index) => index / 1536);

  const embeddingsCreate = vi.fn<EmbeddingsCreate>().mockResolvedValue({
    object: "list",
    data: [{ index: 0, embedding: embeddingVector }],
    model: "text-embedding-3-small",
  } satisfies OpenAIEmbeddingResponse);

  const openai = {
    logger,
    apiKey: "sk-test",
    organization: "org-test",
    request: vi.fn(),
    chat: {
      completions: {
        create: chatCreate,
      },
    },
    embeddings: {
      create: embeddingsCreate,
    },
  } satisfies OpenAIClient;

  return { openai, chatCreate, embeddingsCreate, embeddingVector };
};

describe("runAiPipeline", () => {
  it("generates summary, 3-5 keywords, and embedding per file with SUMMARY_MAX_LENGTH enforcement", async () => {
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValue(
        createListResponse([{ id: "doc-1", name: "report.pdf", mimeType: "application/pdf" }]),
      );

    const extractSpy = vi
      .spyOn(textExtraction, "extractTextOrSkip")
      .mockResolvedValue("x".repeat(800));

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();
    const { openai, chatCreate, embeddingsCreate, embeddingVector } = createOpenAIMock();

    const result = await runAiPipeline({
      config: baseConfig,
      mode: "auto",
      deps: { googleDrive: driveClient, supabase: supabaseClient, openai, logger: openai.logger },
    });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);

    expect(chatCreate).toHaveBeenCalledTimes(2); // summary + keywords
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);

    expect(result.processed).toHaveLength(1);
    const processed = result.processed[0];

    expect(processed.summary).toHaveLength(baseConfig.summaryMaxLength);
    expect(processed.keywords).toEqual(["alpha", "beta", "gamma"]);
    expect(processed.embedding).toEqual(embeddingVector);
    expect(processed.aiError).toBeUndefined();

    const [embeddingPayload] = embeddingsCreate.mock.calls[0];
    expect(embeddingPayload?.model).toBe("text-embedding-3-small");
  });
});
