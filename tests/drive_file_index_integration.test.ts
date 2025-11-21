import process from "node:process";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDriveFileIndex, buildConnectionString } from "../scripts/db-apply.mjs";

const supabaseUrl = process.env.SUPABASE_URL;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const runIntegration = process.env.RUN_SUPABASE_TESTS === "true" && !!supabaseUrl && !!dbPassword;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Expected ${name} to be set when RUN_SUPABASE_TESTS=true`);
  }

  return value;
}

if (!runIntegration) {
  console.warn(
    "Skipping drive_file_index integration tests: set RUN_SUPABASE_TESTS=true and provide SUPABASE_URL and SUPABASE_DB_PASSWORD to enable",
  );
}

describe.skipIf(!runIntegration)("drive_file_index integration", () => {
  let connectionString: string;
  let client: Client;

  beforeAll(async () => {
    const supabaseUrlValue = requireEnv("SUPABASE_URL", supabaseUrl);
    const dbPasswordValue = requireEnv("SUPABASE_DB_PASSWORD", dbPassword);
    connectionString = buildConnectionString(supabaseUrlValue, dbPasswordValue);
    client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    await applyDriveFileIndex({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("creates table with expected columns and NOT NULL constraints", async () => {
    const { rows } = await client.query<{
      column_name: string;
      formatted_type: string;
      not_null: boolean;
    }>(
      `
      SELECT
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
        a.attnotnull AS not_null
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND c.relname = 'drive_file_index'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
      `,
    );

    const byName = Object.fromEntries(
      rows.map((row) => [row.column_name, { type: row.formatted_type, notNull: row.not_null }]),
    );

    expect(byName).toMatchObject({
      file_id: { type: "text", notNull: true },
      file_name: { type: "text", notNull: true },
      summary: { type: "text", notNull: true },
      keywords: { type: "text[]", notNull: false },
      embedding: { type: "vector(1536)", notNull: true },
      drive_modified_at: { type: "timestamp with time zone", notNull: true },
      mime_type: { type: "text", notNull: true },
    });
  });

  it("sets file_id as the primary key", async () => {
    const { rows } = await client.query<{ attname: string }>(
      `
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = 'public.drive_file_index'::regclass
        AND i.indisprimary;
      `,
    );

    expect(rows.map((row) => row.attname)).toEqual(["file_id"]);
  });

  it("creates btree index on drive_modified_at and ivfflat index on embedding", async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'drive_file_index';
      `,
    );

    const indexByName = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));

    const modifiedAt = indexByName.drive_file_index_drive_modified_at_idx;
    expect(modifiedAt).toBeDefined();
    expect(modifiedAt).toMatch(/USING\s+btree/i);
    expect(modifiedAt).toMatch(/\(\s*drive_modified_at\s*\)/i);

    const embedding = indexByName.drive_file_index_embedding_idx;
    expect(embedding).toBeDefined();
    expect(embedding).toMatch(/USING\s+ivfflat/i);
    expect(embedding).toMatch(/embedding\s+vector_cosine_ops/i);
    expect(embedding).toMatch(/lists\s*=\s*'?100'?/i);
  });
});
