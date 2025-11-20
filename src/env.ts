import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LogLevel } from "./logger.js";

export type AppConfig = {
  crawlerMode: string;
  searchMaxLoopCount: number;
  summaryMaxLength: number;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleDriveTargetFolderIds: string[];
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey: string;
  openaiOrg?: string;
  logLevel: LogLevel;
  tz?: string;
};

const DEFAULT_LOG_LEVEL: LogLevel = "info";

const REQUIRED_KEYS: ReadonlyArray<keyof NodeJS.ProcessEnv> = [
  "CRAWLER_MODE",
  "SEARCH_MAX_LOOP_COUNT",
  "SUMMARY_MAX_LENGTH",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_TARGET_FOLDER_IDS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
];

const LOG_LEVELS: LogLevel[] = ["info", "debug", "error"];

const loadDotEnvFile = (): Record<string, string> => {
  try {
    const filePath = resolve(process.cwd(), ".env");
    const raw = readFileSync(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .reduce<Record<string, string>>((acc, line) => {
        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) {
          return acc;
        }

        const key = line.slice(0, equalsIndex).trim();
        const value = line.slice(equalsIndex + 1).trim();
        if (key) acc[key] = value;
        return acc;
      }, {});
  } catch {
    return {};
  }
};

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fromFile = loadDotEnvFile();
  const merged: Record<string, string | undefined> = {
    ...fromFile,
    ...env,
  };

  const missing = REQUIRED_KEYS.filter((key) => !merged[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const mergedEnv = merged as Record<(typeof REQUIRED_KEYS)[number], string> & {
    OPENAI_ORG?: string;
    LOG_LEVEL?: string;
    TZ?: string;
  };

  const searchMaxLoopCount = Number.parseInt(mergedEnv.SEARCH_MAX_LOOP_COUNT, 10);
  const summaryMaxLength = Number.parseInt(mergedEnv.SUMMARY_MAX_LENGTH, 10);

  if (!Number.isFinite(searchMaxLoopCount) || searchMaxLoopCount <= 0) {
    throw new Error("SEARCH_MAX_LOOP_COUNT must be a positive integer");
  }

  if (!Number.isFinite(summaryMaxLength) || summaryMaxLength <= 0) {
    throw new Error("SUMMARY_MAX_LENGTH must be a positive integer");
  }

  const logLevel = (mergedEnv.LOG_LEVEL ?? DEFAULT_LOG_LEVEL).toLowerCase();
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  const targetIds = mergedEnv.GOOGLE_DRIVE_TARGET_FOLDER_IDS.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (targetIds.length === 0) {
    throw new Error("GOOGLE_DRIVE_TARGET_FOLDER_IDS must contain at least one id");
  }

  return {
    crawlerMode: mergedEnv.CRAWLER_MODE,
    searchMaxLoopCount,
    summaryMaxLength,
    googleClientId: mergedEnv.GOOGLE_CLIENT_ID,
    googleClientSecret: mergedEnv.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: mergedEnv.GOOGLE_REFRESH_TOKEN,
    googleDriveTargetFolderIds: targetIds,
    supabaseUrl: mergedEnv.SUPABASE_URL,
    supabaseServiceRoleKey: mergedEnv.SUPABASE_SERVICE_ROLE_KEY,
    openaiApiKey: mergedEnv.OPENAI_API_KEY,
    openaiOrg: mergedEnv.OPENAI_ORG,
    logLevel: logLevel as LogLevel,
    tz: mergedEnv.TZ,
  };
}
