"""Logging utilities for document-locator CLIs."""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

LogFormat = Literal["text", "json"]
LogDestination = Literal["auto", "stdout", "stderr"]

_RESERVED_RECORD_KEYS = {
    "name",
    "msg",
    "args",
    "levelname",
    "levelno",
    "pathname",
    "filename",
    "module",
    "exc_info",
    "exc_text",
    "stack_info",
    "lineno",
    "funcName",
    "created",
    "msecs",
    "relativeCreated",
    "thread",
    "threadName",
    "process",
    "processName",
    "taskName",
    "message",
}


class JsonFormatter(logging.Formatter):
    """Format log records as structured JSON objects."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        payload: dict[str, Any] = {
            "timestamp": datetime.now(tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        for key, value in record.__dict__.items():
            if key in _RESERVED_RECORD_KEYS or key.startswith("_"):
                continue
            payload[key] = value
        return json.dumps(payload, default=_stringify)


@dataclass(slots=True)
class _LevelRangeFilter(logging.Filter):
    min_level: int | None = None
    max_level: int | None = None

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        if self.min_level is not None and record.levelno < self.min_level:
            return False
        if self.max_level is not None and record.levelno > self.max_level:
            return False
        return True


def configure_logging(
    *,
    level: str | int = "INFO",
    fmt: LogFormat = "text",
    destination: LogDestination = "auto",
) -> logging.Logger:
    """Configure the root logger with common handlers and formatters."""

    resolved_level = _resolve_level(level)
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(resolved_level)

    formatter = _select_formatter(fmt)
    for handler in _build_handlers(destination):
        handler.setLevel(logging.NOTSET)
        handler.setFormatter(formatter)
        root.addHandler(handler)

    logging.captureWarnings(True)
    return root


def _resolve_level(value: str | int) -> int:
    if isinstance(value, int):
        return value
    normalized = value.upper()
    resolved = logging.getLevelName(normalized)
    if not isinstance(resolved, int):  # logging returns the input string when it fails
        raise ValueError(f"Unknown log level: {value}")
    return resolved


def _select_formatter(fmt: LogFormat) -> logging.Formatter:
    if fmt == "json":
        return JsonFormatter()
    return logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")


def _build_handlers(destination: LogDestination) -> Iterable[logging.Handler]:
    if destination == "stdout":
        return (logging.StreamHandler(sys.stdout),)
    if destination == "stderr":
        return (logging.StreamHandler(sys.stderr),)

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.addFilter(_LevelRangeFilter(max_level=logging.INFO))
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.addFilter(_LevelRangeFilter(min_level=logging.WARNING))
    return (stdout_handler, stderr_handler)


def _stringify(value: Any) -> str:
    return str(value)


__all__ = ["LogDestination", "LogFormat", "JsonFormatter", "configure_logging"]
