const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('誤った Supabase 接続情報のときに CLI がわかりやすいエラーで終了する', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(
    projectRoot,
    '.env.cli-supabase-connection-error'
  );

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  const content = [
    'GOOGLE_DRIVE_TARGET_FOLDER_ID=folder1,folder2',
    'LLM_API_KEY=dummy-llm-key',
    'SUPABASE_URL=https://invalid-host-for-testing.invalid',
    'SUPABASE_ANON_KEY=dummy-supabase-key',
    'GDRIVE_MCP_SERVER_URL=https://gdrive.example',
    'LOG_LEVEL=debug',
  ].join('\n');

  fs.writeFileSync(envPath, content);

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      delete childEnv['GOOGLE_DRIVE_TARGET_FOLDER_ID'];

      childEnv.DOCUMENT_LOCATOR_ENV_PATH = envPath;
      childEnv.LOG_LEVEL = 'debug';

      const child = spawn('node', [binPath, 'crawl'], {
        cwd: projectRoot,
        env: childEnv,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        try {
          assert.notStrictEqual(
            code,
            0,
            `expected non-zero exit code, got ${code}, stdout: ${stdout}, stderr: ${stderr}`
          );

          assert.ok(
            stderr.includes('Supabase への接続に失敗しました'),
            'stderr should contain a message indicating Supabase connection failure'
          );

          assert.ok(
            stderr.includes('Supabase 接続エラー'),
            'stderr should contain ERROR log about Supabase connection error'
          );

          resolve();
        } catch (error) {
          error.stdout = stdout;
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

