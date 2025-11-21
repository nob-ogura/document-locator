import type { AppConfig } from "./env.js";
import { type FetchWithRetryOptions, fetchWithRetry } from "./http.js";
import { createLogger, type Logger } from "./logger.js";

type RequestInfo = Parameters<typeof fetch>[0];
type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

type Retrier = (input: RequestInfo, options?: FetchWithRetryOptions) => Promise<Response>;

type ClientDeps = {
  logger?: Logger;
  fetchWithRetry?: Retrier;
  fetch?: FetchLike;
};

type BaseRequestInit = Omit<FetchWithRetryOptions, "logger" | "fetch">;

// Non-nullable headers type aligned with `RequestInit`.
type HeadersInit = NonNullable<RequestInit["headers"]>;

const ensureLogger = (config: AppConfig, logger?: Logger): Logger =>
  logger ?? createLogger(config.logLevel);

const toAbsoluteUrl = (base: string, input: RequestInfo): RequestInfo => {
  if (typeof input !== "string") return input;
  if (/^https?:\/\//i.test(input)) return input;

  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = input.startsWith("/") ? input.slice(1) : input;
  return new URL(normalizedPath, normalizedBase).toString();
};

const normalizeHeaderValue = (value: unknown): string =>
  Array.isArray(value) ? value.join(", ") : String(value);

const headersToObject = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) return {};

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, normalizeHeaderValue(value)]));
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, normalizeHeaderValue(value)]),
  );
};

const mergeHeaders = (...headersList: HeadersInit[]): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const headers of headersList) {
    Object.assign(merged, headersToObject(headers));
  }
  return merged;
};

const createRetrier =
  (logger: Logger, retrier: Retrier, fetchImpl?: FetchLike) =>
  (input: RequestInfo, options: BaseRequestInit = {}) =>
    retrier(input, { ...options, ...(fetchImpl ? { fetch: fetchImpl } : {}), logger });

export type GoogleDriveRequestInit = BaseRequestInit & { accessToken?: string };

export type GoogleDriveFilesListParams = {
  accessToken?: string;
  q?: string;
  fields?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  spaces?: string;
  corpora?: string;
  includeItemsFromAllDrives?: boolean;
  supportsAllDrives?: boolean;
};

export type GoogleDriveFilesExportParams = {
  accessToken?: string;
};

export type GoogleDriveFilesGetParams = {
  accessToken?: string;
  alt?: string;
};

type GoogleDriveAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

type GoogleDriveFolderMetadata = {
  id?: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
};

export type GoogleDriveClient = {
  logger: Logger;
  targetFolderIds: string[];
  credentials: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  request: (input: RequestInfo, init?: GoogleDriveRequestInit) => Promise<Response>;
  auth: {
    fetchAccessToken: () => Promise<string>;
  };
  folders: {
    ensureTargetsExist: () => Promise<void>;
  };
  files: {
    list: (params?: GoogleDriveFilesListParams, init?: GoogleDriveRequestInit) => Promise<Response>;
    export: (
      fileId: string,
      mimeType: string,
      params?: GoogleDriveFilesExportParams,
      init?: GoogleDriveRequestInit,
    ) => Promise<Response>;
    get: (
      fileId: string,
      params?: GoogleDriveFilesGetParams,
      init?: GoogleDriveRequestInit,
    ) => Promise<Response>;
  };
};

