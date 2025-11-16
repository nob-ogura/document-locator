from __future__ import annotations

from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from app.db import repositories
from app.db.client import ConnectionMode
from psycopg.errors import Error as PsycopgError
from tests.conftest import DbRepositoryTestContext


@dataclass(slots=True)
class ExecutedStatement:
    sql: str
    params: Any


class FakeCursor:
    def __init__(
        self,
        *,
        rows: Iterable[tuple[Any, ...]] | None = None,
        rowcount: int | None = None,
    ) -> None:
        self._rows = list(rows or [])
        self.rowcount = rowcount if rowcount is not None else len(self._rows)

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)

    def fetchone(self) -> tuple[Any, ...] | None:
        if not self._rows:
            return None
        return self._rows[0]


class RecordingConnection:
    def __init__(self, responses: list[FakeCursor] | None = None) -> None:
        self._responses = list(responses or [])
        self.statements: list[ExecutedStatement] = []
        self.transaction_begun = 0
        self.transaction_commits = 0
        self.transaction_rollbacks = 0

    def execute(self, sql: Any, params: Any | None = None) -> FakeCursor:
        self.statements.append(ExecutedStatement(sql=str(sql), params=params))
        if self._responses:
            return self._responses.pop(0)
        return FakeCursor()

    def transaction(self) -> _RecordingTransaction:
        return _RecordingTransaction(self)


class ExplodingConnection(RecordingConnection):
    def execute(self, sql: Any, params: Any | None = None) -> FakeCursor:  # noqa: D401
        super().execute(sql, params)
        raise PsycopgError("boom")


@dataclass(slots=True)
class _RecordingTransaction:
    connection: RecordingConnection

    def __enter__(self) -> RecordingConnection:  # noqa: D401
        self.connection.transaction_begun += 1
        return self.connection

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: D401, ANN001
        if exc_type is None:
            self.connection.transaction_commits += 1
        else:
            self.connection.transaction_rollbacks += 1


def install_connection(
    monkeypatch: pytest.MonkeyPatch, connection: RecordingConnection
) -> list[ConnectionMode]:
    modes: list[ConnectionMode] = []

    @contextmanager
    def fake_get_connection(*, mode: ConnectionMode):
        modes.append(mode)
        yield connection

    monkeypatch.setattr(repositories, "get_connection", fake_get_connection)
    return modes


def build_file_record(
    file_id: str,
    *,
    drive_id: str = "drive-001",
    file_name: str = "Example",
    summary: str | None = "summary",
    keywords: str | None = "alpha,beta",
    embedding: list[float] | None = None,
    mime_type: str | None = "application/pdf",
    last_modifier: str | None = "alice",
    updated_at: datetime | None = None,
    deleted_at: datetime | None = None,
) -> repositories.FileRecord:
    return repositories.FileRecord(
        file_id=file_id,
        drive_id=drive_id,
        file_name=file_name,
        summary=summary,
        keywords=keywords,
        embedding=embedding or [0.01, 0.02, 0.03],
        mime_type=mime_type,
        last_modifier=last_modifier,
        updated_at=updated_at or datetime(2024, 1, 1, tzinfo=UTC),
        deleted_at=deleted_at,
    )


def build_state(
    drive_id: str,
    *,
    start_page_token: str | None = None,
    last_run_at: datetime | None = None,
    last_status: str | None = None,
    updated_at: datetime | None = None,
) -> repositories.CrawlerState:
    return repositories.CrawlerState(
        drive_id=drive_id,
        start_page_token=start_page_token,
        last_run_at=last_run_at,
        last_status=last_status,
        updated_at=updated_at,
    )


