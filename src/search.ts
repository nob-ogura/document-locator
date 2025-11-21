import type { GoogleDriveClient, OpenAIClient } from "./clients.ts";
import { createGoogleDriveClient } from "./clients.ts";
import type { DriveFileEntry } from "./drive.ts";
import type { AppConfig } from "./env.ts";
import { createLogger, type Logger } from "./logger.ts";
import { extractKeywords } from "./openai.ts";
import { resolveOpenAIClient } from "./openai-provider.ts";

export type SearchFilters = {
  after?: string;
  before?: string;
  mime?: string;
};

export type SearchRequest = {
  query: string;
  filters: SearchFilters;
  searchMaxLoopCount: number;
};

export type InitialSearchDeps = {
  googleDrive?: GoogleDriveClient;
  openai?: Pick<OpenAIClient, "chat">;
  logger?: Logger;
};

export type InitialDriveSearchResult = {
  keywords: string[];
  driveQuery: string;
  files: DriveFileEntry[];
};

type FilesListResponse = {
  files?: DriveFileEntry[];
  nextPageToken?: string;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_FIELDS = "files(id,name,mimeType,modifiedTime),nextPageToken";

const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "\\'");

const normalizeKeywords = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const toDateBoundary = (date: string, endOfDay: boolean): string => {
  const suffix = endOfDay ? "T23:59:59Z" : "T00:00:00Z";
  return `${date}${suffix}`;
};

const buildFolderScope = (folderIds: string[]): string | null => {
  const scopes = folderIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => `'${escapeSingleQuotes(id)}' in parents`);

  if (scopes.length === 0) return null;
  return scopes.join(" or ");
};

const scopeQueryToFolders = (query: string, folderIds: string[]): string => {
  const folderScope = buildFolderScope(folderIds);
  if (!folderScope) return query;
  if (!query || query.trim() === "") {
    return `(${folderScope})`;
  }
  return `(${folderScope}) and (${query})`;
};

export const buildDriveSearchQuery = (options: {
  query: string;
  keywords: string[];
  filters: SearchFilters;
}): string => {
  const { query, keywords, filters } = options;
  const conditions: string[] = [];

  if (filters.after) {
    conditions.push(`modifiedTime >= '${toDateBoundary(filters.after, false)}'`);
  }

  if (filters.before) {
    conditions.push(`modifiedTime <= '${toDateBoundary(filters.before, true)}'`);
  }

  if (filters.mime) {
    conditions.push(`mimeType='${escapeSingleQuotes(filters.mime)}'`);
  }

  conditions.push("trashed = false");

  const terms = keywords.length > 0 ? keywords : [query];
  for (const term of terms) {
    const sanitized = escapeSingleQuotes(term.trim());
    if (sanitized.length === 0) continue;
    conditions.push(`fullText contains '${sanitized}'`);
  }

  return conditions.join(" and ");
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

  throw new Error(
    `Google Drive request failed: ${response.status} ${response.statusText}${detail}`,
  );
};

const parseListResponse = async (response: Response): Promise<FilesListResponse> => {
  const data = (await response.json()) as unknown;
  return data as FilesListResponse;
};

const listDriveSearchResults = async (
  driveClient: GoogleDriveClient,
  query: string,
  logger?: Logger,
): Promise<DriveFileEntry[]> => {
  const files: DriveFileEntry[] = [];
  let pageToken: string | undefined;

  do {
    const response = await driveClient.files.list({
      q: query,
      pageSize: DEFAULT_PAGE_SIZE,
      pageToken,
      fields: DEFAULT_FIELDS,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    await ensureOk(response);
    const parsed = await parseListResponse(response);
    if (parsed.files && parsed.files.length > 0) {
      files.push(...parsed.files);
    }
    pageToken = parsed.nextPageToken ?? undefined;
  } while (pageToken);

  logger?.debug("drive search completed", { query, files: files.length });
  return files;
};

export const runInitialDriveSearch = async (options: {
  config: AppConfig;
  request: SearchRequest;
  deps?: InitialSearchDeps;
}): Promise<InitialDriveSearchResult> => {
  const { config, request } = options;
  const logger = options.deps?.logger ?? createLogger(config.logLevel);

  const defaultGoogleDrive =
    options.deps?.googleDrive ??
    createGoogleDriveClient(config, {
      logger,
    });

  const defaultOpenAI = options.deps?.openai
    ? { openai: options.deps.openai, mode: "injected" }
    : resolveOpenAIClient(config, { logger });

  const googleDrive = options.deps?.googleDrive ?? defaultGoogleDrive;
  const openai = options.deps?.openai ?? defaultOpenAI.openai;

  let extracted: string[] = [];

  try {
    extracted = await extractKeywords({
      openai,
      text: request.query,
      logger,
    });
    logger.info("search: keywords extracted", { count: extracted.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info("search: keyword extraction failed; falling back to raw query", { error: message });
  }

  const normalizedKeywords = normalizeKeywords(extracted);
  const driveQuery = buildDriveSearchQuery({
    query: request.query,
    keywords: normalizedKeywords,
    filters: request.filters,
  });

  const scopedQuery = scopeQueryToFolders(driveQuery, googleDrive.targetFolderIds);

  const files = await listDriveSearchResults(googleDrive, scopedQuery, logger);

  logger.info("search: initial drive search finished", {
    keywords: normalizedKeywords.length,
    driveQuery: scopedQuery,
    hits: files.length,
  });

  return {
    keywords: normalizedKeywords,
    driveQuery: scopedQuery,
    files,
  };
};
