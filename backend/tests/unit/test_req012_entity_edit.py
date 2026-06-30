"""REQ-012-v1 unit tests — entity 종류 수정 + 노드 합치기 + 분리.

PO 의뢰서 verbatim:
  - 10종 드롭다운 + 변경 즉시 그래프 반영 + 검증 행위 기록 + AI confidence.
  - 광주 + 광주광역시 / 삼성전자 2개 사용자 병합 — canonical 하나 + alias
    보존 + fact 이전 + merge_provenance.
  - 분리 (잘못 병합 되돌리기).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from api.routes.entities import (
    ENTITY_TYPE_V3_SET,
    EntityMergeRequest,
    EntityTypeChangeRequest,
    EntityUnmergeRequest,
    change_entity_type,
    merge_candidates,
    merge_entities,
    unmerge_entity,
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


# ---------------------------------------------------------------------------
# A. closed 10-set (PO 의뢰서 verbatim).
# ---------------------------------------------------------------------------

def test_entity_type_v3_is_exactly_ten_classes():
    """★ PO 의뢰서: 10종 드롭다운. 자유 입력 금지."""
    assert len(ENTITY_TYPE_V3_SET) == 10
    assert ENTITY_TYPE_V3_SET == {
        "person", "organization", "group",
        "knowledge", "resource", "task", "concept", "event", "metric",
        "location",
    }


# ---------------------------------------------------------------------------
# B. 기능 A — change_entity_type.
# ---------------------------------------------------------------------------

def _fake_session_for(ks):
    """Build a session whose .get(KnowledgeSpace, sid) returns ks and that
    accepts .add/.commit/.close without raising."""
    session = MagicMock()
    session.get.return_value = ks
    session.add = MagicMock()
    session.commit = MagicMock()
    session.rollback = MagicMock()
    session.close = MagicMock()
    return session


def test_change_entity_type_rejects_unknown_class():
    """★ PO: closed 10-set. 'place' 같은 legacy/임의값 거부."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    body = EntityTypeChangeRequest(entity_type="place")
    sessionmaker = MagicMock(return_value=lambda: _fake_session_for(ks))
    with patch(
        "api.routes.entities.make_sessionmaker", sessionmaker,
    ), patch("api.routes.entities.get_client") as mock_client:
        mock_client.return_value = MagicMock()
        with pytest.raises(HTTPException) as exc:
            change_entity_type(
                space_id=ks_id,
                entity_uid="ent-1",
                body=body,
                user=user,
            )
    assert exc.value.status_code == 400
    assert exc.value.detail == "invalid_entity_type"


