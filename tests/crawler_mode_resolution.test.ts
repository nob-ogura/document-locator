import { afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "../src/clients.js";
import { runCrawler } from "../src/crawler.js";
import * as syncRepo from "../src/drive_sync_state_repository.js";
import type { AppConfig } from "../src/env.js";
import { createLogger } from "../src/logger.js";

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

const createSupabaseStub = (): SupabaseClient => ({
  logger: createLogger("debug"),
  credentials: { url: "https://example.supabase.co", serviceRoleKey: "service-role-key" },
  request: vi.fn(),
});

describe("runCrawler mode resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects full scan when auto mode and drive_sync_state is empty", async () => {
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const result = await runCrawler({
      config: baseConfig,
      mode: "auto",
      deps: { supabase: createSupabaseStub(), logger: createLogger("debug") },
    });

    expect(result.effectiveMode).toBe("full");
    expect(result.driveQuery).toBeUndefined();
  });

  it("uses diff scan with modifiedTime filter when drive_sync_state exists", async () => {
    const driveModifiedAt = "2024-10-01T00:00:00Z";
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue({
      id: "global",
      drive_modified_at: driveModifiedAt,
    });

    const result = await runCrawler({
      config: baseConfig,
      mode: "auto",
      deps: { supabase: createSupabaseStub(), logger: createLogger("debug") },
    });

    expect(result.effectiveMode).toBe("diff");
    expect(result.driveQuery).toBe(`modifiedTime > '${driveModifiedAt}'`);
  });

  it("falls back to full scan when diff is requested but sync state is missing", async () => {
    vi.spyOn(syncRepo, "getDriveSyncState").mockResolvedValue(null);

    const result = await runCrawler({
      config: baseConfig,
      mode: "diff",
      deps: { supabase: createSupabaseStub(), logger: createLogger("debug") },
    });

    expect(result.effectiveMode).toBe("full");
    expect(result.driveQuery).toBeUndefined();
  });
});
