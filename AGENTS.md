# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source. `src/cli/` hosts runnable entrypoints (`crawler.ts`, `search.ts`); other files are domain modules (Drive client, Supabase sync, OpenAI pipeline, logging, MIME helpers, env loader).
- `tests/`: Vitest specs (`*.test.ts`) mirroring modules and CLI behaviours; fixtures and declaration shims live alongside tests.
- `scripts/`: Utility scripts such as `db-apply.mjs` (applies SQL migrations) and `test-runner.mjs` (Vitest wrapper that supports `--filter`).
- `sql/`: Ordered DDL files applied to Supabase/Postgres (`001_drive_file_index.sql`, `002_drive_sync_state.sql`).
- `docs/`: Design notes, plans, and runbooks used for background context.

## Build, Test, and Development Commands
- Install deps: `pnpm install` (Node 22+). Add a `.env` before running CLIs.
- Crawl Drive with current settings: `pnpm crawler -- --mode auto`; limit a dry run with `-l 50`.
- Search stub for debugging: `pnpm search -- --query "memo" --json` prints the request payload.
- Apply DB schema to Supabase: `pnpm db:apply` (requires `SUPABASE_URL` and `SUPABASE_DB_PASSWORD`).
- Quality gates: `pnpm format` (Biome), `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest via scripts/test-runner.mjs), or `pnpm verify` to run all.

## Coding Style & Naming Conventions
- Language: ESM TypeScript with explicit `.ts` imports (`allowImportingTsExtensions=true`).
- Formatting: Biome, 2-space indent, 100‑char line width, organizeImports enabled. Run `pnpm format` before committing.
- Naming: PascalCase for types/classes, camelCase for functions/variables, UPPER_SNAKE_CASE for constants. File names favour lowercase with underscores (e.g., `drive_sync_state_repository.ts`). Log messages should stay concise and structured.

## Testing Guidelines
- Framework: Vitest. Place specs in `tests/` with `*.test.ts` suffix (e.g., `drive_file_index_repository.test.ts`).
- Targeted runs: `pnpm test -- --filter drive_sync_state` or pass glob/test name. Vitest worker env enables mock Supabase/Drive clients; avoid real network calls inside tests.
- Add fixtures close to the test; prefer deterministic inputs over shared globals.

## Commit & Pull Request Guidelines
- Commits in history use short, descriptive Japanese sentences; follow the same style (one clear sentence, no emoji/prefix). Include scope keywords when obvious (例: `クローラーにMIMEフィルタを追加`).
- Before opening a PR, run `pnpm verify`. Describe the change, note env or migration impacts, and attach CLI output snippets (crawler/search/db apply) when behaviour changes. Link related issues/tasks in the description.

## Environment & Secrets
- `.env` must define: `CRAWLER_MODE`, `SEARCH_MAX_LOOP_COUNT`, `SUMMARY_MAX_LENGTH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_TARGET_FOLDER_IDS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (plus `SUPABASE_DB_PASSWORD` for `pnpm db:apply`). Optional: `OPENAI_ORG`, `LOG_LEVEL`, `TZ`.
- Keep credentials out of commits; use separate project accounts for local testing. When unsure, run with `CRAWLER_USE_MOCK_SUPABASE=1` to avoid writing to Supabase.
