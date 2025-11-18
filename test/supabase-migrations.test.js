const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Supabase migrations enable pgvector and create required tables', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const migrationsDir = path.resolve(projectRoot, 'supabase', 'migrations');

  assert.ok(
    fs.existsSync(migrationsDir),
    'supabase/migrations directory should exist'
  );

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'));

  assert.ok(
    migrationFiles.length > 0,
    'there should be at least one SQL migration file'
  );

  const combinedSql = migrationFiles
    .map((file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    .join('\n')
    .toLowerCase();

  assert.ok(
    combinedSql.includes('create extension if not exists vector'),
    'pgvector extension should be enabled with CREATE EXTENSION IF NOT EXISTS vector'
  );

  assert.ok(
    combinedSql.includes('create table if not exists files'),
    '`files` table should be created with CREATE TABLE IF NOT EXISTS files'
  );

  const requiredFilesColumns = [
    'file_id',
    'file_name',
    'summary',
    'keywords',
    'embedding',
    'updated_at',
    'created_at',
  ];

  for (const column of requiredFilesColumns) {
    assert.ok(
      combinedSql.includes(column),
      `files table should contain column: ${column}`
    );
  }

  assert.ok(
    combinedSql.includes('create table if not exists crawler_state'),
    '`crawler_state` table should be created with CREATE TABLE IF NOT EXISTS crawler_state'
  );

  assert.ok(
    combinedSql.includes('start_page_token'),
    '`crawler_state` table should contain a column to store Start Page Token (e.g. start_page_token)'
  );
});

