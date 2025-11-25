import { describe, expect, it } from "vitest";

import {
  type AiProcessedDriveFile,
  latestModifiedAt,
  toDriveFileIndexRow,
} from "../src/crawler.js";

const baseFile: AiProcessedDriveFile = {
  id: "base-id",
  name: "example.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2024-10-01T00:00:00Z",
  text: "hello",
  summary: "short",
  keywords: ["alpha"],
  embedding: [0.1, 0.2],
};

describe("toDriveFileIndexRow", () => {
  it("returns a row when required fields exist", () => {
    const row = toDriveFileIndexRow(baseFile);

    expect(row).toMatchObject({
      file_id: "base-id",
      file_name: "example.pdf",
      mime_type: "application/pdf",
      drive_modified_at: "2024-10-01T00:00:00Z",
    });
  });

  it("returns null when summary or embedding is missing", () => {
    expect(toDriveFileIndexRow({ ...baseFile, summary: null, embedding: null })).toBeNull();
  });

  it("returns null when id or modifiedTime is missing", () => {
    expect(toDriveFileIndexRow({ ...baseFile, id: undefined })).toBeNull();
    expect(toDriveFileIndexRow({ ...baseFile, modifiedTime: undefined })).toBeNull();
  });
});

describe("latestModifiedAt", () => {
  it("prefers the newer timestamp", () => {
    const first = latestModifiedAt(null, "2024-10-01T00:00:00Z");
    const second = latestModifiedAt(first, "2024-10-03T12:00:00Z");

    expect(first).toBe("2024-10-01T00:00:00Z");
    expect(second).toBe("2024-10-03T12:00:00Z");
  });

  it("keeps the current value when the candidate is older or null", () => {
    const baseline = "2024-10-05T00:00:00Z";

    expect(latestModifiedAt(baseline, "2024-10-04T00:00:00Z")).toBe(baseline);
    expect(latestModifiedAt(baseline, null)).toBe(baseline);
  });
});
