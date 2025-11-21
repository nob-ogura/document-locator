import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "../src/clients.js";
import {
  type DriveSyncStateRow,
  getDriveSyncState,
  upsertDriveSyncState,
} from "../src/drive_sync_state_repository.js";

describe("drive_sync_state repository", () => {
  it("getDriveSyncState は未初期化時に null を返す", async () => {
    const request = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    const supabase = { request } as unknown as SupabaseClient;

    const result = await getDriveSyncState(supabase);

    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("request not called");
    }
    const [url] = firstCall;
    const params = new URL(url, "https://example.com").searchParams;
    expect(params.get("select")).toBe("id,drive_modified_at");
    expect(params.get("limit")).toBe("1");
    expect(result).toBeNull();
  });

  it("upsertDriveSyncState が drive_modified_at を保存し件数を返す", async () => {
    const row: DriveSyncStateRow = { id: "global", drive_modified_at: "2024-09-01T10:00:00Z" };
    const request = vi.fn<NonNullable<SupabaseClient["request"]>>(
      async () =>
        new Response(JSON.stringify([row]), {
          status: 201,
          headers: { "Content-Range": "0-0/1" },
        }),
    );
    const supabase = { request } as unknown as SupabaseClient;

    const updated = await upsertDriveSyncState(supabase, row.drive_modified_at);

    expect(updated).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    const firstCall = request.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("request not called");
    }
    const [url, init] = firstCall;
    expect(url).toBe("/rest/v1/drive_sync_state");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation,count=exact",
    });
    expect(JSON.parse(init?.body as string)).toEqual(row);
  });
});