def test_change_entity_type_writes_history_and_validation_log():
    """★ PO: 변경 즉시 그래프·색·형태 반영 (entity_type + class 둘 다) +
    검증 행위로 기록 (relabel_history + validation_logs)."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.return_value = {
        "_source": {
            "object_uid": "ent-1",
            "knowledge_space_id": str(ks_id),
            "primary_label": "광주",
            "entity_type": "organization",
            "class": "organization",
            "relabel_history": [],
        }
    }

    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = change_entity_type(
            space_id=ks_id,
            entity_uid="ent-1",
            body=EntityTypeChangeRequest(entity_type="location",
                                         reason="광주는 도시"),
            user=user,
        )

    assert resp.entity_type == "location"
    assert resp.previous_entity_type == "organization"
    assert resp.relabel_history_size == 1
    # entity_type AND class 둘 다 갱신됐는지 (★ STELLAR 색 즉시 반영).
    es_client.update.assert_called_once()
    args, kwargs = es_client.update.call_args
    assert kwargs["id"] == "ent-1"
    doc = kwargs["doc"]
    assert doc["entity_type"] == "location"
    assert doc["class"] == "location"
    assert len(doc["relabel_history"]) == 1
    assert doc["relabel_history"][0]["reason"] == "user_type_change"
    assert doc["relabel_history"][0]["from_primary"] == "organization"
    assert doc["relabel_history"][0]["to_primary"] == "location"
    # validation_logs row written.
    assert session.add.called
    log = session.add.call_args[0][0]
    assert log.action == "edit"
    assert log.object_uid == "ent-1"
    assert log.decision_metadata["type_change"] is True
    assert log.decision_metadata["to_entity_type"] == "location"


# ---------------------------------------------------------------------------
# C. 기능 B — merge_entities.
# ---------------------------------------------------------------------------

def test_merge_requires_canonical_in_members():
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm):
        with pytest.raises(HTTPException) as exc:
            merge_entities(
                space_id=ks_id,
                body=EntityMergeRequest(
                    canonical_uid="ent-A",
                    members=["ent-B", "ent-C"],
                ),
                user=user,
            )
    assert exc.value.status_code == 400


def test_merge_writes_aliases_and_remaps_facts_and_retires_members():
    """★ PO: 광주 + 광주광역시 → canonical 하나 + alias 보존 + fact 이전 +
    member doc 에 retired_by_merge."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)

    es_client = MagicMock()
    # 두 member doc — '광주' 가 살아남는 canonical, '광주광역시' 는 흡수.
    docs = {
        "ent-A": {
            "object_uid": "ent-A",
            "knowledge_space_id": str(ks_id),
            "primary_label": "광주",
            "entity_type": "location",
            "aliases": [],
        },
        "ent-B": {
            "object_uid": "ent-B",
            "knowledge_space_id": str(ks_id),
            "primary_label": "광주광역시",
            "entity_type": "location",
            "aliases": ["Gwangju"],
        },
    }
    es_client.get.side_effect = lambda index, id: {"_source": docs[id]}
    es_client.search.return_value = {"hits": {"hits": []}}

    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)

    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client), \
         patch(
            "api.routes.entities.remap_fact_subject_object",
            return_value={"subjects_remapped": 2, "objects_remapped": 0,
                          "facts_touched": 2},
         ) as mock_remap:
        resp = merge_entities(
            space_id=ks_id,
            body=EntityMergeRequest(
                canonical_uid="ent-A",
                members=["ent-A", "ent-B"],
                reason="둘 다 광주",
            ),
            user=user,
        )

    assert resp.canonical_uid == "ent-A"
    assert resp.primary_label == "광주"
    assert resp.members_retired == ["ent-B"]
    assert resp.facts_rewritten == {
        "subjects_remapped": 2, "objects_remapped": 0, "facts_touched": 2,
    }
    # ★ alias union: 광주광역시 + Gwangju (광주 자신은 primary 이므로 제외).
    assert "광주광역시" in resp.aliases
    assert "Gwangju" in resp.aliases
    assert "광주" not in resp.aliases

    # ES update 호출 시퀀스: canonical 갱신 + retired member 갱신.
    updates = es_client.update.call_args_list
    update_ids = [u.kwargs.get("id") for u in updates]
    assert "ent-A" in update_ids  # canonical 갱신
    assert "ent-B" in update_ids  # member retire

    # fact rewrite — uid_remap = {ent-B: ent-A}.
    mock_remap.assert_called_once()
    args, kwargs = mock_remap.call_args
    assert kwargs["uid_remap"] == {"ent-B": "ent-A"}

    # validation_log — merge_with 가 각 retired member 당 한 row.
    add_calls = session.add.call_args_list
    assert len(add_calls) == 1  # 단일 retired (ent-B)
    log = add_calls[0][0][0]
    assert log.action == "merge_with"
    assert log.object_uid == "ent-B"
    assert log.decision_metadata["user_merge"] is True
    assert log.decision_metadata["canonical_uid"] == "ent-A"
    assert log.decision_metadata["all_members"] == ["ent-A", "ent-B"]


