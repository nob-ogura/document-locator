import { describe, expect, it, vi } from "vitest";

import type { OpenAIChatResponse, OpenAIClient } from "../src/clients.js";
import { summarizeText } from "../src/openai.js";

type ChatCreate = OpenAIClient["chat"]["completions"]["create"];

const createOpenAIMock = (content: string) => {
  const response: OpenAIChatResponse = {
    id: "chat-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };

  const create = vi.fn<ChatCreate>().mockResolvedValue(response);

  const openai: Pick<OpenAIClient, "chat"> = {
    chat: {
      completions: {
        create: create as ChatCreate,
      },
    },
  };

  return { openai, create };
};

describe("summarizeText", () => {
  it("temperature=0 / max_tokens<=200 で呼び出し、SUMMARY_MAX_LENGTH でトランケートする", async () => {
    const generated = "あ".repeat(450);
    const { openai, create } = createOpenAIMock(generated);
    const input = "x".repeat(1000);

    const summary = await summarizeText({
      openai,
      text: input,
      summaryMaxLength: 400,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const [payload] = create.mock.calls[0];
    expect(payload.model).toBe("gpt-4o-mini");
    expect(payload.temperature).toBe(0);
    expect(payload.max_tokens).toBeLessThanOrEqual(200);
    expect(payload.messages[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(payload.messages[1]).toEqual(expect.objectContaining({ role: "user", content: input }));

    expect(summary).toHaveLength(400);
    expect(summary).toBe("あ".repeat(400));
  });

  it("summaryMaxLength が小さい場合は max_tokens を同じ値に抑制する", async () => {
    const { openai, create } = createOpenAIMock("short summary");

    await summarizeText({
      openai,
      text: "hello",
      summaryMaxLength: 10,
    });

    const [payload] = create.mock.calls[0];
    expect(payload.max_tokens).toBe(10);
  });

  it("レスポンスにコンテンツが無い場合は例外を投げる", async () => {
    const create = vi.fn<ChatCreate>().mockResolvedValue({
      id: "chat-2",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant" } }],
    } satisfies OpenAIChatResponse);

    const openai: Pick<OpenAIClient, "chat"> = {
      chat: { completions: { create: create as ChatCreate } },
    };

    await expect(
      summarizeText({
        openai,
        text: "hello",
        summaryMaxLength: 50,
      }),
    ).rejects.toThrow(/assistant content/);
  });
});
