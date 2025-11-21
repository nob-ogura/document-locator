import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { GoogleDriveClient, SupabaseClient } from "../src/clients.js";
import { extractDriveTexts } from "../src/crawler.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";
import type { AppConfig } from "../src/env.js";
import * as textExtraction from "../src/text_extraction.js";

const baseConfig: AppConfig = {
  crawlerMode: "auto",
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

const createListResponse = (files: unknown[]): Response =>
  new Response(JSON.stringify({ files }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const createDriveClient = (listMock: Mock<GoogleDriveClient["files"]["list"]>): GoogleDriveClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    targetFolderIds: ["folderA"],
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn() },
    folders: { ensureTargetsExist: vi.fn() },
    files: { list: listMock, export: vi.fn(), get: vi.fn() },
  }) satisfies GoogleDriveClient;

const createSupabaseClient = (): SupabaseClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request: vi.fn(),
  }) satisfies SupabaseClient;

describe("extractDriveTexts", () => {
  it("processes supported MIME, skips unsupported with log, and continues on extraction failure", async () => {
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const listMock = vi.fn<GoogleDriveClient["files"]["list"]>().mockResolvedValue(
      createListResponse([
        { id: "doc-1", mimeType: "application/vnd.google-apps.document" },
        { id: "pdf-1", mimeType: "application/pdf" },
        { id: "img-1", mimeType: "image/png" },
      ]),
    );

    const extractSpy = vi
      .spyOn(textExtraction, "extractTextOrSkip")
      .mockResolvedValueOnce("doc text")
      .mockRejectedValueOnce(new Error("pdf parse failed"));

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const result = await extractDriveTexts({
      config: baseConfig,
      mode: "auto",
      deps: { googleDrive: driveClient, supabase: supabaseClient, logger },
    });

    // list called once with no modifiedTime filter (auto + no sync state)
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(driveClient.folders.ensureTargetsExist).toHaveBeenCalledTimes(1);

    // unsupported MIME is marked skipped and logged
    expect(result.skipped.map((f) => f.id)).toEqual(["img-1"]);
    expect(logger.info).toHaveBeenCalledWith(
      "skip: unsupported mime_type",
      expect.objectContaining({ mimeType: "image/png", fileId: "img-1" }),
    );

    // extraction attempted for supported files even if one fails
    expect(extractSpy).toHaveBeenCalledTimes(2);
    expect(extractSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fileMeta: expect.objectContaining({ id: "doc-1" }) }),
    );
    expect(extractSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileMeta: expect.objectContaining({ id: "pdf-1" }) }),
    );

    expect(result.extracted).toHaveLength(2);
    const doc = result.extracted.find((f) => f.id === "doc-1");
    const pdf = result.extracted.find((f) => f.id === "pdf-1");

    expect(doc?.text).toBe("doc text");
    expect(pdf?.text).toBeNull();
    expect(pdf?.error).toMatch(/pdf parse failed/i);

    expect(logger.info).toHaveBeenCalledWith(
      "text extraction failed; continuing",
      expect.objectContaining({ fileId: "pdf-1" }),
    );
  });
});
