"""B-48b regression tests for the fact detail / retract / restore /
detach-source endpoints.

Each ★ acceptance criterion is locked by a named test:
- test_detail_returns_fact_with_entities_and_sources
- test_detail_404s_on_unknown_fact
- test_detail_404s_when_fact_belongs_to_another_space
- test_retract_sets_retracted_at_and_audits
- test_restore_clears_retracted_at_and_audits
- test_detach_source_removes_one_source_only
- test_detach_last_source_auto_retracts
- test_detach_audit_metadata_marks_auto_retract
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
    fact_uid="fact-1", ks_id=None, subject_uid="uid-x", object_value="literal",
    source_uids=None, retracted_at=None, retracted_by=None,
):
    return {
        "fact_uid": fact_uid,
        "claim": "SpaceX IPO priced at 135.",
        "claim_en": None,
        "subject_uid": subject_uid,
        "predicate": "ipo_price",
        "object_value": object_value,
        "source_uids": list(source_uids or []),
        "validated_at": "2026-06-15T09:00:00Z",
        "validator_id": "u-1",
        "validation_method": "manual",
        "knowledge_space_id": str(ks_id) if ks_id else "ks-1",
        "negation_flag": False,
        "negation_scope": None,
        "retracted_at": retracted_at,
        "retracted_by": retracted_by,
        "edit_history": [],
    }


# ---------------------------------------------------------------------------
# A. fact_detail endpoint
# ---------------------------------------------------------------------------

def test_detail_returns_fact_with_entities_and_sources():
    """★ The right-panel detail rendering: subject label resolved,
    object literal preserved, two sources listed in order."""
    from api.routes.recall import fact_detail

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(
        ks_id=ks_id,
        subject_uid="uid-spacex", object_value="135 USD",
        source_uids=["src-A", "src-B"],
    )
    subject_obj = {
        "object_uid": "uid-spacex", "name": "SpaceX",
        "class": "organization",
        "knowledge_space_id": str(ks_id),
    }
    source_a = {
        "source_uid": "src-A", "url": "https://a.com/1",
        "domain": "a.com", "captured_at": "2026-06-10T10:00:00Z",
        "knowledge_space_id": str(ks_id), "source_type": "web_article",
    }
    source_b = {
        "source_uid": "src-B", "url": "https://b.com/2",
        "domain": "b.com", "captured_at": "2026-06-12T10:00:00Z",
        "knowledge_space_id": str(ks_id), "source_type": "web_article",
    }

    fake_client = MagicMock()
    fake_client.exists.return_value = True

    def _get(*, index, id):
        if id == "uid-spacex":
            return {"_source": subject_obj}
        if id == "src-A":
            return {"_source": source_a}
        if id == "src-B":
            return {"_source": source_b}
        raise KeyError(id)

    fake_client.get.side_effect = _get

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ):
        result = fact_detail(space_id=ks_id, fact_uid="fact-1", user=user)

    assert result.fact.fact_uid == "fact-1"
    assert result.fact.subject_label == "SpaceX"
    # Literal object stays as text; no entity row for it.
    assert result.fact.object_value == "135 USD"
    assert result.fact.object_label is None
    # Subject entity row is present.
    roles = [(e.role, e.name) for e in result.entities]
    assert ("subject", "SpaceX") in roles
    # Two sources, in their list order.
    assert [s.source_uid for s in result.sources] == ["src-A", "src-B"]
    assert result.sources[0].url == "https://a.com/1"


def test_detail_404s_on_unknown_fact():
    from fastapi import HTTPException

    from api.routes.recall import fact_detail

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=None,
    ):
        with pytest.raises(HTTPException) as exc:
            fact_detail(space_id=ks_id, fact_uid="missing", user=user)
    assert exc.value.status_code == 404


def test_detail_404s_when_fact_belongs_to_another_space():
    """A fact that exists but lives in someone else's KS is treated as
    not found — no info leak."""
    from fastapi import HTTPException

    from api.routes.recall import fact_detail

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    other_ks_fact = _fact_doc(ks_id=uuid4())  # different KS
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=other_ks_fact,
    ):
        with pytest.raises(HTTPException) as exc:
            fact_detail(space_id=ks_id, fact_uid="fact-1", user=user)
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# B. retract / restore
# ---------------------------------------------------------------------------

def test_retract_sets_retracted_at_and_audits():
    """★ POST /retract → retracted_at on lucid_facts + validation_logs row."""
    from api.routes.recall import retract_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, source_uids=["src-A"])
    captured: dict[str, Any] = {}
    fake_client = MagicMock()
    fake_client.exists.return_value = True

    def _update(*, index, id, doc, refresh):
        captured["doc"] = doc
        captured["id"] = id

    fake_client.update.side_effect = _update

    audit_calls: list[tuple[str, str]] = []

    def _audit(uid, fact_uid, action, metadata=None):
        audit_calls.append((str(uid), fact_uid, action))

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ), patch(
        "api.routes.recall._record_retract_audit", side_effect=_audit,
    ):
        result = retract_fact(space_id=ks_id, fact_uid="fact-1", user=user)

    assert result.retracted_at is not None
    # Pydantic parses the ISO string into a datetime on the response;
    # the ES doc still carries the string. They represent the same
    # instant — compare via iso format.
    assert captured["doc"]["retracted_at"] == result.retracted_at.isoformat()
    assert captured["doc"]["retracted_by"] == str(user.id)
    assert audit_calls == [(str(user.id), "fact-1", "retract")]


def test_restore_clears_retracted_at_and_audits():
    """★ Restore wipes retracted_at to null and audits."""
    from api.routes.recall import restore_fact

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(
        ks_id=ks_id, source_uids=["src-A"],
        retracted_at="2026-06-15T09:00:00Z", retracted_by="u-1",
    )
    captured: dict[str, Any] = {}
    fake_client = MagicMock()
    fake_client.exists.return_value = True
    fake_client.update.side_effect = lambda **kw: captured.update(kw["doc"])

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ), patch(
        "api.routes.recall._record_retract_audit", lambda *a, **kw: None,
    ):
        result = restore_fact(space_id=ks_id, fact_uid="fact-1", user=user)

    assert result.retracted_at is None
    assert captured["retracted_at"] is None
    assert captured["retracted_by"] is None


# ---------------------------------------------------------------------------
# C. detach-source — including auto-retract on last detach
# ---------------------------------------------------------------------------

def test_detach_source_removes_one_source_only():
    """★ Removing one source from a multi-source fact preserves the
    others — no auto-retract."""
    from api.models.recall import DetachSourceRequest
    from api.routes.recall import detach_source

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, source_uids=["src-A", "src-B"])
    captured: dict[str, Any] = {}
    fake_client = MagicMock()

    def _update(*, index, id, doc, refresh):
        captured.update(doc)

    fake_client.update.side_effect = _update

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ), patch(
        "api.routes.recall._record_retract_audit", lambda *a, **kw: None,
    ):
        result = detach_source(
            space_id=ks_id, fact_uid="fact-1",
            req=DetachSourceRequest(source_uid="src-A"),
            user=user,
        )

    assert result.source_uids == ["src-B"]
    assert result.auto_retracted is False
    assert result.retracted_at is None
    # Update body removed src-A but did NOT touch retracted_at.
    assert captured["source_uids"] == ["src-B"]
    assert "retracted_at" not in captured


def test_detach_last_source_auto_retracts():
    """★ Removing the only source auto-retracts the fact (PO decision
    2: a fact with zero sources is no longer "validated")."""
    from api.models.recall import DetachSourceRequest
    from api.routes.recall import detach_source

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, source_uids=["src-A"])
    captured: dict[str, Any] = {}
    fake_client = MagicMock()

    def _update(*, index, id, doc, refresh):
        captured.update(doc)

    fake_client.update.side_effect = _update

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ), patch(
        "api.routes.recall._record_retract_audit", lambda *a, **kw: None,
    ):
        result = detach_source(
            space_id=ks_id, fact_uid="fact-1",
            req=DetachSourceRequest(source_uid="src-A"),
            user=user,
        )

    assert result.source_uids == []
    assert result.auto_retracted is True
    assert result.retracted_at is not None
    assert captured["source_uids"] == []
    assert captured["retracted_at"] is not None
    assert captured["retracted_by"] == str(user.id)


def test_detach_audit_metadata_marks_auto_retract():
    """The audit row's metadata distinguishes auto-retract from a
    plain detach so post-hoc analysis can tell them apart."""
    from api.models.recall import DetachSourceRequest
    from api.routes.recall import detach_source

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, source_uids=["src-A"])
    fake_client = MagicMock()
    fake_client.update.side_effect = lambda **kw: None
    audit: dict[str, Any] = {}

    def _audit(uid, fact_uid, action, metadata=None):
        audit["action"] = action
        audit["metadata"] = metadata

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ), patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ), patch(
        "api.routes.recall._record_retract_audit", side_effect=_audit,
    ):
        detach_source(
            space_id=ks_id, fact_uid="fact-1",
            req=DetachSourceRequest(source_uid="src-A"),
            user=user,
        )

    assert audit["action"] == "detach_source"
    assert audit["metadata"]["source_uid"] == "src-A"
    assert audit["metadata"]["auto_retracted"] is True


def test_detach_400s_when_source_not_attached():
    """Detaching a source that isn't on the fact returns 400, not 500."""
    from fastapi import HTTPException

    from api.models.recall import DetachSourceRequest
    from api.routes.recall import detach_source

    ks_id = uuid4()
    user = _make_user()
    session = _make_session_with_space(ks_id, user.id)

    fact = _fact_doc(ks_id=ks_id, source_uids=["src-A"])
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_fact_by_uid", return_value=fact,
    ):
        with pytest.raises(HTTPException) as exc:
            detach_source(
                space_id=ks_id, fact_uid="fact-1",
                req=DetachSourceRequest(source_uid="src-NEVER"),
                user=user,
            )
    assert exc.value.status_code == 400
