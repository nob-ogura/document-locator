const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('Drive 側で削除されたファイルに削除マークが付与される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const repo = new files.InMemoryFilesRepository();

  const metadata = {
    fileId: 'to-delete',
    fileName: 'to-delete.txt',
    summary: 'to be deleted',
    keywords: 'delete,me',
    embedding: [0.1, 0.2, 0.3],
  };

  const inserted = await files.upsertFileRecord(repo, metadata);

  assert.strictEqual(
    inserted.isDeleted,
    false,
    'newly inserted record should not be marked as deleted'
  );

  const before = await repo.findByFileId('to-delete');
  assert.ok(before, 'record should exist before delete mark');
  assert.strictEqual(before.isDeleted, false);

  const deleted = await files.markFileAsDeleted(repo, 'to-delete');

  assert.strictEqual(
    deleted.isDeleted,
    true,
    'markFileAsDeleted should return record with isDeleted=true'
  );

  const after = await repo.findByFileId('to-delete');
  assert.ok(after, 'record should still exist after delete mark');
  assert.strictEqual(after.isDeleted, true, 'record in repository should have isDeleted=true');
});


test('ベクトル検索の対象から削除フラグ true のレコードが除外される', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const now = new Date();

  const candidates = [
    {
      fileId: 'active-1',
      fileName: 'active-1.txt',
      summary: 'active record 1',
      keywords: 'active',
      embedding: [0.1, 0.2, 0.3],
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      fileId: 'deleted-1',
      fileName: 'deleted-1.txt',
      summary: 'deleted record',
      keywords: 'deleted',
      embedding: [0.4, 0.5, 0.6],
      isDeleted: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const filtered = files.filterActiveFilesForVectorSearch(candidates);

  assert.deepStrictEqual(
    filtered.map((r) => r.fileId),
    ['active-1'],
    'only records with isDeleted=false should be returned'
  );
});

