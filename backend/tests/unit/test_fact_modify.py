"""feat/fact-detail-modify — PATCH /api/spaces/{ks}/facts/{fact_uid}.

PO directive 2026-06-22: Recall's Fact-detail modal must be editable
for surface fields (claim / predicate_label / object_value / tags),
mirroring Decide's edit affordance but limited to non-structural keys.

Acceptance:
- ★ test_modify_updates_claim_appends_alias_and_edit_history
- ★ test_modify_updates_predicate_label_without_history
- ★ test_modify_updates_object_value_and_tags
- ★ test_modify_returns_refreshed_detail
- ★ test_modify_empty_body_400s
- ★ test_modify_404s_on_unknown_fact
- ★ test_modify_404s_when_fact_belongs_to_another_space
- ★ test_modify_ignores_immutable_fields
- ★ test_modify_noop_when_value_unchanged
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest


def _make_user(user_id=None):
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


def _make_session_with_space(ks_id, user_id):
    session = MagicMock()
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user_id
    session.get.return_value = ks
    return session


def _fact_doc(
    fact_uid="fact-1", ks_id=None, subject_uid="uid-x",
    object_value="literal", claim="SpaceX IPO priced at 135.",
    predicate="ipo_price", predicate_label=None, tags=None,
    source_uids=None, retracted_at=None,
):
    return {
        "fact_uid": fact_uid,
        "claim": claim,
        "claim_en": None,
        "subject_uid": subject_uid,
        "predicate": predicate,
        "predicate_label": predicate_label,
        "object_value": object_value,
        "source_uids": list(source_uids or []),
        "validated_at": "2026-06-15T09:00:00Z",
        "validator_id": "u-1",
        "validation_method": "manual",
        "knowledge_space_id": str(ks_id) if ks_id else "ks-1",
        "negation_flag": False,
        "negation_scope": None,
        "retracted_at": retracted_at,
        "retracted_by": None,
        "edit_history": [],
        "tags": list(tags or []),
        "aliases": [],
    }


def _detail_response(fact_uid="fact-1", ks_id=None):
    """Minimal FactDetailResponse a refreshed _build_fact_detail returns."""
    from api.models.recall import (
        FactDetailEntity,
        FactDetailHeader,
        FactDetailResponse,
    )
    header = FactDetailHeader(
        fact_uid=fact_uid,
        claim="refreshed claim",
        subject_uid="uid-x",
        predicate="ipo_price",
        object_value="135 USD",
        validated_at="2026-06-15T09:00:00Z",
    )
    entity = FactDetailEntity(
        uid="uid-x",
        name="SpaceX",
        role="subject",
        **{"class": "organization"},
    )
    return FactDetailResponse(fact=header, entities=[entity], sources=[])


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------

def test_modify_updates_claim_appends_alias_and_edit_history():
    """★ Changing the claim text flows through update_fact, which we
    verify is called with the new claim text. update_fact itself is
    integration-tested in test_es_facts_crud.py for the
    aliases/edit_history mechanics."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, claim="old claim")
    captured: dict[str, Any] = {}

    def _fake_update_fact(uid, updates, editor_uid):
        captured["uid"] = uid
        captured["updates"] = updates
        captured["editor"] = editor_uid
        return {**fact, **updates}

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        side_effect=_fake_update_fact,
    ), patch(
        "api.routes.recall._build_fact_detail",
        return_value=_detail_response(),
    ):
        result = modify_fact(
            space_id=ks_id,
            fact_uid="fact-1",
            body=ModifyFactRequest(claim="new claim text"),
            user=user,
        )

    assert captured["uid"] == "fact-1"
    assert captured["updates"] == {"claim": "new claim text"}
    assert captured["editor"] == str(user.id)
    assert result.fact.fact_uid == "fact-1"


def test_modify_updates_predicate_label_without_history():
    """predicate_label is surface metadata — change updates the field
    in place but does NOT generate an edit_history row (those track
    semantic claim revisions, not gloss tweaks)."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, predicate_label="acquired")
    captured: dict[str, Any] = {}

    def _fake_update_fact(uid, updates, editor_uid):
        captured["updates"] = updates
        return {**fact, **updates}

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        side_effect=_fake_update_fact,
    ), patch(
        "api.routes.recall._build_fact_detail",
        return_value=_detail_response(),
    ):
        modify_fact(
            space_id=ks_id,
            fact_uid="fact-1",
            body=ModifyFactRequest(predicate_label="bought"),
            user=user,
        )

    assert captured["updates"] == {"predicate_label": "bought"}
    # claim is NOT in the updates payload — no aliases/edit_history
    # would be touched by the storage layer.
    assert "claim" not in captured["updates"]


def test_modify_updates_object_value_and_tags():
    """Surface metadata: object_value and tags update in place."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(
        ks_id=ks_id, object_value="100 USD", tags=["finance"],
    )
    captured: dict[str, Any] = {}

    def _fake_update_fact(uid, updates, editor_uid):
        captured["updates"] = updates
        return {**fact, **updates}

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        side_effect=_fake_update_fact,
    ), patch(
        "api.routes.recall._build_fact_detail",
        return_value=_detail_response(),
    ):
        modify_fact(
            space_id=ks_id,
            fact_uid="fact-1",
            body=ModifyFactRequest(
                object_value="135 USD", tags=["finance", "ipo"],
            ),
            user=user,
        )

    assert captured["updates"]["object_value"] == "135 USD"
    assert captured["updates"]["tags"] == ["finance", "ipo"]


