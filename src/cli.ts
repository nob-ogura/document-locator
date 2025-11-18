declare const process: any;

import { Command } from 'commander';
import { loadEnv, validateRequiredEnv } from './env';
import { getLogger } from './logger';
import { getSupabaseClient, SupabaseConnectionError } from './supabase';

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
      getSupabaseClient();
      logger.info('Crawl command executed');
    });

  program
    .command('search')
    .description('Search indexed documents using semantic search')
    .action(() => {
      logger.debug('Starting search command');
      getSupabaseClient();
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
  try {
    program.parse(argv);
  } catch (error: any) {
    const logger = getLogger();

    if (error instanceof SupabaseConnectionError) {
      const reason =
        typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : '不明な理由';

      logger.error(`Supabase 接続エラー: ${reason}`);

      // ユーザー向けには、接続に失敗したことと概要のみを標準エラー出力に表示する。
      // eslint-disable-next-line no-console
      console.error(`Supabase への接続に失敗しました: ${reason}`);
    } else {
      const message =
        error && typeof error.message === 'string'
          ? error.message
          : String(error);

      logger.error(`予期しないエラーが発生しました: ${message}`);

      // eslint-disable-next-line no-console
      console.error(
        '予期しないエラーが発生しました。詳細はログを確認してください。'
      );
    }

    process.exit(1);
  }
}
