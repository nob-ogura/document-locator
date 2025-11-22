import { vi } from "vitest";

import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIClient,
  OpenAIEmbeddingResponse,
} from "../../src/clients.ts";
import { createTestLogger } from "./logger.ts";

export const defaultKeywords = ["alpha", "beta", "gamma"];
export const defaultSummary = "mock summary";
export const embeddingVector = Array.from({ length: 1536 }, (_, index) => (index + 1) / 1536);

const buildRankingIds = (content: string): string[] => {
  const matches = Array.from(content.matchAll(/id:\s*([^\s]+)/g));
  return matches.map(([, id]) => id);
};

export const createOpenAIMock = (options?: {
  keywords?: string[];
  summary?: string;
  rerankOrder?: string[];
  embedding?: number[];
}) => {
  type ChatCreate = OpenAIClient["chat"]["completions"]["create"];
  type EmbeddingsCreate = OpenAIClient["embeddings"]["create"];

  const logger = createTestLogger();
  const keywordsContent = JSON.stringify(options?.keywords ?? defaultKeywords);
  const summaryContent = options?.summary ?? defaultSummary;
  const rerankIds = options?.rerankOrder;

  const chatCreate = vi.fn<ChatCreate>().mockImplementation(async (payload: OpenAIChatRequest) => {
    const system = payload.messages?.[0]?.content ?? "";
    const user = payload.messages?.[1]?.content ?? "";
    const isKeywordRequest =
      typeof system === "string" && /Extract 3 to 5 short keywords/i.test(system);
    const isRelaxRequest =
      typeof system === "string" && system.toString().includes("zero hits. Provide ONE relaxed");
    const isRankingRequest =
      typeof system === "string" && system.toString().includes("You are a ranking model");

    let content: string;

    if (isKeywordRequest) {
      content = keywordsContent;
    } else if (isRelaxRequest) {
      content = JSON.stringify({ keywords: [(options?.keywords ?? defaultKeywords)[0]] });
    } else if (isRankingRequest) {
      const extractedIds = buildRankingIds(typeof user === "string" ? user : "");
      const ids =
        (rerankIds && rerankIds.length > 0 && rerankIds) ||
        (extractedIds.length > 0 ? extractedIds : (options?.keywords ?? defaultKeywords));
      content = JSON.stringify(ids);
    } else {
      content = summaryContent;
    }

    return {
      id: isKeywordRequest ? "chat-keywords" : isRankingRequest ? "chat-rerank" : "chat-summary",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content } }],
    } satisfies OpenAIChatResponse;
  });

  const embeddingsCreate = vi.fn<EmbeddingsCreate>().mockResolvedValue({
    object: "list",
    data: [{ index: 0, embedding: options?.embedding ?? embeddingVector }],
    model: "text-embedding-3-small",
  } satisfies OpenAIEmbeddingResponse);

  const openai: OpenAIClient = {
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
  };

  return {
    openai,
    chatCreate,
    embeddingsCreate,
    embeddingVector: options?.embedding ?? embeddingVector,
    logger,
  };
};
