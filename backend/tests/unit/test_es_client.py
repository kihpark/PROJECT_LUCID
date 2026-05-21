"""Unit test: ES client singleton behavior (no live ES needed)."""
from __future__ import annotations

import os
from unittest.mock import patch

from api.storage.elasticsearch import client as es_client


def setup_function() -> None:
    es_client.reset_client()


def teardown_function() -> None:
    es_client.reset_client()


def test_get_client_returns_singleton():
    """Two consecutive get_client() calls return the same instance."""
    with patch.dict(os.environ, {"ELASTICSEARCH_URL": "http://localhost:9200"}):
        a = es_client.get_client()
        b = es_client.get_client()
        assert a is b


def test_reset_client_drops_singleton():
    """reset_client() forces the next get_client() to construct a new one."""
    with patch.dict(os.environ, {"ELASTICSEARCH_URL": "http://localhost:9200"}):
        a = es_client.get_client()
        es_client.reset_client()
        b = es_client.get_client()
        assert a is not b


def test_index_name_constants():
    """The three index name constants are stable strings."""
    assert es_client.LUCID_FACTS == "lucid_facts"
    assert es_client.LUCID_OBJECTS == "lucid_objects"
    assert es_client.LUCID_SOURCES == "lucid_sources"
