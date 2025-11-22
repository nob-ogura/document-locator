import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIClient,
  OpenAIEmbeddingData,
} from "./clients.ts";
import type { Logger } from "./logger.ts";

type ChatClient = Pick<OpenAIClient, "chat">;
type EmbeddingsClient = Pick<OpenAIClient, "embeddings">;

export type SummarizeTextOptions = {
  openai: ChatClient;
  text: string;
  summaryMaxLength: number;
  logger?: Logger;
};

export type ExtractKeywordsOptions = {
  openai: ChatClient;
  text: string;
  logger?: Logger;
};

export type BuildEmbeddingInputOptions = {
  summary: string;
  keywords?: string[] | null;
  fileName: string;
};

export type GenerateEmbeddingOptions = {
  openai: EmbeddingsClient;
  input: string;
};

const SUMMARY_MODEL = "gpt-4o-mini";
const SUMMARY_TEMPERATURE = 0;
const SUMMARY_MAX_TOKENS = 200;
const KEYWORDS_MODEL = SUMMARY_MODEL;
const KEYWORDS_TEMPERATURE = SUMMARY_TEMPERATURE;
const KEYWORDS_MAX_TOKENS = SUMMARY_MAX_TOKENS;
const KEYWORDS_MIN_LENGTH = 3;
const KEYWORDS_MAX_LENGTH = 5;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSION = 1536;

const clampMaxTokens = (summaryMaxLength: number): number => {
  const safeLength =
    Number.isFinite(summaryMaxLength) && summaryMaxLength > 0 ? summaryMaxLength : 1;
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(1, safeLength));
};

const extractContent = (response: OpenAIChatResponse): string => {
  const content = response.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI chat response did not include assistant content");
  }
  return content.trim();
};

const keywordLabelPattern = /^[\s>*-]*keywords?\s*[:|-]\s*/i;

const normalizeKeywordStrings = (values: unknown[]): string[] => {
  const normalized = values
    .map((value) => (typeof value === "string" ? value : value == null ? "" : String(value)))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return Array.from(new Set(normalized));
};

const parseJsonArray = (text: string): string[] | null => {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return normalizeKeywordStrings(parsed);
  } catch {
    return null;
  }
};

const parseDelimitedKeywords = (text: string): string[] => {
  const withoutLabel = text.replace(keywordLabelPattern, "");
  const unwrapped = withoutLabel.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  return normalizeKeywordStrings(unwrapped.split(/[,\n]/));
};

const collectKeywordCandidates = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) candidates.add(codeBlockMatch[1].trim());

  const bracketMatch = trimmed.match(/\[[\s\S]*\]/);
  if (bracketMatch?.[0]) candidates.add(bracketMatch[0].trim());

  candidates.add(trimmed);

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
};

const clampKeywords = (keywords: string[], logger?: Logger): string[] => {
  const trimmed = keywords.slice(0, KEYWORDS_MAX_LENGTH);

  if (keywords.length > KEYWORDS_MAX_LENGTH) {
    logger?.debug?.("keywords trimmed to max length", {
      requested: keywords.length,
      trimmedTo: KEYWORDS_MAX_LENGTH,
    });
  }

  if (trimmed.length < KEYWORDS_MIN_LENGTH) {
    throw new Error(
      `OpenAI keyword response contained ${trimmed.length} keyword(s); expected between ${KEYWORDS_MIN_LENGTH} and ${KEYWORDS_MAX_LENGTH}`,
    );
  }

  return trimmed;
};

const parseKeywordsContent = (content: string, logger?: Logger): string[] => {
  const candidates = collectKeywordCandidates(content);

  for (const candidate of candidates) {
    const jsonKeywords = parseJsonArray(candidate);
    if (jsonKeywords && jsonKeywords.length >= KEYWORDS_MIN_LENGTH) {
      return clampKeywords(jsonKeywords, logger);
    }

    const delimitedKeywords = parseDelimitedKeywords(candidate);
    if (delimitedKeywords.length >= KEYWORDS_MIN_LENGTH) {
      return clampKeywords(delimitedKeywords, logger);
    }
  }

  throw new Error("OpenAI keyword response could not be normalized to 3-5 keywords");
};

const isValidEmbeddingVector = (
  data: OpenAIEmbeddingData | undefined,
): data is OpenAIEmbeddingData => {
  if (!data) return false;
  if (typeof data.index !== "number" || !Number.isInteger(data.index)) return false;
  if (!Array.isArray(data.embedding)) return false;
  if (data.embedding.length !== EMBEDDING_DIMENSION) return false;
  return data.embedding.every((value) => typeof value === "number" && Number.isFinite(value));
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
        content: `ユーザーのテキストを${targetLength}文字以内で要約しなさい。体言止めを中心に記述すること。${targetLength}文字を超えてはならない。`,
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

/**
 * テキストから 3〜5 件のキーワードを抽出し、JSON 配列に正規化する。
 *
 * - model="gpt-4o-mini", temperature=0, max_tokens<=200 で呼び出す
 * - 非 JSON 出力でもカンマ/改行区切りや "Keywords:" 接頭辞を補正して配列化する
 * - 3 未満の場合は失敗とみなし、5 件を超える場合は 5 件にトリムする
 */
export const extractKeywords = async (options: ExtractKeywordsOptions): Promise<string[]> => {
  const { openai, text, logger } = options;

  const payload: OpenAIChatRequest = {
    model: KEYWORDS_MODEL,
    temperature: KEYWORDS_TEMPERATURE,
    max_tokens: KEYWORDS_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content:
          "Extract 3 to 5 short keywords that best describe the user's text. " +
          "Respond ONLY with a JSON array of strings.",
      },
      { role: "user", content: text },
    ],
  };

  const response = await openai.chat.completions.create(payload);
  const content = extractContent(response);

  return parseKeywordsContent(content, logger);
};

/**
 * 要約・キーワード・ファイル名を結合し、Embedding 入力文字列を生成する。
 */
export const buildEmbeddingInput = (options: BuildEmbeddingInputOptions): string => {
  const { summary, keywords, fileName } = options;
  const normalizedKeywords = keywords ? normalizeKeywordStrings(keywords) : [];

  const parts = [
    summary?.trim() ?? "",
    normalizedKeywords.length > 0 ? `Keywords: ${normalizedKeywords.join(", ")}` : "",
    `File: ${fileName}`,
  ];

  return parts.filter((part) => part.trim().length > 0).join("\n");
};

/**
 * text-embedding-3-small で 1536 次元のベクトルを生成し、型ガードで誤応答を排除する。
 */
export const generateEmbedding = async (options: GenerateEmbeddingOptions): Promise<number[]> => {
  const { openai, input } = options;

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });

  const first = response.data.length > 0 ? response.data[0] : undefined;
  const length = Array.isArray(first?.embedding) ? first?.embedding.length : undefined;
  if (!isValidEmbeddingVector(first)) {
    throw new Error(
      `OpenAI embedding vector must contain ${EMBEDDING_DIMENSION} numbers (received ${length ?? "none"})`,
    );
  }

  return first.embedding;
};
