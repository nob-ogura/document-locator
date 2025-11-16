-- Phase 1 / T1-2: bootstrap schema and indexes for the document locator service.
--
-- This migration expects the session `search_path` to point to the application
-- schema (set by `scripts/migrate.py`). All statements are idempotent so the
-- migration can be re-applied safely.

create extension if not exists vector with schema extensions;

create table if not exists file_index (
    file_id text primary key,
    drive_id text not null,
    file_name text not null,
    summary text,
    keywords text,
    embedding vector(1536) not null,
    mime_type text,
    last_modifier text,
    updated_at timestamptz not null default timezone('utc', now()),
    deleted_at timestamptz
);

comment on table file_index is
    'Vector-searchable metadata for Drive files. Future ACL tables will join via drive_id/file_id to enforce visibility.';
comment on column file_index.drive_id is 'Drive identifier used when joining with ACL/visibility data.';
comment on column file_index.embedding is 'OpenAI embedding payload stored as vector(1536) for pgvector queries.';

create index if not exists idx_file_index_drive_file on file_index (drive_id, file_id);
create index if not exists idx_file_index_drive_active on file_index (drive_id) where deleted_at is null;
create index if not exists idx_file_index_updated_at on file_index (updated_at desc);

-- Tune `lists` to balance recall/latency. Start with 100 for Supabase''s recommended defaults.
create index if not exists file_index_embedding_idx
    on file_index using ivfflat (embedding vector_l2_ops) with (lists = 100);

create table if not exists crawler_state (
    drive_id text primary key,
    start_page_token text,
    last_run_at timestamptz,
    last_status text,
    updated_at timestamptz not null default timezone('utc', now())
);

comment on table crawler_state is 'Stores delta-crawl state per Drive (page tokens / last status).';
comment on column crawler_state.start_page_token is 'Latest Drive API page token to resume incremental crawling.';
comment on column crawler_state.last_status is 'Summary of the last crawler outcome (success, failed:<reason>, etc.).';

create index if not exists idx_crawler_state_updated_at on crawler_state (updated_at desc);
