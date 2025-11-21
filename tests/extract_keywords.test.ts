import { describe, expect, it, vi } from "vitest";

import type { OpenAIChatResponse, OpenAIClient } from "../src/clients.js";
import { extractKeywords } from "../src/openai.js";

type ChatCreate = OpenAIClient["chat"]["completions"]["create"];

const createOpenAIMock = (content: string) => {
  const response: OpenAIChatResponse = {
    id: "chat-keywords-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
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

describe("extractKeywords", () => {
  it("model/temperature/max_tokens を設定し、非 JSON 出力を 3〜5 件の配列に補正する", async () => {
    const { openai, create } = createOpenAIMock("Keywords: foo, bar, baz");

    const keywords = await extractKeywords({
      openai,
      text: "任意の入力テキスト",
    });

    expect(create).toHaveBeenCalledTimes(1);
    const [payload] = create.mock.calls[0];
    expect(payload.model).toBe("gpt-4o-mini");
    expect(payload.temperature).toBe(0);
    expect(payload.max_tokens).toBeLessThanOrEqual(200);
    expect(payload.messages[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(payload.messages[1]).toEqual(
      expect.objectContaining({ role: "user", content: "任意の入力テキスト" }),
    );

    expect(keywords).toEqual(["foo", "bar", "baz"]);
  });

  it("6 件など多すぎる場合は 5 件にトリムする", async () => {
    const { openai } = createOpenAIMock('["a","b","c","d","e","f"]');

    const keywords = await extractKeywords({
      openai,
      text: "input",
    });

    expect(keywords).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("3 件未満しか取得できない場合は例外を送出する", async () => {
    const { openai } = createOpenAIMock('["one","two"]');

    await expect(
      extractKeywords({
        openai,
        text: "input",
      }),
    ).rejects.toThrow(/keyword/i);
  });
});
