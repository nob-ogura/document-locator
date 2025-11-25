import { describe, expect, it, vi } from "vitest";

import { type CrawlerSummaryInput, logCrawlerSummary } from "../src/crawler.js";

describe("logCrawlerSummary", () => {
  it("computes processed/skipped/upserted/failed counts and logs summary", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const input: CrawlerSummaryInput = {
      processed: [
        {
          id: "a",
          name: "a.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2024-10-01T00:00:00Z",
          text: "text-a",
          summary: "summary-a",
          keywords: ["alpha"],
          embedding: [0.1, 0.2],
        },
        {
          id: "b",
          name: "b.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2024-10-02T00:00:00Z",
          text: "text-b",
          summary: null,
          keywords: null,
          embedding: null,
          aiError: "missing summary",
        },
        {
          id: "c",
          name: "c.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2024-10-03T00:00:00Z",
          text: "text-c",
          summary: "summary-c",
          keywords: ["charlie"],
          embedding: [0.3, 0.4],
        },
      ],
      skipped: [{ id: "skip-1" }],
      upsertedCount: 2,
      failedUpserts: [{ fileId: "c", error: "duplicate" }],
    };

    const summary = logCrawlerSummary(input, logger);

    expect(summary).toEqual({ processed: 3, skipped: 1, upserted: 2, failed: 1 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/processed=3/),
      expect.objectContaining({ processed: 3, skipped: 1, upserted: 2, failed: 1 }),
    );
  });
});
