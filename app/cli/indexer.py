"""`gdrive-indexer` CLI entrypoint."""

from __future__ import annotations

import argparse
from typing import Sequence

from app.cli import _common


PROG_NAME = "gdrive-indexer"
DESCRIPTION = "Index Google Drive documents into the document-locator data store."


def build_parser() -> argparse.ArgumentParser:
    return _common.build_parser(prog=PROG_NAME, description=DESCRIPTION)


def run(args: argparse.Namespace) -> int:
    """Placeholder for the real indexing workflow."""

    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    return _common.run_cli(parser, argv, cli_name="indexer", display_name="Indexer", runner=run)


if __name__ == "__main__":  # pragma: no cover - manual execution guard
    raise SystemExit(main())


__all__ = ["build_parser", "main", "run"]
