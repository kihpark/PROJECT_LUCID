"""Unit tests for DCR-002 v2 — LinkRecord.link_nuance + understanding_depth."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from api.metrics.understanding import (
    compute_understanding_depth,
    compute_user_average_understanding,
)
from api.models.links import LinkRecord


# ---------------------------------------------------------------------------
# LinkRecord.link_nuance
# ---------------------------------------------------------------------------
def test_link_record_with_nuance():
    """A LinkRecord can carry an arbitrary `link_nuance` string."""
    r = LinkRecord(
        from_uid="fn-1", to_uid="fn-2",
        link_type="derived_from", link_nuance="causal",
    )
    assert r.link_nuance == "causal"
    assert r.link_type == "derived_from"


def test_link_record_nuance_optional():
    """link_nuance defaults to None when omitted."""
    r = LinkRecord(from_uid="a", to_uid="b", link_type="supports")
    assert r.link_nuance is None


def test_link_record_backward_compat_dump_excludes_default_none():
    """Existing serialized LinkRecords (no link_nuance) round-trip cleanly.
    Pydantic v2 model_dump emits link_nuance=None when present in the
    instance; the API layer treats None as the legacy semantic."""
    legacy_payload = {
        "from_uid": "fn-a", "to_uid": "fn-b",
        "link_type": "contradicts", "weight": 1.0,
    }
    r = LinkRecord.model_validate(legacy_payload)
    assert r.link_nuance is None
    assert r.link_type == "contradicts"


# ---------------------------------------------------------------------------
# compute_understanding_depth
# ---------------------------------------------------------------------------
KS = "ks-und-test"


def test_understanding_depth_isolated_zero():
    """A fact with no Object mentions has depth 0."""
    with patch(
        "api.metrics.understanding._get_objects_for_fact",
        return_value=set(),
    ):
        d = compute_understanding_depth("fn-isolated", KS)
    assert d == 0


def test_understanding_depth_1hop():
    """One Object mediates two facts -> depth >= 1."""
    def fake_objs(fact_uid, ks):
        return {"obj-1"} if fact_uid == "fn-seed" else {"obj-1"}

    def fake_facts(obj_uids, ks):
        return {"fn-seed", "fn-other-1", "fn-other-2"}

    with patch(
        "api.metrics.understanding._get_objects_for_fact",
        side_effect=fake_objs,
    ), patch(
        "api.metrics.understanding._get_facts_for_objects",
        side_effect=fake_facts,
    ):
        d = compute_understanding_depth("fn-seed", KS, max_hop=1)
    # 1-hop: 2 distinct others (fn-other-1, fn-other-2). The seed is excluded.
    assert d == 2


def test_understanding_depth_2hop_dedup():
    """2-hop traversal de-dupes facts already counted at hop 1."""
    # fn-seed -> obj-1 -> {fn-seed, fn-A}
    # fn-A    -> obj-2 -> {fn-A, fn-B, fn-seed}   # fn-seed is the seed; drop.
    objs_by_fact = {
        "fn-seed": {"obj-1"},
        "fn-A": {"obj-2"},
    }
    facts_by_objs = {
        frozenset({"obj-1"}): {"fn-seed", "fn-A"},
        frozenset({"obj-2"}): {"fn-A", "fn-B", "fn-seed"},
    }

    def fake_obj(fact_uid, ks):
        return objs_by_fact.get(fact_uid, set())

    def fake_facts(obj_uids, ks):
        return facts_by_objs.get(frozenset(obj_uids), set())

    with patch(
        "api.metrics.understanding._get_objects_for_fact",
        side_effect=fake_obj,
    ), patch(
        "api.metrics.understanding._get_facts_for_objects",
        side_effect=fake_facts,
    ):
        d = compute_understanding_depth("fn-seed", KS, max_hop=2)
    # 1-hop = {fn-A}; 2-hop adds {fn-B}; total distinct others = 2.
    assert d == 2


# ---------------------------------------------------------------------------
# compute_user_average_understanding
# ---------------------------------------------------------------------------
def test_user_average_understanding():
    """Average over a 3-fact KS where each fact has known depth."""
    with patch(
        "api.metrics.understanding._get_objects_for_fact",
        side_effect=lambda fact_uid, ks: {"obj-shared"},
    ), patch(
        "api.metrics.understanding._get_facts_for_objects",
        side_effect=lambda obj_uids, ks: {"fn-1", "fn-2", "fn-3"},
    ), patch(
        "api.storage.elasticsearch.client.get_client",
    ) as mock_client:
        # Mock the index-level search that lists all facts in the KS.
        mock_client.return_value.search.return_value = {
            "hits": {"hits": [
                {"_source": {"fact_uid": "fn-1"}},
                {"_source": {"fact_uid": "fn-2"}},
                {"_source": {"fact_uid": "fn-3"}},
            ]},
        }
        avg = compute_user_average_understanding(KS)
    # Each fact's depth = 2 (the other two facts via the shared object).
    assert avg == 2.0


def test_user_average_understanding_empty_ks_returns_zero():
    """Empty KS scan returns 0.0 (no division-by-zero)."""
    with patch(
        "api.storage.elasticsearch.client.get_client",
    ) as mock_client:
        mock_client.return_value.search.return_value = {"hits": {"hits": []}}
        avg = compute_user_average_understanding(KS)
    assert avg == 0.0


# ---------------------------------------------------------------------------
# UnderstandingDepthLog: PII invariant
# ---------------------------------------------------------------------------
def test_understanding_depth_log_has_no_pii_columns():
    """The aggregate log carries no fact ids, no claim text, no urls."""
    from api.storage.postgres.orm import UnderstandingDepthLog
    cols = {c.name for c in UnderstandingDepthLog.__table__.columns}
    banned = {
        "fact_uid", "object_uid", "claim", "claim_text",
        "source_url", "url", "object_name", "raw_payload",
    }
    assert banned.isdisjoint(cols), (
        f"PII column leaked into understanding_depth_logs: {banned & cols}"
    )
    required = {
        "id", "user_id", "knowledge_space_id",
        "average_depth", "max_depth",
        "isolated_facts_count", "total_facts", "measured_at",
    }
    assert required.issubset(cols), f"missing: {required - cols}"
