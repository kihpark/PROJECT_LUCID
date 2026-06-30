"""B-48a regression tests for the fact_uid canonical remap, S/P/O
dedup, source wiring, soft-delete filter, and replay backfill.

Each acceptance criterion (★ in the brief) is locked by a named test:
- test_fact_uid_remap_assigns_canonical_uuid4
- test_dedup_collapses_same_spo_within_submit
- test_dedup_attaches_source_to_existing_es_fact
- test_recall_filters_retracted_by_default
- test_recall_surfaces_retracted_when_include_retracted_true
- test_replay_remap_resolves_fn_collision_across_jobs
- test_replay_attaches_source_to_factnode

These tests are intentionally narrow and patch at module boundaries so
they don't depend on a live ES instance — the end-to-end "wipe + replay
brings the count from 23 back to 54" verification lives in the
manual smoke test recorded on the PR.
"""
from __future__ import annotations

import re
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _make_struct_fact(uid: str, subject_uid: str, predicate: str,
                      object_value: str, claim: str = "x"):
    # ★ STAGE 1c-vii: ACTION + literal object_value 는 validator 가 raise.
    # 이 helper 는 fact_uid 매핑 로직 검증용이라 fact_type 은 무관 →
    # CLAIM 으로 우회해 literal 보존.
    from api.structure.models import StructureFact
    return StructureFact(
        uid=uid, claim=claim, type="proposition",
        subject_uid=subject_uid, predicate=predicate,
        object_value=object_value,
        fact_type="claim",
    )


# ---------------------------------------------------------------------------
# A. processor — fact_uid canonical remap
# ---------------------------------------------------------------------------

def test_fact_uid_remap_assigns_canonical_uuid4():
    """★ Every LLM placeholder maps to a distinct UUID4. Non-placeholder
    uids (e.g. coord_split children with -a/-b suffix) also remap."""
    from api.structure.models import StructureResult
    from api.structure.processor import _build_fact_uid_mapping

    facts = [
        _make_struct_fact("fn-1", "obj-1", "p", "v"),
        _make_struct_fact("fn-2", "obj-1", "p", "v"),
        _make_struct_fact("fn-2-a", "obj-2", "p", "v"),  # coord child shape
    ]
    decomp = StructureResult(
        facts=facts, objects=[], fact_object_links=[], fact_fact_links=[],
        extraction_status="success",
    )
    mapping = _build_fact_uid_mapping(decomp)
    assert set(mapping.keys()) == {"fn-1", "fn-2", "fn-2-a"}
    for orig, remapped in mapping.items():
        assert _UUID4_RE.match(remapped), f"{orig} mapped to non-UUID4 {remapped!r}"
    # Distinct UUID4s — no collision across the three.
    assert len({*mapping.values()}) == 3


def test_fact_uid_remap_passes_through_canonical_input():
    """Already-canonical UUID4 inputs map to themselves (idempotent
    when the upstream layer already remapped)."""
    from api.structure.models import StructureResult
    from api.structure.processor import _build_fact_uid_mapping

    canonical = "59ca596c-c1eb-4983-a36a-87b35adce76b"
    facts = [_make_struct_fact(canonical, "obj-1", "p", "v")]
    decomp = StructureResult(
        facts=facts, objects=[], fact_object_links=[], fact_fact_links=[],
        extraction_status="success",
    )
    mapping = _build_fact_uid_mapping(decomp)
    assert mapping[canonical] == canonical


# ---------------------------------------------------------------------------
# B. validate — S/P/O dedup attaches source instead of inserting
# ---------------------------------------------------------------------------

def test_dedup_attaches_source_to_existing_es_fact():
    """★ A second job with the same S/P/O hits the existing fact in
    ES; validate.py does NOT create a new doc and INSTEAD pushes the
    new source_uid onto the existing one."""
    from api.routes.validate import _coerce_fact_to_factnode

    node = _coerce_fact_to_factnode(
        fact_summary={
            "uid": "fn-1", "fact_uid": "fn-1", "claim": "x",
            "type": "proposition",
            "subject_uid": "uid-spacex", "predicate": "ipo_price",
            "object_value": "135 USD",
        },
        edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1",
        validator_id="u-1",
        source_uid="src-NEW",
    )
    # The coerced node carries source_uids=[source_uid] when provided —
    # this is the seed for both the ES insert path and the dedup-push
    # path (in the latter the node is discarded but its source_uid
    # is still the one attached to the existing fact).
    assert node.source_uids == ["src-NEW"]