def test_merge_rejects_already_retired_member():
    """★ 한 번 흡수된 entity 를 다시 다른 canonical 로 흡수하지 못함
    (provenance orphan 방지)."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    es_client = MagicMock()
    es_client.get.side_effect = lambda index, id: {"_source": {
        "object_uid": id,
        "knowledge_space_id": str(ks_id),
        "primary_label": id,
        "entity_type": "location",
        "retired_by_merge": "2026-01-01T00:00:00Z",
    }}
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        with pytest.raises(HTTPException) as exc:
            merge_entities(
                space_id=ks_id,
                body=EntityMergeRequest(
                    canonical_uid="ent-A",
                    members=["ent-A", "ent-B"],
                ),
                user=user,
            )
    assert exc.value.status_code == 409


# ---------------------------------------------------------------------------
# D. 기능 B 되돌리기 — unmerge_entity.
# ---------------------------------------------------------------------------

def test_unmerge_restores_members_and_clears_aliases():
    """★ PO: 분리 (잘못 병합 되돌리기). retired_by_merge 클리어 +
    canonical 의 aliases 에서 복원된 member 의 primary 제거."""
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)

    # validation_logs 안에 가장 최근 merge_with 행을 모킹.
    merge_log = MagicMock()
    merge_log.decision_metadata = {
        "user_merge": True,
        "canonical_uid": "ent-A",
        "all_members": ["ent-A", "ent-B"],
    }
    session = _fake_session_for(ks)
    session.execute.return_value.scalars.return_value.all.return_value = [merge_log]

    es_client = MagicMock()

    def _es_get(index, id):
        if id == "ent-A":
            return {"_source": {
                "object_uid": "ent-A",
                "knowledge_space_id": str(ks_id),
                "primary_label": "광주",
                "entity_type": "location",
                "aliases": ["광주광역시", "Gwangju"],
            }}
        if id == "ent-B":
            return {"_source": {
                "object_uid": "ent-B",
                "knowledge_space_id": str(ks_id),
                "primary_label": "광주광역시",
                "entity_type": "location",
                "canonical_uid": "ent-A",
                "retired_by_merge": "2026-07-01T00:00:00Z",
            }}
        raise KeyError(id)

    es_client.get.side_effect = _es_get
    es_client.search.return_value = {"hits": {"hits": []}}

    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = unmerge_entity(
            space_id=ks_id,
            body=EntityUnmergeRequest(canonical_uid="ent-A"),
            user=user,
        )

    assert resp.canonical_uid == "ent-A"
    assert "ent-B" in resp.members_restored
    # alias 에서 광주광역시 제거 — Gwangju 는 보존.
    assert "광주광역시" not in resp.aliases_after
    assert "Gwangju" in resp.aliases_after

    # ES update: member doc 의 retired_by_merge 제거 script + canonical
    # doc 의 aliases update.
    update_call_ids = [c.kwargs.get("id") for c in es_client.update.call_args_list]
    assert "ent-B" in update_call_ids
    assert "ent-A" in update_call_ids


def test_unmerge_404_when_no_history():
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    session = _fake_session_for(ks)
    session.execute.return_value.scalars.return_value.all.return_value = []
    sm = MagicMock(side_effect=lambda: session)
    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=MagicMock()):
        with pytest.raises(HTTPException) as exc:
            unmerge_entity(
                space_id=ks_id,
                body=EntityUnmergeRequest(canonical_uid="ent-A"),
                user=user,
            )
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# E. merge_candidates — prefix surface 후보 제시.
# ---------------------------------------------------------------------------

def test_merge_candidates_excludes_self_and_retired():
    user = _make_user()
    ks_id = uuid4()
    ks = _ks_for(user, ks_id)
    session = _fake_session_for(ks)
    sm = MagicMock(side_effect=lambda: session)

    es_client = MagicMock()
    es_client.get.return_value = {"_source": {
        "object_uid": "ent-A",
        "knowledge_space_id": str(ks_id),
        "primary_label": "광주",
        "entity_type": "location",
    }}
    es_client.search.return_value = {"hits": {"hits": [
        {"_id": "ent-B", "_score": 5.0, "_source": {
            "object_uid": "ent-B",
            "primary_label": "광주광역시",
            "entity_type": "location",
        }},
        # self should not appear (must_not term query), but the test
        # ensures the route filters defensively.
        {"_id": "ent-A", "_score": 99.0, "_source": {
            "object_uid": "ent-A",
            "primary_label": "광주",
            "entity_type": "location",
        }},
    ]}}

    with patch("api.routes.entities.make_sessionmaker", return_value=sm), \
         patch("api.routes.entities.get_client", return_value=es_client):
        resp = merge_candidates(
            space_id=ks_id,
            entity_uid="ent-A",
            limit=10,
            user=user,
        )

    assert len(resp.items) == 1
    assert resp.items[0].entity_uid == "ent-B"
    assert resp.items[0].primary_label == "광주광역시"
    assert "same type" in resp.items[0].reason
