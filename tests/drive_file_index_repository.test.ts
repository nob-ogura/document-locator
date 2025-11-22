import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "../src/clients.js";
import {
  fetchDriveFileIndexByIds,
  upsertDriveFileIndex,
  vectorSearchDriveFileIndex,
} from "../src/drive_file_index_repository.js";

describe("drive_file_index repository", () => {
  it("upsertDriveFileIndex が Prefer: resolution=merge-duplicates で POST する", async () => {
    const request = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async () => new Response(null, { status: 201 }),
    );
    const supabase = { request } as unknown as SupabaseClient;

    const rows = [
      {
        file_id: "1",
        file_name: "a",
        summary: "s",
        keywords: [],
        embedding: [0.1],
        drive_modified_at: "2024-01-01T00:00:00Z",
        mime_type: "application/pdf",
      },
    ];

    await upsertDriveFileIndex(supabase, rows);

    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("request not called");
    }
    const [url, init] = firstCall;
    expect(url).toBe("/rest/v1/drive_file_index");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Prefer: "resolution=merge-duplicates",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual(rows);
  });

  it("fetchDriveFileIndexByIds は存在する ID のみ返す", async () => {
    const existing = {
      file_id: "x",
      file_name: "keep",
      summary: "ok",
      keywords: ["a"],
      drive_modified_at: "2024-02-02T00:00:00Z",
      mime_type: "text/plain",
    };

    const request = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async () => new Response(JSON.stringify([existing]), { status: 200 }),
    );
    const supabase = { request } as unknown as SupabaseClient;

    const results = await fetchDriveFileIndexByIds(supabase, ["x", "missing"]);

    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("request not called");
    }
    const [url] = firstCall;
    const params = new URL(url, "https://example.com").searchParams;
    expect(params.get("select")).toBe("*");
    expect(params.get("file_id")).toMatch(/in\./);

    expect(results).toEqual([
      {
        ...existing,
        keywords: existing.keywords ?? null,
      },
    ]);
  });

  it("vectorSearchDriveFileIndex が probes と limit を渡し、コサイン距離昇順で filterFileIds を適用する", async () => {
    const supabaseResponse = [
      {
        file_id: "b",
        file_name: "b",
        summary: "b",
        keywords: null,
        drive_modified_at: "2024-03-03T00:00:00Z",
        mime_type: "application/pdf",
        distance: 0.05,
      },
      {
        file_id: "a",
        file_name: "a",
        summary: "a",
        keywords: null,
        drive_modified_at: "2024-03-03T00:00:00Z",
        mime_type: "application/pdf",
        distance: 0.1,
      },
      {
        file_id: "c",
        file_name: "c",
        summary: "c",
        keywords: null,
        drive_modified_at: "2024-03-03T00:00:00Z",
        mime_type: "application/pdf",
        distance: 0.2,
      },
    ];

    const request = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async () => new Response(JSON.stringify(supabaseResponse), { status: 200 }),
    );
    const supabase = { request } as unknown as SupabaseClient;

    const results = await vectorSearchDriveFileIndex(supabase, [0.01, 0.02], {
      limit: 2,
      probes: 10,
      filterFileIds: ["a", "c"],
    });

    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("request not called");
    }
    const [url, init] = firstCall;
    expect(url).toBe("/rest/v1/rpc/match_drive_file_index");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.match_count).toBe(2);
    expect(body.probes).toBe(10);
    expect(body.filter_file_ids).toEqual(["a", "c"]);
    expect(body.filter_after).toBeNull();
    expect(body.filter_before).toBeNull();
    expect(body.filter_mime).toBeNull();

    expect(results.map((row) => row.file_id)).toEqual(["a", "c"]);
    expect(results.every((row) => ["a", "c"].includes(row.file_id))).toBe(true);
  });
});
