"""Live OpenAI embedding smoke (env-gated).

These tests hit the real OpenAI text-embedding-3-small endpoint. They
are skipped by default so CI runs (and dev runs without a key) don't
accidentally spend tokens or hang. To run:

    LUCID_LIVE_EMBEDDING_SMOKE=1 \\
        OPENAI_API_KEY=sk-... \\
        python -m pytest tests/smoke/test_embedding_live.py -v

They exist to prove the v0.2.0 graduation gate is real:
- the embedding wrapper returns a non-zero 1536-dim vector for the
  PO repro queries, and
- the two PO-repro entities have low cosine similarity (i.e. the
  vector space actually separates them).
"""
from __future__ import annotations

import math
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("LUCID_LIVE_EMBEDDING_SMOKE") != "1",
    reason="live embedding smoke disabled (set LUCID_LIVE_EMBEDDING_SMOKE=1)",
)


def _reset_embed_cache() -> None:
    """Defensive: clear the lru_cache so a previous test run doesn't
    feed a stale tuple back."""
    from api.storage.elasticsearch import embeddings as embed_mod
    embed_mod.reset_client()


def test_election_commission_real_embedding():
    _reset_embed_cache()
    from api.storage.elasticsearch.embeddings import get_embedding
    vec = get_embedding("선거관리위원회")
    assert vec is not None, "Live embedding returned None (check OPENAI_API_KEY)"
    assert len(vec) == 1536
    assert any(abs(v) > 1e-9 for v in vec)


def test_minimum_wage_commission_real_embedding():
    _reset_embed_cache()
    from api.storage.elasticsearch.embeddings import get_embedding
    vec = get_embedding("최저임금위원회")
    assert vec is not None
    assert len(vec) == 1536
    assert any(abs(v) > 1e-9 for v in vec)


def test_unrelated_concepts_have_low_similarity():
    """The two PO-repro entity names are different concepts. Their
    cosine similarity should sit well below the 0.85 mark a true
    near-duplicate would hit. Real-world value is closer to 0.4-0.7
    because they share government-commission semantics — but never
    above 0.85."""
    _reset_embed_cache()
    from api.storage.elasticsearch.embeddings import get_embedding
    a = get_embedding("선거관리위원회")
    b = get_embedding("최저임금위원회")
    assert a is not None and b is not None
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    cos = dot / (na * nb)
    print(f"cosine similarity (election vs min-wage commission): {cos:.4f}")
    assert cos < 0.85, (
        f"Expected unrelated concepts to have cosine < 0.85, got {cos:.4f}"
    )
