import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_DB_PASSWORD"];
const DEFAULT_SQL_DIR = resolve("sql");

export const ensureEnv = (env = process.env) => {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
};

export const buildConnectionString = (supabaseUrl, dbPassword) => {
  const { hostname } = new URL(supabaseUrl);
  const dbHost = hostname.startsWith("db.") ? hostname : `db.${hostname}`;

  return `postgresql://postgres:${encodeURIComponent(dbPassword)}@${dbHost}:5432/postgres`;
};

const applySql = async (client, sqlPath) => {
  const sql = await readFile(sqlPath, "utf8");
  await client.query(sql);
};

export const applyDriveFileIndex = async ({
  connectionString,
  sqlPath = resolve("sql/001_drive_file_index.sql"),
} = {}) => {
  if (!connectionString) {
    ensureEnv();
    const supabaseUrl = process.env.SUPABASE_URL;
    const dbPassword = process.env.SUPABASE_DB_PASSWORD;
    connectionString = buildConnectionString(supabaseUrl, dbPassword);
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await applySql(client, sqlPath);
  } finally {
    await client.end();
  }
};

const collectSqlFiles = async (sqlDir = DEFAULT_SQL_DIR) => {
  const entries = await readdir(sqlDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => resolve(sqlDir, entry.name))
    .sort();
};

export const applyAllSqlFiles = async ({ connectionString, sqlDir = DEFAULT_SQL_DIR } = {}) => {
  if (!connectionString) {
    ensureEnv();
    const supabaseUrl = process.env.SUPABASE_URL;
    const dbPassword = process.env.SUPABASE_DB_PASSWORD;
    connectionString = buildConnectionString(supabaseUrl, dbPassword);
  }

  const sqlFiles = await collectSqlFiles(sqlDir);
  if (sqlFiles.length === 0) {
    throw new Error(`No SQL files found in ${sqlDir}`);
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    for (const file of sqlFiles) {
      await applySql(client, file);
      console.log(`Applied ${file}`);
    }
  } finally {
    await client.end();
  }
};

const main = async () => {
  ensureEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  const connectionString = buildConnectionString(supabaseUrl, dbPassword);
  await applyAllSqlFiles({ connectionString });
  console.log(`Applied SQL files in ${DEFAULT_SQL_DIR} to ${supabaseUrl}`);
};

const isEntryPoint = () => {
  if (!process.argv[1]) return false;
  const current = fileURLToPath(import.meta.url);
  return process.argv[1] === current || pathToFileURL(process.argv[1]).href === import.meta.url;
};

if (isEntryPoint()) {
  main().catch((error) => {
    console.error("db:apply failed", error);
    process.exitCode = 1;
  });
}
