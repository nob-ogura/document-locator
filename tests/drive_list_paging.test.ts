import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GoogleDriveClient, SupabaseClient } from "../src/clients.js";
import { listDriveFilesPaged } from "../src/drive.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";

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
    files: { list: listMock, export: vi.fn() },
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

describe("listDriveFilesPaged", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mode=auto で drive_sync_state が無い場合はフルクロールとしてページング取得する", async () => {
    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValueOnce(createListResponse([{ id: "file-1" }], "token-1"))
      .mockResolvedValueOnce(createListResponse([{ id: "file-2" }]));

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const files = await listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "auto",
    });

    expect(files.map((f) => f.id)).toEqual(["file-1", "file-2"]);
    expect(listMock).toHaveBeenCalledTimes(2);

    const firstCallParams = listMock.mock.calls[0]?.[0];
    const secondCallParams = listMock.mock.calls[1]?.[0];
    expect(firstCallParams?.pageSize).toBe(100);
    expect(firstCallParams?.pageToken).toBeUndefined();
    expect(firstCallParams?.q).toBeUndefined();
    expect(secondCallParams?.pageToken).toBe("token-1");
  });

  it("mode=diff で drive_sync_state を用いて modifiedTime フィルタを付与する", async () => {
    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValue(createListResponse([{ id: "file-3" }]));

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue({
      id: "global",
      drive_modified_at: "2024-09-01T00:00:00Z",
    });

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const files = await listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "diff",
    });

    expect(files.map((f) => f.id)).toEqual(["file-3"]);
    expect(listMock).toHaveBeenCalledTimes(1);
    const params = listMock.mock.calls[0]?.[0];
    expect(params?.pageSize).toBe(100);
    expect(params?.q).toBe("modifiedTime > '2024-09-01T00:00:00Z'");
  });
});
