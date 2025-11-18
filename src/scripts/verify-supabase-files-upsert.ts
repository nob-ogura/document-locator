declare const process: any;

import { loadEnv } from '../env';
import { upsertFileRecord, type FileMetadata } from '../files';
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
    `supabase-files-test-${Date.now()}`;

  const baseMetadata: FileMetadata = {
    fileId,
    fileName: 'supabase-files-test.txt',
    summary: 'old',
    keywords: 'test',
    embedding: new Array(1536).fill(0),
  };

  await upsertFileRecord(repository, baseMetadata);

  const updatedMetadata: FileMetadata = {
    ...baseMetadata,
    summary: 'new',
  };

  await upsertFileRecord(repository, updatedMetadata);

  const finalRecord = await repository.findByFileId(fileId);

  if (!finalRecord) {
    // eslint-disable-next-line no-console
    console.error(
      `Supabase files upsert verification failed: record with file_id=${fileId} was not found`
    );
    process.exit(1);
  }

  const nonNullRecord = finalRecord!;

  // eslint-disable-next-line no-console
  console.log('Supabase files upsert verification result:', {
    fileId: nonNullRecord.fileId,
    summary: nonNullRecord.summary,
  });

  if (nonNullRecord.summary !== 'new') {
    // eslint-disable-next-line no-console
    console.error(
      `Supabase files upsert verification failed: expected summary "new", got "${nonNullRecord.summary}"`
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
  console.error('Supabase files upsert verification failed with error:', message);
  process.exit(1);
});
