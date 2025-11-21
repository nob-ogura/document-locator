import type { GoogleDriveClient } from "./clients.js";
import type { Logger } from "./logger.js";

type FetchGoogleDocTextOptions = {
  driveClient: GoogleDriveClient;
  fileId: string;
  accessToken?: string;
  logger?: Logger;
};

const ensureExportOk = async (response: Response, fileId: string): Promise<void> => {
  if (response.ok) return;

  let detail = "";
  try {
    const body = await response.text();
    detail = body ? ` body=${body}` : "";
  } catch {
    // ignore parse errors
  }

  throw new Error(`Failed to export Google Doc ${fileId}: HTTP ${response.status}${detail}`);
};

/**
 * Google ドキュメントを text/plain で取得し、UTF-8 文字列として返す。
 */
export const fetchGoogleDocText = async (options: FetchGoogleDocTextOptions): Promise<string> => {
  const { driveClient, fileId, accessToken, logger } = options;

  const response = await driveClient.files.export(fileId, "text/plain", { accessToken });
  await ensureExportOk(response, fileId);

  const text = await response.text();

  if (text.length === 0) {
    logger?.error("google doc export returned empty text", { fileId });
    throw new Error(`Google Doc ${fileId} returned empty text`);
  }

  return text;
};

export type { FetchGoogleDocTextOptions };
