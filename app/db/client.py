from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from threading import Lock
from typing import Any

from app.config import AppConfig, get_config

try:  # pragma: no cover - exercised in tests via monkeypatching
    from psycopg import Connection, conninfo, sql
    from psycopg.errors import Error as PsycopgError
    from psycopg_pool import ConnectionPool
except ImportError as exc:  # pragma: no cover - dependency missing at runtime
    raise RuntimeError(
        "psycopg and psycopg-pool are required. Install them with `uv add psycopg[binary]`."
    ) from exc

logger = logging.getLogger(__name__)


class ConnectionMode(str, Enum):
    SERVICE = "service"
    USER = "user"

    @classmethod
    def coerce(cls, value: ConnectionMode | str | None) -> ConnectionMode:
        if isinstance(value, cls):
            return value
        if value is None:
            return cls.SERVICE
        normalized = str(value).strip().lower()
        for member in cls:
            if member.value == normalized:
                return member
        raise ValueError(f"Unknown connection mode: {value!r}")


@dataclass(frozen=True, slots=True)
class PoolSettings:
    conninfo: str
    schema: str
    application_name: str
    statement_timeout_ms: int = 10_000
    idle_in_transaction_timeout_ms: int = 5_000


_POOLS: dict[ConnectionMode, ConnectionPool] = {}
_POOL_LOCK = Lock()


def get_supabase_api_key(*, mode: ConnectionMode | str = ConnectionMode.SERVICE) -> str:
    """Return the Supabase key for the chosen mode."""

    resolved = ConnectionMode.coerce(mode)
    config = get_config()
    if resolved is ConnectionMode.SERVICE:
        return config.supabase.service_role_key
    return config.supabase.anon_key


@contextmanager
def get_connection(
    *,
    mode: ConnectionMode | str = ConnectionMode.SERVICE,
) -> Iterator[Connection[Any]]:
    """Yield a pooled psycopg connection configured for the requested mode."""

    resolved = ConnectionMode.coerce(mode)
    pool = _get_pool(resolved)
    try:
        with pool.connection() as connection:
            yield connection
    except PsycopgError:
        logger.exception("Database connection failed", extra={"mode": resolved.value})
        raise


def reset_pools() -> None:
    """Close all connection pools (used by tests)."""

    with _POOL_LOCK:
        for pool in _POOLS.values():
            try:
                pool.close()
            except Exception:  # pragma: no cover - defensive
                logger.exception("Failed to close connection pool cleanly")
        _POOLS.clear()


def doctor(*, mode: ConnectionMode | str = ConnectionMode.SERVICE) -> bool:
    """Run a `select 1` to verify the Supabase connection for the given mode."""

    resolved = ConnectionMode.coerce(mode)
    try:
        with get_connection(mode=resolved) as connection:
            connection.execute("select 1")
    except Exception as exc:
        print(
            f"Supabase connection failed ({resolved.value} mode): {exc}",
            file=sys.stderr,
        )
        return False

    print(
        f"Supabase connection OK ({resolved.value} mode).",
        file=sys.stdout,
    )
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Supabase connection utilities.")
    subparsers = parser.add_subparsers(dest="command")

    doctor_parser = subparsers.add_parser("doctor", help="Validate the Supabase connection.")
    doctor_parser.add_argument(
        "--mode",
        default=ConnectionMode.SERVICE.value,
        choices=[mode.value for mode in ConnectionMode],
        help="Which set of credentials to use for the connection.",
    )

    args = parser.parse_args(argv)
    if args.command == "doctor":
        result = doctor(mode=args.mode)
        return 0 if result else 1

    parser.print_help()
    return 1


def _get_pool(mode: ConnectionMode) -> ConnectionPool:
    with _POOL_LOCK:
        pool = _POOLS.get(mode)
        if pool is None:
            pool = _create_pool(mode)
            _POOLS[mode] = pool
        return pool


def _create_pool(mode: ConnectionMode) -> ConnectionPool:
    config = get_config()
    settings = _build_pool_settings(config, mode)
    pool = ConnectionPool(
        settings.conninfo,
        min_size=1,
        max_size=5,
        timeout=10,
        configure=_build_configure_callback(settings),
    )
    setattr(pool, "document_locator_mode", mode)
    masked_key = _mask_secret(get_supabase_api_key(mode=mode))
    logger.info(
        "Initialized Supabase connection pool",
        extra={
            "mode": mode.value,
            "schema": settings.schema,
            "application": settings.application_name,
            "api_key": masked_key,
        },
    )
    return pool


def _build_pool_settings(config: AppConfig, mode: ConnectionMode) -> PoolSettings:
    database = config.database
    conninfo_str = conninfo.make_conninfo(
        database.url,
        dbname=database.name,
        application_name=f"document-locator:{mode.value}",
    )
    return PoolSettings(
        conninfo=conninfo_str,
        schema=database.schema,
        application_name=f"document-locator:{mode.value}",
    )


def _build_configure_callback(settings: PoolSettings) -> Callable[[Connection[Any]], None]:
    def _configure(connection: Connection[Any]) -> None:
        connection.execute(sql.SQL("set search_path to {}").format(sql.Identifier(settings.schema)))
        connection.execute(
            "set statement_timeout to %s",
            (str(settings.statement_timeout_ms),),
        )
        connection.execute(
            "set idle_in_transaction_session_timeout to %s",
            (str(settings.idle_in_transaction_timeout_ms),),
        )

    return _configure


def _mask_secret(value: str) -> str:
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}...{value[-4:]}"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
