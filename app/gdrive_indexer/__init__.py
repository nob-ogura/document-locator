"""Bootstrap module for Google Drive indexing workflows."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class IndexerConfig:
    """Static configuration placeholder for the Drive indexer."""

    project: str = "document-locator"


def bootstrap() -> IndexerConfig:
    """Return a default configuration instance.

    Phase 1+ will replace this stub with real logic, but providing a concrete
    function ensures downstream modules can import this package today.
    """

    return IndexerConfig()


__all__ = [
    "IndexerConfig",
    "bootstrap",
]
