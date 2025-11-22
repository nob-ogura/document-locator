import { vi } from "vitest";

import type { GoogleDriveClient, GoogleDriveFilesListParams } from "../../src/clients.ts";
import type { DriveFileEntry } from "../../src/drive.ts";
import { isAfter } from "../../src/time.ts";
import { createTestLogger } from "./logger.ts";

const parseModifiedAfter = (q?: string): string | null => {
  if (!q) return null;
  const match = q.match(/modifiedTime\s*>\s*'([^']+)'/);
  return match?.[1] ?? null;
};

export const driveFilesFull: DriveFileEntry[] = [
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

export const driveFilesWithPdf: DriveFileEntry[] = [
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
    id: "pdf-1",
    name: "whitepaper",
    mimeType: "application/pdf",
    modifiedTime: "2024-10-15T00:00:00Z",
  },
];

export const driveFilesDiff: DriveFileEntry[] = [
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

export const driveFilesForSearch: DriveFileEntry[] = Array.from({ length: 15 }, (_, index) => ({
  id: `search-${index + 1}`,
  name: `search-file-${index + 1}`,
  mimeType: index % 3 === 0 ? "application/pdf" : "application/vnd.google-apps.document",
  modifiedTime: `2024-10-${10 + Math.floor(index / 3)}T00:00:00Z`,
}));

export const createDriveMock = (
  files: DriveFileEntry[],
  options: { folderIds?: string[] } = {},
): {
  drive: GoogleDriveClient;
  list: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["list"]>>;
  exportFile: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["export"]>>;
  get: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["get"]>>;
  logger: ReturnType<typeof createTestLogger>;
} => {
  const logger = createTestLogger();

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

  const get = vi.fn<GoogleDriveClient["files"]["get"]>().mockImplementation(async (fileId) => {
    const file = files.find((entry) => entry.id === fileId);
    const body = file?.name ?? "mock-binary";

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": file?.mimeType ?? "application/octet-stream" },
    });
  });

  const drive: GoogleDriveClient = {
    logger,
    targetFolderIds: options.folderIds ?? ["folderA"],
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
      get,
    },
  };

  return { drive, list, exportFile, get, logger };
};

export type DriveTree = Record<string, DriveFileEntry[]>;

export const createHierarchicalDriveMock = (
  tree: DriveTree,
  options: { rootIds?: string[] } = {},
): {
  drive: GoogleDriveClient;
  list: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["list"]>>;
  exportFile: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["export"]>>;
  get: ReturnType<typeof vi.fn<GoogleDriveClient["files"]["get"]>>;
  logger: ReturnType<typeof createTestLogger>;
} => {
  const logger = createTestLogger();
  const rootIds = options.rootIds ?? ["root"];

  const fileMap = new Map<string, DriveFileEntry>();
  Object.values(tree).forEach((entries) => {
    entries.forEach((entry) => {
      if (entry.id) {
        fileMap.set(entry.id, entry);
      }
    });
  });

  const list = vi
    .fn<GoogleDriveClient["files"]["list"]>()
    .mockImplementation(async (params?: GoogleDriveFilesListParams) => {
      const parentId = params?.parents?.[0] ?? rootIds[0];
      const entries = tree[parentId] ?? [];
      const cutoff = parseModifiedAfter(params?.q);

      const filtered =
        cutoff === null
          ? entries
          : entries.filter((entry) => {
              if (!entry.modifiedTime) return true;
              return isAfter(entry.modifiedTime, cutoff);
            });

      return new Response(JSON.stringify({ files: filtered }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

  const exportFile = vi
    .fn<GoogleDriveClient["files"]["export"]>()
    .mockImplementation(async (fileId: string) => {
      const text = fileMap.get(fileId)?.name ?? "mock-text";
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });

  const get = vi.fn<GoogleDriveClient["files"]["get"]>().mockImplementation(async (fileId) => {
    const file = fileMap.get(fileId);
    const body = file?.name ?? "mock-body";
    const mime = file?.mimeType ?? "application/octet-stream";

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": mime },
    });
  });

  const drive: GoogleDriveClient = {
    logger,
    targetFolderIds: rootIds,
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
      get,
    },
  };

  return { drive, list, exportFile, get, logger };
};
