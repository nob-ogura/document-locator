import type { GoogleDriveClient, GoogleDriveFilesListParams, SupabaseClient } from "./clients.ts";
import { type DriveSyncStateRow, getDriveSyncState } from "./drive_sync_state_repository.ts";
import { isRetryableStatus } from "./http.ts";
import type { Logger } from "./logger.ts";
import { isAfter } from "./time.ts";

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
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

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
  parents?: string[],
): GoogleDriveFilesListParams => ({
  q,
  pageSize,
  pageToken,
  fields,
  parents,
  orderBy: DEFAULT_ORDER,
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
});

const filterBySyncState = (
  files: DriveFileEntry[],
  effectiveMode: CrawlMode,
  syncState: DriveSyncStateRow | null,
): DriveFileEntry[] => {
  if (effectiveMode !== "diff" || !syncState?.drive_modified_at) return files;

  return files.filter((file) => {
    if (!file.modifiedTime) return true;
    return isAfter(file.modifiedTime, syncState.drive_modified_at);
  });
};

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
  const folderQueue = [...driveClient.targetFolderIds];
  const visitedFolders = new Set(folderQueue);

  while (folderQueue.length > 0) {
    const currentFolderId = folderQueue.shift();
    if (!currentFolderId) continue;

    let pageToken: string | undefined;

    do {
      const params = buildListParams(modifiedFilter, pageSize, pageToken, fields, [
        currentFolderId,
      ]);
      const response = await listWithBackoff(driveClient, params, effectiveLogger);

      await ensureOk(response);
      const parsed = await parseListResponse(response);
      const files = parsed.files ?? [];

      for (const file of files) {
        if (file.mimeType === FOLDER_MIME_TYPE && file.id && !visitedFolders.has(file.id)) {
          visitedFolders.add(file.id);
          folderQueue.push(file.id);
        }
      }

      const filtered = filterBySyncState(files, effectiveMode, syncState);
      if (filtered.length > 0) {
        aggregated.push(...filtered);
      }

      pageToken = parsed.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return aggregated;
};
