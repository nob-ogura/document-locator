import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = resolve("src/cli/search.ts");

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

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const runSearchCli = (
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): CliResult => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
    cwd: resolve("tests"),
    env: { ...process.env, ...baseEnv, ...envOverrides },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

describe("search CLI", () => {
  it("クエリとフィルタをパースする", () => {
    const result = runSearchCli([
      "--",
      "--after",
      "2024-09-01",
      "--before",
      "2024-09-30",
      "--mime",
      "application/pdf",
      "--json",
      "レポート",
    ]);

    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout.trim()) as {
      query: string;
      filters: { after?: string; before?: string; mime?: string };
      searchMaxLoopCount: number;
    };

    expect(payload.query).toBe("レポート");
    expect(payload.filters.after).toBe("2024-09-01");
    expect(payload.filters.before).toBe("2024-09-30");
    expect(payload.filters.mime).toBe("application/pdf");
    expect(payload.searchMaxLoopCount).toBe(3);
  });

  it("必須環境変数が欠落していればエラー終了する", () => {
    const result = runSearchCli(["--json", "レポート"], { SEARCH_MAX_LOOP_COUNT: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SEARCH_MAX_LOOP_COUNT/);
  });
});
