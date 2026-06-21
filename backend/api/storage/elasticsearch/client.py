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

# B-38: an optional prefix lets the integration test suite operate
# on test_lucid_facts / test_lucid_objects / test_lucid_sources so its
# session-scoped index teardown can never wipe dev ES. Production /
# the running app leaves LUCID_INDEX_PREFIX unset and gets the bare
# index names exactly as before. The conftest sets the env at import
# time before any app import lands.
_INDEX_PREFIX = os.getenv("LUCID_INDEX_PREFIX", "")
LUCID_FACTS = f"{_INDEX_PREFIX}lucid_facts"
LUCID_OBJECTS = f"{_INDEX_PREFIX}lucid_objects"
LUCID_SOURCES = f"{_INDEX_PREFIX}lucid_sources"
# B-62 landing-integration: public, pre-account beta-applicant intake
# from the v8.2 landing page. ES-only (no alembic migration).
LUCID_APPLICATIONS = f"{_INDEX_PREFIX}lucid_applications"

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
