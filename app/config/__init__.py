from __future__ import annotations

import os
import sys
import tomllib
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"
DEFAULT_CONFIG_FILE = Path.home() / ".config" / "document_locator" / "config.toml"
ENV_FILE_ENV_VAR = "DOCUMENT_LOCATOR_ENV_FILE"
CONFIG_FILE_ENV_VAR = "DOCUMENT_LOCATOR_CONFIG_FILE"

_PATH_TO_ENV_KEY: dict[tuple[str, str], str] = {
    ("google", "oauth_client_id"): "GOOGLE_OAUTH_CLIENT_ID",
    ("google", "oauth_client_secret"): "GOOGLE_OAUTH_CLIENT_SECRET",
    ("google", "target_folder_id"): "GOOGLE_DRIVE_TARGET_FOLDER_ID",
    ("supabase", "url"): "SUPABASE_URL",
    ("supabase", "service_role_key"): "SUPABASE_SERVICE_ROLE_KEY",
    ("supabase", "anon_key"): "SUPABASE_ANON_KEY",
    ("database", "url"): "DATABASE_URL",
    ("database", "name"): "DATABASE_NAME",
    ("database", "schema"): "DATABASE_SCHEMA",
    ("openai", "api_key"): "OPENAI_API_KEY",
}
_ENV_KEY_TO_PATH = {env_name: path for path, env_name in _PATH_TO_ENV_KEY.items()}

_SECTION_FIELDS: dict[str, set[str]] = {}
for section, field in _PATH_TO_ENV_KEY:
    _SECTION_FIELDS.setdefault(section, set()).add(field)


class ConfigError(RuntimeError):
    """Raised when the configuration cannot be loaded."""


@dataclass(frozen=True)
class GoogleConfig:
    oauth_client_id: str
    oauth_client_secret: str
    target_folder_id: str


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    service_role_key: str
    anon_key: str


@dataclass(frozen=True)
class DatabaseConfig:
    url: str
    name: str
    schema: str


@dataclass(frozen=True)
class OpenAIConfig:
    api_key: str


@dataclass(frozen=True)
class AppConfig:
    google: GoogleConfig
    supabase: SupabaseConfig
    database: DatabaseConfig
    openai: OpenAIConfig


_CONFIG_CACHE: AppConfig | None = None


def get_config() -> AppConfig:
    """Return a cached configuration using the default sources."""
    global _CONFIG_CACHE
    if _CONFIG_CACHE is None:
        _CONFIG_CACHE = load_config()
    return _CONFIG_CACHE


def load_config(
    *,
    env_file: Path | str | None = None,
    config_file: Path | str | None = None,
    environ: Mapping[str, str] | None = None,
) -> AppConfig:
    """Load a configuration from `.env`, the personal config file, and environment variables."""
    env_path = _resolve_env_file(env_file)
    config_path = _resolve_config_file(config_file)

    merged: dict[str, Any] = {}
    _deep_merge(merged, _env_mapping_to_nested(_parse_env_file(env_path)))
    _deep_merge(merged, _filter_known_sections(_read_config_file(config_path)))
    runtime_values = environ if environ is not None else os.environ
    _deep_merge(merged, _env_mapping_to_nested(runtime_values))
    return _build_app_config(merged)


