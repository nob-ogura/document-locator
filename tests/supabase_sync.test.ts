import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "../src/clients.js";
import { type AiProcessedDriveFile, upsertProcessedFiles } from "../src/crawler.js";
import * as driveFileIndexRepo from "../src/drive_file_index_repository.js";
import * as syncStateRepo from "../src/drive_sync_state_repository.js";

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

const createSupabase = (): SupabaseClient =>
  ({
    logger: createLogger(),
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request: vi.fn(),
  }) as unknown as SupabaseClient;

const processedFixtures: AiProcessedDriveFile[] = [
  {
    id: "a",
    name: "report-a.pdf",
    mimeType: "application/pdf",
    modifiedTime: "2024-10-01T00:00:00Z",
    text: "text-a",
    summary: "summary-a",
    keywords: ["alpha"],
    embedding: [0.1, 0.2],
  },
  {
    id: "b",
    name: "report-b.pdf",
    mimeType: "application/pdf",
    modifiedTime: "2024-10-03T12:00:00Z",
    text: "text-b",
    summary: "summary-b",
    keywords: ["beta"],
    embedding: [0.3, 0.4],
  },
  {
    id: "c",
    name: "report-c.pdf",
    mimeType: "application/pdf",
    modifiedTime: "2024-10-02T00:00:00Z",
    text: "text-c",
    summary: "summary-c",
    keywords: ["gamma"],
    embedding: [0.5, 0.6],
  },
];

describe("upsertProcessedFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts all rows and updates sync state with the latest modifiedTime", async () => {
    const supabase = createSupabase();
    const upsertSpy = vi.spyOn(driveFileIndexRepo, "upsertDriveFileIndex").mockResolvedValue();
    const syncStateSpy = vi.spyOn(syncStateRepo, "upsertDriveSyncState").mockResolvedValue(1);

    const result = await upsertProcessedFiles(processedFixtures, supabase, supabase.logger);

    expect(upsertSpy).toHaveBeenCalledTimes(processedFixtures.length);
    expect(syncStateSpy).toHaveBeenCalledWith(supabase, "2024-10-03T12:00:00Z");
    expect(result.upsertedCount).toBe(3);
    expect(result.failedUpserts).toHaveLength(0);
    expect(result.latestDriveModifiedAt).toBe("2024-10-03T12:00:00Z");
  });

  it("logs file_id and throws when any upsert fails", async () => {
    const supabase = createSupabase();
    const upsertSpy = vi
      .spyOn(driveFileIndexRepo, "upsertDriveFileIndex")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("duplicate"))
      .mockResolvedValueOnce();
    const syncStateSpy = vi.spyOn(syncStateRepo, "upsertDriveSyncState").mockResolvedValue(1);

    await expect(
      upsertProcessedFiles(processedFixtures, supabase, supabase.logger),
    ).rejects.toThrow(/supabase upsert failed/i);

    expect(upsertSpy).toHaveBeenCalledTimes(processedFixtures.length);
    expect(syncStateSpy).not.toHaveBeenCalled();
    expect(supabase.logger.error).toHaveBeenCalledWith(
      "supabase upsert failed",
      expect.objectContaining({ fileId: "b" }),
    );
  });

  it("skips rows missing AI outputs without calling Supabase", async () => {
    const supabase = createSupabase();
    const upsertSpy = vi.spyOn(driveFileIndexRepo, "upsertDriveFileIndex").mockResolvedValue();
    const syncStateSpy = vi.spyOn(syncStateRepo, "upsertDriveSyncState").mockResolvedValue(1);

    const incomplete: AiProcessedDriveFile[] = [
      {
        id: "skip-1",
        name: "skip.pdf",
        mimeType: "application/pdf",
        modifiedTime: "2024-10-04T00:00:00Z",
        text: "",
        summary: null,
        keywords: null,
        embedding: null,
        aiError: "empty summary",
      },
    ];

    const result = await upsertProcessedFiles(incomplete, supabase, supabase.logger);

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(syncStateSpy).not.toHaveBeenCalled();
    expect(result.upsertedCount).toBe(0);
    expect(result.latestDriveModifiedAt).toBeNull();
  });
});
