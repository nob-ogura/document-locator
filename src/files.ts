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
  /**
   * Supabase の `files.is_deleted` に対応する削除フラグ。
   * 未指定の場合は false (未削除) として扱う。
   */
  isDeleted?: boolean;
}

export interface FileRecord extends FileMetadata {
  /**
   * Supabase の `files.is_deleted` に相当する削除フラグ。
   */
  isDeleted: boolean;
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
  markAsDeleted(fileId: string): Promise<FileRecord>;
  /**
   * Embedding ベクトルと file_id のリストを入力として、
   * 類似度の高い順に最大 limit 件のレコードを返すベクトル検索。
   */
  vectorSearch(
    queryEmbedding: number[],
    fileIdFilter: string[],
    limit: number
  ): Promise<FileRecord[]>;
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
        isDeleted:
          metadata.isDeleted !== undefined
            ? metadata.isDeleted
            : existing.isDeleted,
        createdAt: existing.createdAt,
        updatedAt: now,
      };

      this.records.set(metadata.fileId, updated);
      return updated;
    }

    const created: FileRecord = {
      ...metadata,
      isDeleted: metadata.isDeleted ?? false,
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

  async markAsDeleted(fileId: string): Promise<FileRecord> {
    const existing = this.records.get(fileId);

    if (!existing) {
      throw new Error(`File not found for logical delete: ${fileId}`);
    }

    const now = new Date();

    const updated: FileRecord = {
      ...existing,
      isDeleted: true,
      updatedAt: now,
    };

    this.records.set(fileId, updated);
    return updated;
  }

  async vectorSearch(
    queryEmbedding: number[],
    fileIdFilter: string[],
    limit: number
  ): Promise<FileRecord[]> {
    const allRecords = await this.getAllRecords();
    const activeRecords = filterActiveFilesForVectorSearch(allRecords);

    const filterSet =
      fileIdFilter.length > 0 ? new Set(fileIdFilter) : null;

    const filteredRecords = filterSet
      ? activeRecords.filter((record) => filterSet.has(record.fileId))
      : activeRecords;

    const sorted = sortRecordsByEmbeddingSimilarity(
      filteredRecords,
      queryEmbedding
    );

    const safeLimit = limit > 0 ? limit : 0;
    return sorted.slice(0, safeLimit);
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

/**
 * Drive 側で削除されたファイルに対して、
 * 論理削除フラグ (isDeleted) を付与するための関数。
 *
 * T5 の受入基準に対応するエントリーポイント。
 */
export async function markFileAsDeleted(
  repository: FilesRepository,
  fileId: string
): Promise<FileRecord> {
  return repository.markAsDeleted(fileId);
}

/**
 * ベクトル検索の対象から削除フラグが true のレコードを除外するためのフィルタ関数。
 *
 * T5 の「ベクトル検索の対象から削除フラグが true のレコードが除外される」
 * という受入基準をコードとして表現する。
 */
export function filterActiveFilesForVectorSearch(
  records: FileRecord[]
): FileRecord[] {
  return records.filter((record) => !record.isDeleted);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sortRecordsByEmbeddingSimilarity(
  records: FileRecord[],
  queryEmbedding: number[]
): FileRecord[] {
  const scored = records.map((record) => ({
    record,
    score: cosineSimilarity(record.embedding ?? [], queryEmbedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.map((item) => item.record);
}

/**
 * T6: `files` テーブルに対するベクトル検索関数のエントリーポイント。
 *
 * Embedding ベクトルと file_id フィルタリスト、および取得件数 N を受け取り、
 * リポジトリ実装に委譲して関連度上位 N 件のレコードを返す。
 */
export async function vectorSearchFiles(
  repository: FilesRepository,
  queryEmbedding: number[],
  fileIdFilter: string[],
  limit: number
): Promise<FileRecord[]> {
  return repository.vectorSearch(queryEmbedding, fileIdFilter, limit);
}

