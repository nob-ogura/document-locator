export const TEXT_SUPPORTED_MIMES = [
  "application/vnd.google-apps.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
] as const;

export const isTextSupportedMime = (mimeType: string | undefined): boolean =>
  Boolean(
    mimeType && TEXT_SUPPORTED_MIMES.includes(mimeType as (typeof TEXT_SUPPORTED_MIMES)[number]),
  );
