declare module "mammoth" {
  export type ExtractRawTextResult = {
    value: string;
    messages?: Array<{ type?: string; message?: string }>;
  };

  export function extractRawText(options: {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    [key: string]: unknown;
  }): Promise<ExtractRawTextResult>;

  const mammoth: {
    extractRawText: typeof extractRawText;
  };

  export default mammoth;
}
