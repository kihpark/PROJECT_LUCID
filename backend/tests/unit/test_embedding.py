"""Unit tests for the OpenAI embedding wrapper as exercised by the
search-embedding-restore graduation gate.

Complements tests/unit/test_es_embeddings.py with the failure-mode
coverage the v0.2.0 gate cares about: network errors, wrong-length
responses, and ensuring an OpenAI client is never constructed when
no key is set.
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

from api.storage.elasticsearch import embeddings


def setup_function() -> None:
    embeddings.reset_client()


def teardown_function() -> None:
    embeddings.reset_client()


def test_empty_input_returns_none():
    """An empty / whitespace input short-circuits before any client
    construction — even if a key is configured."""
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        with patch.object(embeddings, "_make_client") as make:
            assert embeddings.get_embedding("") is None
            assert embeddings.get_embedding("   ") is None
            make.assert_not_called()


def test_missing_api_key_returns_none():
    """The wrapper degrades to None when OPENAI_API_KEY is unset."""
    with patch.dict(os.environ, {}, clear=True):
        embeddings.reset_client()
        assert embeddings.get_embedding("hello") is None


def test_real_client_returns_1536_vector():
    """Happy-path: client returns a 1536-element vector; the wrapper
    surfaces it as a hashable tuple."""
    fake_resp = MagicMock()
    fake_resp.data = [MagicMock(embedding=[0.01] * 1536)]
    fake_client = MagicMock()
    fake_client.embeddings.create.return_value = fake_resp
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        with patch.object(embeddings, "_make_client", return_value=fake_client):
            vec = embeddings.get_embedding("선거관리위원회")
            assert isinstance(vec, tuple)
            assert len(vec) == 1536
            assert vec[0] == 0.01


def test_network_error_returns_none_after_retries():
    """A persistent exception from the OpenAI client returns None,
    not a raise — the recall route depends on this for fail-soft
    behaviour."""
    fake_client = MagicMock()
    fake_client.embeddings.create.side_effect = RuntimeError("boom")
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        # Make backoff effectively zero so the test doesn't sleep.
        with patch.object(embeddings, "INITIAL_BACKOFF_SECONDS", 0):
            with patch.object(embeddings, "_make_client", return_value=fake_client):
                assert embeddings.get_embedding("nonempty") is None
        # 3 attempts per MAX_RETRIES.
        assert fake_client.embeddings.create.call_count == embeddings.MAX_RETRIES


def test_unexpected_dim_returns_value_anyway_but_logs_warning(caplog):
    """The wrapper passes a non-1536 vector through (it logs a warning
    rather than munging the return). Downstream callers must treat
    `len(vec) != EMBEDDING_DIMS` as a soft signal."""
    fake_resp = MagicMock()
    fake_resp.data = [MagicMock(embedding=[0.01] * 100)]
    fake_client = MagicMock()
    fake_client.embeddings.create.return_value = fake_resp
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        with patch.object(embeddings, "_make_client", return_value=fake_client):
            with caplog.at_level("WARNING", logger="lucid.es.embeddings"):
                vec = embeddings.get_embedding("anything")
        assert vec is not None
        assert len(vec) == 100
        assert any("Unexpected embedding dim" in r.message for r in caplog.records)
