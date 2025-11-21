import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import {
  buildEmbeddingInput,
  extractKeywords,
  generateEmbedding,
  summarizeText,
} from "../src/openai.js";
import { resolveOpenAIClient } from "../src/openai-provider.js";

type Argv = {
  envPath?: string;
};

const parseArgs = (argv: string[]): Argv => {
  const envFlagIndex = argv.indexOf("--env");
  if (envFlagIndex !== -1) {
    return { envPath: argv[envFlagIndex + 1] };
  }

  const envValue = argv.find((arg) => arg.startsWith("--env="));
  if (envValue) {
    const [, value] = envValue.split("=", 2);
    return { envPath: value };
  }

  return {};
};

const loadEnvFile = (envPath?: string): void => {
  const target = envPath ? resolve(envPath) : resolve(".env");
  loadDotenv({ path: target });
};

const toCsv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  const split = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return split.length > 0 ? split : fallback;
};

const toPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildConfig = (): AppConfig => {
  return {
    crawlerMode: "diff",
    searchMaxLoopCount: 1,
    summaryMaxLength: toPositiveInteger(process.env.SUMMARY_MAX_LENGTH, 400),
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "mock-client-id",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "mock-client-secret",
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "mock-refresh-token",
    googleDriveTargetFolderIds: toCsv(process.env.GOOGLE_DRIVE_TARGET_FOLDER_IDS, ["mock-folder"]),
    supabaseUrl: process.env.SUPABASE_URL ?? "https://example.supabase.co",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "mock-service-role-key",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiOrg: process.env.OPENAI_ORG,
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "debug",
    tz: process.env.TZ,
  } satisfies AppConfig;
};

const main = async (): Promise<void> => {
  const { envPath } = parseArgs(process.argv.slice(2));
  loadEnvFile(envPath);

  const config = buildConfig();
  const logger = createLogger(config.logLevel);

  const { openai, mode } = resolveOpenAIClient(config, { logger });
  logger.info("openai smoke start", { mode, envPath: envPath ?? ".env" });

  const sampleText =
    "Document Locator smoke test. This text should be summarized and used to generate keywords.";

  const summary = await summarizeText({
    openai,
    text: sampleText,
    summaryMaxLength: config.summaryMaxLength,
    logger,
  });
  logger.info("summarizeText finished", { length: summary.length, preview: summary.slice(0, 80) });

  const keywords = await extractKeywords({
    openai,
    text: sampleText,
    logger,
  });
  logger.info("extractKeywords finished", { keywords });

  const embeddingInput = buildEmbeddingInput({ summary, keywords, fileName: "smoke-openai.txt" });
  const embedding = await generateEmbedding({ openai, input: embeddingInput });
  logger.info("generateEmbedding finished", { dimensions: embedding.length });

  // Human readable output in addition to JSON logs
  console.log("\n==== OpenAI smoke completed ====");
  console.log(`mode: ${mode}`);
  console.log(`env file: ${envPath ?? ".env"}`);
  console.log(`summary (${summary.length} chars): ${summary}`);
  console.log(`keywords (${keywords.length}): ${keywords.join(", ")}`);
  console.log(`embedding dimensions: ${embedding.length}`);
};

main().catch((error) => {
  console.error("OpenAI smoke failed:", error);
  process.exitCode = 1;
});
