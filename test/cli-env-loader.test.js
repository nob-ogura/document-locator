const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('CLI starts when required env variables are defined in .env', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-env-loader');

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  const content = [
    'GOOGLE_DRIVE_TARGET_FOLDER_ID=folder1,folder2',
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
      delete childEnv['GOOGLE_DRIVE_TARGET_FOLDER_ID'];
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
          assert.strictEqual(
            code,
            0,
            `expected exit code 0, got ${code}, stderr: ${stderr}`
          );
          assert.ok(
            !stderr.includes('必須の環境変数が不足しています'),
            'stderr should not contain missing env error message'
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
