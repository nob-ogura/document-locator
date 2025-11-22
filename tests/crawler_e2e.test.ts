import { afterEach, describe, expect, it, vi } from "vitest";
import { syncSupabaseIndex } from "../src/crawler.ts";
import type { DriveFileEntry } from "../src/drive.ts";
import { baseConfig } from "./fixtures/config.ts";
import {
  createDriveMock,
  createHierarchicalDriveMock,
  driveFilesDiff,
  driveFilesFull,
  driveFilesWithPdf,
} from "./fixtures/drive.ts";
import { createOpenAIMock } from "./fixtures/openai.ts";
import { createSupabaseIndexMock } from "./fixtures/supabase.ts";

const pdfParseMock = vi.hoisted(() => vi.fn());

vi.mock("pdf-parse", () => ({ default: pdfParseMock }));

describe("crawler mock e2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pdfParseMock.mockReset();
  });

  it("full モードでサポート MIME をすべて処理し、非対応はスキップする", async () => {
    const { drive } = createDriveMock(driveFilesFull);
    const { supabase, upserts, getSyncState } = createSupabaseIndexMock();
    const { openai, chatCreate, embeddingsCreate, embeddingVector } = createOpenAIMock();

    const result = await syncSupabaseIndex({
      config: baseConfig,
      mode: "full",
      deps: { googleDrive: drive, supabase, openai, logger: drive.logger },
    });

    expect(result.effectiveMode).toBe("full");
    expect(result.files.map((f) => f.id)).toEqual(["doc-1", "doc-2", "image-1"]);
    expect(result.processed.map((f) => f.id)).toEqual(["doc-1", "doc-2"]);
    expect(result.skipped.map((f) => f.id)).toEqual(["image-1"]);

    expect(chatCreate).toHaveBeenCalledTimes(4);
    expect(embeddingsCreate).toHaveBeenCalledTimes(2);

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.embedding).toEqual(embeddingVector);
    expect(result.upsertedCount).toBe(2);
    expect(result.latestDriveModifiedAt).toBe("2024-10-12T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-12T00:00:00Z");
  });

  it("PDF を含むクロールで要約と埋め込みを生成する", async () => {
    pdfParseMock.mockImplementation(async (buffer: Buffer) => buffer.toString());

    const { drive } = createDriveMock(driveFilesWithPdf);
    const { supabase, upserts, getSyncState } = createSupabaseIndexMock();
    const { openai, chatCreate, embeddingsCreate, embeddingVector } = createOpenAIMock();

    const result = await syncSupabaseIndex({
      config: baseConfig,
      mode: "full",
      deps: { googleDrive: drive, supabase, openai, logger: drive.logger },
    });

    expect(result.processed.map((f) => f.id)).toEqual(["doc-1", "doc-2", "pdf-1"]);
    expect(result.skipped).toHaveLength(0);

    expect(chatCreate).toHaveBeenCalledTimes(6);
    expect(embeddingsCreate).toHaveBeenCalledTimes(3);

    expect(upserts.map((row) => row.file_id)).toEqual(["doc-1", "doc-2", "pdf-1"]);
    expect(upserts[2]?.embedding).toEqual(embeddingVector);
    expect(result.upsertedCount).toBe(3);
    expect(result.latestDriveModifiedAt).toBe("2024-10-15T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-15T00:00:00Z");
  });

  it("diff モードで drive_sync_state を用いて差分 + limit を適用する", async () => {
    const { drive } = createDriveMock(driveFilesDiff);
    const { supabase, upserts, getSyncState } = createSupabaseIndexMock("2024-10-10T00:00:00Z");
    const { openai, chatCreate, embeddingsCreate } = createOpenAIMock();

    const result = await syncSupabaseIndex({
      config: baseConfig,
      mode: "diff",
      limit: 1,
      deps: { googleDrive: drive, supabase, openai, logger: drive.logger },
    });

    expect(result.effectiveMode).toBe("diff");
    expect(result.driveQuery).toBe("modifiedTime > '2024-10-10T00:00:00Z'");

    expect(result.files.map((f) => f.id)).toEqual(["doc-new-1", "doc-new-2", "image-2"]);
    expect(result.processable.map((f) => f.id)).toEqual(["doc-new-1"]);
    expect(result.processed.map((f) => f.id)).toEqual(["doc-new-1"]);
    expect(result.skipped.map((f) => f.id)).toEqual(["image-2"]);

    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);

    expect(upserts.map((row) => row.file_id)).toEqual(["doc-new-1"]);
    expect(result.upsertedCount).toBe(1);
    expect(result.latestDriveModifiedAt).toBe("2024-10-11T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-11T00:00:00Z");
  });

  it("再帰列挙した最下層のテキストを処理して AI / upsert まで実行する", async () => {
    const folderMime = "application/vnd.google-apps.folder";
    const tree = {
      "root-folder": [{ id: "folder-A", name: "A", mimeType: folderMime }],
      "folder-A": [{ id: "folder-B", name: "B", mimeType: folderMime }],
      "folder-B": [{ id: "folder-C", name: "C", mimeType: folderMime }],
      "folder-C": [
        {
          id: "deep-text",
          name: "deep.txt",
          mimeType: "text/plain",
          modifiedTime: "2024-10-20T00:00:00Z",
        },
        {
          id: "deep-image",
          name: "deep.png",
          mimeType: "image/png",
          modifiedTime: "2024-10-21T00:00:00Z",
        },
      ],
    } satisfies Record<string, DriveFileEntry[]>;

    const { drive, list, get, logger } = createHierarchicalDriveMock(tree, {
      rootIds: ["root-folder"],
    });
    const { supabase, upserts, getSyncState } = createSupabaseIndexMock();
    const { openai, chatCreate, embeddingsCreate } = createOpenAIMock();

    const result = await syncSupabaseIndex({
      config: { ...baseConfig, googleDriveTargetFolderIds: ["root-folder"] },
      mode: "full",
      limit: 10,
      deps: { googleDrive: drive, supabase, openai, logger },
    });

    expect(list.mock.calls.map((call) => call?.[0]?.parents)).toEqual([
      ["root-folder"],
      ["folder-A"],
      ["folder-B"],
      ["folder-C"],
    ]);

    expect(result.processed.map((f) => f.id)).toEqual(["deep-text"]);
    expect(result.skipped.map((f) => f.id)).toEqual(expect.arrayContaining(["deep-image"]));

    expect(get).toHaveBeenCalledWith("deep-text", expect.objectContaining({ alt: "media" }));
    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);

    expect(upserts.map((row) => row.file_id)).toEqual(["deep-text"]);
    expect(result.upsertedCount).toBe(1);
    expect(result.latestDriveModifiedAt).toBe("2024-10-20T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-20T00:00:00Z");
  });

  it("再帰列挙後のテキスト対象に limit を適用する", async () => {
    const folderMime = "application/vnd.google-apps.folder";
    const tree = {
      "root-target": [{ id: "folder-A", name: "A", mimeType: folderMime }],
      "folder-A": [
        {
          id: "text-1",
          name: "first.txt",
          mimeType: "text/plain",
          modifiedTime: "2024-10-02T00:00:00Z",
        },
        { id: "folder-B", name: "B", mimeType: folderMime },
      ],
      "folder-B": [
        {
          id: "text-2",
          name: "second.txt",
          mimeType: "text/plain",
          modifiedTime: "2024-10-03T00:00:00Z",
        },
        { id: "folder-C", name: "C", mimeType: folderMime },
      ],
      "folder-C": [
        {
          id: "text-3",
          name: "third.txt",
          mimeType: "text/plain",
          modifiedTime: "2024-10-04T00:00:00Z",
        },
      ],
    } satisfies Record<string, DriveFileEntry[]>;

    const { drive, list, logger } = createHierarchicalDriveMock(tree, {
      rootIds: ["root-target"],
    });
    const { supabase, upserts, getSyncState } = createSupabaseIndexMock("2024-10-01T00:00:00Z");
    const { openai, chatCreate, embeddingsCreate } = createOpenAIMock();

    const result = await syncSupabaseIndex({
      config: { ...baseConfig, googleDriveTargetFolderIds: ["root-target"] },
      mode: "diff",
      limit: 1,
      deps: { googleDrive: drive, supabase, openai, logger },
    });

    expect(list.mock.calls.map((call) => call?.[0]?.parents)).toEqual([
      ["root-target"],
      ["folder-A"],
      ["folder-B"],
      ["folder-C"],
    ]);

    const firstParams = list.mock.calls[0]?.[0];
    expect(firstParams?.q).toBe("modifiedTime > '2024-10-01T00:00:00Z'");

    expect(result.processable.map((f) => f.id)).toEqual(["text-1"]);
    expect(result.processed.map((f) => f.id)).toEqual(["text-1"]);

    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);

    expect(upserts.map((row) => row.file_id)).toEqual(["text-1"]);
    expect(result.upsertedCount).toBe(1);
    expect(result.latestDriveModifiedAt).toBe("2024-10-02T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-02T00:00:00Z");
  });
});