def doctor(*, env_file: Path | str | None = None, config_file: Path | str | None = None) -> bool:
    """Validate configuration sources and print a diagnostic summary."""
    try:
        config = load_config(env_file=env_file, config_file=config_file)
    except ConfigError as exc:
        print("Configuration invalid:", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
        return False

    print("Configuration looks good.", file=sys.stdout)
    print(f"  Google OAuth client ID: {config.google.oauth_client_id}", file=sys.stdout)
    print(f"  Drive target folder ID: {config.google.target_folder_id}", file=sys.stdout)
    print(f"  Supabase URL: {config.supabase.url}", file=sys.stdout)
    print("  Supabase keys: service role + anon key loaded.", file=sys.stdout)
    print(f"  Database name: {config.database.name}", file=sys.stdout)
    print(f"  Database schema: {config.database.schema}", file=sys.stdout)
    print("  Secrets are loaded from secure sources.", file=sys.stdout)
    return True


def _build_app_config(data: Mapping[str, Any]) -> AppConfig:
    values: dict[tuple[str, str], str] = {}
    missing: list[str] = []
    for path, env_name in _PATH_TO_ENV_KEY.items():
        section_name, key = path
        section = data.get(section_name)
        raw_value = section.get(key) if isinstance(section, Mapping) else None
        if raw_value is None or str(raw_value).strip() == "":
            missing.append(env_name)
            continue
        values[path] = str(raw_value)

    if missing:
        missing.sort()
        raise ConfigError("Missing required values for " + ", ".join(missing))

    return AppConfig(
        google=GoogleConfig(
            oauth_client_id=values[("google", "oauth_client_id")],
            oauth_client_secret=values[("google", "oauth_client_secret")],
            target_folder_id=values[("google", "target_folder_id")],
        ),
        supabase=SupabaseConfig(
            url=values[("supabase", "url")],
            service_role_key=values[("supabase", "service_role_key")],
            anon_key=values[("supabase", "anon_key")],
        ),
        database=DatabaseConfig(
            url=values[("database", "url")],
            name=values[("database", "name")],
            schema=values[("database", "schema")],
        ),
        openai=OpenAIConfig(api_key=values[("openai", "api_key")]),
    )


def _resolve_env_file(explicit: Path | str | None) -> Path:
    if explicit is not None:
        return Path(explicit)
    override = os.environ.get(ENV_FILE_ENV_VAR)
    if override:
        return Path(override)
    return DEFAULT_ENV_FILE


def _resolve_config_file(explicit: Path | str | None) -> Path:
    if explicit is not None:
        return Path(explicit)
    override = os.environ.get(CONFIG_FILE_ENV_VAR)
    if override:
        return Path(override)
    return DEFAULT_CONFIG_FILE


def _parse_env_file(path: Path) -> dict[str, str]:
    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise ConfigError(f"Failed to read env file {path}: {exc}") from exc

    values: dict[str, str] = {}
    for raw_line in contents.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        value = _strip_quotes(raw_value.strip())
        values[key] = value
    return values


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and ((value[0] == value[-1]) and value.startswith(("'", '"'))):
        return value[1:-1]
    return value


def _read_config_file(path: Path) -> Mapping[str, Any]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise ConfigError(f"Failed to read config file {path}: {exc}") from exc


def _filter_known_sections(raw: Mapping[str, Any]) -> dict[str, Any]:
    filtered: dict[str, Any] = {}
    for section, allowed_fields in _SECTION_FIELDS.items():
        raw_section = raw.get(section)
        if isinstance(raw_section, Mapping):
            filtered_section: dict[str, Any] = {}
            for field in allowed_fields:
                if field in raw_section:
                    filtered_section[field] = str(raw_section[field])
            if filtered_section:
                filtered[section] = filtered_section
    return filtered


def _env_mapping_to_nested(mapping: Mapping[str, Any]) -> dict[str, Any]:
    nested: dict[str, Any] = {}
    for key, value in mapping.items():
        path = _ENV_KEY_TO_PATH.get(key)
        if not path:
            continue
        _assign_path(nested, path, value)
    return nested


def _assign_path(target: MutableMapping[str, Any], path: tuple[str, ...], value: Any) -> None:
    current: MutableMapping[str, Any] = target
    for component in path[:-1]:
        next_value = current.get(component)
        if not isinstance(next_value, MutableMapping):
            next_value = {}
            current[component] = next_value
        current = next_value
    current[path[-1]] = value


def _deep_merge(target: MutableMapping[str, Any], data: Mapping[str, Any]) -> None:
    for key, value in data.items():
        if isinstance(value, Mapping):
            child = target.get(key)
            if not isinstance(child, MutableMapping):
                child = {}
                target[key] = child
            _deep_merge(child, value)
        elif value is not None:
            target[key] = value


__all__ = [
    "AppConfig",
    "ConfigError",
    "DatabaseConfig",
    "GoogleConfig",
    "OpenAIConfig",
    "SupabaseConfig",
    "doctor",
    "get_config",
    "load_config",
]
