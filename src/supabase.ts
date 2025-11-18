declare const process: any;
declare const URL: any;

import { getLogger } from './logger';

export class SupabaseConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConnectionError';
  }
}

export interface SupabaseConfig {
  url: string;
  apiKey: string;
}

export function getSupabaseConfig(env: {
  [key: string]: string | undefined;
} = process.env): SupabaseConfig {
  const url = env.SUPABASE_URL ?? env['SUPABASE_URL'];
  const apiKey = env.SUPABASE_ANON_KEY ?? env['SUPABASE_ANON_KEY'];

  if (!url || !apiKey) {
    const logger = getLogger();
    logger.error('Supabase 接続情報が不足しています');
    throw new Error('Missing Supabase connection environment variables');
  }

  return { url, apiKey };
}

function validateSupabaseConnection(config: SupabaseConfig): void {
  try {
    const parsedUrl = new URL(config.url);
    const hostname = parsedUrl.hostname as string;

    const isSupabaseHost =
      hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.com');

    if (!isSupabaseHost) {
      throw new SupabaseConnectionError(
        '無効な Supabase URL が設定されています (hostname が supabase.co / supabase.com ではありません)'
      );
    }
  } catch (error) {
    if (error instanceof SupabaseConnectionError) {
      throw error;
    }

    throw new SupabaseConnectionError('Supabase URL の形式が不正です');
  }
}

export interface SupabaseClient {
  readonly config: SupabaseConfig;
}

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const logger = getLogger();
  const config = getSupabaseConfig(process.env);

  validateSupabaseConnection(config);

  logger.debug('Supabase client initialized');

  cachedClient = { config };
  return cachedClient;
}
