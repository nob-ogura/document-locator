declare const process: any;

import { getLogger } from './logger';

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

  logger.debug('Supabase client initialized');

  cachedClient = { config };
  return cachedClient;
}

