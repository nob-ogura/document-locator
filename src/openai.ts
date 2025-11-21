import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIClient } from "./clients.js";
import type { Logger } from "./logger.js";

type ChatClient = Pick<OpenAIClient, "chat">;

export type SummarizeTextOptions = {
  openai: ChatClient;
  text: string;
  summaryMaxLength: number;
  logger?: Logger;
};

const SUMMARY_MODEL = "gpt-4o-mini";
const SUMMARY_TEMPERATURE = 0;
const SUMMARY_MAX_TOKENS = 200;

const clampMaxTokens = (summaryMaxLength: number): number => {
  const safeLength =
    Number.isFinite(summaryMaxLength) && summaryMaxLength > 0 ? summaryMaxLength : 1;
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(1, safeLength));
};

const extractContent = (response: OpenAIChatResponse): string => {
  const content = response.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI summary response did not include assistant content");
  }
  return content.trim();
};

/**
 * 長文テキストを要約し、SUMMARY_MAX_LENGTH 以下に二重制限する。
 *
 * - モデル入力では制約付きプロンプトと低 max_tokens を設定
 * - 返却時にも文字数でトランケートして上限を絶対に超えない
 */
export const summarizeText = async (options: SummarizeTextOptions): Promise<string> => {
  const { openai, text, summaryMaxLength, logger } = options;
  const targetLength = Math.max(1, summaryMaxLength);
  const maxTokens = clampMaxTokens(targetLength);

  const payload: OpenAIChatRequest = {
    model: SUMMARY_MODEL,
    temperature: SUMMARY_TEMPERATURE,
    max_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content: `Summarize the user's text in plain language within ${targetLength} characters. Do not exceed ${targetLength} characters.`,
      },
      { role: "user", content: text },
    ],
  };

  const response = await openai.chat.completions.create(payload);
  const content = extractContent(response);

  const trimmed = content.length > targetLength ? content.slice(0, targetLength) : content;

  if (content.length !== trimmed.length) {
    logger?.debug?.("summary trimmed to max length", {
      requested: content.length,
      truncatedTo: targetLength,
    });
  }

  return trimmed;
};