export const createGoogleDriveClient = (
  config: AppConfig,
  deps: ClientDeps = {},
): GoogleDriveClient => {
  const logger = ensureLogger(config, deps.logger);
  const retryRequest = createRetrier(logger, deps.fetchWithRetry ?? fetchWithRetry, deps.fetch);

  const fetchAccessToken: GoogleDriveClient["auth"]["fetchAccessToken"] = async () => {
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.googleRefreshToken,
      grant_type: "refresh_token",
    });

    const response = await retryRequest("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh Google access token: HTTP ${response.status}`);
    }

    let parsed: GoogleDriveAccessTokenResponse;
    try {
      parsed = (await response.json()) as GoogleDriveAccessTokenResponse;
    } catch (error) {
      throw new Error(`Failed to parse Google access token response: ${String(error)}`);
    }

    if (!parsed.access_token) {
      throw new Error("Google access token is missing in the response");
    }

    logger.debug("google drive: refreshed access token");
    return parsed.access_token;
  };

  const request: GoogleDriveClient["request"] = (input, init = {}) => {
    const { accessToken, headers, ...rest } = init;
    const mergedHeaders = headersToObject(headers);

    if (accessToken && !mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${accessToken}`;
    }

    return retryRequest(toAbsoluteUrl("https://www.googleapis.com", input), {
      ...rest,
      headers: mergedHeaders,
    });
  };

  const buildFolderScope = (): string =>
    config.googleDriveTargetFolderIds.map((id) => `'${id}' in parents`).join(" or ");

  const toScopedQuery = (userQuery?: string): string => {
    const folderScope = buildFolderScope();
    if (!userQuery || userQuery.trim() === "") {
      return `(${folderScope})`;
    }
    return `(${folderScope}) and (${userQuery})`;
  };

  const buildFilesListUrl = (params: Omit<GoogleDriveFilesListParams, "accessToken"> = {}) => {
    const searchParams = new URLSearchParams();
    searchParams.set("q", toScopedQuery(params.q));

    if (params.fields) searchParams.set("fields", params.fields);
    if (params.pageSize !== undefined) searchParams.set("pageSize", String(params.pageSize));
    if (params.pageToken) searchParams.set("pageToken", params.pageToken);
    if (params.orderBy) searchParams.set("orderBy", params.orderBy);
    if (params.spaces) searchParams.set("spaces", params.spaces);
    if (params.corpora) searchParams.set("corpora", params.corpora);
    if (params.includeItemsFromAllDrives !== undefined) {
      searchParams.set("includeItemsFromAllDrives", String(params.includeItemsFromAllDrives));
    }
    if (params.supportsAllDrives !== undefined) {
      searchParams.set("supportsAllDrives", String(params.supportsAllDrives));
    }

    return `/drive/v3/files?${searchParams.toString()}`;
  };

  const buildFilesExportUrl = (fileId: string, mimeType: string) => {
    const encodedId = encodeURIComponent(fileId);
    const params = new URLSearchParams({ mimeType });
    return `/drive/v3/files/${encodedId}/export?${params.toString()}`;
  };

  const buildFilesGetUrl = (fileId: string, alt?: string) => {
    const encodedId = encodeURIComponent(fileId);
    const params = new URLSearchParams();
    if (alt) params.set("alt", alt);
    const query = params.toString();
    return query ? `/drive/v3/files/${encodedId}?${query}` : `/drive/v3/files/${encodedId}`;
  };

  const ensureFolderExists = async (folderId: string, accessToken: string): Promise<void> => {
    const encodedId = encodeURIComponent(folderId);
    const url = `/drive/v3/files/${encodedId}?fields=id,name,mimeType,trashed`;
    const response = await request(url, { accessToken });

    if (response.status === 404) {
      throw new Error(`Target folder not found: ${folderId}`);
    }

    if (!response.ok) {
      throw new Error(`Failed to load folder ${folderId}: HTTP ${response.status}`);
    }

    const metadata = (await response.json()) as GoogleDriveFolderMetadata;
    const isFolder = metadata.mimeType === "application/vnd.google-apps.folder";
    const isTrashed = metadata.trashed === true;

    if (!isFolder || isTrashed) {
      throw new Error(`Target folder is not available: ${folderId}`);
    }
  };

  const folders: GoogleDriveClient["folders"] = {
    ensureTargetsExist: async () => {
      const accessToken = await fetchAccessToken();

      for (const id of config.googleDriveTargetFolderIds) {
        await ensureFolderExists(id, accessToken);
      }
    },
  };

  const files: GoogleDriveClient["files"] = {
    list: async (params = {}, init = {}) => {
      const { accessToken: providedToken, ...rest } = params;
      const accessToken = providedToken ?? (await fetchAccessToken());
      const url = buildFilesListUrl(rest);
      return request(url, { ...init, accessToken });
    },
    export: async (fileId, mimeType, params = {}, init = {}) => {
      const { accessToken: providedToken } = params;
      const accessToken = providedToken ?? (await fetchAccessToken());
      const url = buildFilesExportUrl(fileId, mimeType);
      return request(url, { ...init, accessToken });
    },
    get: async (fileId, params = {}, init = {}) => {
      const { accessToken: providedToken, alt } = params;
      const accessToken = providedToken ?? (await fetchAccessToken());
      const url = buildFilesGetUrl(fileId, alt);
      return request(url, { ...init, accessToken });
    },
  };

  return {
    logger,
    targetFolderIds: config.googleDriveTargetFolderIds,
    credentials: {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      refreshToken: config.googleRefreshToken,
    },
    request,
    auth: {
      fetchAccessToken,
    },
    folders,
    files,
  };
};

export type OpenAIClient = {
  logger: Logger;
  apiKey: string;
  organization?: string;
  request: (input: RequestInfo, init?: BaseRequestInit) => Promise<Response>;
  chat: {
    completions: {
      create: (payload: OpenAIChatRequest, init?: BaseRequestInit) => Promise<OpenAIChatResponse>;
    };
  };
  embeddings: {
    create: (
      payload: OpenAIEmbeddingRequest,
      init?: BaseRequestInit,
    ) => Promise<OpenAIEmbeddingResponse>;
  };
};

export type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenAIChatRequest = {
  messages: OpenAIChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
};

export type OpenAIChatChoice = {
  index: number;
  message: OpenAIChatMessage & { refusal?: string | null };
  finish_reason?: string | null;
};

export type OpenAIChatResponse = {
  id?: string;
  choices: OpenAIChatChoice[];
  usage?: OpenAIUsage;
};

export type OpenAIEmbeddingRequest = {
  input: string | string[];
  model?: string;
};

export type OpenAIEmbeddingData = {
  index: number;
  embedding: number[];
  object?: string;
};

export type OpenAIEmbeddingResponse = {
  object?: string;
  data: OpenAIEmbeddingData[];
  model?: string;
  usage?: OpenAIUsage;
};

const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_CHAT_TEMPERATURE = 0;
const DEFAULT_CHAT_MAX_TOKENS = 200;
const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small";

const DEFAULT_OPENAI_RETRY: Pick<FetchWithRetryOptions, "maxRetries" | "baseDelayMs"> = {
  maxRetries: 5,
  baseDelayMs: 1000,
};

export const createOpenAIClient = (config: AppConfig, deps: ClientDeps = {}): OpenAIClient => {
  if (!config.openaiApiKey || config.openaiApiKey.trim() === "") {
    throw new Error("OPENAI_API_KEY is required to initialize OpenAI client");
  }

  const logger = ensureLogger(config, deps.logger);
  const retryRequest = createRetrier(logger, deps.fetchWithRetry ?? fetchWithRetry, deps.fetch);

  const request: OpenAIClient["request"] = (input, init = {}) => {
    const { headers, ...rest } = init;
    const mergedHeaders = mergeHeaders(headers ?? {});

    if (!mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${config.openaiApiKey}`;
    }

    if (config.openaiOrg && !mergedHeaders["OpenAI-Organization"]) {
      mergedHeaders["OpenAI-Organization"] = config.openaiOrg;
    }

    return retryRequest(toAbsoluteUrl("https://api.openai.com", input), {
      ...DEFAULT_OPENAI_RETRY,
      ...rest,
      headers: mergedHeaders,
    });
  };

  const logUsage = (endpoint: "chat" | "embeddings", model: string, usage?: OpenAIUsage) => {
    if (!usage) return;
    logger.debug("openai usage", {
      endpoint,
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    });
  };

  const parseJson = async <T>(response: Response, label: string): Promise<T> => {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`Failed to parse ${label}: ${String(error)}`);
    }
  };

  const createChatCompletion: OpenAIClient["chat"]["completions"]["create"] = async (
    payload,
    init = {},
  ) => {
    const body = {
      model: payload.model ?? DEFAULT_CHAT_MODEL,
      temperature: payload.temperature ?? DEFAULT_CHAT_TEMPERATURE,
      max_tokens: payload.max_tokens ?? DEFAULT_CHAT_MAX_TOKENS,
      messages: payload.messages,
    } satisfies OpenAIChatRequest;

    const { headers, ...rest } = init;
    const response = await request("/v1/chat/completions", {
      ...DEFAULT_OPENAI_RETRY,
      ...rest,
      method: "POST",
      headers: mergeHeaders({ "Content-Type": "application/json" }, headers ?? {}),
      body: JSON.stringify(body),
    });

    const parsed = await parseJson<OpenAIChatResponse>(response, "OpenAI chat response");
    logUsage("chat", body.model ?? DEFAULT_CHAT_MODEL, parsed.usage);
    return parsed;
  };

  const createEmbedding: OpenAIClient["embeddings"]["create"] = async (payload, init = {}) => {
    const body = {
      model: payload.model ?? DEFAULT_EMBEDDINGS_MODEL,
      input: payload.input,
    } satisfies OpenAIEmbeddingRequest;

    const { headers, ...rest } = init;
    const response = await request("/v1/embeddings", {
      ...DEFAULT_OPENAI_RETRY,
      ...rest,
      method: "POST",
      headers: mergeHeaders({ "Content-Type": "application/json" }, headers ?? {}),
      body: JSON.stringify(body),
    });

    const parsed = await parseJson<OpenAIEmbeddingResponse>(response, "OpenAI embeddings response");
    logUsage("embeddings", body.model ?? DEFAULT_EMBEDDINGS_MODEL, parsed.usage);
    return parsed;
  };

  return {
    logger,
    apiKey: config.openaiApiKey,
    organization: config.openaiOrg,
    request,
    chat: {
      completions: {
        create: createChatCompletion,
      },
    },
    embeddings: {
      create: createEmbedding,
    },
  };
};

