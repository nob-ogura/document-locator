declare const process: any;

import {
  filterActiveFilesForVectorSearch,
  type FileMetadata,
  type FileRecord,
  type FilesRepository,
} from './files';
import { getSupabaseClient } from './supabase';

type SupabaseClientLike = {
  from(table: string): SupabaseQueryBuilderLike;
};

type SupabaseQueryBuilderLike = {
  upsert(values: any, options?: { onConflict?: string }): {
    select(): {
      single(): Promise<{ data: any | null; error: any | null }>;
    };
  };
  select(columns?: string): SupabaseQueryBuilderLike;
  eq(column: string, value: any): SupabaseQueryBuilderLike;
  single(): Promise<{ data: any | null; error: any | null }>;
};

function mapRowToFileRecord(row: any): FileRecord {
  return {
    fileId: row.file_id,
    fileName: row.file_name,
    summary: row.summary ?? undefined,
    keywords: row.keywords ?? undefined,
    embedding: row.embedding ?? [],
    isDeleted: row.is_deleted ?? false,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
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

export class SupabaseFilesRepository implements FilesRepository {
  private clientPromise: Promise<SupabaseClientLike> | null = null;

  private async getClient(): Promise<SupabaseClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { config } = getSupabaseClient();
        const supabaseModule = await import('@supabase/supabase-js');
        const createClient =
          (supabaseModule as any).createClient ?? (supabaseModule as any).default;

        if (typeof createClient !== 'function') {
          throw new Error(
            'Supabase クライアントを初期化できませんでした (@supabase/supabase-js の createClient が見つかりません)'
          );
        }

        const client = createClient(config.url, config.apiKey);
        return client as SupabaseClientLike;
      })();
    }

    return this.clientPromise;
  }

  async upsert(metadata: FileMetadata): Promise<FileRecord> {
    const client = await this.getClient();

    const { data, error } = await client
      .from('files')
      .upsert(
        {
          file_id: metadata.fileId,
          file_name: metadata.fileName,
          summary: metadata.summary ?? null,
          keywords: metadata.keywords ?? null,
          embedding: metadata.embedding,
          is_deleted: metadata.isDeleted ?? false,
        },
        { onConflict: 'file_id' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(
        `Supabase upsert failed: ${error.message ?? String(error)}`
      );
    }

    if (!data) {
      throw new Error('Supabase upsert did not return a row');
    }

    return mapRowToFileRecord(data);
  }

  async findByFileId(fileId: string): Promise<FileRecord | null> {
    const client = await this.getClient();

    const { data, error } = await client
      .from('files')
      .select('*')
      .eq('file_id', fileId)
      .single();

    if (error) {
      const code =
        typeof error.code === 'string' ? error.code : (error.status as any);

      if (code === 'PGRST116' || code === 406) {
        return null;
      }

      throw new Error(
        `Supabase select failed: ${error.message ?? String(error)}`
      );
    }

    if (!data) {
      return null;
    }

    return mapRowToFileRecord(data);
  }

  async markAsDeleted(fileId: string): Promise<FileRecord> {
    const existing = await this.findByFileId(fileId);

    if (!existing) {
      throw new Error(`File not found for logical delete: ${fileId}`);
    }

    const metadata: FileMetadata = {
      fileId: existing.fileId,
      fileName: existing.fileName,
      summary: existing.summary,
      keywords: existing.keywords,
      embedding: existing.embedding,
      isDeleted: true,
    };

    return this.upsert(metadata);
  }

  async vectorSearch(
    queryEmbedding: number[],
    fileIdFilter: string[],
    limit: number
  ): Promise<FileRecord[]> {
    const client = (await this.getClient()) as any;

    let query = client.from('files').select('*');

    if (fileIdFilter.length > 0) {
      query = query.in('file_id', fileIdFilter);
    }

    // Supabase 側では is_deleted=false でフィルタしつつ、
    // 念のためアプリ側でも filterActiveFilesForVectorSearch を適用する。
    query = query.eq('is_deleted', false);

    const { data, error } = await query;

    if (error) {
      throw new Error(
        `Supabase vector search select failed: ${
          error.message ?? String(error)
        }`
      );
    }

    const rows: any[] = Array.isArray(data) ? data : data ? [data] : [];
    const records = rows.map(mapRowToFileRecord);
    const activeRecords = filterActiveFilesForVectorSearch(records);

    const sorted = sortRecordsByEmbeddingSimilarity(
      activeRecords,
      queryEmbedding
    );

    const safeLimit = limit > 0 ? limit : 0;
    return sorted.slice(0, safeLimit);
  }
}
