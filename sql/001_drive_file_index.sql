-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS "vector";

-- Main file index table
CREATE TABLE IF NOT EXISTS drive_file_index (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT[],
  embedding VECTOR(1536) NOT NULL,
  drive_modified_at TIMESTAMPTZ NOT NULL,
  mime_type TEXT NOT NULL
);

-- For sorting and incremental sync queries
CREATE INDEX IF NOT EXISTS drive_file_index_drive_modified_at_idx
  ON drive_file_index USING BTREE (drive_modified_at);

-- Vector index tuned for cosine similarity
CREATE INDEX IF NOT EXISTS drive_file_index_embedding_idx
  ON drive_file_index USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
