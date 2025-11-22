import { afterEach, describe, expect, it, vi } from "vitest";

import { syncSupabaseIndex } from "../src/crawler.ts";
import { baseConfig } from "./fixtures/config.ts";
import {
  createDriveMock,
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
});
