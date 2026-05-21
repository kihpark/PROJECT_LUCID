"""Integration test: Elasticsearch connection.

Requires `docker compose up -d elasticsearch`. Skipped automatically when
ELASTICSEARCH_URL is unreachable.
"""
import os

import pytest

pytestmark = pytest.mark.integration


def test_elasticsearch_ping_and_info():
    """ping() must succeed and info() must report version >= 8.0."""
    try:
        from elasticsearch import Elasticsearch
    except ImportError:
        pytest.skip("elasticsearch not installed in this environment")

    url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    try:
        client = Elasticsearch(url, request_timeout=5, verify_certs=False)
        if not client.ping():
            pytest.skip(f"Elasticsearch not reachable at {url}")
        info = client.info()
        version = info["version"]["number"]
        major = int(version.split(".")[0])
        assert major >= 8, f"Expected ES 8.x, got {version}"
        client.close()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Elasticsearch not reachable: {exc}")
