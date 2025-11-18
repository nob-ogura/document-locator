declare var require: any;
declare const process: any;

const fs = require('node:fs');
const path = require('node:path');

export type EnvMap = Record<string, string>;

export interface LoadEnvOptions {
  /**
   * 読み込む .env ファイルのパス。
   * 指定しない場合は `process.cwd()/.env` を使用する。
   */
  envFilePath?: string;
  /**
   * `process.env` に既に同名のキーが存在する場合に上書きするかどうか。
   * デフォルトでは「存在しないキーのみ」を設定する。
   */
  overrideProcessEnv?: boolean;
}

const DEFAULT_ENV_FILE_NAME = '.env';

function resolveEnvPath(envFilePath?: string): string {
  if (!envFilePath) {
    return path.resolve(process.cwd(), DEFAULT_ENV_FILE_NAME);
  }

  if (path.isAbsolute(envFilePath)) {
    return envFilePath;
  }

  return path.resolve(process.cwd(), envFilePath);
}

export function loadEnv(options: LoadEnvOptions = {}): EnvMap {
  const envPath = resolveEnvPath(options.envFilePath);

  if (!fs.existsSync(envPath)) {
    return {};
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const parsed: EnvMap = {};

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');

    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();

    if (!key) {
      continue;
    }

    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;

    const shouldOverride =
      options.overrideProcessEnv === true ||
      (options.overrideProcessEnv !== false && !(key in process.env));

    if (shouldOverride) {
      process.env[key] = value;
    }
  }

  return parsed;
}

export function getGoogleDriveTargetFolderIds(
  env: { [key: string]: string | undefined } = process.env
): string[] {
  const raw =
    env.GOOGLE_DRIVE_TARGET_FOLDER_ID ?? env['GOOGLE_DRIVE_TARGET_FOLDER_ID'];

  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function validateRequiredEnv(env: {
  [key: string]: string | undefined;
} = process.env): void {
  const folderIds = getGoogleDriveTargetFolderIds(env);

  if (folderIds.length === 0) {
    // ロガーは T5 以降で導入予定のため、現時点では直接 stderr に出力する。
    // T5 実装時に ERROR レベルのログ出力に差し替える。
    // eslint-disable-next-line no-console
    console.error('必須の環境変数が不足しています');
    // 非 0 ステータスでプロセスを終了させる。
    // ロガー導入後は ERROR レベルのログ出力に置き換える。
    process.exit(1);
  }
}
