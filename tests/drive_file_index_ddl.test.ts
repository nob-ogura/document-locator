import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sqlPath = resolve("sql/001_drive_file_index.sql");

const readSql = () => readFileSync(sqlPath, "utf8");

describe("drive_file_index DDL", () => {
  it("exists under sql/ with the expected filename", () => {
    expect(() => readSql()).not.toThrow();
  });

  it("creates drive_file_index table with required columns and primary key", () => {
    const sql = readSql();

    expect(sql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"?vector"?;?/i);
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+drive_file_index/i);
    expect(sql).toMatch(/file_id\s+TEXT\s+PRIMARY\s+KEY/i);
    expect(sql).toMatch(/file_name\s+TEXT\s+NOT\s+NULL/i);
    expect(sql).toMatch(/file_name_tsv\s+TSVECTOR/i);
    expect(sql).toMatch(/summary\s+TEXT\s+NOT\s+NULL/i);
    expect(sql).toMatch(/keywords\s+TEXT\[\]/i);
    expect(sql).toMatch(/embedding\s+VECTOR\(1536\)\s+NOT\s+NULL/i);
    expect(sql).toMatch(/drive_modified_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
    expect(sql).toMatch(/mime_type\s+TEXT\s+NOT\s+NULL/i);
  });

  it("creates indexes for drive_modified_at, embedding ivfflat, and file_name_tsv gin", () => {
    const sql = readSql();

    expect(sql).toMatch(
      /CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?drive_file_index_drive_modified_at_idx\s+ON\s+drive_file_index\s+USING\s+BTREE\s*\(\s*drive_modified_at\s*\)/i,
    );

    expect(sql).toMatch(
      /CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?drive_file_index_embedding_idx\s+ON\s+drive_file_index\s+USING\s+ivfflat\s*\(\s*embedding\s+vector_cosine_ops\s*\)\s*WITH\s*\(\s*lists\s*=\s*100\s*\)/i,
    );

    expect(sql).toMatch(
      /CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?idx_drive_file_name_tsv\s+ON\s+drive_file_index\s+USING\s+gin\s*\(\s*file_name_tsv\s*\)/i,
    );
  });

  it("defines trigger to keep file_name_tsv in sync", () => {
    const sql = readSql();
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+drive_file_index_set_tsv/i);
    expect(sql).toMatch(/CREATE\s+TRIGGER\s+trg_drive_file_name_tsv/i);
  });
});
