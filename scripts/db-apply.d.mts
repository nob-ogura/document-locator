export interface DriveFileIndexOptions {
  connectionString: string;
}

export function buildConnectionString(supabaseUrl: string, dbPassword: string): string;
export function applyDriveFileIndex(options: DriveFileIndexOptions): Promise<void>;
