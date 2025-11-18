declare const process: any;

import type { FileMetadata, FileRecord, FilesRepository } from './files';
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
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
}

