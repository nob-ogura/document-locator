import { describe, expect, it, vi } from "vitest";
import {
  createGoogleDriveClient,
  createOpenAIClient,
  createSupabaseClient,
} from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import type { FetchWithRetryOptions } from "../src/http.js";
import { createLogger } from "../src/logger.js";

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
  logLevel: "info",
};

describe("external client factories", () => {
  it("環境設定からクライアントを生成し、ロガーとリトライを共有する", async () => {
    const logger = createLogger("debug");
    type RequestInfo = Parameters<typeof fetch>[0];
    type Retrier = (input: RequestInfo, options?: FetchWithRetryOptions) => Promise<Response>;

    const retrier = vi.fn<Retrier>(async (_input, _options) => new Response(null, { status: 200 }));

    const google = createGoogleDriveClient(baseConfig, { logger, fetchWithRetry: retrier });
    const openai = createOpenAIClient(baseConfig, { logger, fetchWithRetry: retrier });
    const supabase = createSupabaseClient(baseConfig, { logger, fetchWithRetry: retrier });

    expect(google.credentials.refreshToken).toBe(baseConfig.googleRefreshToken);
    expect(google.targetFolderIds).toEqual(["folderA"]);
    expect(openai.apiKey).toBe(baseConfig.openaiApiKey);
    expect(openai.organization).toBe(baseConfig.openaiOrg);
    expect(supabase.credentials.serviceRoleKey).toBe(baseConfig.supabaseServiceRoleKey);

    expect(google.logger).toBe(logger);
    expect(openai.logger).toBe(logger);
    expect(supabase.logger).toBe(logger);

    expect(retrier).not.toHaveBeenCalled();

    await google.request("/drive/v3/files", { accessToken: "ya29.test" });
    await openai.request("/v1/models");
    await supabase.request("/rest/v1/drive_file_index");

    expect(retrier).toHaveBeenCalledTimes(3);

    const googleCall = retrier.mock.calls[0];
    expect(googleCall).toBeDefined();
    if (!googleCall) throw new Error("Google request was not recorded");
    const [, googleOptions] = googleCall;
    expect(googleOptions).toBeDefined();
    if (!googleOptions) throw new Error("Google options were not recorded");
    expect(googleOptions.logger).toBe(logger);
    const googleHeaders = googleOptions.headers as Record<string, string> | undefined;
    expect(googleHeaders?.Authorization).toBe("Bearer ya29.test");

    const openaiCall = retrier.mock.calls[1];
    expect(openaiCall).toBeDefined();
    if (!openaiCall) throw new Error("OpenAI request was not recorded");
    const [, openaiOptions] = openaiCall;
    expect(openaiOptions).toBeDefined();
    if (!openaiOptions) throw new Error("OpenAI options were not recorded");
    expect(openaiOptions.logger).toBe(logger);
    const openaiHeaders = openaiOptions.headers as Record<string, string> | undefined;
    expect(openaiHeaders?.Authorization).toBe(`Bearer ${baseConfig.openaiApiKey}`);
    expect(openaiHeaders?.["OpenAI-Organization"]).toBe(baseConfig.openaiOrg);

    const supabaseCall = retrier.mock.calls[2];
    expect(supabaseCall).toBeDefined();
    if (!supabaseCall) throw new Error("Supabase request was not recorded");
    const [, supabaseOptions] = supabaseCall;
    expect(supabaseOptions).toBeDefined();
    if (!supabaseOptions) throw new Error("Supabase options were not recorded");
    const supabaseHeaders = supabaseOptions.headers as Record<string, string> | undefined;
    expect(supabaseHeaders?.apikey).toBe(baseConfig.supabaseServiceRoleKey);
    expect(supabaseHeaders?.Authorization).toBe(`Bearer ${baseConfig.supabaseServiceRoleKey}`);
  });
});
