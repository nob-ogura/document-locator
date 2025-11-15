"""Bootstrap module for Google Drive search workflows."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class SearchQuery:
    """Minimal query representation placeholder."""

    term: str


def build_query(term: str) -> SearchQuery:
    """Construct a SearchQuery that future phases can expand."""

    return SearchQuery(term=term)


__all__ = [
    "SearchQuery",
    "build_query",
]
