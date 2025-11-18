const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('CLI fails to start when required env variables are missing', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-env-validation');

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  // `.env` に GOOGLE_DRIVE_TARGET_FOLDER_ID を定義しない
  const content = [
    '# Missing GOOGLE_DRIVE_TARGET_FOLDER_ID on purpose',
    'LLM_API_KEY=dummy-llm-key',
    'SUPABASE_URL=https://example.supabase.co',
    'SUPABASE_ANON_KEY=dummy-supabase-key',
    'GDRIVE_MCP_SERVER_URL=https://gdrive.example',
  ].join('\n');

  fs.writeFileSync(envPath, content);

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      // CLI に使用する .env のパスを指定する
      childEnv.DOCUMENT_LOCATOR_ENV_PATH = envPath;

      const child = spawn('node', [binPath, 'crawl'], {
        cwd: projectRoot,
        env: childEnv,
      });

      let stderr = '';

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        try {
          assert.notStrictEqual(
            code,
            0,
            `expected non-zero exit code when required env vars are missing, got ${code}`
          );
          assert.ok(
            stderr.includes('必須の環境変数が不足しています'),
            'stderr should contain missing env error message'
          );
          resolve();
        } catch (error) {
          error.stderr = stderr;
          reject(error);
        }
      });
    });
  } finally {
    if (originalEnvContent !== null) {
      fs.writeFileSync(envPath, originalEnvContent);
    } else if (fs.existsSync(envPath)) {
      fs.unlinkSync(envPath);
    }
  }
});
