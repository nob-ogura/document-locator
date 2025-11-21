import {
  createOpenAIClient,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
  type OpenAIClient,
  type OpenAIEmbeddingRequest,
  type OpenAIEmbeddingResponse,
} from "./clients.js";
import type { AppConfig } from "./env.js";
import { createLogger, type Logger } from "./logger.js";

const MOCK_EMBEDDING_DIMENSION = 1536;
const MOCK_KEYWORDS = ["mock", "openai", "ci"];

const buildMockEmbeddingVector = (): number[] =>
  Array.from(
    { length: MOCK_EMBEDDING_DIMENSION },
    (_, index) => (index + 1) / MOCK_EMBEDDING_DIMENSION,
  );

const buildMockChatResponse = (payload: OpenAIChatRequest): OpenAIChatResponse => {
  const isKeywordRequest = payload.messages.some(
    (message) =>
      message.role === "system" && /Extract 3 to 5 short keywords/i.test(message.content),
  );

  const content = isKeywordRequest ? JSON.stringify(MOCK_KEYWORDS) : "Mock summary response";

  return {
    id: "mock-chat",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  } satisfies OpenAIChatResponse;
};

const buildMockEmbeddingResponse = (
  payload: OpenAIEmbeddingRequest,
  logger: Logger,
): OpenAIEmbeddingResponse => {
  const embedding = buildMockEmbeddingVector();
  logger.debug("mock openai embeddings", { model: payload.model, dimensions: embedding.length });

  return {
    object: "list",
    data: [{ index: 0, embedding }],
    model: payload.model ?? "text-embedding-3-small",
    usage: { prompt_tokens: 1, total_tokens: embedding.length },
  } satisfies OpenAIEmbeddingResponse;
};

/**
 * CI やキー未設定の環境で OpenAI 呼び出しをモックするクライアント。
 */
export const createMockOpenAIClient = (options: { logger?: Logger } = {}): OpenAIClient => {
  const logger = options.logger ?? createLogger("debug");

  const request: OpenAIClient["request"] = async () => {
    throw new Error("mock openai client does not support raw request calls");
  };

  const createChat: OpenAIClient["chat"]["completions"]["create"] = async (payload) => {
    logger.info("mock openai chat", {
      model: payload.model,
      messageCount: payload.messages.length,
    });
    return buildMockChatResponse(payload);
  };

  const createEmbeddings: OpenAIClient["embeddings"]["create"] = async (payload) =>
    buildMockEmbeddingResponse(payload, logger);

  return {
    logger,
    apiKey: "mock-openai-key",
    organization: "mock-openai-org",
    request,
    chat: {
      completions: {
        create: createChat,
      },
    },
    embeddings: {
      create: createEmbeddings,
    },
  } satisfies OpenAIClient;
};

export type OpenAIProviderMode = "live" | "mock";
export type OpenAIProviderResult = { openai: OpenAIClient; mode: OpenAIProviderMode };

export type OpenAIProviderOptions = {
  logger?: Logger;
  ciFlag?: boolean;
  forceMock?: boolean;
};

/**
 * CI ではモック、ローカルでは実クライアントを返す OpenAI プロバイダ。
 */
export const resolveOpenAIClient = (
  config: AppConfig,
  options: OpenAIProviderOptions = {},
): OpenAIProviderResult => {
  const logger = options.logger ?? createLogger(config.logLevel);
  const ciFlag = options.ciFlag ?? process.env.CI === "true";
  const useMock = options.forceMock ?? ciFlag;

  if (useMock) {
    logger.info("mock openai mode enabled", { reason: ciFlag ? "CI" : "forced" });
    return { openai: createMockOpenAIClient({ logger }), mode: "mock" };
  }

  const openai = createOpenAIClient(config, { logger });
  logger.info("live openai mode enabled", { organization: openai.organization ?? "default" });
  return { openai, mode: "live" };
};
