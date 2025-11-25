import { afterEach, describe, expect, it, vi } from "vitest";

import { syncSupabaseIndex } from "../src/crawler.js";
import * as textExtraction from "../src/text_extraction.js";
import { baseConfig } from "./fixtures/config.ts";
import { createDriveMock } from "./fixtures/drive.ts";
import { createOpenAIMock } from "./fixtures/openai.ts";
import { createSupabaseIndexMock } from "./fixtures/supabase.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("crawler interrupt handling", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("drains in-flight files and stops scheduling new ones after SIGINT", async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      id: `file-${index + 1}`,
      name: `file-${index + 1}.txt`,
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: `2024-10-${(index + 1).toString().padStart(2, "0")}T00:00:00Z`,
    }));

    const { drive, logger } = createDriveMock(files);
    const { supabase, upserts } = createSupabaseIndexMock();
    const { openai, chatCreate, embeddingsCreate } = createOpenAIMock();

    const deferreds = files.map(() => createDeferred<string>());
    const startOrder: string[] = [];

    vi.spyOn(textExtraction, "extractTextOrSkip").mockImplementation(({ fileMeta }) => {
      const index = startOrder.length;
      startOrder.push(fileMeta.id ?? `index-${index}`);
      return deferreds[index]?.promise ?? Promise.resolve("text");
    });

    const runPromise = syncSupabaseIndex({
      config: baseConfig,
      mode: "full",
      deps: { googleDrive: drive, supabase, openai, logger },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startOrder).toHaveLength(5);

    process.emit("SIGINT");

    deferreds.slice(0, 5).forEach((deferred, idx) => {
      deferred.resolve(`text-${idx + 1}`);
    });
    const result = await runPromise;

    expect(result.interrupted).toBe(true);
    expect(startOrder).toHaveLength(5);
    expect(upserts).toHaveLength(5);
    expect(result.processed).toHaveLength(5);
    expect(result.upsertedCount).toBe(5);
    expect(chatCreate).toHaveBeenCalledTimes(10);
    expect(embeddingsCreate).toHaveBeenCalledTimes(5);
    expect(process.exitCode).toBe(1);
  });
});
