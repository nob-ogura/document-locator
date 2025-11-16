from __future__ import annotations

import argparse
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from app.config import get_config
from psycopg import Connection, connect, sql
from psycopg.conninfo import make_conninfo
from psycopg.errors import Error as PsycopgError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = PROJECT_ROOT / "app" / "db" / "migrations"
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Migration:
    version: str
    path: Path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lightweight Supabase migration runner.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    up_parser = subparsers.add_parser("up", help="Apply any pending migrations.")
    up_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List pending migrations without executing them.",
    )

    subparsers.add_parser("status", help="Show applied/pending migrations.")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "up":
        return _run_up(dry_run=args.dry_run)
    if args.command == "status":
        return _show_status()

    parser.print_help()
    return 1


def _run_up(*, dry_run: bool) -> int:
    migrations = _load_migrations()
    if not migrations:
        logger.info("No migrations found under %s", MIGRATIONS_DIR)
        return 0

    config = get_config()
    conninfo_str = make_conninfo(
        config.database.url,
        dbname=config.database.name,
        application_name="document-locator:migrate",
    )

    with connect(conninfo_str) as connection:
        connection.autocommit = False
        _ensure_schema(connection, config.database.schema)
        applied = _ensure_migrations_table(connection)
        pending = [migration for migration in migrations if migration.version not in applied]

        if not pending:
            logger.info("Database already up-to-date (%d migrations applied).", len(applied))
            return 0

        if dry_run:
            logger.info("Pending migrations (dry-run):")
            for migration in pending:
                logger.info("  - %s", migration.version)
            return 0

        for migration in pending:
            _apply_migration(connection, migration)

        logger.info(
            "Applied %d migrations (total applied: %d).",
            len(pending),
            len(applied) + len(pending),
        )
        return 0


def _show_status() -> int:
    migrations = _load_migrations()
    config = get_config()
    conninfo_str = make_conninfo(
        config.database.url,
        dbname=config.database.name,
        application_name="document-locator:migrate-status",
    )

    with connect(conninfo_str) as connection:
        connection.autocommit = False
        _ensure_schema(connection, config.database.schema)
        applied = _ensure_migrations_table(connection)

    if not migrations:
        logger.info("No migrations found under %s", MIGRATIONS_DIR)
        return 0

    logger.info("Migration status:")
    for migration in migrations:
        marker = "✔" if migration.version in applied else "✖"
        logger.info("  %s %s", marker, migration.version)
    return 0


def _ensure_schema(connection: Connection[object], schema: str) -> None:
    identifier = sql.Identifier(schema)
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("create schema if not exists {}").format(identifier))
        cursor.execute(sql.SQL("set search_path to {}, public, extensions").format(identifier))


def _ensure_migrations_table(connection: Connection[object]) -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            create table if not exists schema_migrations (
                version text primary key,
                applied_at timestamptz not null default timezone('utc', now())
            )
            """
        )
        cursor.execute("select version from schema_migrations order by version")
        rows = cursor.fetchall()
    return {row[0] for row in rows}


def _apply_migration(connection: Connection[object], migration: Migration) -> None:
    logger.info("Applying %s", migration.version)
    sql_text = migration.path.read_text(encoding="utf-8")
    try:
        with connection.transaction():
            connection.execute(sql_text)
            connection.execute(
                "insert into schema_migrations (version) values (%s) "
                "on conflict (version) do nothing",
                (migration.version,),
            )
    except PsycopgError:
        logger.exception("Migration %s failed", migration.version)
        raise


def _load_migrations() -> list[Migration]:
    if not MIGRATIONS_DIR.exists():
        return []
    return [
        Migration(version=path.name, path=path)
        for path in sorted(MIGRATIONS_DIR.glob("*.sql"))
    ]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
