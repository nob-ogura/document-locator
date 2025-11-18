declare const process: any;

import { loadEnv } from '../env';
import {
  upsertFileRecord,
  markFileAsDeleted,
  type FileMetadata,
} from '../files';
import { SupabaseFilesRepository } from '../files-supabase';

async function main(): Promise<void> {
  const envPath = process.env.DOCUMENT_LOCATOR_ENV_PATH;

  if (envPath) {
    loadEnv({ envFilePath: envPath, overrideProcessEnv: true });
  } else {
    loadEnv();
  }

  const repository = new SupabaseFilesRepository();

  const fileId =
    process.env.SUPABASE_FILES_TEST_FILE_ID ??
    `supabase-files-logical-delete-test-${Date.now()}`;

  const baseMetadata: FileMetadata = {
    fileId,
    fileName: 'supabase-files-logical-delete-test.txt',
    summary: 'to be logically deleted',
    keywords: 'logical-delete,test',
    embedding: new Array(1536).fill(0),
    isDeleted: false,
  };

  // 1. まず is_deleted=false の状態で upsert されることを確認する
  await upsertFileRecord(repository, baseMetadata);

  const beforeDeleteNullable = await repository.findByFileId(fileId);

  if (!beforeDeleteNullable) {
    // eslint-disable-next-line no-console
    console.error(
      `Supabase files logical delete verification failed: record with file_id=${fileId} was not found before delete mark`
    );
    process.exit(1);
  }

  const beforeDelete = beforeDeleteNullable as NonNullable<typeof beforeDeleteNullable>;

  if (beforeDelete.isDeleted) {
    // eslint-disable-next-line no-console
    console.error(
      `Supabase files logical delete verification failed: expected isDeleted=false before delete mark, got true`
    );
    process.exit(1);
  }

  // 2. markFileAsDeleted を呼び出して is_deleted=true に更新する
  const deletedRecord = await markFileAsDeleted(repository, fileId);

  const afterDelete = await repository.findByFileId(fileId);

  if (!afterDelete) {
    // eslint-disable-next-line no-console
    console.error(
      `Supabase files logical delete verification failed: record with file_id=${fileId} was not found after delete mark`
    );
    process.exit(1);
  }

  const nonNullRecord = afterDelete!;

  // eslint-disable-next-line no-console
  console.log(
    'Supabase files logical delete verification result:',
    {
      fileId: nonNullRecord.fileId,
      isDeletedBefore: beforeDelete.isDeleted,
      isDeletedAfter: nonNullRecord.isDeleted,
    }
  );

  if (!deletedRecord.isDeleted || !nonNullRecord.isDeleted) {
    // eslint-disable-next-line no-console
    console.error(
      'Supabase files logical delete verification failed: expected isDeleted=true after delete mark'
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  const message =
    error && typeof (error as any).message === 'string'
      ? (error as any).message
      : String(error);

  // eslint-disable-next-line no-console
  console.error(
    'Supabase files logical delete verification failed with error:',
    message
  );
  process.exit(1);
});
