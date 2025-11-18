const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

test('document-locator --help が crawl と search のサブコマンドを表示する', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-help');

  const originalEnvContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : null;

  const content = ['GOOGLE_DRIVE_TARGET_FOLDER_ID=folder1'].join('\n');

  fs.writeFileSync(envPath, content);

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      // CLI に使用する .env のパスを指定する
      childEnv.DOCUMENT_LOCATOR_ENV_PATH = envPath;

      const child = spawn('node', [binPath, '--help'], {
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
            stdout.toLowerCase().includes('crawl'),
            'help output should mention "crawl" subcommand'
          );
          assert.ok(
            stdout.toLowerCase().includes('search'),
            'help output should mention "search" subcommand'
          );
          resolve();
        } catch (error) {
          // Attach captured output for easier debugging
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