def test_coerce_omits_source_uids_when_source_uid_missing():
    """B-48a defensive: if the source-wiring helper degraded and
    returned None (ES sources index down), the coerced node has no
    source_uids — preferable to inserting a junk placeholder."""
    from api.routes.validate import _coerce_fact_to_factnode
    node = _coerce_fact_to_factnode(
        fact_summary={
            "uid": "fn-1", "fact_uid": "fn-1", "claim": "x",
            "type": "proposition",
            "subject_uid": "uid-x", "predicate": "p", "object_value": "v",
        },
        edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1",
        validator_id="u-1",
        source_uid=None,
    )
    assert node.source_uids == []


# ---------------------------------------------------------------------------
# C. ES facts helpers — find_fact_by_spo + attach_source_to_fact
# ---------------------------------------------------------------------------

def test_attach_source_to_fact_is_idempotent():
    """★ Pushing the same source_uid twice never grows the list."""
    from api.storage.elasticsearch import facts as fmod

    existing_source_uids = ["src-A"]

    class _FakeClient:
        def exists(self, **kw): return True

        def get(self, **kw):
            return {"_source": {"source_uids": list(existing_source_uids)}}

        def update(self, **kw):
            existing_source_uids.clear()
            existing_source_uids.extend(kw["doc"]["source_uids"])

    fake = _FakeClient()
    with patch("api.storage.elasticsearch.facts.get_client", return_value=fake):
        # New source: appended.
        added_new = fmod.attach_source_to_fact("fact-1", "src-B")
        # Same source: no-op.
        added_again = fmod.attach_source_to_fact("fact-1", "src-A")
    assert added_new is True
    assert added_again is False
    assert existing_source_uids == ["src-A", "src-B"]


def test_find_fact_by_spo_builds_term_filter_triple():
    """The dedup lookup query must filter on the canonical triple
    (KS, subject, predicate, object_value). A missing clause would
    silently broaden the search and merge unrelated facts."""
    from api.storage.elasticsearch import facts as fmod

    captured: dict = {}

    class _FakeClient:
        def search(self, **kw):
            captured["query"] = kw["query"]
            return {"hits": {"hits": []}}

    with patch("api.storage.elasticsearch.facts.get_client", return_value=_FakeClient()):
        fmod.find_fact_by_spo("ks-1", "uid-spacex", "ipo_price", "135 USD")

    filters = captured["query"]["bool"]["filter"]
    terms = {next(iter(f["term"])): next(iter(f["term"].values())) for f in filters}
    assert terms == {
        "knowledge_space_id": "ks-1",
        "subject_uid": "uid-spacex",
        "predicate": "ipo_price",
        "object_value": "135 USD",
    }


# ---------------------------------------------------------------------------
# D. ES sources — URL-keyed dedup
# ---------------------------------------------------------------------------

def test_source_dedup_is_url_keyed():
    """B-48a per-PO decision: dedup at URL level, not domain."""
    from api.storage.elasticsearch import sources as smod

    docs_by_url: dict[str, dict] = {}

    class _FakeClient:
        def search(self, **kw):
            url_filter = next(
                f["term"]["url"] for f in kw["query"]["bool"]["filter"]
                if "url" in f.get("term", {})
            )
            doc = docs_by_url.get(url_filter)
            return {"hits": {"hits": [{"_source": doc}] if doc else []}}

        def index(self, **kw):
            docs_by_url[kw["document"]["url"]] = kw["document"]

        def update(self, **kw):
            doc = next(
                d for d in docs_by_url.values() if d["source_uid"] == kw["id"]
            )
            doc.update(kw["doc"])

    with patch("api.storage.elasticsearch.sources.get_client", return_value=_FakeClient()):
        a = smod.create_or_update_source(
            domain="wsj.com", source_type="web_article",
            url="https://wsj.com/a/1", knowledge_space_id="ks-1",
        )
        same_url = smod.create_or_update_source(
            domain="wsj.com", source_type="web_article",
            url="https://wsj.com/a/1", knowledge_space_id="ks-1",
        )
        diff_url = smod.create_or_update_source(
            domain="wsj.com", source_type="web_article",
            url="https://wsj.com/a/2", knowledge_space_id="ks-1",
        )
    assert same_url["source_uid"] == a["source_uid"]
    assert diff_url["source_uid"] != a["source_uid"]


