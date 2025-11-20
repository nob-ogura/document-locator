import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.js";

const baseEnv = {
  CRAWLER_MODE: "diff",
  SEARCH_MAX_LOOP_COUNT: "3",
  SUMMARY_MAX_LENGTH: "400",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  GOOGLE_DRIVE_TARGET_FOLDER_IDS: "folder1,folder2",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  OPENAI_API_KEY: "sk-test",
} satisfies Record<string, string>;

describe("loadEnv", () => {
  it("必須の環境変数がそろっているならデフォルト込みの型付き設定を返す", () => {
    const config = loadEnv(baseEnv);

    expect(config.crawlerMode).toBe("diff");
    expect(config.searchMaxLoopCount).toBe(3);
    expect(config.summaryMaxLength).toBe(400);
    expect(config.logLevel).toBe("info");
    expect(config.googleDriveTargetFolderIds).toEqual(["folder1", "folder2"]);
  });

  it("必須の環境変数が欠けていると例外を投げる", () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    env.SUPABASE_SERVICE_ROLE_KEY = undefined;

    expect(() => loadEnv(env)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
