from __future__ import annotations

import app.gdrive_indexer as gdrive_indexer
import app.gdrive_search as gdrive_search


def test_indexer_bootstrap_returns_config() -> None:
    config = gdrive_indexer.bootstrap()
    assert config.project == "document-locator"


def test_search_build_query_roundtrip() -> None:
    query = gdrive_search.build_query("drive")
    assert query.term == "drive"