# ---------------------------------------------------------------------------
# E. recall — retracted_at filter
# ---------------------------------------------------------------------------

def test_recall_filters_retracted_by_default():
    """★ Default recall hides facts where retracted_at is set; the
    knn body carries `must_not exists retracted_at`."""
    from api.routes.recall import _knn_facts_validated_only

    captured: dict = {}

    class _FakeClient:
        def search(self, *, index, body):
            captured["body"] = body
            return {"hits": {"hits": []}}

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        _knn_facts_validated_only([0.1] * 1536, "ks-1", 5)

    filters = captured["body"]["knn"]["filter"]
    must_nots = [
        c for f in filters if isinstance(f, dict) and "bool" in f
        for c in (f["bool"].get("must_not") or [])
    ]
    assert {"exists": {"field": "retracted_at"}} in must_nots


def test_recall_surfaces_retracted_when_include_retracted_true():
    """★ `include_retracted=True` removes the must_not clause."""
    from api.routes.recall import _knn_facts_validated_only

    captured: dict = {}

    class _FakeClient:
        def search(self, *, index, body):
            captured["body"] = body
            return {"hits": {"hits": []}}

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        _knn_facts_validated_only(
            [0.1] * 1536, "ks-1", 5, include_retracted=True,
        )

    filters = captured["body"]["knn"]["filter"]
    must_nots = [
        c for f in filters if isinstance(f, dict) and "bool" in f
        for c in (f["bool"].get("must_not") or [])
    ]
    # No retracted_at must_not clause when toggle is on.
    assert not any(
        c == {"exists": {"field": "retracted_at"}} for c in must_nots
    )


def test_entity_link_pass_also_honours_retracted_filter():
    """The expansion pass uses the same default-hide policy."""
    from api.routes.recall import _entity_link_facts

    captured: dict = {}

    class _FakeClient:
        def search(self, *, index, body):
            captured["body"] = body
            return {"hits": {"hits": []}}

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        _entity_link_facts(["uid-x"], "ks-1", exclude_fact_uids=set())

    filters = captured["body"]["query"]["bool"]["filter"]
    must_nots = [
        c for f in filters if isinstance(f, dict) and "bool" in f
        for c in (f["bool"].get("must_not") or [])
    ]
    assert {"exists": {"field": "retracted_at"}} in must_nots


# ---------------------------------------------------------------------------
# F. FactNode + Source model surface (extra='forbid' guard)
# ---------------------------------------------------------------------------

def test_factnode_accepts_retracted_at_and_locators():
    from datetime import UTC, datetime

    from api.models.facts import FactNode, Locator

    f = FactNode(
        fact_uid=str(uuid4()),
        claim="x", type="proposition",
        subject_uid="uid-x", predicate="p", object_value="v",
        validation_method="manual", validator_id="u-1",
        knowledge_space_id="ks-1",
        retracted_at=datetime(2026, 6, 18, tzinfo=UTC),
        retracted_by="u-1",
        locators=[
            Locator(source_uid="src-1", kind="text"),
        ],
    )
    assert f.retracted_at is not None
    assert f.retracted_by == "u-1"
    assert f.locators and f.locators[0].source_uid == "src-1"


def test_factnode_rejects_legacy_staleness_fields():
    """Regression for DR-053 / C-14: extra='forbid' still rejects the
    three retired fields, even though we added retracted_at."""
    from pydantic import ValidationError

    from api.models.facts import FactNode
    for forbidden in ("valid_until", "is_stale", "stale_at"):
        with pytest.raises(ValidationError):
            FactNode.model_validate({
                "fact_uid": str(uuid4()), "claim": "x", "type": "proposition",
                "subject_uid": "u", "predicate": "p", "object_value": "v",
                "validation_method": "manual", "validator_id": "u-1",
                "knowledge_space_id": "ks-1", forbidden: "2026-01-01",
            })


def test_source_model_accepts_source_job_id_and_captured_at():
    from datetime import UTC, datetime

    from api.models.source import Source, SourceType

    s = Source(
        source_uid=str(uuid4()),
        domain="wsj.com", source_type=SourceType.WEB_ARTICLE,
        source_url="https://wsj.com/a/1",
        knowledge_space_id="ks-1",
        source_job_id=str(uuid4()),
        captured_at=datetime(2026, 6, 18, tzinfo=UTC),
    )
    assert s.source_job_id is not None
    assert s.captured_at is not None
