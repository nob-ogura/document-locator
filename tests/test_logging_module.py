from __future__ import annotations

import json
import logging

import pytest


def test_configure_logging_emits_json_to_stdout(capsys: pytest.CaptureFixture[str]) -> None:
    import app.logging as app_logging

    app_logging.configure_logging(level="INFO", fmt="json", destination="stdout")
    logging.getLogger("test.logger").info("structured message", extra={"component": "logger"})

    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip())
    assert payload["message"] == "structured message"
    assert payload["component"] == "logger"
    assert payload["level"] == "INFO"
    assert "timestamp" in payload


def test_configure_logging_sends_warnings_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    import app.logging as app_logging

    app_logging.configure_logging(level="INFO", fmt="text", destination="auto")
    logger = logging.getLogger("split.logger")
    logger.info("info-line")
    logger.warning("warn-line")

    captured = capsys.readouterr()
    assert "info-line" in captured.out
    assert "warn-line" in captured.err
