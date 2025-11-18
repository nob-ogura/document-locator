export interface FileMetadata {
  /**
   * Supabase の `files.file_id` に対応する一意な ID。
   */
  fileId: string;
  /**
   * Supabase の `files.file_name` に対応するファイル名。
   */
  fileName: string;
  /**
   * Supabase の `files.summary` に対応する要約テキスト。
   */
  summary?: string;
  /**
   * Supabase の `files.keywords` に対応するキーワード。
   */
  keywords?: string;
  /**
   * Supabase の `files.embedding` に対応するベクトル。
   */
  embedding: number[];
}

export interface FileRecord extends FileMetadata {
  /**
   * Supabase の `files.created_at` に相当する作成日時。
   */
  createdAt: Date;
  /**
   * Supabase の `files.updated_at` に相当する更新日時。
   */
  updatedAt: Date;
}

/**
 * `files` テーブルに対する最小限のリポジトリインターフェース。
 *
 * 将来的に Supabase クライアント実装に差し替えられることを想定し、
 * 非同期 API として定義する。
 */
export interface FilesRepository {
  upsert(metadata: FileMetadata): Promise<FileRecord>;
  findByFileId(fileId: string): Promise<FileRecord | null>;
}

/**
 * フェーズ 2 時点では実際の Supabase ではなく、
 * 受入基準をテストで確認するためのインメモリ実装を提供する。
 */
export class InMemoryFilesRepository implements FilesRepository {
  private readonly records = new Map<string, FileRecord>();

  async upsert(metadata: FileMetadata): Promise<FileRecord> {
    const now = new Date();
    const existing = this.records.get(metadata.fileId);

    if (existing) {
      const updated: FileRecord = {
        ...existing,
        ...metadata,
        createdAt: existing.createdAt,
        updatedAt: now,
      };

      this.records.set(metadata.fileId, updated);
      return updated;
    }

    const created: FileRecord = {
      ...metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(metadata.fileId, created);
    return created;
  }

  async findByFileId(fileId: string): Promise<FileRecord | null> {
    const record = this.records.get(fileId);
    return record ?? null;
  }

  /**
   * テスト向けのヘルパー: 全レコードを取得する。
   */
  async getAllRecords(): Promise<FileRecord[]> {
    return Array.from(this.records.values());
  }

  /**
   * テスト向けのヘルパー: すべてのレコードを削除する。
   */
  async clear(): Promise<void> {
    this.records.clear();
  }
}

/**
 * `files` テーブルに対して単一レコードの upsert を行う関数。
 *
 * T4 の受入基準に対応するメインのエントリーポイント。
 */
export async function upsertFileRecord(
  repository: FilesRepository,
  metadata: FileMetadata
): Promise<FileRecord> {
  return repository.upsert(metadata);
}

