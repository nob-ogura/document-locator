# Repository Guidelines

## Project Structure & Module Organization
- `src/` TypeScript sources; CLI entrypoints live under `src/cli/` (`crawler.ts`, `search.ts`). Domain modules cover Drive client, Supabase sync, OpenAI pipeline, logging, MIME helpers, and env loading.
- `tests/` Vitest specs mirroring modules and CLI behaviours; fixtures and shims sit beside specs.
- `scripts/` Utility runners such as `db-apply.mjs` (SQL migrations) and `test-runner.mjs` (Vitest wrapper with `--filter` support).
- `sql/` Ordered DDLs (`001_drive_file_index.sql`, `002_drive_sync_state.sql`) applied to Supabase/Postgres.
- `docs/` Design notes, plans, and runbooks for background context.

## Build, Test, and Development Commands
- Install deps (Node 22+): `pnpm install`.
- Run crawler: `pnpm crawler -- --mode auto` (dry-run cap example: `-l 50`).
- Debug search payload: `pnpm search -- --query "memo" --json`.
- Apply DB schema: `pnpm db:apply` (needs `SUPABASE_URL` and `SUPABASE_DB_PASSWORD`).
- Quality gates: `pnpm format` (Biome), `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest via `scripts/test-runner.mjs`), or `pnpm verify` to run all.

## Coding Style & Naming Conventions
- ESM TypeScript with explicit `.ts` imports; 2-space indent, 100-char line width, organized imports.
- Formatting via Biome; run `pnpm format` before committing.
- Naming: PascalCase types/classes, camelCase functions/variables, UPPER_SNAKE_CASE constants; filenames lowercase with underscores (e.g., `drive_sync_state_repository.ts`).
- Log messages stay concise and structured.

## Testing Guidelines
- Framework: Vitest. Specs end with `.test.ts` in `tests/` and mirror module names.
- Targeted runs: `pnpm test -- --filter drive_sync_state` (accepts glob or test name).
- Use deterministic fixtures near the spec; Vitest worker env supplies mock Supabase/Drive clients—avoid real network calls.

## Commit & Pull Request Guidelines
- Commit messages are short Japanese sentences; prefer one clear phrase without emoji/prefix (e.g., `クローラーにMIMEフィルタを追加`).
- Before PR: run `pnpm verify`. Describe behaviour changes, env/migration impacts, and paste relevant CLI output (crawler/search/db apply). Link related issues/tasks.

## Environment & Security Tips
- Required `.env`: `CRAWLER_MODE`, `SEARCH_MAX_LOOP_COUNT`, `SUMMARY_MAX_LENGTH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_TARGET_FOLDER_IDS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`; add `SUPABASE_DB_PASSWORD` for `pnpm db:apply`. Optional: `OPENAI_ORG`, `LOG_LEVEL`, `TZ`.
- Keep credentials out of commits; for safe local experiments set `CRAWLER_USE_MOCK_SUPABASE=1`.
