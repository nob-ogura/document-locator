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

const createRetrier =
  (logger: Logger, retrier: Retrier, fetchImpl?: FetchLike) =>
  (input: RequestInfo, options: BaseRequestInit = {}) =>
    retrier(input, { ...options, ...(fetchImpl ? { fetch: fetchImpl } : {}), logger });

export type GoogleDriveRequestInit = BaseRequestInit & { accessToken?: string };

export type GoogleDriveClient = {
  logger: Logger;
  targetFolderIds: string[];
  credentials: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  request: (input: RequestInfo, init?: GoogleDriveRequestInit) => Promise<Response>;
};

export const createGoogleDriveClient = (
  config: AppConfig,
  deps: ClientDeps = {},
): GoogleDriveClient => {
  const logger = ensureLogger(config, deps.logger);
  const retryRequest = createRetrier(logger, deps.fetchWithRetry ?? fetchWithRetry, deps.fetch);

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

  return {
    logger,
    targetFolderIds: config.googleDriveTargetFolderIds,
    credentials: {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      refreshToken: config.googleRefreshToken,
    },
    request,
  };
};

export type OpenAIClient = {
  logger: Logger;
  apiKey: string;
  organization?: string;
  request: (input: RequestInfo, init?: BaseRequestInit) => Promise<Response>;
};

export const createOpenAIClient = (config: AppConfig, deps: ClientDeps = {}): OpenAIClient => {
  const logger = ensureLogger(config, deps.logger);
  const retryRequest = createRetrier(logger, deps.fetchWithRetry ?? fetchWithRetry, deps.fetch);

  const request: OpenAIClient["request"] = (input, init = {}) => {
    const { headers, ...rest } = init;
    const mergedHeaders = headersToObject(headers);

    if (!mergedHeaders.Authorization) {
      mergedHeaders.Authorization = `Bearer ${config.openaiApiKey}`;
    }

    if (config.openaiOrg && !mergedHeaders["OpenAI-Organization"]) {
      mergedHeaders["OpenAI-Organization"] = config.openaiOrg;
    }

    return retryRequest(toAbsoluteUrl("https://api.openai.com", input), {
      ...rest,
      headers: mergedHeaders,
    });
  };

  return {
    logger,
    apiKey: config.openaiApiKey,
    organization: config.openaiOrg,
    request,
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
