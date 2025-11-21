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

  it("0件かつキーワード1件になったら見つかりませんでしたを表示する", () => {
    const result = runSearchCli(["空振りクエリ"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/見つかりませんでした/);
  });

  it("結果を番号付きで要約とリンクを指定フォーマットで表示する", () => {
    const result = runSearchCli(["--", "フォーマット検証"], {
      SEARCH_MOCK_DRIVE_FILE_COUNT: "3",
      SUMMARY_MAX_LENGTH: "10",
    });

    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split("\n");
    const hitLine = lines.find((line) => line.startsWith("hits:"));
    expect(hitLine).toContain("3");
    expect(hitLine).toContain("few");

    for (let index = 1; index <= 3; index += 1) {
      const headerIndex = lines.findIndex((line) => line.startsWith(`[${index}]`));
      expect(headerIndex).toBeGreaterThan(-1);

      const summaryLine = lines[headerIndex + 1]?.trim() ?? "";
      expect(summaryLine).toMatch(/^要約: .+/);
      const summaryText = summaryLine.replace(/^要約: /, "");
      expect(summaryText.length).toBeLessThanOrEqual(10);

      const linkLine = lines[headerIndex + 2]?.trim() ?? "";
      expect(linkLine).toMatch(/^Link: https:\/\/drive\.google\.com\/open\?id=mock-file-/);
    }
  });
});
