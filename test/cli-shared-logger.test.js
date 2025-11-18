const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('crawl and search CLI use shared logger format', async () => {
  const projectRoot = path.resolve(__dirname, '..');
  const binPath = path.resolve(projectRoot, 'bin', 'document-locator');
  const envPath = path.resolve(projectRoot, '.env.cli-shared-logger');

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

  const logLinePattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z (INFO|DEBUG|ERROR) .+/;

  async function runCli(args) {
    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.GOOGLE_DRIVE_TARGET_FOLDER_ID;
      delete childEnv['GOOGLE_DRIVE_TARGET_FOLDER_ID'];
      childEnv.DOCUMENT_LOCATOR_ENV_PATH = envPath;

      const child = spawn('node', [binPath, ...args], {
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
        if (code !== 0) {
          const error = new Error(
            `CLI exited with code ${code}, stderr: ${stderr}`
          );
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  }

  try {
    const crawlResult = await runCli(['crawl']);
    const searchResult = await runCli(['search', 'test']);

    function extractInfoLine(output, label) {
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      assert.ok(lines.length > 0, `${label} should produce at least one log`);

      const infoLines = lines.filter((line) => line.includes('INFO'));

      assert.ok(
        infoLines.length === 1,
        `${label} should produce exactly one INFO log line, got ${infoLines.length}`
      );

      const infoLine = infoLines[0];

      assert.ok(
        logLinePattern.test(infoLine),
        `${label} INFO log line should have timestamp, level and message format, got: ${infoLine}`
      );

      assert.ok(
        !output.includes('DEBUG'),
        `${label} output should not contain DEBUG logs when LOG_LEVEL=info`
      );

      return infoLine;
    }

    const crawlInfoLine = extractInfoLine(crawlResult.stdout, 'crawl CLI');
    const searchInfoLine = extractInfoLine(searchResult.stdout, 'search CLI');

    // 2つの INFO ログ行が同じフォーマット (timestamp + level + message) であることを確認する。
    // 正確なメッセージ内容は異なっていてよいが、構造は同じである必要がある。
    function splitLog(line) {
      const [timestamp, level, ...messageParts] = line.split(' ');
      return { timestamp, level, message: messageParts.join(' ') };
    }

    const crawlParts = splitLog(crawlInfoLine);
    const searchParts = splitLog(searchInfoLine);

    assert.ok(
      /^\d{4}-\d{2}-\d{2}T/.test(crawlParts.timestamp),
      `crawl timestamp should look like ISO string, got: ${crawlParts.timestamp}`
    );
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T/.test(searchParts.timestamp),
      `search timestamp should look like ISO string, got: ${searchParts.timestamp}`
    );

    assert.strictEqual(
      crawlParts.level,
      'INFO',
      `crawl log level should be INFO, got: ${crawlParts.level}`
    );
    assert.strictEqual(
      searchParts.level,
      'INFO',
      `search log level should be INFO, got: ${searchParts.level}`
    );
  } finally {
    if (originalEnvContent !== null) {
      fs.writeFileSync(envPath, originalEnvContent);
    } else if (fs.existsSync(envPath)) {
      fs.unlinkSync(envPath);
    }
  }
});

