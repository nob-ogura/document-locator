import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GoogleDriveClient,
  GoogleDriveFilesListParams,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIClient,
  OpenAIEmbeddingResponse,
  SupabaseClient,
} from "../src/clients.ts";
import { syncSupabaseIndex } from "../src/crawler.ts";
import type { DriveFileEntry } from "../src/drive.ts";
import type { DriveFileIndexUpsertRow } from "../src/drive_file_index_repository.ts";
import type { AppConfig } from "../src/env.ts";
import { isAfter } from "../src/time.ts";

const baseConfig: AppConfig = {
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

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

const parseModifiedAfter = (q?: string): string | null => {
  if (!q) return null;
  const match = q.match(/modifiedTime\s*>\s*'([^']+)'/);
  return match?.[1] ?? null;
};

const createDriveClient = (files: DriveFileEntry[]): GoogleDriveClient => {
  const logger = createLogger();

  const list = vi
    .fn<GoogleDriveClient["files"]["list"]>()
    .mockImplementation(async (params?: GoogleDriveFilesListParams) => {
      const cutoff = parseModifiedAfter(params?.q);
      const filtered = cutoff
        ? files.filter((file) => file.modifiedTime && isAfter(file.modifiedTime, cutoff))
        : files;

      return new Response(JSON.stringify({ files: filtered }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

  const exportFile = vi
    .fn<GoogleDriveClient["files"]["export"]>()
    .mockImplementation(async (fileId: string) => {
      const text = files.find((file) => file.id === fileId)?.name ?? "mock-text";
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });

  return {
    logger,
    targetFolderIds: ["folderA"],
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn().mockResolvedValue("token") },
    folders: { ensureTargetsExist: vi.fn().mockResolvedValue(undefined) },
    files: {
      list,
      export: exportFile,
      get: vi.fn(),
    },
  };
};

const createSupabaseClient = (initialSync?: string | null) => {
  const logger = createLogger();
  let driveModifiedAt: string | null = initialSync ?? null;
  const upserts: DriveFileIndexUpsertRow[] = [];

  const request: SupabaseClient["request"] = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init.method ?? "GET").toUpperCase();

    if (url.startsWith("/rest/v1/drive_sync_state")) {
      if (method === "GET") {
        const rows = driveModifiedAt ? [{ id: "global", drive_modified_at: driveModifiedAt }] : [];
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "POST") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        driveModifiedAt = body?.drive_modified_at ?? null;
        const rows = [{ id: "global", drive_modified_at: driveModifiedAt }];

        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
    }

    if (url.startsWith("/rest/v1/drive_file_index") && method === "POST") {
      const rows = typeof init.body === "string" ? JSON.parse(init.body) : [];
      upserts.push(...rows);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not implemented", { status: 500 });
  };

  const supabase: SupabaseClient = {
    logger,
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request,
  };

  return { supabase, upserts, getSyncState: () => driveModifiedAt };
};

const createOpenAIClient = () => {
  type ChatCreate = OpenAIClient["chat"]["completions"]["create"];
  type EmbeddingsCreate = OpenAIClient["embeddings"]["create"];

  const logger = createLogger();
  const keywordsContent = JSON.stringify(["alpha", "beta", "gamma"]);

  const chatCreate = vi.fn<ChatCreate>().mockImplementation(async (payload: OpenAIChatRequest) => {
    const system = payload.messages?.[0]?.content ?? "";
    const isKeywordRequest =
      typeof system === "string" && /Extract 3 to 5 short keywords/i.test(system);
    const content = isKeywordRequest ? keywordsContent : "mock summary";

    return {
      id: isKeywordRequest ? "chat-keywords" : "chat-summary",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content } }],
    } satisfies OpenAIChatResponse;
  });

  const embeddingVector = Array.from({ length: 1536 }, (_, index) => (index + 1) / 1536);

  const embeddingsCreate = vi.fn<EmbeddingsCreate>().mockResolvedValue({
    object: "list",
    data: [{ index: 0, embedding: embeddingVector }],
    model: "text-embedding-3-small",
  } satisfies OpenAIEmbeddingResponse);

  const openai: OpenAIClient = {
    logger,
    apiKey: "sk-test",
    organization: "org-test",
    request: vi.fn(),
    chat: {
      completions: {
        create: chatCreate,
      },
    },
    embeddings: {
      create: embeddingsCreate,
    },
  };

  return { openai, chatCreate, embeddingsCreate, embeddingVector };
};

