import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { GoogleDriveClient, OpenAIChatResponse, OpenAIClient } from "../src/clients.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { runInitialDriveSearch } from "../src/search.js";

const baseConfig: AppConfig = {
  crawlerMode: "auto",
  searchMaxLoopCount: 3,
  summaryMaxLength: 400,
  googleClientId: "client-id",
  googleClientSecret: "client-secret",
  googleRefreshToken: "refresh-token",
  googleDriveTargetFolderIds: ["folderA"],
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  openaiApiKey: "sk-test",
  logLevel: "debug",
};

type ChatCreate = OpenAIClient["chat"]["completions"]["create"];

const createOpenAIMock = (content: string) => {
  const response: OpenAIChatResponse = {
    id: "chat-keywords",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };

  const create = vi.fn<ChatCreate>().mockResolvedValue(response);

  const openai: Pick<OpenAIClient, "chat"> = {
    chat: {
      completions: {
        create: create as ChatCreate,
      },
    },
  };

  return { openai, create };
};

const createListResponse = (files: unknown[], nextPageToken?: string): Response =>
  new Response(JSON.stringify({ files, nextPageToken }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const createDriveClient = (pages: Response[]) => {
  const listMock = vi
    .fn<GoogleDriveClient["files"]["list"]>()
    .mockImplementation(async () => pages.shift() ?? createListResponse([]));

  const driveClient = {
    logger: createLogger("debug"),
    targetFolderIds: ["folderA"],
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn() },
    folders: { ensureTargetsExist: vi.fn() },
    files: {
      list: listMock as Mock<GoogleDriveClient["files"]["list"]>,
      export: vi.fn(),
      get: vi.fn(),
    },
  } satisfies GoogleDriveClient;

  return { driveClient, listMock };
};

describe("runInitialDriveSearch", () => {
  it("キーワードを使って期間/MIME 付きで Drive を検索する", async () => {
    const { openai, create } = createOpenAIMock('["週次","9月","売上"]');
    const { driveClient, listMock } = createDriveClient([
      createListResponse([{ id: "doc-1" }], "next-1"),
      createListResponse([{ id: "doc-2" }]),
    ]);

    const result = await runInitialDriveSearch({
      config: baseConfig,
      request: {
        query: "週次レポート 9月 売上",
        filters: { after: "2024-09-01", before: "2024-09-30", mime: "application/pdf" },
        searchMaxLoopCount: baseConfig.searchMaxLoopCount,
      },
      deps: { googleDrive: driveClient, openai, logger: driveClient.logger },
    });

    expect(create).toHaveBeenCalledTimes(1);

    expect(listMock).toHaveBeenCalledTimes(2);
    const firstCall = listMock.mock.calls[0]?.[0];
    expect(firstCall?.includeItemsFromAllDrives).toBe(true);
    expect(firstCall?.supportsAllDrives).toBe(true);

    const query = firstCall?.q ?? "";
    expect(query).toContain("'folderA' in parents");
    expect(query).toContain("modifiedTime >=");
    expect(query).toContain("modifiedTime <=");
    expect(query).toContain("mimeType='application/pdf'");
    expect(query).toContain("fullText contains '週次'");
    expect(query).toContain("fullText contains '9月'");
    expect(query).toContain("fullText contains '売上'");

    expect(result.driveQuery).toBe(query);
    expect(result.keywords).toEqual(["週次", "9月", "売上"]);
    expect(result.files.map((file) => file.id)).toEqual(["doc-1", "doc-2"]);
  });

  it("キーワード抽出失敗時はクエリだけで Drive 検索する", async () => {
    const { openai } = createOpenAIMock("[]"); // 3件未満で例外になる
    const { driveClient, listMock } = createDriveClient([createListResponse([])]);

    const result = await runInitialDriveSearch({
      config: baseConfig,
      request: {
        query: "週次レポート 9月 売上",
        filters: { mime: "application/pdf" },
        searchMaxLoopCount: baseConfig.searchMaxLoopCount,
      },
      deps: { googleDrive: driveClient, openai, logger: driveClient.logger },
    });

    const query = listMock.mock.calls[0]?.[0]?.q ?? "";
    expect(query).toContain("'folderA' in parents");
    expect(query).toContain("fullText contains '週次レポート 9月 売上'");
    expect(result.keywords).toEqual([]);
  });
});
