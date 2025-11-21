import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { GoogleDriveClient, SupabaseClient } from "../src/clients.js";
import { extractDriveTexts } from "../src/crawler.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";
import type { AppConfig } from "../src/env.js";
import * as textExtraction from "../src/text_extraction.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

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

const createListResponse = (files: unknown[]): Response =>
  new Response(JSON.stringify({ files }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const createDriveClient = (listMock: Mock<GoogleDriveClient["files"]["list"]>): GoogleDriveClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    targetFolderIds: ["folderA"],
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    request: vi.fn(),
    auth: { fetchAccessToken: vi.fn() },
    folders: { ensureTargetsExist: vi.fn() },
    files: { list: listMock, export: vi.fn(), get: vi.fn() },
  }) satisfies GoogleDriveClient;

const createSupabaseClient = (): SupabaseClient =>
  ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    credentials: {
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    request: vi.fn(),
  }) satisfies SupabaseClient;

describe("parallel processing", () => {
  it("processes files with max concurrency 5 and queues remaining work", async () => {
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const files = Array.from({ length: 10 }, (_, index) => ({
      id: `file-${index + 1}`,
      name: `file-${index + 1}.pdf`,
      mimeType: "application/pdf",
    }));

    const listMock = vi
      .fn<GoogleDriveClient["files"]["list"]>()
      .mockResolvedValue(createListResponse(files));

    const deferreds = files.map(() => createDeferred<string>());
    let inFlight = 0;
    let maxInFlight = 0;
    const startOrder: string[] = [];

    vi.spyOn(textExtraction, "extractTextOrSkip").mockImplementation(({ fileMeta }) => {
      const index = startOrder.length;
      startOrder.push(fileMeta.id ?? `index-${index}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const deferred = deferreds[index];
      return deferred.promise.finally(() => {
        inFlight -= 1;
      });
    });

    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const driveClient = createDriveClient(listMock);
    const supabaseClient = createSupabaseClient();

    const extractionPromise = extractDriveTexts({
      config: baseConfig,
      mode: "auto",
      deps: { googleDrive: driveClient, supabase: supabaseClient, logger },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startOrder).toHaveLength(5);

    deferreds.slice(0, 5).forEach((deferred, idx) => {
      deferred.resolve(`text-batch-1-${idx + 1}`);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startOrder).toHaveLength(10);

    deferreds.slice(5).forEach((deferred, idx) => {
      deferred.resolve(`text-batch-2-${idx + 1}`);
    });

    const result = await extractionPromise;

    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(result.extracted).toHaveLength(10);
  });
});
