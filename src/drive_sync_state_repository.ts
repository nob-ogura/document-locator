import type { SupabaseClient } from "./clients.js";

export type DriveSyncStateRow = {
  id: string;
  drive_modified_at: string;
};

const GLOBAL_ID = "global";

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as unknown;
  return data as T;
};

const ensureOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let detail = "";
  try {
    const body = await response.text();
    detail = body ? ` body=${body}` : "";
  } catch {
    // ignore parse errors
  }

  throw new Error(`Supabase request failed: ${response.status} ${response.statusText}${detail}`);
};

const parseContentRangeCount = (contentRange: string | null): number | null => {
  if (!contentRange) return null;

  const match = /\/(\d+)$/.exec(contentRange);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export const getDriveSyncState = async (
  supabase: SupabaseClient,
): Promise<DriveSyncStateRow | null> => {
  const params = new URLSearchParams();
  params.set("select", "id,drive_modified_at");
  params.set("limit", "1");

  const response = await supabase.request(`/rest/v1/drive_sync_state?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  await ensureOk(response);
  const rows = await parseJson<DriveSyncStateRow[]>(response);
  return rows[0] ?? null;
};

export const upsertDriveSyncState = async (
  supabase: SupabaseClient,
  driveModifiedAt: string,
): Promise<number> => {
  const response = await supabase.request("/rest/v1/drive_sync_state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation,count=exact",
    },
    body: JSON.stringify({ id: GLOBAL_ID, drive_modified_at: driveModifiedAt }),
  });

  await ensureOk(response);

  const rangeCount = parseContentRangeCount(response.headers.get("content-range"));
  if (rangeCount !== null) {
    return rangeCount;
  }

  try {
    const rows = await parseJson<DriveSyncStateRow[]>(response);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    // Treat parse failures as zero affected rows rather than throwing.
    return 0;
  }
};
