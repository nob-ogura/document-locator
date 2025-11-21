import type { GoogleDriveClient } from "./clients.ts";
import type { DriveFileEntry } from "./drive.ts";
import type { Logger } from "./logger.ts";

type FetchGoogleDocTextOptions = {
  driveClient: GoogleDriveClient;
  fileId: string;
  accessToken?: string;
  logger?: Logger;
};

type FetchPdfTextOptions = {
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

const ensureGetOk = async (response: Response, fileId: string): Promise<void> => {
  if (response.ok) return;

  let detail = "";
  try {
    const body = await response.text();
    detail = body ? ` body=${body}` : "";
  } catch {
    // ignore parse errors
  }

  throw new Error(`Failed to fetch PDF ${fileId}: HTTP ${response.status}${detail}`);
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

/**
 * PDF を Drive からバイナリ取得し、pdf-parse でテキスト化する。
 */
export const fetchPdfText = async (options: FetchPdfTextOptions): Promise<string> => {
  const { driveClient, fileId, accessToken, logger } = options;

  const response = await driveClient.files.get(fileId, { accessToken, alt: "media" });
  await ensureGetOk(response, fileId);

  const buffer = Buffer.from(await response.arrayBuffer());
  const pdfParse = await importPdfParse();
  const parsed = await pdfParse(buffer);

  const text = typeof parsed === "string" ? parsed : (parsed?.text ?? "");

  if (text.length === 0) {
    logger?.error("pdf parse returned empty text", { fileId });
    throw new Error(`PDF ${fileId} returned empty text`);
  }

  return text;
};

export type { FetchGoogleDocTextOptions, FetchPdfTextOptions };

type MimeHandler = (params: {
  driveClient: GoogleDriveClient;
  fileId: string;
  accessToken?: string;
  logger?: Logger;
}) => Promise<string>;

const MIME_HANDLERS: Record<string, MimeHandler> = {
  "application/vnd.google-apps.document": ({ driveClient, fileId, accessToken, logger }) =>
    fetchGoogleDocText({ driveClient, fileId, accessToken, logger }),
  "application/pdf": ({ driveClient, fileId, accessToken, logger }) =>
    fetchPdfText({ driveClient, fileId, accessToken, logger }),
};

export type ExtractTextOrSkipOptions = {
  driveClient: GoogleDriveClient;
  fileMeta: DriveFileEntry;
  accessToken?: string;
  logger?: Logger;
};

/**
 * テキスト抽出可能な MIME のみを処理し、それ以外はスキップとしてログに記録する。
 * サポート対象: Google ドキュメント, PDF
 */
export const extractTextOrSkip = async (
  options: ExtractTextOrSkipOptions,
): Promise<string | null> => {
  const { driveClient, fileMeta, accessToken, logger } = options;
  const mimeType = fileMeta.mimeType;
  const handler = mimeType ? MIME_HANDLERS[mimeType] : undefined;
  const fileId = fileMeta.id;
  const effectiveLogger = logger ?? driveClient.logger;

  if (!handler) {
    effectiveLogger?.info("skip: unsupported mime_type", {
      mimeType,
      fileId,
      fileName: fileMeta.name,
    });
    return null;
  }

  if (!fileId) {
    throw new Error("file id is required for text extraction");
  }

  return handler({
    driveClient,
    fileId,
    accessToken,
    logger: effectiveLogger,
  });
};

type PdfParseFn = (dataBuffer: Buffer) => Promise<{ text?: string } | string>;

const importPdfParse = async (): Promise<PdfParseFn> => {
  const mod = await import("pdf-parse");
  const fn = (mod as { default?: unknown }).default ?? (mod as unknown);

  if (typeof fn === "function") {
    return fn as PdfParseFn;
  }

  const PDFParseCtor = (mod as { PDFParse?: unknown }).PDFParse;
  if (typeof PDFParseCtor === "function") {
    return async (dataBuffer: Buffer) => {
      const parser = new (
        PDFParseCtor as new (params: {
          data: Buffer;
        }) => {
          getText?: () => Promise<{ text?: string } | string>;
          destroy?: () => Promise<void> | void;
        }
      )({ data: dataBuffer });

      try {
        const result = await parser.getText?.();
        return result ?? "";
      } finally {
        if (typeof parser.destroy === "function") {
          await parser.destroy();
        }
      }
    };
  }

  throw new Error("pdf-parse module did not export a callable function");
};
