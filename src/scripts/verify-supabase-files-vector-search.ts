declare const process: any;

import { loadEnv } from '../env';
import {
  upsertFileRecord,
  markFileAsDeleted,
  vectorSearchFiles,
  type FileMetadata,
  type FileRecord,
} from '../files';
import { SupabaseFilesRepository } from '../files-supabase';

const EMBEDDING_DIMENSION = 1536;

function createEmbedding(headValues: number[]): number[] {
  const embedding = new Array(EMBEDDING_DIMENSION).fill(0);

  for (let i = 0; i < headValues.length && i < EMBEDDING_DIMENSION; i += 1) {
    embedding[i] = headValues[i];
  }

  return embedding;
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    // eslint-disable-next-line no-console
    console.error(`Supabase files vector search verification failed: ${message}`);
    process.exit(1);
  }
}

function assertAllFileIdsInFilter(
  records: FileRecord[],
  filter: string[],
  label: string
): void {
  const filterSet = new Set(filter);

  for (const record of records) {
    assertCondition(
      filterSet.has(record.fileId),
      `${label}: expected fileId "${record.fileId}" to be included in filter [${filter.join(
        ', '
      )}]`
    );
  }
}

function assertNoDeletedRecords(
  records: FileRecord[],
  label: string
): void {
  for (const record of records) {
    assertCondition(
      !record.isDeleted,
      `${label}: expected isDeleted=false for fileId="${record.fileId}", but got true`
    );
  }
}

async function main(): Promise<void> {
  const envPath = process.env.DOCUMENT_LOCATOR_ENV_PATH;

  if (envPath) {
    loadEnv({ envFilePath: envPath, overrideProcessEnv: true });
  } else {
    loadEnv();
  }

  const repository = new SupabaseFilesRepository();

  const baseFileId =
    process.env.SUPABASE_FILES_TEST_FILE_ID ??
    `supabase-files-vector-search-test-${Date.now()}`;

  const fileId1 = `${baseFileId}-1`;
  const fileId2 = `${baseFileId}-2`;
  const fileId3 = `${baseFileId}-3`;

  const metadata1: FileMetadata = {
    fileId: fileId1,
    fileName: 'supabase-files-vector-search-test-1.txt',
    summary: 'vector search test 1 (closest)',
    keywords: 'vector-search,test,1',
    embedding: createEmbedding([1, 0, 0]),
    isDeleted: false,
  };

  const metadata2: FileMetadata = {
    fileId: fileId2,
    fileName: 'supabase-files-vector-search-test-2.txt',
    summary: 'vector search test 2 (second closest)',
    keywords: 'vector-search,test,2',
    embedding: createEmbedding([0.8, 0.2, 0]),
    isDeleted: false,
  };

  const metadata3: FileMetadata = {
    fileId: fileId3,
    fileName: 'supabase-files-vector-search-test-3.txt',
    summary: 'vector search test 3 (far)',
    keywords: 'vector-search,test,3',
    embedding: createEmbedding([0, 1, 0]),
    isDeleted: false,
  };

  await upsertFileRecord(repository, metadata1);
  await upsertFileRecord(repository, metadata2);
  await upsertFileRecord(repository, metadata3);

  const deletedRecord = await markFileAsDeleted(repository, fileId3);

  assertCondition(
    deletedRecord.isDeleted === true,
    `expected fileId="${fileId3}" to be logically deleted (isDeleted=true), but got false`
  );

  const queryEmbedding = createEmbedding([1, 0, 0]);

  const fileIdFilterForOrder = [fileId1, fileId2];
  const fileIdFilterWithDeleted = [fileId1, fileId3];
  const limit = 2;

  const orderedResults = await vectorSearchFiles(
    repository,
    queryEmbedding,
    fileIdFilterForOrder,
    limit
  );

  assertCondition(
    orderedResults.length > 0,
    'vector search with non-deleted records returned no results'
  );

  assertCondition(
    orderedResults.length <= limit,
    `expected result length <= ${limit} for non-deleted records, got ${orderedResults.length}`
  );

  assertAllFileIdsInFilter(
    orderedResults,
    fileIdFilterForOrder,
    'non-deleted filter'
  );

  assertNoDeletedRecords(orderedResults, 'non-deleted filter');

  if (orderedResults.length >= 2) {
    const first = orderedResults[0];
    const second = orderedResults[1];

    assertCondition(
      first.fileId === fileId1 && second.fileId === fileId2,
      `expected ordered results [${fileId1}, ${fileId2}] for non-deleted filter, got [${orderedResults
        .map((record) => record.fileId)
        .join(', ')}]`
    );
  } else {
    const first = orderedResults[0];

    assertCondition(
      first.fileId === fileId1,
      `expected first result to be "${fileId1}" for non-deleted filter, got "${first.fileId}"`
    );
  }

  const resultsWithDeleted = await vectorSearchFiles(
    repository,
    queryEmbedding,
    fileIdFilterWithDeleted,
    limit
  );

  assertCondition(
    resultsWithDeleted.length <= limit,
    `expected result length <= ${limit} for filter including logically deleted record, got ${resultsWithDeleted.length}`
  );

  assertAllFileIdsInFilter(
    resultsWithDeleted,
    fileIdFilterWithDeleted,
    'filter including logically deleted record'
  );

  assertNoDeletedRecords(
    resultsWithDeleted,
    'filter including logically deleted record'
  );

  for (const record of resultsWithDeleted) {
    assertCondition(
      record.fileId !== fileId3,
      `expected logically deleted record fileId="${fileId3}" not to be included in vector search results`
    );
  }

  // eslint-disable-next-line no-console
  console.log('Supabase files vector search verification result:', {
    queryEmbeddingPreview: queryEmbedding.slice(0, 3),
    fileIdFilterForOrder,
    fileIdFilterWithDeleted,
    orderedResultFileIds: orderedResults.map((record) => record.fileId),
    resultsWithDeletedFileIds: resultsWithDeleted.map(
      (record) => record.fileId
    ),
  });

  process.exit(0);
}

main().catch((error: unknown) => {
  const message =
    error && typeof (error as any).message === 'string'
      ? (error as any).message
      : String(error);

  // eslint-disable-next-line no-console
  console.error(
    'Supabase files vector search verification failed with error:',
    message
  );
  process.exit(1);
});

