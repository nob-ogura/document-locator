import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { GoogleDriveClient } from "../src/clients.js";
import { createGoogleDriveClient } from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import { fetchGoogleDocText } from "../src/text_extraction.js";

const baseConfig: AppConfig = {
  crawlerMode: "diff",
  searchMaxLoopCount: 3,
  summaryMaxLength: 400,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

const createDriveClient = (
  exportMock: Mock<GoogleDriveClient["files"]["export"]>,
): GoogleDriveClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    targetFolderIds: baseConfig.googleDriveTargetFolderIds,
    credentials: {
      clientId: baseConfig.googleClientId,
      clientSecret: baseConfig.googleClientSecret,
      refreshToken: baseConfig.googleRefreshToken,
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn() },
    folders: { ensureTargetsExist: vi.fn() },
    files: { list: vi.fn(), export: exportMock, get: vi.fn() },
  }) satisfies GoogleDriveClient;

describe("fetchGoogleDocText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("files.export を text/plain で呼び出し UTF-8 文字列を返す", async () => {
    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    exportMock.mockResolvedValue(
      new Response("Hello, Docs!", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const driveClient = createDriveClient(exportMock);

    const text = await fetchGoogleDocText({ driveClient, fileId: "doc-123" });

    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(exportMock).toHaveBeenCalledWith("doc-123", "text/plain", { accessToken: undefined });
    expect(text).toBe("Hello, Docs!");
  });

  it("429 応答を指数バックオフでリトライして成功する", async () => {
    type RequestInfo = Parameters<typeof fetch>[0];
    type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.retry" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response("Retried body", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createGoogleDriveClient(baseConfig, { fetch: fetchMock, logger });

    const promise = fetchGoogleDocText({ driveClient, fileId: "doc-429" });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);

    const text = await promise;
    expect(text).toBe("Retried body");

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [, firstExportOptions] = fetchMock.mock.calls[1] ?? [];
    expect(firstExportOptions?.headers).toMatchObject({ Authorization: "Bearer ya29.retry" });

    const exportUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(exportUrl.pathname).toBe("/drive/v3/files/doc-429/export");
    expect(exportUrl.searchParams.get("mimeType")).toBe("text/plain");

    expect(logger.info).toHaveBeenCalledWith(
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
  });
});
