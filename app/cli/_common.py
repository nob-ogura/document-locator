"""Utilities shared by CLI entrypoints."""

from __future__ import annotations

import argparse
import logging
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, cast

from app.config import ConfigError, load_config
from app.logging import configure_logging

if TYPE_CHECKING:
    from app.config import AppConfig


_LOG_LEVEL_CHOICES = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET")
_LOG_FORMAT_CHOICES = ("text", "json")
_LOG_DESTINATION_CHOICES = ("auto", "stdout", "stderr")


CliRunner = Callable[[argparse.Namespace], int]


class CLIArgs(argparse.Namespace):
    log_level: str
    log_format: str
    log_destination: str
    config: Path | None
    env_file: Path | None
    app_config: AppConfig


def build_parser(*, prog: str, description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog,
        description=description,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="Path to a TOML configuration file overriding defaults.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        help="Optional .env file containing secrets.",
    )
    parser.add_argument(
        "--log-level",
        type=_log_level_type,
        choices=_LOG_LEVEL_CHOICES,
        default="INFO",
        help="Logging verbosity (case-insensitive).",
    )
    parser.add_argument(
        "--log-format",
        type=_log_format_type,
        choices=_LOG_FORMAT_CHOICES,
        default="text",
        help="Structured JSON or human-readable text logs.",
    )
    parser.add_argument(
        "--log-destination",
        type=_log_destination_type,
        choices=_LOG_DESTINATION_CHOICES,
        default="auto",
        help="Write logs to stdout, stderr, or split automatically by level.",
    )
    return parser


def run_cli(
    parser: argparse.ArgumentParser,
    argv: Sequence[str] | None,
    *,
    cli_name: str,
    display_name: str,
    runner: CliRunner,
) -> int:
    args = cast(CLIArgs, parser.parse_args(argv))
    configure_logging(
        level=args.log_level,
        fmt=args.log_format,
        destination=args.log_destination,
    )
    logger = logging.getLogger(f"document_locator.cli.{cli_name}")
    try:
        config = load_config(env_file=args.env_file, config_file=args.config)
    except ConfigError as exc:
        logger.error(
            "Configuration invalid",
            extra={"cli": cli_name, "error": str(exc)},
        )
        return 2

    args.app_config = config
    logger.info("%s CLI ready", display_name, extra={"cli": cli_name})
    return runner(args)


def _log_level_type(value: str) -> str:
    normalized = value.upper()
    if normalized not in _LOG_LEVEL_CHOICES:
        raise argparse.ArgumentTypeError(
            f"Invalid log level '{value}'. Expected one of: {', '.join(_LOG_LEVEL_CHOICES)}"
        )
    return normalized


def _log_format_type(value: str) -> str:
    normalized = value.lower()
    if normalized not in _LOG_FORMAT_CHOICES:
        raise argparse.ArgumentTypeError(
            f"Invalid log format '{value}'. Expected one of: {', '.join(_LOG_FORMAT_CHOICES)}"
        )
    return normalized


def _log_destination_type(value: str) -> str:
    normalized = value.lower()
    if normalized not in _LOG_DESTINATION_CHOICES:
        expected = ", ".join(_LOG_DESTINATION_CHOICES)
        raise argparse.ArgumentTypeError(
            f"Invalid log destination '{value}'. Expected one of: {expected}"
        )
    return normalized


__all__ = [
    "CliRunner",
    "build_parser",
    "run_cli",
]
