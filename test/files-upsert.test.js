const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('同一 file_id のレコードが存在しない場合に新規挿入される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const repo = new files.InMemoryFilesRepository();

  const before = await repo.getAllRecords();
  assert.strictEqual(
    before.length,
    0,
    'initially files table should be empty'
  );

  const metadata = {
    fileId: 'abc123',
    fileName: 'test.txt',
    summary: 'summary-1',
    keywords: 'kw1,kw2',
    embedding: [0.1, 0.2, 0.3],
  };

  const inserted = await files.upsertFileRecord(repo, metadata);

  assert.strictEqual(inserted.fileId, 'abc123');
  assert.strictEqual(inserted.summary, 'summary-1');

  const after = await repo.getAllRecords();

  assert.strictEqual(
    after.length,
    1,
    'files table should contain exactly one record after insert'
  );

  assert.strictEqual(after[0].fileId, 'abc123');
  assert.strictEqual(after[0].summary, 'summary-1');
});

test('同一 file_id のレコードが存在する場合に更新される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const filesModulePath = path.resolve(projectRoot, 'dist', 'files.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const files = require(filesModulePath);

  const repo = new files.InMemoryFilesRepository();

  const initialMetadata = {
    fileId: 'abc123',
    fileName: 'test.txt',
    summary: 'old',
    keywords: 'kw1',
    embedding: [0.1, 0.2, 0.3],
  };

  await files.upsertFileRecord(repo, initialMetadata);

  const beforeUpdate = await repo.getAllRecords();
  assert.strictEqual(
    beforeUpdate.length,
    1,
    'files table should contain exactly one record before update'
  );
  assert.strictEqual(beforeUpdate[0].summary, 'old');

  const updatedMetadata = {
    ...initialMetadata,
    summary: 'new',
  };

  const updated = await files.upsertFileRecord(repo, updatedMetadata);

  const afterUpdate = await repo.getAllRecords();

  assert.strictEqual(
    afterUpdate.length,
    1,
    'files table should still contain exactly one record after update'
  );

  assert.strictEqual(afterUpdate[0].fileId, 'abc123');
  assert.strictEqual(afterUpdate[0].summary, 'new');

  assert.strictEqual(updated.fileId, 'abc123');
  assert.strictEqual(updated.summary, 'new');
});

