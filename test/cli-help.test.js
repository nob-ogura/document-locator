const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('document-locator --help shows crawl and search subcommands', async () => {
  const binPath = path.resolve(__dirname, '..', 'bin', 'document-locator');

  await new Promise((resolve, reject) => {
    const child = spawn('node', [binPath, '--help']);

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
});

