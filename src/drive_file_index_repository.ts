import type { SupabaseClient } from "./clients.ts";

export type DriveFileIndexUpsertRow = {
  file_id: string;
  file_name: string;
  summary: string;
  keywords?: string[] | null;
  embedding: number[];
  drive_modified_at: string;
  mime_type: string;
};

export type DriveFileIndexRow = {
  file_id: string;
  file_name: string;
  summary: string;
  keywords: string[] | null;
  embedding?: number[];
  drive_modified_at: string;
  mime_type: string;
  /**
   * Cosine distance. Smaller is more similar.
   */
  distance?: number;
  /**
   * Similarity score (higher is more similar). Kept for compatibility with Supabase examples.
   */
  similarity?: number;
};

export type VectorSearchOptions = {
  limit?: number;
  probes?: number;
  filterFileIds?: string[];
};

const DEFAULT_VECTOR_LIMIT = 20;
const DEFAULT_VECTOR_PROBES = 10;

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as unknown;
  return data as T;
};

const buildInFilter = (values: string[]): string =>
  `in.(${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(",")})`;

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

const orderingScore = (row: DriveFileIndexRow): number => {
  if (typeof row.distance === "number") return row.distance;
  if (typeof row.similarity === "number") return -row.similarity;
  return Number.POSITIVE_INFINITY;
};

export const upsertDriveFileIndex = async (
  supabase: SupabaseClient,
  rows: DriveFileIndexUpsertRow[],
): Promise<void> => {
  if (rows.length === 0) return;

  const response = await supabase.request("/rest/v1/drive_file_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });

  await ensureOk(response);
};

export const fetchDriveFileIndexByIds = async (
  supabase: SupabaseClient,
  ids: string[],
): Promise<DriveFileIndexRow[]> => {
  if (ids.length === 0) return [];

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("file_id", buildInFilter(ids));

  const response = await supabase.request(`/rest/v1/drive_file_index?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  await ensureOk(response);
  return parseJson<DriveFileIndexRow[]>(response);
};

export const vectorSearchDriveFileIndex = async (
  supabase: SupabaseClient,
  queryEmbedding: number[],
  options: VectorSearchOptions = {},
): Promise<DriveFileIndexRow[]> => {
  const limit = options.limit ?? DEFAULT_VECTOR_LIMIT;
  const probes = options.probes ?? DEFAULT_VECTOR_PROBES;

  const response = await supabase.request("/rest/v1/rpc/match_drive_file_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: limit,
      probes,
      filter_file_ids:
        options.filterFileIds && options.filterFileIds.length > 0 ? options.filterFileIds : null,
    }),
  });

  await ensureOk(response);
  const rows = await parseJson<DriveFileIndexRow[]>(response);

  const filtered =
    options.filterFileIds && options.filterFileIds.length > 0
      ? rows.filter((row) => options.filterFileIds?.includes(row.file_id))
      : rows;

  const sorted = [...filtered].sort((a, b) => orderingScore(a) - orderingScore(b));
  return sorted.slice(0, limit);
};
