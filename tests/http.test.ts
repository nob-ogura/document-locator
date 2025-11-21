import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "../src/http.js";

const createResponse = (status: number) => new Response(null, { status });

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("429/5xx を指数バックオフで再試行し、成功レスポンスを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse(429))
      .mockResolvedValueOnce(createResponse(500))
      .mockResolvedValueOnce(createResponse(200));

    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    const promise = fetchWithRetry("https://example.com/resource", { fetch: fetchMock, logger });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const response = await promise;
    expect(response.status).toBe(200);

    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenNthCalledWith(
      1,
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      "http retry",
      expect.objectContaining({ attempt: 2, status: 500, delayMs: 2000 }),
    );
  });

  it("429 以外の 4xx はリトライせずに例外を投げる", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(400));
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      fetchWithRetry("https://example.com/fail", { fetch: fetchMock, logger }),
    ).rejects.toThrow(/HTTP 400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("429/5xx は最大5回リトライし16秒待機まで指数バックオフする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse(429));
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    const promise = fetchWithRetry("https://example.com/backoff", { fetch: fetchMock, logger });
    const settled = promise.catch((error) => error as Error);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const error = await settled;
    if (!(error instanceof Error)) {
      throw new Error(`unexpected settled value: ${String(error)}`);
    }
    expect(String(error.message)).toMatch(/HTTP 429/);

    expect(logger.debug).toHaveBeenCalledTimes(5);
    const lastDebugCall = logger.debug.mock.calls.at(-1);
    expect(lastDebugCall?.[0]).toBe("http retry");
    expect(lastDebugCall?.[1]).toEqual(expect.objectContaining({ delayMs: 16_000 }));
    expect(logger.error).toHaveBeenCalledWith(
      "http request failed after retries",
      expect.objectContaining({ attempts: 6, status: 429, url: "https://example.com/backoff" }),
    );
  });
});
