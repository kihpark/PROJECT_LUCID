"""REQ-012-v2 unit tests — entity name edit + soft delete (node/edge).

PO 의뢰서 (2026-07-01, image #145 dogfood):
  - "한 총리" → "한성숙" 처럼 사용자가 대표명을 바꿀 때
    (alias 흡수 + relabel_history append + validation_logs)
  - 사용자가 노드와 엣지를 delete 할 때
    (soft delete = retired_by_user + 연결 fact 자동 retract)
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from api.routes.entities import (
    EntityDeleteRequest,
    EntityNameChangeRequest,
    change_entity_name,
    delete_entity,
)


def _make_user(user_id=None):
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


def _ks_for(user, ks_id):
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user.id
    return ks


def _fake_session_for(ks):
    session = MagicMock()
    session.get.return_value = ks
    session.add = MagicMock()
    session.commit = MagicMock()
    session.rollback = MagicMock()
    session.close = MagicMock()
    return session


# ---------------------------------------------------------------------------
# A. change_entity_name.
# ---------------------------------------------------------------------------

def test_name_change_rejects_empty_name():
    user = _make_user()
    ks_id = uuid4()
    with pytest.raises(Exception):
        # pydantic v2 will actually raise ValidationError on min_length=1
        EntityNameChangeRequest(name="")


def test_name_change_writes_primary_and_absorbs_previous_into_aliases():
    """★ PO: '한 총리' → '한성숙'. 옛 이름은 aliases 로 흡수 → 사용자가
    옛 이름으로 검색해도 찾을 수 있게."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "한 총리",
            "name": "한 총리",
            "aliases": [],
            "relabel_history": [],
        }
    }

    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = change_entity_name(
            space_id=ks_id,
            entity_uid="ent-1",
            body=EntityNameChangeRequest(
                name="한성숙",
                previous_name="한 총리",
                reason="v3 §7 대표명 지정",
            ),
            user=user,
        )

    assert resp.primary_label == "한성숙"
    assert resp.previous_name == "한 총리"
    # ★ 옛 이름은 aliases 로 흡수.
    assert "한 총리" in resp.aliases
    assert resp.relabel_history_size == 1
    # ES update — primary_label + name + aliases + history 동기.
    es_client.update.assert_called_once()
    args, kwargs = es_client.update.call_args
    assert kwargs["id"] == "ent-1"
    doc = kwargs["doc"]
    assert doc["primary_label"] == "한성숙"
    assert doc["name"] == "한성숙"
    assert "한 총리" in doc["aliases"]
    assert doc["relabel_history"][0]["reason"] == "user_name_edit"
    assert doc["relabel_history"][0]["from_primary"] == "한 총리"
    assert doc["relabel_history"][0]["to_primary"] == "한성숙"
    # validation_logs — name_change=True.
    assert session.add.called
    log = session.add.call_args[0][0]
    assert log.action == "edit"
    assert log.object_uid == "ent-1"
    assert log.decision_metadata["name_change"] is True
    assert log.decision_metadata["to_name"] == "한성숙"
    assert log.decision_metadata["from_name"] == "한 총리"


def test_name_change_rejects_retired_entity():
    """★ retired_by_merge / retired_by_user 는 name edit 금지 (일관성)."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "옛 이름",
            "retired_by_merge": "2026-01-01T00:00:00Z",
        }
    }
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        with pytest.raises(HTTPException) as exc:
            change_entity_name(
                space_id=ks_id,
                entity_uid="ent-1",
                body=EntityNameChangeRequest(name="새 이름"),
                user=user,
            )
    assert exc.value.status_code == 409


def test_name_change_is_no_op_when_new_equals_current():
    """같은 이름 저장 시도 → 상태 그대로, ES update 호출 X."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "한성숙",
            "aliases": [],
            "relabel_history": [],
            "updated_at": "2026-06-30T00:00:00Z",
        }
    }
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = change_entity_name(
            space_id=ks_id,
            entity_uid="ent-1",
            body=EntityNameChangeRequest(name="한성숙"),
            user=user,
        )
    assert resp.primary_label == "한성숙"
    es_client.update.assert_not_called()


# ---------------------------------------------------------------------------
# B. delete_entity.
# ---------------------------------------------------------------------------

def test_delete_writes_retired_by_user_and_retracts_facts():
    """★ PO: 노드 delete → retired_by_user + 연결 fact 자동 retract."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "삭제할 노드",
        }
    }
    # 두 개의 연결 fact 반환.
    es_client.search.return_value = {
        "hits": {
            "hits": [
                {"_id": "fact-1", "_source": {"fact_uid": "fact-1"}},
                {"_id": "fact-2", "_source": {"fact_uid": "fact-2"}},
            ]
        }
    }
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = delete_entity(
            space_id=ks_id,
            entity_uid="ent-1",
            body=EntityDeleteRequest(reason="user_delete_via_stellar"),
            user=user,
        )

    assert resp.entity_uid == "ent-1"
    assert resp.primary_label == "삭제할 노드"
    assert resp.retired_at
    assert resp.facts_retracted == 2

    # ES update — entity doc + fact retract 3 회 (1 entity + 2 facts).
    updates = es_client.update.call_args_list
    ids = [u.kwargs.get("id") for u in updates]
    assert "ent-1" in ids
    assert "fact-1" in ids
    assert "fact-2" in ids

    # entity doc update — retired_by_user 필드.
    ent_update = next(u for u in updates if u.kwargs.get("id") == "ent-1")
    assert "retired_by_user" in ent_update.kwargs["doc"]
    assert ent_update.kwargs["doc"]["retirement_reason"] == \
        "user_delete_via_stellar"

    # fact retract — retracted_at + retract_reason 세팅.
    fact_update = next(u for u in updates if u.kwargs.get("id") == "fact-1")
    doc = fact_update.kwargs["doc"]
    assert doc["retracted_at"]
    assert doc["retract_reason"] == "user_entity_delete"

    # validation_logs — user_delete=True.
    assert session.add.called
    log = session.add.call_args[0][0]
    assert log.action == "edit"
    assert log.object_uid == "ent-1"
    assert log.decision_metadata["user_delete"] is True
    assert log.decision_metadata["facts_retracted"] == 2


def test_delete_rejects_retired_by_merge_entity():
    """merged-away entity 는 이미 canonical 이 존재 → 사용자 delete 금지
    (unmerge 후 delete 해야 함)."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "옛 이름",
            "retired_by_merge": "2026-01-01T00:00:00Z",
        }
    }
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        with pytest.raises(HTTPException) as exc:
            delete_entity(
                space_id=ks_id,
                entity_uid="ent-1",
                body=EntityDeleteRequest(),
                user=user,
            )
    assert exc.value.status_code == 409


def test_delete_is_idempotent_when_already_user_retired():
    """이미 사용자 delete 한 entity 를 다시 delete → 200 OK, facts_retracted=0."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "이미 삭제",
            "retired_by_user": "2026-06-30T00:00:00Z",
        }
    }
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = delete_entity(
            space_id=ks_id,
            entity_uid="ent-1",
            body=EntityDeleteRequest(),
            user=user,
        )
    assert resp.entity_uid == "ent-1"
    assert resp.facts_retracted == 0
    # No ES update on the entity doc.
    es_client.update.assert_not_called()