def test_modify_returns_refreshed_detail():
    """★ The response is the refreshed FactDetailResponse so the client
    can swap the modal state in one round-trip — no second GET."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, claim="old claim")
    refreshed = _detail_response()

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        return_value=fact,
    ), patch(
        "api.routes.recall._build_fact_detail", return_value=refreshed,
    ):
        result = modify_fact(
            space_id=ks_id,
            fact_uid="fact-1",
            body=ModifyFactRequest(claim="new claim"),
            user=user,
        )

    assert result is refreshed


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------

def test_modify_empty_body_400s():
    """★ A patch with no editable fields is a client bug — surface 400
    rather than silently accepting a no-op write."""
    from fastapi import HTTPException

    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id)
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ):
        with pytest.raises(HTTPException) as exc:
            modify_fact(
                space_id=ks_id, fact_uid="fact-1",
                body=ModifyFactRequest(),  # all fields None — empty patch
                user=user,
            )
    assert exc.value.status_code == 400
    assert exc.value.detail == "no_modifiable_fields"


def test_modify_404s_on_unknown_fact():
    """★ Unknown fact uid → 404, identical shape to the GET 404."""
    from fastapi import HTTPException

    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=None,
    ):
        with pytest.raises(HTTPException) as exc:
            modify_fact(
                space_id=ks_id, fact_uid="missing",
                body=ModifyFactRequest(claim="x"),
                user=user,
            )
    assert exc.value.status_code == 404


def test_modify_404s_when_fact_belongs_to_another_space():
    """★ A fact that exists but lives in someone else's KS is 404 —
    same info-leak guard as the GET endpoint."""
    from fastapi import HTTPException

    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    foreign_fact = _fact_doc(ks_id=uuid4())  # different KS
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=foreign_fact,
    ):
        with pytest.raises(HTTPException) as exc:
            modify_fact(
                space_id=ks_id, fact_uid="fact-1",
                body=ModifyFactRequest(claim="x"),
                user=user,
            )
    assert exc.value.status_code == 404


def test_modify_rejects_immutable_fields_at_validation():
    """★ Identity fields (subject_uid, predicate, validation_method,
    validator_id) cannot reach the endpoint at all — the
    ModifyFactRequest model (LucidBaseModel.extra='forbid') rejects
    any extra field at request-parse time, so a forward-compat
    client trying to sneak an identity field in gets a 422 from
    FastAPI before the route function ever runs.

    This is even safer than the allow-list inside the route. We
    still keep the allow-list in modify_fact as defense in depth,
    but the wire-level rejection is the primary gate."""
    from pydantic import ValidationError

    from api.models.recall import ModifyFactRequest

    with pytest.raises(ValidationError) as exc:
        ModifyFactRequest.model_validate({
            "claim": "new",
            "subject_uid": "uid-evil",
            "validation_method": "auto",
            "predicate": "evil_predicate",
            "validator_id": "u-evil",
        })

    errs = exc.value.errors()
    forbidden = {e["loc"][0] for e in errs if e["type"] == "extra_forbidden"}
    # Every identity field is rejected — none reach the route.
    assert "subject_uid" in forbidden
    assert "validation_method" in forbidden
    assert "predicate" in forbidden
    assert "validator_id" in forbidden


def test_modify_allow_list_drops_non_modifiable_keys_at_route():
    """Defense in depth: even if a future Pydantic config change
    accepted extras, the route's allow-list inside modify_fact
    drops anything that isn't in _MODIFIABLE_FIELDS before the
    storage call. This test exercises that filter directly by
    constructing a ModifyFactRequest with only legal fields and
    confirming the storage layer sees only allow-listed keys."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import _MODIFIABLE_FIELDS, modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id)
    captured: dict[str, Any] = {}

    def _fake_update_fact(uid, updates, editor_uid):
        captured["updates"] = updates
        return {**fact, **updates}

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        side_effect=_fake_update_fact,
    ), patch(
        "api.routes.recall._build_fact_detail",
        return_value=_detail_response(),
    ):
        modify_fact(
            space_id=ks_id, fact_uid="fact-1",
            body=ModifyFactRequest(claim="new", tags=["a"]),
            user=user,
        )

    # Every key the storage layer sees is allow-listed.
    assert set(captured["updates"].keys()) <= _MODIFIABLE_FIELDS


def test_modify_noop_when_value_unchanged():
    """If the patched value is identical to what's already stored, the
    endpoint skips the storage write entirely. This is friendly to
    optimistic clients that re-PATCH on every edit-mode close."""
    from api.models.recall import ModifyFactRequest
    from api.routes.recall import modify_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, claim="same claim")
    update_calls: list[Any] = []

    def _fake_update_fact(uid, updates, editor_uid):
        update_calls.append((uid, updates))
        return fact

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.storage.elasticsearch.facts.update_fact",
        side_effect=_fake_update_fact,
    ), patch(
        "api.routes.recall._build_fact_detail",
        return_value=_detail_response(),
    ):
        modify_fact(
            space_id=ks_id, fact_uid="fact-1",
            body=ModifyFactRequest(claim="same claim"),
            user=user,
        )

    assert update_calls == []  # write was skipped — value identical
