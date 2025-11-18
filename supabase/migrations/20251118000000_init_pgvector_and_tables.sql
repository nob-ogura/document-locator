-- Enable pgvector extension for vector similarity search
create extension if not exists vector;

-- Table to store indexed files and their embeddings
create table if not exists files (
  file_id text primary key,
  file_name text not null,
  summary text,
  keywords text,
  embedding vector(1536) not null,
  updated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

-- Table to store crawler state such as Google Drive Start Page Token
create table if not exists crawler_state (
  id bigint generated always as identity primary key,
  start_page_token text,
  updated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

