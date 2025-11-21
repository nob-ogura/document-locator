import type { Logger } from "./logger.ts";

// Compatible with the node-global `fetch` signature without relying on DOM lib types.
type RequestInfo = Parameters<typeof fetch>[0];
type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export type FetchWithRetryOptions = RequestInit & {
  fetch?: FetchLike;
  logger?: Logger;
  /**
   * 最大リトライ回数（初回リクエストを含む）
   */
  maxRetries?: number;
  /**
   * 初回待機の基準ミリ秒（指数的に倍増する）
   */
  baseDelayMs?: number;
};

export const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeUrl = (input: RequestInfo): string => {
  if (input instanceof Request) return input.url;
  try {
    return new URL(input as string).toString();
  } catch {
    return String(input);
  }
};

export const fetchWithRetry = async (
  input: RequestInfo,
  options: FetchWithRetryOptions = {},
): Promise<Response> => {
  const {
    fetch: fetchImpl = globalThis.fetch,
    logger,
    maxRetries = 5,
    baseDelayMs = 1000,
    ...init
  } = options;

  if (!fetchImpl) {
    throw new Error("fetch implementation is not available");
  }

  const urlText = normalizeUrl(input);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let response: Response;

    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (attempt >= maxRetries) {
        logger?.error("http request failed after retries", {
          attempts: attempt,
          error,
          url: urlText,
        });
        throw error instanceof Error ? error : new Error(String(error));
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      logger?.debug("http retry", { attempt, status: "exception", delayMs, url: urlText });
      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      return response;
    }

    if (!isRetryableStatus(response.status)) {
      throw new Error(`HTTP ${response.status}: ${response.statusText || "request failed"}`);
    }

    if (attempt >= maxRetries) {
      logger?.error("http request failed after retries", {
        attempts: attempt,
        status: response.status,
        url: urlText,
      });
      throw new Error(`HTTP ${response.status}: exceeded retry limit`);
    }

    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    logger?.debug("http retry", { attempt, status: response.status, delayMs, url: urlText });
    await sleep(delayMs);
  }

  throw new Error("fetchWithRetry exhausted attempts unexpectedly");
};
