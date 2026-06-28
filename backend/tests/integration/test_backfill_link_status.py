"""Integration tests for api.ops.backfill_link_status.

Contracts:
- dry-run never writes
- claim -> claimed, non-claim -> verified
- idempotent (second pass = 0 updated)
"""
from __future__ import annotations

import uuid

import pytest

from api.ops.backfill_link_status import backfill_link_status
from api.storage.elasticsearch.client import LUCID_FACTS, get_client

pytestmark = pytest.mark.integration


def _seed_fact(es_client, *, ks_id, fact_type, link_status=None):
    fact_uid = f"f-{uuid.uuid4().hex[:12]}"
    doc = {
        "fact_uid": fact_uid,
        "fact_type": fact_type,
        "knowledge_space_id": ks_id,
        "subject_uid": "subj-x",
        "predicate": "tested",
        "source_uids": [],
    }
    if link_status is not None:
        doc["link_status"] = link_status
    es_client.index(
        index=LUCID_FACTS, id=fact_uid, document=doc, refresh="wait_for"
    )
    return fact_uid


def _delete_fact(es_client, fact_uid):
    try:
        es_client.delete(
            index=LUCID_FACTS, id=fact_uid, refresh="wait_for"
        )
    except Exception:
        pass


def _get_link_status(es_client, fact_uid):
    src = es_client.get(index=LUCID_FACTS, id=fact_uid)["_source"]
    return src.get("link_status")


@pytest.fixture
def fresh_ks(es_indexes):
    from api.storage.elasticsearch import indexes
    indexes.create_indexes()
    return f"ks-bls-{uuid.uuid4().hex[:10]}"


def test_dry_run_does_not_write(es_client, fresh_ks):
    """Seed 1 claim + 1 action. Dry-run should count both but mutate nothing."""
    ids = []
    try:
        ids.append(_seed_fact(es_client, ks_id=fresh_ks, fact_type="claim"))
        ids.append(_seed_fact(es_client, ks_id=fresh_ks, fact_type="action"))

        es_client.indices.refresh(index=LUCID_FACTS)
        result = backfill_link_status(fresh_ks, dry_run=True)

        assert result["dry_run"] is True
        assert result["claim_to_claimed"] == 1
        assert result["non_claim_to_verified"] == 1

        # Nothing written
        es_client.indices.refresh(index=LUCID_FACTS)
        for fid in ids:
            assert _get_link_status(es_client, fid) is None, (
                "dry-run must not write link_status"
            )
    finally:
        for fid in ids:
            _delete_fact(es_client, fid)


def test_apply_sets_link_status(es_client, fresh_ks):
    """Apply: claim -> claimed, action+measurement -> verified."""
    ids = {}
    try:
        ids["claim"] = _seed_fact(es_client, ks_id=fresh_ks, fact_type="claim")
        ids["action"] = _seed_fact(es_client, ks_id=fresh_ks, fact_type="action")
        ids["measurement"] = _seed_fact(
            es_client, ks_id=fresh_ks, fact_type="measurement"
        )

        es_client.indices.refresh(index=LUCID_FACTS)
        result = backfill_link_status(fresh_ks, dry_run=False)

        assert result["dry_run"] is False
        assert result["claim_to_claimed"] == 1
        assert result["non_claim_to_verified"] == 2

        es_client.indices.refresh(index=LUCID_FACTS)
        assert _get_link_status(es_client, ids["claim"]) == "claimed"
        assert _get_link_status(es_client, ids["action"]) == "verified"
        assert _get_link_status(es_client, ids["measurement"]) == "verified"
    finally:
        for fid in ids.values():
            _delete_fact(es_client, fid)


def test_idempotent_second_pass(es_client, fresh_ks):
    """Apply twice: second pass returns 0/0 (must_not exists clause)."""
    ids = []
    try:
        ids.append(_seed_fact(es_client, ks_id=fresh_ks, fact_type="claim"))
        ids.append(_seed_fact(es_client, ks_id=fresh_ks, fact_type="action"))

        es_client.indices.refresh(index=LUCID_FACTS)
        first = backfill_link_status(fresh_ks, dry_run=False)
        assert first["claim_to_claimed"] == 1
        assert first["non_claim_to_verified"] == 1

        es_client.indices.refresh(index=LUCID_FACTS)
        second = backfill_link_status(fresh_ks, dry_run=False)
        assert second["claim_to_claimed"] == 0, "idempotency: second pass no-op"
        assert second["non_claim_to_verified"] == 0
    finally:
        for fid in ids:
            _delete_fact(es_client, fid)
