const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('Embedding ベクトルと file_id リストを指定して関連度上位 N 件を取得できる', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const repo = new files.InMemoryFilesRepository();

  const records = [
    {
      fileId: 'file-1',
      fileName: 'file-1.txt',
      summary: 'first',
      keywords: 'first',
      embedding: [1, 0],
    },
    {
      fileId: 'file-2',
      fileName: 'file-2.txt',
      summary: 'second',
      keywords: 'second',
      embedding: [0.8, 0.2],
    },
    {
      fileId: 'file-3',
      fileName: 'file-3.txt',
      summary: 'third',
      keywords: 'third',
      embedding: [0, 1],
    },
  ];

  for (const record of records) {
    // T4 の upsert 関数を通じてレコードを作成する
    // eslint-disable-next-line no-await-in-loop
    await files.upsertFileRecord(repo, record);
  }

  const queryEmbedding = [1, 0];

  // file-1 と file-2 だけを対象とするフィルタ
  const filterFileIds = ['file-1', 'file-2'];

  const results = await files.vectorSearchFiles(
    repo,
    queryEmbedding,
    filterFileIds,
    2
  );

  assert.ok(Array.isArray(results), 'results should be an array');
  assert.ok(
    results.length <= 2,
    'number of results should be at most N=2'
  );

  const resultFileIds = results.map((r) => r.fileId);

  // 返却される file_id はフィルタに含まれるものだけであること
  for (const fileId of resultFileIds) {
    assert.ok(
      filterFileIds.includes(fileId),
      `result fileId ${fileId} should be included in filter list`
    );
  }

  // 類似度の高い順 (file-1 の方が file-2 よりクエリに近い) に並んでいること
  assert.deepStrictEqual(
    resultFileIds,
    ['file-1', 'file-2'],
    'results should be ordered by similarity to query embedding'
  );
});

test('ベクトル検索の対象から削除フラグ true のレコードが除外される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const repo = new files.InMemoryFilesRepository();

  const activeRecord = {
    fileId: 'active-1',
    fileName: 'active-1.txt',
    summary: 'active',
    keywords: 'active',
    embedding: [1, 0],
    isDeleted: false,
  };

  const deletedRecord = {
    fileId: 'deleted-1',
    fileName: 'deleted-1.txt',
    summary: 'deleted',
    keywords: 'deleted',
    embedding: [0.9, 0.1],
    isDeleted: true,
  };

  await files.upsertFileRecord(repo, activeRecord);
  await files.upsertFileRecord(repo, deletedRecord);

  const results = await files.vectorSearchFiles(
    repo,
    [1, 0],
    ['active-1', 'deleted-1'],
    10
  );

  const resultFileIds = results.map((r) => r.fileId);

  assert.deepStrictEqual(
    resultFileIds,
    ['active-1'],
    'vector search should exclude logically deleted records'
  );

  assert.ok(
    results.every((r) => r.isDeleted === false),
    'all results should have isDeleted=false'
  );
});

