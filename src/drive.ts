import type { GoogleDriveClient, GoogleDriveFilesListParams, SupabaseClient } from "./clients.ts";
import { type DriveSyncStateRow, getDriveSyncState } from "./drive_sync_state_repository.ts";
import { isRetryableStatus } from "./http.ts";
import type { Logger } from "./logger.ts";

export type CrawlMode = "auto" | "full" | "diff";

export type DriveFileEntry = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
};

type FilesListResponse = {
  files?: DriveFileEntry[];
  nextPageToken?: string;
};

type ListDriveFilesPagedOptions = {
  driveClient: GoogleDriveClient;
  supabaseClient: SupabaseClient;
  mode?: CrawlMode;
  pageSize?: number;
  logger?: Logger;
  fields?: string;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_FIELDS = "files(id,name,mimeType,modifiedTime),nextPageToken";
const DEFAULT_ORDER = "modifiedTime asc";
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ensureOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let detail = "";
  try {
    const body = await response.text();
    detail = body ? ` body=${body}` : "";
  } catch {
    // ignore parse errors
  }

  throw new Error(
    `Google Drive request failed: ${response.status} ${response.statusText}${detail}`,
  );
};

const parseListResponse = async (response: Response): Promise<FilesListResponse> => {
  const data = (await response.json()) as unknown;
  return data as FilesListResponse;
};

const listWithBackoff = async (
  driveClient: GoogleDriveClient,
  params: GoogleDriveFilesListParams,
  logger?: Logger,
): Promise<Response> => {
  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    const response = await driveClient.files.list(params);

    if (response.ok) {
      return response;
    }

    if (!isRetryableStatus(response.status)) {
      await ensureOk(response); // throws
    }

    if (attempt >= DEFAULT_MAX_RETRIES) {
      await ensureOk(response); // throws after including response body when available
    }

    const delayMs = DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1);
    logger?.debug("http retry", { attempt, status: response.status, delayMs });
    await sleep(delayMs);
  }

  throw new Error("Drive files.list retry attempts exhausted unexpectedly");
};

const resolveMode = async (
  mode: CrawlMode,
  supabase: SupabaseClient,
  logger?: Logger,
): Promise<{ effectiveMode: CrawlMode; syncState: DriveSyncStateRow | null }> => {
  const syncState = await getDriveSyncState(supabase);

  if (mode === "full") {
    return { effectiveMode: "full", syncState };
  }

  if (mode === "diff") {
    if (!syncState) {
      logger?.info("drive_sync_state is empty; falling back to full crawl");
      return { effectiveMode: "full", syncState: null };
    }
    return { effectiveMode: "diff", syncState };
  }

  // mode === "auto"
  if (!syncState) {
    logger?.debug("drive_sync_state not found; running full crawl (auto mode)");
    return { effectiveMode: "full", syncState: null };
  }

  return { effectiveMode: "diff", syncState };
};

const buildModifiedTimeFilter = (
  mode: CrawlMode,
  syncState: DriveSyncStateRow | null,
): string | undefined => {
  if (mode !== "diff") return undefined;
  if (!syncState?.drive_modified_at) return undefined;

  return `modifiedTime > '${syncState.drive_modified_at}'`;
};

const buildListParams = (
  q: string | undefined,
  pageSize: number,
  pageToken: string | undefined,
  fields: string,
): GoogleDriveFilesListParams => ({
  q,
  pageSize,
  pageToken,
  fields,
  orderBy: DEFAULT_ORDER,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
});

/**
 * Drive API files.list をページングし、フル／差分クロールの判定を行う骨格実装。
 * 返却される配列は files.list から得た各ページの files を連結したもの。
 */
export const listDriveFilesPaged = async (
  options: ListDriveFilesPagedOptions,
): Promise<DriveFileEntry[]> => {
  const {
    driveClient,
    supabaseClient,
    mode = "auto",
    pageSize = DEFAULT_PAGE_SIZE,
    logger,
    fields = DEFAULT_FIELDS,
  } = options;

  const effectiveLogger = logger ?? driveClient.logger;

  const { effectiveMode, syncState } = await resolveMode(mode, supabaseClient, logger);
  const modifiedFilter = buildModifiedTimeFilter(effectiveMode, syncState);

  const aggregated: DriveFileEntry[] = [];
  let pageToken: string | undefined;

  do {
    const params = buildListParams(modifiedFilter, pageSize, pageToken, fields);
    const response = await listWithBackoff(driveClient, params, effectiveLogger);

    await ensureOk(response);
    const parsed = await parseListResponse(response);

    if (parsed.files && parsed.files.length > 0) {
      aggregated.push(...parsed.files);
    }

    pageToken = parsed.nextPageToken ?? undefined;
  } while (pageToken);

  return aggregated;
};
