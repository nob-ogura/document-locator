-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS "vector";

-- Main file index table
CREATE TABLE IF NOT EXISTS drive_file_index (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_name_tsv TSVECTOR,
  summary TEXT NOT NULL,
  keywords TEXT[],
  embedding VECTOR(1536) NOT NULL,
  drive_modified_at TIMESTAMPTZ NOT NULL,
  mime_type TEXT NOT NULL
);

-- Ensure column exists when migrating an existing table
ALTER TABLE drive_file_index
  ADD COLUMN IF NOT EXISTS file_name_tsv TSVECTOR;

-- For sorting and incremental sync queries
CREATE INDEX IF NOT EXISTS drive_file_index_drive_modified_at_idx
  ON drive_file_index USING BTREE (drive_modified_at);

-- Vector index tuned for cosine similarity
CREATE INDEX IF NOT EXISTS drive_file_index_embedding_idx
  ON drive_file_index USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- GIN index and trigger for file_name tsvector search
CREATE INDEX IF NOT EXISTS idx_drive_file_name_tsv
  ON drive_file_index USING gin (file_name_tsv);

CREATE OR REPLACE FUNCTION drive_file_index_set_tsv() RETURNS trigger AS $$
BEGIN
  NEW.file_name_tsv := to_tsvector('simple', coalesce(NEW.file_name, ''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_drive_file_name_tsv ON drive_file_index;
CREATE TRIGGER trg_drive_file_name_tsv
  BEFORE INSERT OR UPDATE ON drive_file_index
  FOR EACH ROW EXECUTE PROCEDURE drive_file_index_set_tsv();
