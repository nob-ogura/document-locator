import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { GoogleDriveClient, SupabaseClient } from "../src/clients.js";
import { enumerateDriveFiles } from "../src/crawler.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";

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

const createListResponse = (files: unknown[], nextPageToken?: string): Response =>
  new Response(JSON.stringify({ files, nextPageToken }), {
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
    logger: createLogger("debug"),
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request: vi.fn(),
  }) satisfies SupabaseClient;

describe("drive enumeration with limit and mime filtering", () => {
  it("applies modifiedTime filter, skips unsupported MIME, and honors limit on processable files", async () => {
    const driveModifiedAt = "2024-10-01T00:00:00Z";

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue({
      id: "global",
      drive_modified_at: driveModifiedAt,
    });

    const listMock = vi.fn<GoogleDriveClient["files"]["list"]>().mockResolvedValue(
      createListResponse([
        { id: "doc-1", mimeType: "application/vnd.google-apps.document" },
        { id: "img-1", mimeType: "image/png" },
        { id: "pdf-1", mimeType: "application/pdf" },
        { id: "zip-1", mimeType: "application/zip" },
        { id: "doc-2", mimeType: "application/vnd.google-apps.document" },
        { id: "pdf-2", mimeType: "application/pdf" },
      ]),
    );

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();
    const logger = createLogger("debug");

    const result = await enumerateDriveFiles({
      config: baseConfig,
      mode: "auto",
      limit: 3,
      deps: { googleDrive: driveClient, supabase: supabaseClient, logger },
    });

    expect(result.effectiveMode).toBe("diff");
    expect(result.driveQuery).toBe(`modifiedTime > '${driveModifiedAt}'`);

    expect(driveClient.folders.ensureTargetsExist).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledTimes(1);

    const params = listMock.mock.calls[0]?.[0];
    expect(params?.q).toBe(
      `(modifiedTime > '${driveModifiedAt}' and 'folderA' in parents) and trashed = false`,
    );

    expect(result.files).toHaveLength(6);
    expect(result.processable.map((f) => f.id)).toEqual(["doc-1", "pdf-1", "doc-2"]);
    expect(result.skipped.map((f) => f.id)).toEqual(["img-1", "zip-1"]);
  });
});
