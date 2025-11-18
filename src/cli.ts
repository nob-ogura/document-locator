import { Command } from 'commander';
import { loadEnv } from './env';

export function buildCli(): Command {
  const program = new Command();

  program
    .name('document-locator')
    .description('CLI for crawling and searching documents')
    .showHelpAfterError();

  program
    .command('crawl')
    .description('Crawl target sources (e.g. Google Drive) and index documents');

  program
    .command('search')
    .description('Search indexed documents using semantic search');

  return program;
}

export function runCli(argv: string[]): void {
  // `.env` から環境変数を読み込む。
  // `.env` が存在しない場合は何もしない。
  loadEnv();

  const program = buildCli();
  program.parse(argv);
}
