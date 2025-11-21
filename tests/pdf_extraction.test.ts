import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGoogleDriveClient } from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import { fetchPdfText } from "../src/text_extraction.js";

const pdfParseMock = vi.hoisted(() => vi.fn());

vi.mock("pdf-parse", () => ({ default: pdfParseMock }));

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

describe("fetchPdfText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pdfParseMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("files.get alt=media で取得した PDF を pdf-parse で文字列化する", async () => {
    pdfParseMock.mockResolvedValue({ text: "PDF BODY" });

    type RequestInfo = Parameters<typeof fetch>[0];
    type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    const pdfBinary = new Uint8Array([1, 2, 3]);

    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(pdfBinary, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );

    const driveClient = createGoogleDriveClient(baseConfig, { fetch: fetchMock });

    const text = await fetchPdfText({ driveClient, fileId: "pdf-123" });

    expect(text).toBe("PDF BODY");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const pdfUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(pdfUrl.pathname).toBe("/drive/v3/files/pdf-123");
    expect(pdfUrl.searchParams.get("alt")).toBe("media");

    const pdfParseArgs = pdfParseMock.mock.calls[0]?.[0] as unknown;
    expect(Buffer.isBuffer(pdfParseArgs)).toBe(true);
  });

  it("429/5xx でも指数バックオフで再試行して成功する", async () => {
    pdfParseMock.mockResolvedValue("Retried PDF");

    type RequestInfo = Parameters<typeof fetch>[0];
    type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.retry-pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 9, 9]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createGoogleDriveClient(baseConfig, { fetch: fetchMock, logger });

    const promise = fetchPdfText({ driveClient, fileId: "pdf-429" });

    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);

    const text = await promise;
    expect(text).toBe("Retried PDF");

    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(logger.info).toHaveBeenCalledWith(
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
  });
});
