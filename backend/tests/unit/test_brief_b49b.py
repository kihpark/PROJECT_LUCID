"""B-49b regression: when two Object docs share the same name (e.g.
old LLM-placeholder + new canonical UUID4), the brief unions both
sides' facts so it agrees with the facet panel.

Root cause was `_resolve_entity_by_name` returning ONE source (the
LLM-placeholder `obj-1`) and `_facts_for_entity` looking up by that
single uid, missing everything attached to the canonical `59ca596c…`.
"""
from __future__ import annotations

from unittest.mock import patch


def _doc(uid: str, name: str, cls: str = "organization") -> dict:
    return {"object_uid": uid, "name": name, "class": cls}


def _fact_hit(*, fact_uid: str, subject_uid: str, predicate: str,
              object_value: str, claim: str = "x",
              knowledge_space_id: str = "ks-1") -> dict:
    return {
        "_id": fact_uid,
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "predicate": predicate,
            "subject_uid": subject_uid,
            "object_value": object_value,
            "validation_method": "manual",
            "knowledge_space_id": knowledge_space_id,
        },
    }


def test_brief_unions_facts_when_two_objects_share_a_name():
    """The PO's SpaceX reproduction: an old `obj-1` SpaceX with NO
    facts on either side, and a new canonical SpaceX (UUID4) that
    carries 5 facts. Pre-B-49b: brief returned None/empty because
    it picked `obj-1` and looked up only there. Post-B-49b: it
    finds 5 facts and lands the canonical uid on the representative."""
    from api.routes.recall import _build_entity_brief

    placeholder = _doc("obj-1", "SpaceX")
    canonical_uid = "59ca596c-c1eb-4983-a36a-87b35adce76b"
    canonical = _doc(canonical_uid, "SpaceX")

    hits = [
        _fact_hit(
            fact_uid="fn-1", subject_uid=canonical_uid,
            predicate="ipo_price_per_share",
            object_value="135 USD per share",
            claim="SpaceX set IPO price at 135",
        ),
        _fact_hit(
            fact_uid="fn-2", subject_uid=canonical_uid,
            predicate="listing_date",
            object_value="2026-01-12",
            claim="SpaceX listed on Jan 12 2026",
        ),
        _fact_hit(
            fact_uid="fn-3", subject_uid=canonical_uid,
            predicate="initial_free_float_ratio",
            object_value="15 percent",
            claim="SpaceX initial free float was 15%",
        ),
    ]

    with patch(
        "api.routes.recall._resolve_entities_by_name",
        return_value=[canonical, placeholder],  # canonical sorted first
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=hits,
    ):
        brief = _build_entity_brief("SpaceX", "ks-1")

    assert brief is not None
    # The representative uid is canonical, NOT the LLM placeholder.
    assert brief.entity_uid == canonical_uid
    assert brief.entity_name == "SpaceX"
    assert brief.total_facts == 3
    predicates = sorted(g.predicate for g in brief.as_subject)
    assert predicates == [
        "initial_free_float_ratio",
        "ipo_price_per_share",
        "listing_date",
    ]


def test_brief_facts_for_entity_called_with_full_uid_list():
    """The fix's contract: _facts_for_entity must receive ALL matched
    uids, not just the representative. This pins the union-query path
    so a later refactor that "simplifies" back to a singular uid
    breaks loudly."""
    from api.routes.recall import _build_entity_brief

    placeholder = _doc("obj-1", "SpaceX")
    canonical = _doc("59ca596c-c1eb-4983-a36a-87b35adce76b", "SpaceX")

    captured: list = []

    def _capture(uids, knowledge_space_id, **kw):
        captured.append(list(uids) if isinstance(uids, list) else [uids])
        return []

    with patch(
        "api.routes.recall._resolve_entities_by_name",
        return_value=[canonical, placeholder],
    ), patch(
        "api.routes.recall._facts_for_entity", side_effect=_capture,
    ):
        _build_entity_brief("SpaceX", "ks-1")

    assert captured, "facts lookup was not called"
    passed_uids = captured[0]
    assert "obj-1" in passed_uids
    assert "59ca596c-c1eb-4983-a36a-87b35adce76b" in passed_uids


def test_brief_canonical_uid_preferred_as_representative():
    """When canonical comes second from the matcher we still surface
    it as `entity_uid` on the response — the sorting in
    `_resolve_entities_by_name` makes this deterministic, but we
    re-verify here so the contract is part of the test surface."""
    from api.routes.recall import _resolve_entities_by_name

    placeholder = _doc("obj-1", "SpaceX")
    canonical = _doc("59ca596c-c1eb-4983-a36a-87b35adce76b", "SpaceX")

    class _FakeClient:
        def search(self, **kw):
            # Return placeholder first to simulate ES "natural" order.
            return {"hits": {"hits": [
                {"_source": placeholder},
                {"_source": canonical},
            ]}}

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        out = _resolve_entities_by_name("SpaceX", "ks-1")

    assert out[0]["object_uid"] == "59ca596c-c1eb-4983-a36a-87b35adce76b"
    assert out[1]["object_uid"] == "obj-1"


def test_brief_returns_none_when_no_match():
    from api.routes.recall import _build_entity_brief
    with patch(
        "api.routes.recall._resolve_entities_by_name", return_value=[],
    ):
        out = _build_entity_brief("nothing", "ks-1")
    assert out is None
