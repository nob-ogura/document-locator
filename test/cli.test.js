const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'document-locator');

function runCli(args = ['--help']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args]);

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('document-locator --help exits with code 0 and mentions crawl/search subcommands', async () => {
  const { code, stdout, stderr } = await runCli(['--help']);

  assert.strictEqual(code, 0, `expected exit code 0, got ${code}, stderr: ${stderr}`);

  assert.match(
    stdout,
    /crawl/i,
    'expected help output to mention "crawl" subcommand',
  );

  assert.match(
    stdout,
    /search/i,
    'expected help output to mention "search" subcommand',
  );
});

