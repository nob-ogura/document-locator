# scripts

Utility scripts and one-off maintenance commands will live here. Keeping the
directory in place during Phase 0 clarifies where future automation should
reside.

## Available scripts
- `migrate.py`: Applies SQL migrations under `app/db/migrations/`. Use `uv run scripts/migrate.py status` to inspect progress and `uv run scripts/migrate.py up` (optionally with `--dry-run`) to apply pending files idempotently.
