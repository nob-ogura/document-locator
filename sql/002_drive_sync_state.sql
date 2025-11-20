-- Tracks incremental crawl watermark (singleton row: id='global')
CREATE TABLE IF NOT EXISTS drive_sync_state (
  id TEXT PRIMARY KEY DEFAULT 'global',
  drive_modified_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT drive_sync_state_id_global CHECK (id = 'global')
);
