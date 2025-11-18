const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('LOG_LEVEL=info のときに DEBUG ログが抑制される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-logging-info');

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  const content = [
    'GOOGLE_DRIVE_TARGET_FOLDER_ID=folder1,folder2',
    'LLM_API_KEY=dummy-llm-key',
    'SUPABASE_URL=https://example.supabase.co',
    'SUPABASE_ANON_KEY=dummy-supabase-key',
    'GDRIVE_MCP_SERVER_URL=https://gdrive.example',
    'LOG_LEVEL=info',
  ].join('\n');

  fs.writeFileSync(envPath, content);

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      delete childEnv['GOOGLE_DRIVE_TARGET_FOLDER_ID'];
      childEnv.DOCUMENT_LOCATOR_ENV_PATH = envPath;

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
          assert.strictEqual(
            code,
            0,
            `expected exit code 0, got ${code}, stderr: ${stderr}`
          );

          assert.ok(
            stdout.includes('INFO'),
            'stdout should contain INFO level log message'
          );

          assert.ok(
            !stdout.includes('DEBUG'),
            'stdout should not contain DEBUG level log message when LOG_LEVEL=info'
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

test('ERROR ログがタイムスタンプ・レベル・メッセージ付きで stderr に出力される', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-logging-error');

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  const content = [
    '# Missing GOOGLE_DRIVE_TARGET_FOLDER_ID on purpose',
    'LLM_API_KEY=dummy-llm-key',
    'SUPABASE_URL=https://example.supabase.co',
    'SUPABASE_ANON_KEY=dummy-supabase-key',
    'GDRIVE_MCP_SERVER_URL=https://gdrive.example',
    'LOG_LEVEL=info',
  ].join('\n');

  fs.writeFileSync(envPath, content);

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      delete childEnv['GOOGLE_DRIVE_TARGET_FOLDER_ID'];
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
            stderr.includes('ERROR'),
            'stderr should contain ERROR level indicator'
          );

          assert.ok(
            stderr.includes('必須の環境変数が不足しています'),
            'stderr should contain the error message about missing required env vars'
          );

          const hasTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(
            stderr
          );
          assert.ok(hasTimestamp, 'stderr should contain an ISO-like timestamp');

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
