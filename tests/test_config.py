from __future__ import annotations

from pathlib import Path

import pytest

REQUIRED_KEYS = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "DATABASE_URL",
    "DATABASE_NAME",
    "DATABASE_SCHEMA",
    "OPENAI_API_KEY",
]


def sample_values() -> dict[str, str]:
    return {
        "GOOGLE_OAUTH_CLIENT_ID": "client-id-from-env",
        "GOOGLE_OAUTH_CLIENT_SECRET": "client-secret",
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
        "SUPABASE_ANON_KEY": "public-anon-key",
        "DATABASE_URL": "postgresql://postgres:password@example.supabase.co:5432/postgres",
        "DATABASE_NAME": "document_locator",
        "DATABASE_SCHEMA": "document_locator_app",
        "OPENAI_API_KEY": "sk-example",
    }


@pytest.fixture(autouse=True)
def clear_config_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in REQUIRED_KEYS:
        monkeypatch.delenv(key, raising=False)


def write_env_file(path: Path, values: dict[str, str]) -> Path:
    env_file = path / ".env"
    lines = (f"{key}={value}" for key, value in values.items())
    env_file.write_text("\n".join(lines), encoding="utf-8")
    return env_file


def write_config_file(path: Path, *, overrides: dict[str, str]) -> Path:
    config_path = path / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                "[google]",
                f'oauth_client_id = "{overrides["GOOGLE_OAUTH_CLIENT_ID"]}"',
                f'oauth_client_secret = "{overrides["GOOGLE_OAUTH_CLIENT_SECRET"]}"',
                "[supabase]",
                f'url = "{overrides["SUPABASE_URL"]}"',
                f'service_role_key = "{overrides["SUPABASE_SERVICE_ROLE_KEY"]}"',
                f'anon_key = "{overrides["SUPABASE_ANON_KEY"]}"',
                "[database]",
                f'url = "{overrides["DATABASE_URL"]}"',
                f'name = "{overrides["DATABASE_NAME"]}"',
                f'schema = "{overrides["DATABASE_SCHEMA"]}"',
                "[openai]",
                f'api_key = "{overrides["OPENAI_API_KEY"]}"',
            ]
        ),
        encoding="utf-8",
    )
    return config_path


def test_loads_values_from_env_file(tmp_path: Path) -> None:
    from app.config import AppConfig, load_config

    env_values = sample_values()
    env_file = write_env_file(tmp_path, env_values)

    config = load_config(env_file=env_file)
    assert isinstance(config, AppConfig)
    assert config.google.oauth_client_id == env_values["GOOGLE_OAUTH_CLIENT_ID"]
    assert config.supabase.url == env_values["SUPABASE_URL"]
    assert config.supabase.anon_key == env_values["SUPABASE_ANON_KEY"]
    assert config.database.url == env_values["DATABASE_URL"]
    assert config.database.name == env_values["DATABASE_NAME"]
    assert config.database.schema == env_values["DATABASE_SCHEMA"]
    assert config.openai.api_key == env_values["OPENAI_API_KEY"]


def test_config_file_overrides_env_file(tmp_path: Path) -> None:
    from app.config import load_config

    env_file = write_env_file(tmp_path, sample_values())
    overrides = {
        **sample_values(),
        "OPENAI_API_KEY": "sk-config",
        "SUPABASE_URL": "https://config.supabase.co",
        "DATABASE_SCHEMA": "config_schema",
    }
    config_file = write_config_file(tmp_path, overrides=overrides)

    config = load_config(env_file=env_file, config_file=config_file)
    assert config.openai.api_key == "sk-config"
    assert config.supabase.url == "https://config.supabase.co"
    assert config.database.schema == "config_schema"


def test_environment_variables_have_highest_priority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import load_config

    env_file = write_env_file(tmp_path, sample_values())
    config_file = write_config_file(tmp_path, overrides=sample_values())
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "runtime-secret")

    config = load_config(env_file=env_file, config_file=config_file)
    assert config.supabase.service_role_key == "runtime-secret"


def test_missing_value_raises_error(tmp_path: Path) -> None:
    from app.config import ConfigError, load_config

    env_values = sample_values()
    del env_values["OPENAI_API_KEY"]
    env_file = write_env_file(tmp_path, env_values)

    with pytest.raises(ConfigError) as excinfo:
        load_config(env_file=env_file)

    assert "OPENAI_API_KEY" in str(excinfo.value)


def test_doctor_returns_false_when_invalid(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from app.config import doctor

    env_values = sample_values()
    del env_values["DATABASE_URL"]
    env_file = write_env_file(tmp_path, env_values)

    status = doctor(env_file=env_file)
    captured = capsys.readouterr()
    assert status is False
    assert "DATABASE_URL" in captured.err


def test_doctor_reports_success(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from app.config import doctor

    env_file = write_env_file(tmp_path, sample_values())

    status = doctor(env_file=env_file)
    captured = capsys.readouterr()
    assert status is True
    assert "configuration looks good" in captured.out.lower()
    assert "database schema" in captured.out.lower()
