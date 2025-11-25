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

const createDriveClient = (
  listMock: Mock<GoogleDriveClient["files"]["list"]>,
  targetFolderIds: string[] = ["folderA"],
): GoogleDriveClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    targetFolderIds,
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

describe("listDriveFilesPaged", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect(firstCallParams?.q).toBe("('folderA' in parents) and trashed = false");
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
    expect(params?.q).toBe(
      "(modifiedTime > '2024-09-01T00:00:00Z' and 'folderA' in parents) and trashed = false",
    );
  });

  it("mode=diff で drive_sync_state と同一の modifiedTime を除外する", async () => {
    const listMock = vi.fn<GoogleDriveClient["files"]["list"]>().mockResolvedValue(
      createListResponse([
        { id: "same", modifiedTime: "2024-09-10T00:00:00Z" },
        { id: "after", modifiedTime: "2024-09-10T00:00:01Z" },
      ]),
    );

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue({
      id: "global",
      drive_modified_at: "2024-09-10T00:00:00Z",
    });

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const files = await listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "diff",
    });

    expect(files.map((f) => f.id)).toEqual(["after"]);
  });

  it("mode=full でサブフォルダを FIFO でたどり深い階層のファイルを取得する", async () => {
    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValueOnce(
        createListResponse([{ id: "folder-A", mimeType: "application/vnd.google-apps.folder" }]),
      )
      .mockResolvedValueOnce(
        createListResponse([{ id: "folder-B", mimeType: "application/vnd.google-apps.folder" }]),
      )
      .mockResolvedValueOnce(
        createListResponse([{ id: "folder-C", mimeType: "application/vnd.google-apps.folder" }]),
      )
      .mockResolvedValueOnce(
        createListResponse([
          { id: "deep-file", mimeType: "text/plain", name: "deep.txt" },
          { id: "img-1", mimeType: "image/png" },
        ]),
      );

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const driveClient = createDriveClient(listMock, ["root-target"]);
    const supabaseClient = createSupabaseClient();

    const files = await listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "full",
    });

    expect(listMock).toHaveBeenCalledTimes(4);
    expect(listMock.mock.calls.map((call) => call?.[0]?.parents)).toEqual([
      ["root-target"],
      ["folder-A"],
      ["folder-B"],
      ["folder-C"],
    ]);

    expect(files.some((file) => file.id === "deep-file")).toBe(true);
  });

  it("mode=diff でもサブフォルダを FIFO で再帰列挙し modifiedTime フィルタを適用する", async () => {
    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValueOnce(
        createListResponse([
          { id: "child-A", mimeType: "application/vnd.google-apps.folder" },
          { id: "old-1", mimeType: "text/plain", modifiedTime: "2024-09-01T00:00:00Z" },
        ]),
      )
      .mockResolvedValueOnce(
        createListResponse([{ id: "child-B", mimeType: "application/vnd.google-apps.folder" }]),
      )
      .mockResolvedValueOnce(
        createListResponse([
          { id: "new-1", mimeType: "text/plain", modifiedTime: "2024-09-02T00:00:00Z" },
        ]),
      );

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue({
      id: "global",
      drive_modified_at: "2024-09-01T00:00:00Z",
    });

    const driveClient = createDriveClient(listMock, ["root-target"]);
    const supabaseClient = createSupabaseClient();

    const files = await listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "diff",
    });

    expect(listMock).toHaveBeenCalledTimes(3);
    expect(listMock.mock.calls.map((call) => call?.[0]?.parents)).toEqual([
      ["root-target"],
      ["child-A"],
      ["child-B"],
    ]);

    const queryParam = listMock.mock.calls[0]?.[0];
    expect(queryParam?.q).toBe(
      "(modifiedTime > '2024-09-01T00:00:00Z' and 'root-target' in parents) and trashed = false",
    );

    expect(files.map((f) => f.id)).toEqual(expect.arrayContaining(["child-A", "child-B", "new-1"]));
    expect(files.some((f) => f.id === "old-1")).toBe(false);
  });

  it("429 応答を指数バックオフでリトライしてページングを継続する", async () => {
    vi.useFakeTimers();

    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(createListResponse([{ id: "file-ok" }]));

    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const promise = listDriveFilesPaged({
      driveClient,
      supabaseClient,
      mode: "full",
      logger,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(listMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(listMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(listMock).toHaveBeenCalledTimes(2);

    const files = await promise;
    expect(files.map((f) => f.id)).toEqual(["file-ok"]);

    expect(logger.debug).toHaveBeenCalledWith(
      "http retry",
      expect.objectContaining({ attempt: 1, status: 429, delayMs: 1000 }),
    );
  });
});
