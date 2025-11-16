from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

import app.config as app_config
import pytest
from app.db import repositories
from app.db.client import ConnectionMode, get_connection, reset_pools


@dataclass(slots=True)
class DbRepositoryTestContext:
    file_repo: repositories.FileIndexRepository
    crawler_repo: repositories.CrawlerStateRepository
    _file_ids: set[str] = field(default_factory=set)
    _crawler_drive_ids: set[str] = field(default_factory=set)

    def register_file_records(self, records: Iterable[repositories.FileRecord]) -> None:
        for record in records:
            self._file_ids.add(record.file_id)

    def register_crawler_drive(self, drive_id: str) -> None:
        self._crawler_drive_ids.add(drive_id)

    def cleanup(self) -> None:
        if not self._file_ids and not self._crawler_drive_ids:
            return
        with get_connection(mode=ConnectionMode.SERVICE) as connection:
            with connection.transaction():
                for file_id in sorted(self._file_ids):
                    connection.execute(
                        "delete from file_index where file_id = %(file_id)s",
                        {"file_id": file_id},
                    )
                for drive_id in sorted(self._crawler_drive_ids):
                    connection.execute(
                        "delete from crawler_state where drive_id = %(drive_id)s",
                        {"drive_id": drive_id},
                    )


@pytest.fixture(scope="session")
def _database_environment() -> Iterator[None]:
    try:
        config = app_config.load_config()
    except app_config.ConfigError as exc:  # pragma: no cover - depends on local secrets
        pytest.skip(f"Database tests skipped: {exc}")
    app_config._CONFIG_CACHE = config

    from scripts import migrate

    try:
        exit_code = migrate.main(["up"])
    except Exception as exc:  # pragma: no cover - depends on environment
        pytest.skip(f"Database tests skipped: failed to connect to Supabase ({exc}).")
    if exit_code != 0:  # pragma: no cover - would require broken database
        pytest.skip("Failed to apply migrations for database tests.")

    reset_pools()
    try:
        yield
    finally:
        reset_pools()


@pytest.fixture()
def db_test_context(_database_environment: None) -> Iterator[DbRepositoryTestContext]:
    context = DbRepositoryTestContext(
        file_repo=repositories.FileIndexRepository(),
        crawler_repo=repositories.CrawlerStateRepository(),
    )
    try:
        yield context
    finally:
        context.cleanup()
