"""Elasticsearch client singleton.

Sync API (elasticsearch-py 8.x) to match the PR-1A-2 sync SQLAlchemy
pattern. Async wrapper lands in Sprint 1B / 4 if API routes need it.
"""
from __future__ import annotations

import logging
import os
from threading import Lock

from elasticsearch import Elasticsearch

logger = logging.getLogger("lucid.es")

LUCID_FACTS = "lucid_facts"
LUCID_OBJECTS = "lucid_objects"
LUCID_SOURCES = "lucid_sources"

_client: Elasticsearch | None = None
_client_lock = Lock()


def _elasticsearch_url() -> str:
    return os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")


def get_client() -> Elasticsearch:
    """Return a process-wide singleton Elasticsearch client.

    First call constructs the client; subsequent calls return the same
    instance. Use `reset_client()` between integration tests when a
    fresh connection is needed.
    """
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            _client = Elasticsearch(
                _elasticsearch_url(),
                request_timeout=10,
                retry_on_timeout=True,
                max_retries=3,
                verify_certs=False,
            )
            logger.info("ES client constructed for %s", _elasticsearch_url())
    return _client


def reset_client() -> None:
    """Close and drop the singleton. Used by integration test teardown."""
    global _client
    with _client_lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:  # noqa: BLE001
                pass
            _client = None
