import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { GoogleDriveClient } from "../src/clients.js";
import { createGoogleDriveClient } from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import {
  extractTextOrSkip,
  fetchDocxText,
  fetchGoogleDocText,
  fetchPlainLikeText,
} from "../src/text_extraction.js";

const mammothExtractMock = vi.hoisted(() => vi.fn());

vi.mock("mammoth", () => ({
  default: { extractRawText: mammothExtractMock },
  extractRawText: mammothExtractMock,
}));

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
  getMock: Mock<GoogleDriveClient["files"]["get"]> = vi.fn(),
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
    files: { list: vi.fn(), export: exportMock, get: getMock },
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

    expect(logger.debug).toHaveBeenCalledWith(
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
  });
});

describe("fetchDocxText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mammothExtractMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("files.get alt=media で取得した docx を mammoth.extractRawText で文字列化する", async () => {
    mammothExtractMock.mockResolvedValue({ value: "DOCX BODY", messages: [] });

    type RequestInfo = Parameters<typeof fetch>[0];
    type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    const docxBinary = new Uint8Array([10, 20, 30]);

    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.docx" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(docxBinary, {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        }),
      );

    const driveClient = createGoogleDriveClient(baseConfig, { fetch: fetchMock });

    const text = await fetchDocxText({ driveClient, fileId: "docx-123" });

    expect(text).toBe("DOCX BODY");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const docxUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(docxUrl.pathname).toBe("/drive/v3/files/docx-123");
    expect(docxUrl.searchParams.get("alt")).toBe("media");

    const mammothArg = mammothExtractMock.mock.calls[0]?.[0] as { buffer?: unknown };
    expect(Buffer.isBuffer(mammothArg?.buffer)).toBe(true);
  });

  it("空文字列が返された場合はエラーになる", async () => {
    mammothExtractMock.mockResolvedValue({ value: "" });

    type RequestInfo = Parameters<typeof fetch>[0];
    type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

    const docxBinary = new Uint8Array([4, 5, 6]);

    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.docx-empty" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(docxBinary, {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        }),
      );

    const driveClient = createGoogleDriveClient(baseConfig, { fetch: fetchMock });

    await expect(fetchDocxText({ driveClient, fileId: "docx-empty" })).rejects.toThrow(
      "docx docx-empty returned empty text",
    );

    expect(mammothExtractMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPlainLikeText", () => {
  it.each([
    { mimeType: "text/plain", body: "Just plain text", fileId: "plain-1" },
    { mimeType: "text/markdown", body: "# Title\n\ncontent", fileId: "md-1" },
    { mimeType: "text/csv", body: "a,b\nc,d", fileId: "csv-1" },
  ])("files.get alt=media で %s を文字列として返す", async ({ mimeType, body, fileId }) => {
    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    const getMock = vi.fn() as Mock<GoogleDriveClient["files"]["get"]>;
    getMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": `${mimeType}; charset=utf-8` },
      }),
    );

    const driveClient = createDriveClient(exportMock, getMock);

    const text = await fetchPlainLikeText({ driveClient, fileId });

    expect(text).toBe(body);
    expect(getMock).toHaveBeenCalledWith(fileId, { accessToken: undefined, alt: "media" });
  });

  it("空文字列が返された場合はエラーになる", async () => {
    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    const getMock = vi.fn() as Mock<GoogleDriveClient["files"]["get"]>;
    getMock.mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const driveClient = createDriveClient(exportMock, getMock);

    await expect(fetchPlainLikeText({ driveClient, fileId: "plain-empty" })).rejects.toThrow(
      "text file plain-empty returned empty text",
    );
  });
});

describe("extractTextOrSkip", () => {
  it("非対応 MIME をスキップし、抽出処理を呼ばずにログを残す", async () => {
    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    const getMock = vi.fn() as Mock<GoogleDriveClient["files"]["get"]>;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createDriveClient(exportMock, getMock);

    const pngResult = await extractTextOrSkip({
      driveClient,
      fileMeta: { id: "img-1", mimeType: "image/png", name: "sample.png" },
      logger,
    });

    const zipResult = await extractTextOrSkip({
      driveClient,
      fileMeta: { id: "zip-1", mimeType: "application/zip", name: "archive.zip" },
      logger,
    });

    expect(pngResult).toBeNull();
    expect(zipResult).toBeNull();
    expect(exportMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "skip: unsupported mime_type",
      expect.objectContaining({
        mimeType: "image/png",
        fileId: "img-1",
        fileName: "sample.png",
      }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      "skip: unsupported mime_type",
      expect.objectContaining({
        mimeType: "application/zip",
        fileId: "zip-1",
        fileName: "archive.zip",
      }),
    );
  });

  it("docx MIME を抽出して文字列を返す", async () => {
    mammothExtractMock.mockReset();
    mammothExtractMock.mockResolvedValue({ value: "DOCX FROM SKIP HANDLER" });

    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    const getMock = vi.fn() as Mock<GoogleDriveClient["files"]["get"]>;
    getMock.mockResolvedValue(
      new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createDriveClient(exportMock, getMock);

    const text = await extractTextOrSkip({
      driveClient,
      fileMeta: {
        id: "docx-h1",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "sample.docx",
      },
      logger,
    });

    expect(text).toBe("DOCX FROM SKIP HANDLER");
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(mammothExtractMock).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("text/markdown MIME を抽出して文字列を返す", async () => {
    const exportMock = vi.fn() as Mock<GoogleDriveClient["files"]["export"]>;
    const getMock = vi.fn() as Mock<GoogleDriveClient["files"]["get"]>;
    getMock.mockResolvedValue(
      new Response("# heading", {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createDriveClient(exportMock, getMock);

    const text = await extractTextOrSkip({
      driveClient,
      fileMeta: {
        id: "md-123",
        mimeType: "text/markdown",
        name: "README.md",
      },
      logger,
    });

    expect(text).toBe("# heading");
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
