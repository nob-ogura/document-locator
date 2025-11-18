declare const process: any;

import { Command } from 'commander';
import { loadEnv, validateRequiredEnv } from './env';
import { getLogger } from './logger';

export function buildCli(): Command {
  const program = new Command();
  const logger = getLogger();

  program
    .name('document-locator')
    .description('CLI for crawling and searching documents')
    .showHelpAfterError();

  program
    .command('crawl')
    .description('Crawl target sources (e.g. Google Drive) and index documents')
    .action(() => {
      logger.debug('Starting crawl command');
      logger.info('Crawl command executed');
    });

  program
    .command('search')
    .description('Search indexed documents using semantic search')
    .action(() => {
      logger.debug('Starting search command');
      logger.info('Search command executed');
    });

  return program;
}

export function runCli(argv: string[]): void {
  // `.env` から環境変数を読み込む。
  // テストなどで別のパスを使いたい場合は
  // `DOCUMENT_LOCATOR_ENV_PATH` で上書きできる。
  const envFilePath = process.env.DOCUMENT_LOCATOR_ENV_PATH;
  if (envFilePath) {
    loadEnv({ envFilePath });
  } else {
    // `.env` が存在しない場合は何もしない。
    loadEnv();
  }

  // 起動時に必須環境変数をバリデーションする。
  // 必須変数が不足している場合はエラーメッセージを出力し、非 0 終了とする。
  validateRequiredEnv();

  const program = buildCli();
  program.parse(argv);
}
