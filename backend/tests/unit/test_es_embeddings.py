"""Unit test: OpenAI embedding wrapper — cache and graceful fallback."""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

from api.storage.elasticsearch import embeddings


def setup_function() -> None:
    embeddings.reset_client()


def teardown_function() -> None:
    embeddings.reset_client()


def test_graceful_fallback_when_api_key_missing():
    """OPENAI_API_KEY unset -> get_embedding returns None (never raises)."""
    with patch.dict(os.environ, {}, clear=True):
        embeddings.reset_client()
        result = embeddings.get_embedding("hello")
        assert result is None


def test_get_embedding_uses_lru_cache():
    """Two calls for the same text only hit the OpenAI API once."""
    fake_resp = MagicMock()
    fake_resp.data = [MagicMock(embedding=[0.1] * 1536)]
    fake_client = MagicMock()
    fake_client.embeddings.create.return_value = fake_resp

    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        with patch.object(embeddings, "_make_client", return_value=fake_client):
            a = embeddings.get_embedding("the same string")
            b = embeddings.get_embedding("the same string")
            assert a == b
            assert len(a) == 1536
            # Only one underlying API call thanks to lru_cache
            assert fake_client.embeddings.create.call_count == 1


def test_empty_text_returns_none_without_calling_api():
    """Empty / whitespace input short-circuits to None."""
    fake_client = MagicMock()
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        embeddings.reset_client()
        with patch.object(embeddings, "_make_client", return_value=fake_client):
            assert embeddings.get_embedding("") is None
            assert embeddings.get_embedding("   ") is None
            assert fake_client.embeddings.create.call_count == 0
