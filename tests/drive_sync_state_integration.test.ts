import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildConnectionString } from "../scripts/db-apply.mjs";

const supabaseUrl = process.env.SUPABASE_URL;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;

if (!supabaseUrl || !dbPassword) {
  throw new Error(
    "Integration test needs SUPABASE_URL and SUPABASE_DB_PASSWORD in the environment",
  );
}

describe("drive_sync_state integration", () => {
  const connectionString = buildConnectionString(supabaseUrl, dbPassword);
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  const ddlPath = resolve("sql/002_drive_sync_state.sql");

  beforeAll(async () => {
    const ddl = await readFile(ddlPath, "utf8");
    await client.connect();
    await client.query(ddl);
  });

  beforeEach(async () => {
    await client.query("TRUNCATE TABLE drive_sync_state;");
  });

  afterAll(async () => {
    await client.end();
  });

  it("creates table with expected columns, primary key, and check constraint", async () => {
    const { rows: columnRows } = await client.query<{
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
        AND c.relname = 'drive_sync_state'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum;
      `,
    );

    const columnsByName = Object.fromEntries(
      columnRows.map((row) => [
        row.column_name,
        { type: row.formatted_type, notNull: row.not_null },
      ]),
    );

    expect(columnsByName).toMatchObject({
      id: { type: "text", notNull: true },
      drive_modified_at: { type: "timestamp with time zone", notNull: true },
    });

    const { rows: pkRows } = await client.query<{ attname: string }>(
      `
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = 'public.drive_sync_state'::regclass
        AND i.indisprimary;
      `,
    );

    expect(pkRows.map((row) => row.attname)).toEqual(["id"]);

    const { rows: checkRows } = await client.query<{ definition: string }>(
      `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.drive_sync_state'::regclass
        AND contype = 'c';
      `,
    );

    const hasGlobalCheck = checkRows.some((row) => /id\s*=\s*'global'/i.test(row.definition));
    expect(hasGlobalCheck).toBe(true);
  });

  it("rejects duplicate rows with unique violation", async () => {
    await client.query(
      "INSERT INTO drive_sync_state (drive_modified_at) VALUES ('2024-01-01T00:00:00Z');",
    );

    await expect(
      client.query(
        "INSERT INTO drive_sync_state (drive_modified_at) VALUES ('2024-01-01T00:00:00Z');",
      ),
    ).rejects.toThrow(/duplicate key value/i);
  });

  it("enforces NOT NULL on drive_modified_at", async () => {
    await expect(
      client.query("INSERT INTO drive_sync_state (id, drive_modified_at) VALUES ('global', NULL);"),
    ).rejects.toThrow(/null value in column "drive_modified_at"/i);
  });
});
