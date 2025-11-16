from __future__ import annotations

from contextlib import contextmanager

import pytest
from app.config import (
    AppConfig,
    DatabaseConfig,
    GoogleConfig,
    OpenAIConfig,
    SupabaseConfig,
)
from app.db import client


class DummyConnection:
    def __init__(self) -> None:
        self.closed = False
        self.commands: list[str] = []

    def execute(self, sql: str, *_args: object) -> None:
        self.commands.append(sql)


class DummyPool:
    def __init__(self, conninfo: str, **kwargs: object) -> None:
        self.conninfo = conninfo
        self.kwargs = kwargs
        self.configure = kwargs.get("configure")
        self.checkout_count = 0
        self.document_locator_mode = None

    def connection(self) -> DummyPoolConnection:
        return DummyPoolConnection(self)

    def close(self) -> None:
        self.checkout_count = 0


class DummyPoolConnection:
    def __init__(self, pool: DummyPool) -> None:
        self.pool = pool
        self.conn: DummyConnection | None = None

    def __enter__(self) -> DummyConnection:
        self.pool.checkout_count += 1
        self.conn = DummyConnection()
        if callable(self.pool.configure):
            self.pool.configure(self.conn)
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> None:  # type: ignore[override]
        assert self.conn is not None
        self.pool.checkout_count -= 1
        self.conn.closed = True


def build_config() -> AppConfig:
    return AppConfig(
        google=GoogleConfig(
            oauth_client_id="id",
            oauth_client_secret="secret",
            target_folder_id="folder-id",
        ),
        supabase=SupabaseConfig(
            url="https://project.supabase.co",
            service_role_key="service-role",
            anon_key="anon-key",
        ),
        database=DatabaseConfig(
            url="postgresql://postgres:password@db.supabase.co:5432/postgres",
            name="document_locator",
            schema="document_locator_app",
        ),
        openai=OpenAIConfig(api_key="sk-test"),
    )


def install_fake_pool(monkeypatch: pytest.MonkeyPatch) -> list[DummyPool]:
    pools: list[DummyPool] = []

    def factory(conninfo: str, **kwargs: object) -> DummyPool:
        pool = DummyPool(conninfo, **kwargs)
        pools.append(pool)
        return pool

    monkeypatch.setattr(client, "ConnectionPool", factory)
    return pools


def test_get_connection_configures_connections(monkeypatch: pytest.MonkeyPatch) -> None:
    config = build_config()
    monkeypatch.setattr(client, "get_config", lambda: config)
    pools = install_fake_pool(monkeypatch)
    client.reset_pools()

    with client.get_connection() as connection:
        assert isinstance(connection, DummyConnection)

    assert pools, "expected a connection pool to be created"
    pool = pools[0]
    assert "dbname=document_locator" in pool.conninfo
    assert any("search_path" in str(cmd) for cmd in connection.commands)
    assert any("statement_timeout" in str(cmd) for cmd in connection.commands)


def test_get_connection_creates_distinct_pools_by_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    config = build_config()
    monkeypatch.setattr(client, "get_config", lambda: config)
    pools = install_fake_pool(monkeypatch)
    client.reset_pools()

    with client.get_connection(mode=client.ConnectionMode.SERVICE):
        pass
    with client.get_connection(mode=client.ConnectionMode.USER):
        pass

    assert len(pools) == 2
    assert pools[0] is not pools[1]
    assert pools[0].document_locator_mode == client.ConnectionMode.SERVICE
    assert pools[1].document_locator_mode == client.ConnectionMode.USER


def test_doctor_runs_simple_query(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    executed: list[str] = []

    @contextmanager
    def fake_get_connection(*, mode: client.ConnectionMode):
        class _Conn:
            def execute(self, sql: str) -> None:
                executed.append(sql.strip().lower())

        yield _Conn()

    monkeypatch.setattr(client, "get_connection", fake_get_connection)
    status = client.doctor(mode=client.ConnectionMode.USER)
    captured = capsys.readouterr()

    assert status is True
    assert executed == ["select 1"]
    assert "user" in captured.out.lower()


def test_doctor_handles_errors(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class Exploding:
        def __enter__(self):
            raise RuntimeError("boom")

        def __exit__(self, exc_type, exc, tb) -> None:  # pragma: no cover - never reached
            pass

    monkeypatch.setattr(client, "get_connection", lambda **_: Exploding())

    status = client.doctor(mode=client.ConnectionMode.SERVICE)
    captured = capsys.readouterr()
    assert status is False
    assert "boom" in captured.err.lower()
