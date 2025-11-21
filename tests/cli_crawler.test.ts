import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = resolve("src/cli/crawler.ts");

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

const runCrawlerCli = (
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

type LogPayload = {
  level?: string;
  message?: string;
  context?: Record<string, unknown>;
};

const parseLogLine = (stdout: string): LogPayload => {
  const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? (JSON.parse(firstLine) as LogPayload) : {};
};

const parseLogs = (stdout: string): LogPayload[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogPayload);

describe("crawler CLI", () => {
  it("mode オプション省略時は CRAWLER_MODE をデフォルト採用する", () => {
    const result = runCrawlerCli([], { CRAWLER_MODE: "diff" });

    expect(result.status).toBe(0);

    const log = parseLogLine(result.stdout);
    expect(log.context).toMatchObject({ mode: "diff", limit: null });
  });

  it("CLI オプションが環境デフォルトを上書きする", () => {
    const result = runCrawlerCli(["--mode", "full", "--limit", "2"], { CRAWLER_MODE: "auto" });

    expect(result.status).toBe(0);

    const log = parseLogLine(result.stdout);
    expect(log.context).toMatchObject({ mode: "full", limit: 2 });
  });

  it("先頭に誤って入った '--' を無視してオプションを解釈する", () => {
    const result = runCrawlerCli(["--", "--mode", "diff", "--limit", "5"], {});

    expect(result.status).toBe(0);

    const log = parseLogLine(result.stdout);
    expect(log.context).toMatchObject({ mode: "diff", limit: 5 });
  });

  it("必須環境変数が欠落していればエラー終了する", () => {
    const result = runCrawlerCli([], { SUPABASE_SERVICE_ROLE_KEY: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("完了時にサマリを INFO ログで出力する", () => {
    const result = runCrawlerCli([], {});

    expect(result.status).toBe(0);

    const logs = parseLogs(result.stdout);
    const summary = logs.find((log) => log.message?.startsWith("crawler: summary"));

    expect(summary?.message).toMatch(/processed=0/);
    expect(summary?.message).toMatch(/skipped=0/);
    expect(summary?.message).toMatch(/upserted=0/);
    expect(summary?.message).toMatch(/failed=0/);
  });

  it("致命的エラー時は非ゼロ終了コードを返す", () => {
    const result = runCrawlerCli([], { MOCK_SUPABASE_STATUS: "500" });

    expect(result.status).toBe(1);
    expect(result.stderr || result.stdout).toMatch(/Supabase request failed|HTTP 500/);
  });
});
