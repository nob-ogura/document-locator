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

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
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
  });
});