describe("crawler mock e2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("full モードでサポート MIME をすべて処理し、非対応はスキップする", async () => {
    const files: DriveFileEntry[] = [
      {
        id: "doc-1",
        name: "report-1",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2024-10-10T00:00:00Z",
      },
      {
        id: "doc-2",
        name: "report-2",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2024-10-12T00:00:00Z",
      },
      {
        id: "image-1",
        name: "photo.png",
        mimeType: "image/png",
        modifiedTime: "2024-10-13T00:00:00Z",
      },
    ];

    const drive = createDriveClient(files);
    const { supabase, upserts, getSyncState } = createSupabaseClient();
    const { openai, chatCreate, embeddingsCreate, embeddingVector } = createOpenAIClient();

    const result = await syncSupabaseIndex({
      config: baseConfig,
      mode: "full",
      deps: { googleDrive: drive, supabase, openai, logger: drive.logger },
    });

    expect(result.effectiveMode).toBe("full");
    expect(result.files.map((f) => f.id)).toEqual(["doc-1", "doc-2", "image-1"]);
    expect(result.processed.map((f) => f.id)).toEqual(["doc-1", "doc-2"]);
    expect(result.skipped.map((f) => f.id)).toEqual(["image-1"]);

    expect(chatCreate).toHaveBeenCalledTimes(4);
    expect(embeddingsCreate).toHaveBeenCalledTimes(2);

    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.embedding).toEqual(embeddingVector);
    expect(result.upsertedCount).toBe(2);
    expect(result.latestDriveModifiedAt).toBe("2024-10-12T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-12T00:00:00Z");
  });

  it("diff モードで drive_sync_state を用いて差分 + limit を適用する", async () => {
    const files: DriveFileEntry[] = [
      {
        id: "doc-old",
        name: "old",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2024-10-05T00:00:00Z",
      },
      {
        id: "doc-new-1",
        name: "new-1",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2024-10-11T00:00:00Z",
      },
      {
        id: "doc-new-2",
        name: "new-2",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2024-10-12T00:00:00Z",
      },
      {
        id: "image-2",
        name: "photo-2.png",
        mimeType: "image/png",
        modifiedTime: "2024-10-12T00:00:00Z",
      },
    ];

    const drive = createDriveClient(files);
    const { supabase, upserts, getSyncState } = createSupabaseClient("2024-10-10T00:00:00Z");
    const { openai, chatCreate, embeddingsCreate } = createOpenAIClient();

    const result = await syncSupabaseIndex({
      config: baseConfig,
      mode: "diff",
      limit: 1,
      deps: { googleDrive: drive, supabase, openai, logger: drive.logger },
    });

    expect(result.effectiveMode).toBe("diff");
    expect(result.driveQuery).toBe("modifiedTime > '2024-10-10T00:00:00Z'");

    expect(result.files.map((f) => f.id)).toEqual(["doc-new-1", "doc-new-2", "image-2"]);
    expect(result.processable.map((f) => f.id)).toEqual(["doc-new-1"]);
    expect(result.processed.map((f) => f.id)).toEqual(["doc-new-1"]);
    expect(result.skipped.map((f) => f.id)).toEqual(["image-2"]);

    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);

    expect(upserts.map((row) => row.file_id)).toEqual(["doc-new-1"]);
    expect(result.upsertedCount).toBe(1);
    expect(result.latestDriveModifiedAt).toBe("2024-10-11T00:00:00Z");
    expect(getSyncState()).toBe("2024-10-11T00:00:00Z");
  });
});
