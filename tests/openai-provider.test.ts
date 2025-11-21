import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/env.js";
import type { Logger } from "../src/logger.js";
import {
  buildEmbeddingInput,
  extractKeywords,
  generateEmbedding,
  summarizeText,
} from "../src/openai.js";
import { resolveOpenAIClient } from "../src/openai-provider.js";

const baseConfig: AppConfig = {
  crawlerMode: "diff",
  searchMaxLoopCount: 3,
  summaryMaxLength: 400,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  openaiOrg: "org-test",
  logLevel: "debug",
};

const createMockLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

describe("resolveOpenAIClient", () => {
  it("CI=true ではモックを返し、要約/キーワード/embedding が動作する", async () => {
    const logger = createMockLogger();

    const { openai, mode } = resolveOpenAIClient(baseConfig, { logger, ciFlag: true });
    expect(mode).toBe("mock");

    const summary = await summarizeText({
      openai,
      text: "Hello from CI environment",
      summaryMaxLength: 120,
      logger,
    });

    const keywords = await extractKeywords({ openai, text: "Hello from CI environment", logger });
    const embeddingInput = buildEmbeddingInput({ summary, keywords, fileName: "ci.txt" });
    const embedding = await generateEmbedding({ openai, input: embeddingInput });

    expect(summary.length).toBeGreaterThan(0);
    expect(keywords.length).toBeGreaterThanOrEqual(3);
    expect(keywords.length).toBeLessThanOrEqual(5);
    expect(embedding).toHaveLength(1536);

    expect(logger.info).toHaveBeenCalledWith(
      "mock openai mode enabled",
      expect.objectContaining({ reason: "CI" }),
    );
  });

  it("CI=false では実クライアントを返す", () => {
    const logger = createMockLogger();

    const { openai, mode } = resolveOpenAIClient(baseConfig, { logger, ciFlag: false });

    expect(mode).toBe("live");
    expect(openai.apiKey).toBe(baseConfig.openaiApiKey);
    expect(logger.info).toHaveBeenCalledWith(
      "live openai mode enabled",
      expect.objectContaining({ organization: baseConfig.openaiOrg }),
    );
  });
});
