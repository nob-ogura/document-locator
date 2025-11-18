const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('loadEnv が .env ファイルから値を読み込み process.env を設定する', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const envModulePath = path.resolve(projectRoot, 'dist', 'env.js');

  // 環境ローダーモジュールがビルド済みである前提で読み込む
  // (現時点では存在しないため、このテストは実装前は失敗する)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const env = require(envModulePath);

  const tempEnvPath = path.join(projectRoot, '.env.test');

  const originalValue = process.env.GOOGLE_DRIVE_TARGET_FOLDER_ID;

  const content = [
    'GOOGLE_DRIVE_TARGET_FOLDER_ID=folder1,folder2',
    'LLM_API_KEY=dummy-llm-key',
    'SUPABASE_URL=https://example.supabase.co',
    'SUPABASE_ANON_KEY=dummy-supabase-key',
    'GDRIVE_MCP_SERVER_URL=https://gdrive.example',
  ].join('\n');

  fs.writeFileSync(tempEnvPath, content);

  try {
    delete process.env.GOOGLE_DRIVE_TARGET_FOLDER_ID;

    const parsed = env.loadEnv({ envFilePath: tempEnvPath });

    assert.strictEqual(
      parsed.GOOGLE_DRIVE_TARGET_FOLDER_ID,
      'folder1,folder2'
    );
    assert.strictEqual(parsed.LLM_API_KEY, 'dummy-llm-key');
    assert.strictEqual(
      parsed.SUPABASE_URL,
      'https://example.supabase.co'
    );

    assert.strictEqual(
      process.env.GOOGLE_DRIVE_TARGET_FOLDER_ID,
      'folder1,folder2'
    );
  } finally {
    if (fs.existsSync(tempEnvPath)) {
      fs.unlinkSync(tempEnvPath);
    }

    if (originalValue !== undefined) {
      process.env.GOOGLE_DRIVE_TARGET_FOLDER_ID = originalValue;
    } else {
      delete process.env.GOOGLE_DRIVE_TARGET_FOLDER_ID;
    }
  }
});

test('getGoogleDriveTargetFolderIds がカンマ区切りの ID を分割する', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const envModulePath = path.resolve(projectRoot, 'dist', 'env.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const env = require(envModulePath);

  const ids = env.getGoogleDriveTargetFolderIds({
    GOOGLE_DRIVE_TARGET_FOLDER_ID: 'folderA, folderB ,folderC',
  });

  assert.deepStrictEqual(ids, ['folderA', 'folderB', 'folderC']);
});

test('getGoogleDriveTargetFolderIds が環境変数が存在しない場合に空配列を返す', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const envModulePath = path.resolve(projectRoot, 'dist', 'env.js');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const env = require(envModulePath);

  const ids = env.getGoogleDriveTargetFolderIds({});

  assert.deepStrictEqual(ids, []);
});
