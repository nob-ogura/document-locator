from __future__ import annotations

import json
from importlib import import_module
from pathlib import Path

import pytest

REQUIRED_ENV = {
    "GOOGLE_OAUTH_CLIENT_ID": "client-id",
    "GOOGLE_OAUTH_CLIENT_SECRET": "client-secret",
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "service-role",
    "SUPABASE_ANON_KEY": "public-anon-key",
    "DATABASE_URL": "postgresql://postgres:password@example.supabase.co:5432/postgres",
    "DATABASE_NAME": "document_locator",
    "DATABASE_SCHEMA": "document_locator_app",
    "OPENAI_API_KEY": "sk-test",
}


@pytest.fixture()
def runtime_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    return REQUIRED_ENV


@pytest.mark.parametrize(
    ("module_name", "cli_name"),
    [
        ("app.cli.indexer", "indexer"),
        ("app.cli.search", "search"),
    ],
)
def test_cli_parser_supports_common_options(module_name: str, cli_name: str) -> None:
    module = import_module(module_name)
    parser = module.build_parser()
    args = parser.parse_args(
        [
            "--log-level",
            "debug",
            "--log-format",
            "json",
            "--log-destination",
            "stderr",
            "--config",
            "/tmp/config.toml",
            "--env-file",
            "/tmp/env",
        ]
    )

    assert args.log_level == "DEBUG"
    assert args.log_format == "json"
    assert args.log_destination == "stderr"
    assert args.config == Path("/tmp/config.toml")
    assert args.env_file == Path("/tmp/env")


@pytest.mark.parametrize("module_name", ["app.cli.indexer", "app.cli.search"])
def test_cli_help_exits_cleanly(module_name: str) -> None:
    module = import_module(module_name)
    parser = module.build_parser()
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--help"])
    assert excinfo.value.code == 0


@pytest.mark.parametrize(
    ("module_name", "cli_name"),
    [
        ("app.cli.indexer", "indexer"),
        ("app.cli.search", "search"),
    ],
)
def test_cli_main_emits_json_log(
    module_name: str,
    cli_name: str,
    runtime_env: dict[str, str],
    capsys: pytest.CaptureFixture[str],
) -> None:
    module = import_module(module_name)
    exit_code = module.main(["--log-format=json", "--log-destination=stdout"])

    assert exit_code == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip())
    assert payload["level"] == "INFO"
    assert payload["cli"] == cli_name
    assert payload["message"].startswith(cli_name.capitalize())
    assert captured.err == ""


@pytest.mark.parametrize("module_name", ["app.cli.indexer", "app.cli.search"])
def test_cli_reports_configuration_errors(
    module_name: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    module = import_module(module_name)
    for key in REQUIRED_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DOCUMENT_LOCATOR_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.setenv("DOCUMENT_LOCATOR_CONFIG_FILE", str(tmp_path / "missing.toml"))

    exit_code = module.main([])

    assert exit_code == 2
    captured = capsys.readouterr()
    assert "configuration" in captured.err.lower()
