"""M3-1 canonical-layer integration tests — dry-run only.

★ PO 의뢰서 verbatim: "apply 는 dry-run 만 테스트. 실제 ES write 안 함."

The tests stub the ES client with a fake that records the queries it
sees and returns pre-canned cluster fixtures derived from the live
PO-KS discovery (MP 머티리얼즈 / MP머티리얼스 / 선거관리위원회 / 선관위).
We deliberately do NOT touch the test ES cluster — the surface area we
need to lock is the in-memory clustering + dry-run reporting, both of
which are pure-Python.
"""
from __future__ import annotations

from typing import Any

import pytest

from api.models.canonical import MergeProposal
from api.ops.canonical_merge import (
    apply_merge,
    discover_merge_proposals,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeClient:
    """ES stub matching the two paths canonical_merge.py exercises:

      1. ``search(index=LUCID_OBJECTS, ...)`` — return the KS entity scan.
      2. ``search(index=LUCID_FACTS, ...)`` — return facts referencing
         any cluster member.
    """

    def __init__(self, *, entities, facts):
        self._entities = entities
        self._facts = facts
        self.queries: list[dict[str, Any]] = []

    def search(self, *, index, query=None, size=None, _source=None):
        self.queries.append({"index": index, "query": query})
        if "lucid_objects" in index:
            return {"hits": {"hits": [{"_source": e} for e in self._entities]}}
        if "lucid_facts" in index:
            terms = query["bool"]["filter"][1]["bool"]["should"]
            member_uids = set()
            for clause in terms:
                if "terms" in clause:
                    for v in clause["terms"].values():
                        member_uids.update(v)
            matched = []
            for f in self._facts:
                if (
                    f.get("subject_uid") in member_uids
                    or f.get("object_value") in member_uids
                ):
                    matched.append({"_source": f})
            return {"hits": {"hits": matched}}
        return {"hits": {"hits": []}}


def _entity(uid, name, name_en, *, etype="organization", aliases=None):
    return {
        "object_uid": uid,
        "name": name,
        "name_en": name_en,
        "primary_label": name,
        "primary_lang": "ko",
        "class": etype,
        "entity_type": etype,
        "aliases": aliases or ([name_en] if name_en else []),
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-test",
        "created_at": "2026-06-20T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_discover_emits_one_proposal_per_shared_name_en_cluster():
    """★ The PO-KS live scan showed 7 clusters keyed by shared name_en.
    Two synthetic clusters: MP Materials × 2, 선거관리위원회 × 2."""
    entities = [
        _entity("u-mp1", "MP 머티리얼즈", "MP Materials"),
        _entity("u-mp2", "MP머티리얼스", "MP Materials"),
        _entity(
            "u-nec1", "선거관리위원회", "National Election Commission",
        ),
        _entity("u-nec2", "선관위", "National Election Commission"),
        _entity("u-solo", "단독 entity", "Solo Entity"),  # no cluster mate
    ]
    client = _FakeClient(entities=entities, facts=[])

    proposals = discover_merge_proposals(client, "ks-test")

    assert len(proposals) == 2
    by_target = {p.target_canonical_uid: p for p in proposals}
    mp_proposal = next(p for p in proposals if "u-mp1" in p.members or "u-mp2" in p.members)
    nec_proposal = next(p for p in proposals if "u-nec1" in p.members or "u-nec2" in p.members)
    # Every cluster carries both members.
    assert set(mp_proposal.members) == {"u-mp1", "u-mp2"}
    assert set(nec_proposal.members) == {"u-nec1", "u-nec2"}
    # Deterministic clusters keep the deterministic confidence label.
    assert mp_proposal.confidence == "deterministic"
    assert nec_proposal.confidence == "deterministic"
    # Reason names the matched normalized key.
    assert "mpmaterials" in mp_proposal.reason
    assert "nationalelectioncommission" in nec_proposal.reason
    # The solo entity is not in any proposal.
    assert all("u-solo" not in p.members for p in proposals)


def test_dryrun_preserves_fact_provenance():
    """★ PO 의뢰서 acceptance: "fact provenance 보존". The dry-run
    proposal MUST record the original object_uid for every referencing
    fact so the future apply path can rewrite + roll back."""
    entities = [
        _entity("u-mp1", "MP 머티리얼즈", "MP Materials"),
        _entity("u-mp2", "MP머티리얼스", "MP Materials"),
    ]
    facts = [
        {
            "fact_uid": "f-1",
            "subject_uid": "u-mp1",
            "object_value": "리튬",
            "knowledge_space_id": "ks-test",
        },
        {
            "fact_uid": "f-2",
            "subject_uid": "us-elsewhere",
            "object_value": "u-mp2",  # mp2 referenced as object
            "knowledge_space_id": "ks-test",
        },
    ]
    client = _FakeClient(entities=entities, facts=facts)

    proposals = discover_merge_proposals(client, "ks-test")
    assert len(proposals) == 1
    p = proposals[0]
    # Both referencing facts surface in provenance.
    assert set(p.fact_provenance.keys()) == {"f-1", "f-2"}
    # f-1's original subject was u-mp1 (preferred over object).
    assert p.fact_provenance["f-1"] == "u-mp1"
    # f-2's reference was as object_value → u-mp2.
    assert p.fact_provenance["f-2"] == "u-mp2"

    # Dry-run summary reports the right counts and DOES NOT WRITE.
    summary = apply_merge(client, p, dry_run=True)
    assert summary["dry_run"] is True
    assert summary["would_merge_n_objects"] == 1  # 2 members → 1 retired
    assert summary["would_rewrite_n_facts"] == 2
    # Confirm the fake never received an index/update/delete call.
    assert all(
        not q["index"].endswith("_write") for q in client.queries
    )


def test_apply_merge_apply_path_raises_not_implemented():
    """★ PO 의뢰서: 'apply (실데이터 병합)·entity뷰·meta-network·LENS
    는 PO 명령 대기.' The apply branch must hard-fail until the
    follow-up ticket lands it under PO command."""
    p = MergeProposal(
        target_canonical_uid="u-x",
        members=["u-x", "u-y"],
        primary_label="X",
        aliases=["Y"],
        entity_type="organization",
        confidence="deterministic",
        fact_provenance={},
        reason="test",
    )
    with pytest.raises(NotImplementedError):
        apply_merge(_FakeClient(entities=[], facts=[]), p, dry_run=False)


def test_chain_clusters_via_union_find():
    """A↔B share key K1; B↔C share key K2. The union-find must put
    A, B, C in ONE cluster — even though A and C share no direct key."""
    entities = [
        # All three share entity_type=organization.
        _entity("u-a", "민주당", "Democratic Party",
                aliases=["Democratic Party"]),
        # B uses primary='더불어민주당' (shares with C below) AND
        # alias='민주당' (shares with A above).
        _entity("u-b", "더불어민주당", "Democratic Party of Korea",
                aliases=["민주당", "Democratic Party of Korea"]),
        _entity("u-c", "더불어민주당 (DPK)", "Democratic Party of Korea",
                aliases=["Democratic Party of Korea"]),
    ]
    client = _FakeClient(entities=entities, facts=[])
    proposals = discover_merge_proposals(client, "ks-test")
    assert len(proposals) == 1
    assert set(proposals[0].members) == {"u-a", "u-b", "u-c"}