def test_upsert_files_inserts_rows_in_single_statement(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = RecordingConnection(responses=[FakeCursor(rowcount=2)])
    modes = install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()
    files = [build_file_record("file-1"), build_file_record("file-2")]

    inserted = repo.upsert_files(files)

    assert inserted == 2
    assert len(connection.statements) == 1
    statement = connection.statements[0]
    assert "insert into file_index" in statement.sql.lower()
    assert statement.sql.lower().count("values") == 1
    assert len(statement.params) == 20  # 2 records * 10 columns
    assert statement.params[0] == "file-1"
    assert statement.params[10] == "file-2"
    assert modes == [ConnectionMode.SERVICE]


def test_upsert_files_returns_zero_for_empty_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = RecordingConnection()
    install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()

    inserted = repo.upsert_files([])

    assert inserted == 0
    assert connection.statements == []


def test_upsert_files_wraps_database_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = ExplodingConnection()
    install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()

    with pytest.raises(repositories.RepositoryError) as excinfo:
        repo.upsert_files([build_file_record("boom")])

    assert "file_index.upsert" in str(excinfo.value)


def test_search_applies_filters_and_returns_models(monkeypatch: pytest.MonkeyPatch) -> None:
    updated = datetime(2024, 2, 1, tzinfo=UTC)
    rows = [
        (
            "file-1",
            "drive-1",
            "Doc 1",
            "Summary 1",
            "alpha,beta",
            "application/pdf",
            "alice",
            updated,
            None,
            0.42,
        ),
        (
            "file-2",
            "drive-1",
            "Doc 2",
            None,
            None,
            "text/plain",
            None,
            updated,
            None,
            0.9,
        ),
    ]
    connection = RecordingConnection(responses=[FakeCursor(rows=rows)])
    modes = install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()

    results = repo.search(
        query_embedding=[0.1, 0.2, 0.3],
        drive_ids=["drive-1"],
        file_ids=["file-1", "file-2"],
        limit=5,
        min_similarity=0.5,
    )

    assert [result.file_id for result in results] == ["file-1", "file-2"]
    assert pytest.approx(results[0].similarity) == 1 / (1 + 0.42)
    assert pytest.approx(results[0].distance) == 0.42
    assert modes == [ConnectionMode.SERVICE]

    statement = connection.statements[0]
    assert "order by distance" in statement.sql.lower()
    assert statement.params["drive_ids"] == ["drive-1"]
    assert statement.params["file_ids"] == ["file-1", "file-2"]
    assert statement.params["limit"] == 5
    assert pytest.approx(statement.params["max_distance"]) == 1.0


def test_mark_file_deleted_supports_user_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = RecordingConnection(responses=[FakeCursor(rowcount=1)])
    modes = install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()
    deleted_at = datetime(2024, 3, 1, tzinfo=UTC)

    updated = repo.mark_file_deleted("file-123", deleted_at=deleted_at, connection_mode="user")

    assert updated == 1
    assert modes == [ConnectionMode.USER]
    statement = connection.statements[0]
    assert statement.params["file_id"] == "file-123"
    assert statement.params["deleted_at"] == deleted_at


def test_mark_drive_deleted_updates_all_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = RecordingConnection(responses=[FakeCursor(rowcount=3)])
    install_connection(monkeypatch, connection)
    repo = repositories.FileIndexRepository()

    updated = repo.mark_drive_deleted("drive-77")

    assert updated == 3
    statement = connection.statements[0]
    assert statement.params["drive_id"] == "drive-77"


def test_crawler_state_upsert_returns_saved_row(monkeypatch: pytest.MonkeyPatch) -> None:
    ts = datetime(2024, 4, 1, tzinfo=UTC)
    rows = [
        (
            "drive-9",
            "token",
            ts,
            "success",
            ts,
        )
    ]
    connection = RecordingConnection(responses=[FakeCursor(rows=rows)])
    install_connection(monkeypatch, connection)
    repo = repositories.CrawlerStateRepository()

    saved = repo.upsert_state(
        build_state("drive-9", start_page_token="token", last_run_at=ts, last_status="success")
    )

    assert saved.drive_id == "drive-9"
    assert saved.updated_at == ts


def test_crawler_state_get_and_delete(monkeypatch: pytest.MonkeyPatch) -> None:
    ts = datetime(2024, 5, 1, tzinfo=UTC)
    rows = [
        (
            "drive-11",
            "token",
            ts,
            "failed",
            ts,
        )
    ]
    connection = RecordingConnection(responses=[FakeCursor(rows=rows), FakeCursor(rowcount=1)])
    install_connection(monkeypatch, connection)
    repo = repositories.CrawlerStateRepository()

    state = repo.get_state("drive-11")
    assert state is not None
    assert state.last_status == "failed"

    deleted = repo.delete_state("drive-11")
    assert deleted == 1


def test_crawler_state_list_returns_all(monkeypatch: pytest.MonkeyPatch) -> None:
    ts = datetime(2024, 6, 1, tzinfo=UTC)
    rows = [
        ("drive-1", "token1", ts, "ok", ts),
        ("drive-2", None, None, None, ts),
    ]
    connection = RecordingConnection(responses=[FakeCursor(rows=rows)])
    install_connection(monkeypatch, connection)
    repo = repositories.CrawlerStateRepository()

    states = repo.list_states()

    assert [state.drive_id for state in states] == ["drive-1", "drive-2"]


def test_crawler_state_get_returns_none_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    connection = RecordingConnection(responses=[FakeCursor(rows=[])])
    install_connection(monkeypatch, connection)
    repo = repositories.CrawlerStateRepository()

    assert repo.get_state("drive-x") is None


@pytest.mark.db
def test_file_index_repository_integration(db_test_context: DbRepositoryTestContext) -> None:
    repo = db_test_context.file_repo
    drive_id = f"drive-int-{uuid4()}"
    now = datetime.now(tz=UTC).replace(microsecond=0)
    file_one = repositories.FileRecord(
        file_id=f"file-{uuid4()}",
        drive_id=drive_id,
        file_name="Integration Doc A",
        summary="first doc",
        keywords="alpha,beta",
        embedding=_build_embedding(0.0),
        mime_type="text/plain",
        last_modifier="integration",
        updated_at=now,
        deleted_at=None,
    )
    file_two = repositories.FileRecord(
        file_id=f"file-{uuid4()}",
        drive_id=drive_id,
        file_name="Integration Doc B",
        summary="second doc",
        keywords="gamma,delta",
        embedding=_build_embedding(0.5),
        mime_type="application/pdf",
        last_modifier="integration",
        updated_at=now,
        deleted_at=None,
    )
    db_test_context.register_file_records([file_one, file_two])

    inserted = repo.upsert_files([file_one, file_two])
    assert inserted == 2

    results = repo.search(query_embedding=_build_embedding(0.0), drive_ids=[drive_id], limit=5)
    assert [result.file_id for result in results] == [file_one.file_id, file_two.file_id]
    assert results[0].deleted_at is None
    assert pytest.approx(results[0].similarity) == 1.0

    filtered = repo.search(
        query_embedding=_build_embedding(0.0),
        drive_ids=[drive_id],
        min_similarity=0.8,
    )
    assert [result.file_id for result in filtered] == [file_one.file_id]

    updated_rows = repo.mark_file_deleted(file_one.file_id)
    assert updated_rows == 1

    remaining = repo.search(query_embedding=_build_embedding(0.0), drive_ids=[drive_id])
    assert [result.file_id for result in remaining] == [file_two.file_id]

    drive_updates = repo.mark_drive_deleted(drive_id)
    assert drive_updates == 1  # only the second file was still active

    assert repo.search(query_embedding=_build_embedding(0.0), drive_ids=[drive_id]) == []
    deleted_records = repo.search(
        query_embedding=_build_embedding(0.0),
        drive_ids=[drive_id],
        include_deleted=True,
    )
    assert len(deleted_records) == 2
    assert all(record.deleted_at is not None for record in deleted_records)


@pytest.mark.db
def test_crawler_state_repository_integration(db_test_context: DbRepositoryTestContext) -> None:
    repo = db_test_context.crawler_repo
    drive_id = f"drive-state-{uuid4()}"
    db_test_context.register_crawler_drive(drive_id)
    first_run = datetime(2024, 7, 1, 12, 0, tzinfo=UTC)

    state = repositories.CrawlerState(
        drive_id=drive_id,
        start_page_token="token-1",
        last_run_at=first_run,
        last_status="success",
        updated_at=None,
    )
    saved = repo.upsert_state(state)
    assert saved.drive_id == drive_id
    assert saved.start_page_token == "token-1"

    fetched = repo.get_state(drive_id)
    assert fetched is not None
    assert fetched.start_page_token == "token-1"

    states = repo.list_states()
    assert any(existing.drive_id == drive_id for existing in states)

    second_run = datetime(2024, 7, 2, 15, 0, tzinfo=UTC)
    updated = repo.upsert_state(
        repositories.CrawlerState(
            drive_id=drive_id,
            start_page_token="token-2",
            last_run_at=second_run,
            last_status="failed:timeout",
            updated_at=None,
        )
    )
    assert updated.start_page_token == "token-2"
    assert updated.last_status == "failed:timeout"

    deleted = repo.delete_state(drive_id)
    assert deleted == 1
    assert repo.get_state(drive_id) is None


def _build_embedding(value: float) -> list[float]:
    return [float(value)] * 1536
