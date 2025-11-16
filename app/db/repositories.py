"""Repository abstractions for Supabase-managed PostgreSQL tables."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from psycopg import sql
from psycopg.errors import Error as PsycopgError

from app.db.client import ConnectionMode, get_connection

logger = logging.getLogger(__name__)

__all__ = [
    "ConnectionMode",
    "CrawlerState",
    "CrawlerStateRepository",
    "FileIndexRepository",
    "FileRecord",
    "FileSearchResult",
    "RepositoryError",
]


MAX_SEARCH_LIMIT = 100
_FILE_COLUMNS = (
    "file_id",
    "drive_id",
    "file_name",
    "summary",
    "keywords",
    "embedding",
    "mime_type",
    "last_modifier",
    "updated_at",
    "deleted_at",
)
_FILE_VALUES_TEMPLATE = "(" + ", ".join(["%s"] * len(_FILE_COLUMNS)) + ")"
_FILE_COLUMNS_SQL = sql.SQL(", ").join(sql.Identifier(col) for col in _FILE_COLUMNS)


class RepositoryError(RuntimeError):
    """Raised when a repository operation fails."""

    def __init__(self, operation: str, message: str) -> None:
        super().__init__(f"{operation} failed: {message}")
        self.operation = operation


@dataclass(slots=True, frozen=True)
class FileRecord:
    file_id: str
    drive_id: str
    file_name: str
    summary: str | None
    keywords: str | None
    embedding: Sequence[float]
    mime_type: str | None
    last_modifier: str | None
    updated_at: datetime
    deleted_at: datetime | None = None


@dataclass(slots=True, frozen=True)
class FileSearchResult:
    file_id: str
    drive_id: str
    file_name: str
    summary: str | None
    keywords: str | None
    mime_type: str | None
    last_modifier: str | None
    updated_at: datetime
    deleted_at: datetime | None
    distance: float
    similarity: float


@dataclass(slots=True, frozen=True)
class CrawlerState:
    drive_id: str
    start_page_token: str | None
    last_run_at: datetime | None
    last_status: str | None
    updated_at: datetime | None


class _RepositoryBase:
    def __init__(self, *, connection_mode: ConnectionMode | str = ConnectionMode.SERVICE) -> None:
        self._default_mode = ConnectionMode.coerce(connection_mode)

    def _resolve_mode(self, override: ConnectionMode | str | None) -> ConnectionMode:
        if override is None:
            return self._default_mode
        return ConnectionMode.coerce(override)

    def _raise_db_error(self, operation: str, mode: ConnectionMode, exc: PsycopgError) -> None:
        logger.exception(
            "Repository operation failed",
            extra={"operation": operation, "mode": mode.value},
        )
        raise RepositoryError(operation, str(exc)) from exc


class FileIndexRepository(_RepositoryBase):
    def upsert_files(
        self,
        files: Sequence[FileRecord],
        *,
        connection_mode: ConnectionMode | str | None = None,
    ) -> int:
        if not files:
            return 0

        mode = self._resolve_mode(connection_mode)
        params: list[Any] = []
        value_blocks = [sql.SQL(_FILE_VALUES_TEMPLATE) for _ in files]
        query = sql.SQL(
            """
            insert into file_index ({columns})
            values {values}
            on conflict (file_id) do update set
                drive_id = excluded.drive_id,
                file_name = excluded.file_name,
                summary = excluded.summary,
                keywords = excluded.keywords,
                embedding = excluded.embedding,
                mime_type = excluded.mime_type,
                last_modifier = excluded.last_modifier,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at
            """
        ).format(columns=_FILE_COLUMNS_SQL, values=sql.SQL(", ").join(value_blocks))

        for record in files:
            embedding_literal = _vector_literal(record.embedding)
            params.extend(
                (
                    record.file_id,
                    record.drive_id,
                    record.file_name,
                    record.summary,
                    record.keywords,
                    embedding_literal,
                    record.mime_type,
                    record.last_modifier,
                    record.updated_at,
                    record.deleted_at,
                )
            )

        try:
            with get_connection(mode=mode) as connection:
                with connection.transaction():
                    cursor = connection.execute(query, params)
                    return cursor.rowcount
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("file_index.upsert", mode, exc)
        return 0  # pragma: no cover - systematically unreachable

    def search(
        self,
        *,
        query_embedding: Sequence[float],
        drive_ids: Sequence[str] | None = None,
        file_ids: Sequence[str] | None = None,
        limit: int = 10,
        min_similarity: float | None = None,
        include_deleted: bool = False,
        connection_mode: ConnectionMode | str | None = None,
    ) -> list[FileSearchResult]:
        mode = self._resolve_mode(connection_mode)
        query_vector = _vector_literal(query_embedding)
        bounded_limit = max(1, min(limit, MAX_SEARCH_LIMIT))

        filters: list[str] = []
        params: dict[str, Any] = {
            "query_embedding": query_vector,
            "limit": bounded_limit,
        }
        if not include_deleted:
            filters.append("deleted_at is null")
        if drive_ids:
            params["drive_ids"] = list(dict.fromkeys(drive_ids))
            filters.append("drive_id = any(%(drive_ids)s)")
        if file_ids:
            params["file_ids"] = list(dict.fromkeys(file_ids))
            filters.append("file_id = any(%(file_ids)s)")
        max_distance = _distance_threshold_from_similarity(min_similarity)
        if max_distance is not None:
            params["max_distance"] = max_distance
            filters.append("(embedding <-> %(query_embedding)s::vector) <= %(max_distance)s")

        base_query = [
            "select",
            "    file_id,",
            "    drive_id,",
            "    file_name,",
            "    summary,",
            "    keywords,",
            "    mime_type,",
            "    last_modifier,",
            "    updated_at,",
            "    deleted_at,",
            "    embedding <-> %(query_embedding)s::vector as distance",
            "from file_index",
        ]
        if filters:
            base_query.append("where " + " and ".join(filters))
        base_query.append("order by distance asc")
        base_query.append("limit %(limit)s")
        sql_query = "\n".join(base_query)

        try:
            with get_connection(mode=mode) as connection:
                cursor = connection.execute(sql_query, params)
                rows = cursor.fetchall()
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("file_index.search", mode, exc)
        return [self._row_to_search_result(row) for row in rows]

    def mark_file_deleted(
        self,
        file_id: str,
        *,
        deleted_at: datetime | None = None,
        connection_mode: ConnectionMode | str | None = None,
    ) -> int:
        return self._mark_deleted(
            "file_id = %(file_id)s",
            {"file_id": file_id},
            deleted_at=deleted_at,
            connection_mode=connection_mode,
        )

    def mark_drive_deleted(
        self,
        drive_id: str,
        *,
        deleted_at: datetime | None = None,
        connection_mode: ConnectionMode | str | None = None,
    ) -> int:
        return self._mark_deleted(
            "drive_id = %(drive_id)s",
            {"drive_id": drive_id},
            deleted_at=deleted_at,
            connection_mode=connection_mode,
        )

    def _mark_deleted(
        self,
        condition: str,
        params: dict[str, Any],
        *,
        deleted_at: datetime | None,
        connection_mode: ConnectionMode | str | None,
    ) -> int:
        mode = self._resolve_mode(connection_mode)
        payload = dict(params)
        payload["deleted_at"] = deleted_at or datetime.now(tz=UTC)
        query = (
            "update file_index set deleted_at = %(deleted_at)s "
            "where deleted_at is null and " + condition
        )
        try:
            with get_connection(mode=mode) as connection:
                with connection.transaction():
                    cursor = connection.execute(query, payload)
                    return cursor.rowcount
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("file_index.delete", mode, exc)
        return 0  # pragma: no cover - systematically unreachable

    @staticmethod
    def _row_to_search_result(row: Sequence[Any]) -> FileSearchResult:
        (
            file_id,
            drive_id,
            file_name,
            summary,
            keywords,
            mime_type,
            last_modifier,
            updated_at,
            deleted_at,
            distance,
        ) = row
        distance_value = float(distance)
        return FileSearchResult(
            file_id=file_id,
            drive_id=drive_id,
            file_name=file_name,
            summary=summary,
            keywords=keywords,
            mime_type=mime_type,
            last_modifier=last_modifier,
            updated_at=updated_at,
            deleted_at=deleted_at,
            distance=distance_value,
            similarity=_distance_to_similarity(distance_value),
        )


class CrawlerStateRepository(_RepositoryBase):
    def upsert_state(
        self,
        state: CrawlerState,
        *,
        connection_mode: ConnectionMode | str | None = None,
    ) -> CrawlerState:
        mode = self._resolve_mode(connection_mode)
        query = """
            insert into crawler_state (drive_id, start_page_token, last_run_at, last_status)
            values (%(drive_id)s, %(start_page_token)s, %(last_run_at)s, %(last_status)s)
            on conflict (drive_id) do update set
                start_page_token = excluded.start_page_token,
                last_run_at = excluded.last_run_at,
                last_status = excluded.last_status,
                updated_at = timezone('utc', now())
            returning drive_id, start_page_token, last_run_at, last_status, updated_at
        """
        params = {
            "drive_id": state.drive_id,
            "start_page_token": state.start_page_token,
            "last_run_at": state.last_run_at,
            "last_status": state.last_status,
        }
        try:
            with get_connection(mode=mode) as connection:
                with connection.transaction():
                    cursor = connection.execute(query, params)
                    row = cursor.fetchone()
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("crawler_state.upsert", mode, exc)
        if row is None:  # pragma: no cover - defensive, database always returns rows
            raise RepositoryError("crawler_state.upsert", "no row returned")
        return self._row_to_state(row)

    def get_state(
        self,
        drive_id: str,
        *,
        connection_mode: ConnectionMode | str | None = None,
    ) -> CrawlerState | None:
        mode = self._resolve_mode(connection_mode)
        query = """
            select drive_id, start_page_token, last_run_at, last_status, updated_at
            from crawler_state
            where drive_id = %(drive_id)s
        """
        try:
            with get_connection(mode=mode) as connection:
                cursor = connection.execute(query, {"drive_id": drive_id})
                row = cursor.fetchone()
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("crawler_state.get", mode, exc)
        if row is None:
            return None
        return self._row_to_state(row)

    def list_states(
        self,
        *,
        connection_mode: ConnectionMode | str | None = None,
    ) -> list[CrawlerState]:
        mode = self._resolve_mode(connection_mode)
        query = """
            select drive_id, start_page_token, last_run_at, last_status, updated_at
            from crawler_state
            order by drive_id
        """
        try:
            with get_connection(mode=mode) as connection:
                cursor = connection.execute(query)
                rows = cursor.fetchall()
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("crawler_state.list", mode, exc)
        return [self._row_to_state(row) for row in rows]

    def delete_state(
        self,
        drive_id: str,
        *,
        connection_mode: ConnectionMode | str | None = None,
    ) -> int:
        mode = self._resolve_mode(connection_mode)
        query = "delete from crawler_state where drive_id = %(drive_id)s"
        try:
            with get_connection(mode=mode) as connection:
                with connection.transaction():
                    cursor = connection.execute(query, {"drive_id": drive_id})
                    return cursor.rowcount
        except PsycopgError as exc:  # pragma: no cover - exercised via mocks
            self._raise_db_error("crawler_state.delete", mode, exc)
        return 0  # pragma: no cover - systematically unreachable

    @staticmethod
    def _row_to_state(row: Sequence[Any]) -> CrawlerState:
        drive_id, start_page_token, last_run_at, last_status, updated_at = row
        return CrawlerState(
            drive_id=drive_id,
            start_page_token=start_page_token,
            last_run_at=last_run_at,
            last_status=last_status,
            updated_at=updated_at,
        )


def _normalize_embedding(embedding: Sequence[float]) -> list[float]:
    values = [float(value) for value in embedding]
    if not values:
        raise ValueError("embedding must include at least one value")
    return values


def _vector_literal(embedding: Sequence[float]) -> str:
    normalized = _normalize_embedding(embedding)
    formatted = ",".join(_format_vector_value(value) for value in normalized)
    return f"[{formatted}]"


def _format_vector_value(value: float) -> str:
    return format(value, ".15g")


def _distance_threshold_from_similarity(value: float | None) -> float | None:
    if value is None:
        return None
    if not (0.0 < value <= 1.0):
        raise ValueError("min_similarity must be between 0 and 1")
    return (1.0 / value) - 1.0


def _distance_to_similarity(distance: float) -> float:
    if distance < 0:
        distance = 0.0
    return 1.0 / (1.0 + distance)