export type SupabaseClient = {
  logger: Logger;
  credentials: {
    url: string;
    serviceRoleKey: string;
  };
  request: (input: RequestInfo, init?: BaseRequestInit) => Promise<Response>;
};

export const createSupabaseClient = (config: AppConfig, deps: ClientDeps = {}): SupabaseClient => {
  const logger = ensureLogger(config, deps.logger);
  const retryRequest = createRetrier(logger, deps.fetchWithRetry ?? fetchWithRetry, deps.fetch);

  const request: SupabaseClient["request"] = (input, init = {}) => {
    const { headers, ...rest } = init;
    const mergedHeaders = headersToObject(headers);

    if (!mergedHeaders.apikey) {
      mergedHeaders.apikey = config.supabaseServiceRoleKey;
    }

    if (!mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${config.supabaseServiceRoleKey}`;
    }

    return retryRequest(toAbsoluteUrl(config.supabaseUrl, input), {
      ...rest,
      headers: mergedHeaders,
    });
  };

  return {
    logger,
    credentials: {
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
    },
    request,
  };
};

export const createExternalClients = (
  config: AppConfig,
  deps: ClientDeps = {},
): {
  googleDrive: GoogleDriveClient;
  openai: OpenAIClient;
  supabase: SupabaseClient;
} => {
  const logger = ensureLogger(config, deps.logger);
  const sharedDeps: ClientDeps = {
    ...deps,
    logger,
  };

  return {
    googleDrive: createGoogleDriveClient(config, sharedDeps),
    openai: createOpenAIClient(config, sharedDeps),
    supabase: createSupabaseClient(config, sharedDeps),
  };
};
