import type { SupabaseClient } from "../../src/clients.ts";
import type { DriveFileEntry } from "../../src/drive.ts";
import type {
  DriveFileIndexRow,
  DriveFileIndexUpsertRow,
} from "../../src/drive_file_index_repository.ts";
import { createTestLogger } from "./logger.ts";

const headers = { "Content-Type": "application/json" };

export const buildIndexRows = (
  files: DriveFileEntry[],
  defaults: {
    summary?: string;
    keywords?: string[];
    driveModifiedAt?: string;
    mimeType?: string;
  } = {},
): DriveFileIndexRow[] =>
  files.map((file) => ({
    file_id: file.id ?? "",
    file_name: file.name ?? "",
    summary: defaults.summary ?? "summary from fixture",
    keywords: defaults.keywords ?? ["alpha", "beta"],
    drive_modified_at: defaults.driveModifiedAt ?? file.modifiedTime ?? "2024-10-10T00:00:00Z",
    mime_type: defaults.mimeType ?? file.mimeType ?? "application/pdf",
  }));

export const createSupabaseIndexMock = (initialSync?: string | null) => {
  const logger = createTestLogger();
  let driveModifiedAt: string | null = initialSync ?? null;
  const upserts: DriveFileIndexUpsertRow[] = [];

  const request: SupabaseClient["request"] = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init.method ?? "GET").toUpperCase();

    if (url.startsWith("/rest/v1/drive_sync_state")) {
      if (method === "GET") {
        const rows = driveModifiedAt ? [{ id: "global", drive_modified_at: driveModifiedAt }] : [];
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers,
        });
      }

      if (method === "POST") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        driveModifiedAt = body?.drive_modified_at ?? null;
        const rows = [{ id: "global", drive_modified_at: driveModifiedAt }];

        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { ...headers, "content-range": "0-0/1" },
        });
      }
    }

    if (url.startsWith("/rest/v1/drive_file_index") && method === "POST") {
      const rows = typeof init.body === "string" ? JSON.parse(init.body) : [];
      upserts.push(...rows);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers,
      });
    }

    return new Response("not implemented", { status: 500 });
  };

  const supabase: SupabaseClient = {
    logger,
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request,
  };

  return {
    supabase,
    upserts,
    getSyncState: () => driveModifiedAt,
    logger,
  };
};

const extractIds = (filter: string): string[] => {
  const match = filter.match(/in\.\((.+)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.replace(/"/g, "").trim())
    .filter((value) => value.length > 0);
};

export const createSupabaseSearchMock = (options: {
  rows: DriveFileIndexRow[];
  vectorResults?: DriveFileIndexRow[];
  onMatchRequest?: (body: Record<string, unknown>) => void;
}) => {
  const logger = createTestLogger();
  const requests = { index: [] as string[], match: [] as Record<string, unknown>[] };
  const vectorRows = options.vectorResults ?? [];

  const request: SupabaseClient["request"] = async (input, init = {}) => {
    const url = typeof input === "string" ? input : "";

    if (url.includes("match_drive_file_index")) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? {});
      requests.match.push(body as Record<string, unknown>);
      options.onMatchRequest?.(body as Record<string, unknown>);

      const matchCount = Number.isInteger(body.match_count) ? Number(body.match_count) : null;

      const results =
        vectorRows.length > 0
          ? vectorRows.map((row, index) => ({
              ...row,
              distance: row.distance ?? (index + 1) / 100,
            }))
          : options.rows.map((row, index) => ({
              ...row,
              distance: (index + 1) / 100,
            }));

      const limited = matchCount && matchCount > 0 ? results.slice(0, matchCount) : results;

      return new Response(JSON.stringify(limited), {
        status: 200,
        headers,
      });
    }

    if (url.includes("drive_file_index")) {
      const params = new URL(url, "https://example.supabase.co").searchParams;
      const filter = params.get("file_id");
      const ids = filter ? extractIds(filter) : null;
      const filtered =
        ids && ids.length > 0
          ? options.rows.filter((row) => ids.includes(row.file_id))
          : options.rows;

      requests.index.push(filter ?? "all");

      return new Response(JSON.stringify(filtered), {
        status: 200,
        headers,
      });
    }

    return new Response("[]", { status: 200, headers });
  };

  const supabase: SupabaseClient = {
    logger,
    credentials: { url: "mock://supabase", serviceRoleKey: "mock" },
    request,
  };

  return { supabase, logger, requests };
};
