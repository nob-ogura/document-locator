import type { AppConfig } from "../../src/env.ts";

export const baseConfig: AppConfig = {
  crawlerMode: "auto",
  searchMaxLoopCount: 3,
  summaryMaxLength: 200,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

export const createConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...baseConfig,
  ...overrides,
});
