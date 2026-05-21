"""OpenAI text-embedding-3-small wrapper.

Sync client (matches PR-1A-2 sync pattern). 1536-dim cosine vectors.
LRU cache (1000 entries) on the text-to-embedding path so repeated
captures of the same string do not re-hit the API. Batch helper for
bulk indexing.

Graceful fallback:
  - When OPENAI_API_KEY is missing, every call returns None instead
    of raising. Callers that index into lucid_facts / lucid_objects
    must treat embedding=None as "skip the dense_vector field" so
    text search and graph traversal still work without semantic kNN.

PO directive 2026-05-21 (PR-1A-3 architect decision): OpenAI is the
beta embedding source. Phase 1+ revisits with a multilingual-e5-large
or self-hosted option.
"""
from __future__ import annotations

import logging
import os
import time
from functools import lru_cache
from typing import Any

logger = logging.getLogger("lucid.es.embeddings")

EMBEDDING_MODEL_DEFAULT = "text-embedding-3-small"
EMBEDDING_DIMS = 1536
LRU_SIZE = 1000
MAX_RETRIES = 3
INITIAL_BACKOFF_SECONDS = 1.0


def _model_name() -> str:
    return os.getenv("EMBEDDING_MODEL", EMBEDDING_MODEL_DEFAULT)


def _api_key_present() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def _make_client() -> Any | None:
    """Construct an OpenAI sync client, or return None if API key is missing."""
    if not _api_key_present():
        logger.warning(
            "OPENAI_API_KEY not set; embeddings disabled "
            "(text search + graph traversal still work)"
        )
        return None
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed; embeddings disabled")
        return None
    return OpenAI()


# Module-level client cached on first use. Reset by tests via reset_client().
_client: Any | None = None
_client_constructed = False


def _client_or_none() -> Any | None:
    global _client, _client_constructed
    if not _client_constructed:
        _client = _make_client()
        _client_constructed = True
    return _client


def reset_client() -> None:
    """Reset the cached OpenAI client. Test-only."""
    global _client, _client_constructed
    _client = None
    _client_constructed = False
    get_embedding.cache_clear()


@lru_cache(maxsize=LRU_SIZE)
def get_embedding(text: str) -> tuple[float, ...] | None:
    """Return an embedding vector for `text`, or None if disabled.

    The return type is a tuple so the result is hashable and lru_cache
    can store it. Callers that need a list can `list(result)`.
    """
    if not text or not text.strip():
        return None
    client = _client_or_none()
    if client is None:
        return None

    backoff = INITIAL_BACKOFF_SECONDS
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.embeddings.create(model=_model_name(), input=text)
            vec = resp.data[0].embedding
            if len(vec) != EMBEDDING_DIMS:
                logger.warning(
                    "Unexpected embedding dim %d (want %d)", len(vec), EMBEDDING_DIMS
                )
            return tuple(vec)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logger.warning(
                "OpenAI embedding attempt %d/%d failed: %s",
                attempt,
                MAX_RETRIES,
                exc,
            )
            if attempt < MAX_RETRIES:
                time.sleep(backoff)
                backoff *= 2
    logger.error("OpenAI embedding failed after %d attempts: %s", MAX_RETRIES, last_exc)
    return None


def batch_embeddings(texts: list[str], batch_size: int = 32) -> list[tuple[float, ...] | None]:
    """Embed many texts. Returns one entry per input (None if disabled/failed).

    Uses the batch input form of the OpenAI embeddings endpoint when
    available; falls back to single calls (with LRU cache) otherwise.
    """
    if not texts:
        return []
    client = _client_or_none()
    if client is None:
        return [None] * len(texts)

    out: list[tuple[float, ...] | None] = [None] * len(texts)
    for start in range(0, len(texts), batch_size):
        chunk = texts[start : start + batch_size]
        try:
            resp = client.embeddings.create(model=_model_name(), input=chunk)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI batch embedding failed: %s; falling back per-text", exc)
            for i, text in enumerate(chunk):
                out[start + i] = get_embedding(text)
            continue
        for i, item in enumerate(resp.data):
            out[start + i] = tuple(item.embedding)
    return out
