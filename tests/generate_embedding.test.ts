import { describe, expect, it, vi } from "vitest";

import type { OpenAIClient, OpenAIEmbeddingResponse } from "../src/clients.js";
import { buildEmbeddingInput, generateEmbedding } from "../src/openai.js";

type EmbeddingsCreate = OpenAIClient["embeddings"]["create"];

const createEmbeddingVector = (length = 1536): number[] =>
  Array.from({ length }, (_, index) => index / 1000);

const createOpenAIMock = (embedding: number[]) => {
  const response: OpenAIEmbeddingResponse = {
    object: "list",
    data: [{ index: 0, embedding }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 5, total_tokens: 5 },
  };

  const create = vi.fn<EmbeddingsCreate>().mockResolvedValue(response);

  const openai: Pick<OpenAIClient, "embeddings"> = {
    embeddings: {
      create: create as EmbeddingsCreate,
    },
  };

  return { openai, create };
};

describe("buildEmbeddingInput", () => {
  it("summary + keywords + fileName を改行区切りで結合する", () => {
    const text = buildEmbeddingInput({
      summary: "short",
      keywords: ["foo", "bar"],
      fileName: "report.pdf",
    });

    expect(text).toContain("short");
    expect(text).toContain("foo");
    expect(text).toContain("bar");
    expect(text).toContain("report.pdf");
  });
});

describe("generateEmbedding", () => {
  it("text-embedding-3-small で 1536 次元ベクトルを返す", async () => {
    const vector = createEmbeddingVector();
    const { openai, create } = createOpenAIMock(vector);

    const input = buildEmbeddingInput({
      summary: "short",
      keywords: ["foo", "bar"],
      fileName: "report.pdf",
    });

    const embedding = await generateEmbedding({ openai, input });

    expect(create).toHaveBeenCalledTimes(1);
    const [payload] = create.mock.calls[0];
    expect(payload.model).toBe("text-embedding-3-small");
    expect(payload.input).toBe(input);

    expect(embedding).toHaveLength(1536);
    expect(embedding).toEqual(vector);
  });

  it("1536 次元より短い場合は例外を投げる", async () => {
    const { openai } = createOpenAIMock(createEmbeddingVector(10));

    await expect(generateEmbedding({ openai, input: "text" })).rejects.toThrow(/1536/);
  });

  it("1536 次元より長い場合も例外を投げる", async () => {
    const { openai } = createOpenAIMock(createEmbeddingVector(1600));

    await expect(generateEmbedding({ openai, input: "text" })).rejects.toThrow(/1536/);
  });
});
