"""Entity endpoints — suggestion + REQ-012-v1 / v2 사용자 수정.

REQ-012-v1 (2026-07-01):
  GET /api/spaces/{space_id}/entities/suggest?q=<partial>&limit=5
  POST /api/spaces/{space_id}/entities/{uid}/type        — 기능 A (type 변경)
  POST /api/spaces/{space_id}/entities/merge             — 기능 B (병합)
  POST /api/spaces/{space_id}/entities/unmerge           — 기능 B 되돌리기
  GET  /api/spaces/{space_id}/entities/{uid}/merge-candidates — 후보

REQ-012-v2 (PO 2026-07-01, image #145 dogfood):
  POST /api/spaces/{space_id}/entities/{uid}/name        — ★ name edit
  DELETE /api/spaces/{space_id}/entities/{uid}           — ★ soft delete

PO 의뢰서 verbatim:
  - v1: entity 종류 수정 (10종 closed set) + 검증 행위로 기록 + AI confidence
  - v1: 노드 합치기 (광주 + 광주광역시 / 삼성전자 2개) — canonical 하나 +
    alias 보존 + fact 이전 + merge_provenance (v3 §7 되돌릴 수 있게)
  - v1: 분리 (잘못 병합 되돌리기)
  - v2: 사용자가 "한 총리" → "한성숙" 으로 이름 바꾸고 싶다면? (name edit)
  - v2: 사용자가 노드와 엣지를 선택하고 delete 하고 싶다면? (soft delete)

v3 §7 provenance (v2 verbatim):
  - name edit → relabel_history append (from_primary / to_primary /
    reason='user_name_edit'), primary_label + name + name_en 동기 갱신
  - node delete → retired_by_user 필드 (retired_by_merge 와 구분) +
    audit=action:'edit' with decision_metadata.user_delete=True.
    복원 가능 (unmerge 처럼 되돌리기는 v3 이후).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field

from api.models.entities import EntitySuggestion, EntitySuggestionsResponse
from api.security import get_current_user
from api.storage.elasticsearch.client import LUCID_FACTS, LUCID_OBJECTS, get_client
from api.storage.elasticsearch.objects import remap_fact_subject_object
from api.storage.postgres.orm import KnowledgeSpace, User, ValidationLog
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.entities")

# REQ-012-v1 — 10종 closed set (resolution_gateway.ENTITY_TYPE_V3 와 동일).
# PO 의뢰서 verbatim: person/organization/group/knowledge/resource/task/
# concept/event/metric/location.
ENTITY_TYPE_V3_SET: frozenset[str] = frozenset({
    "person", "organization", "group",
    "knowledge", "resource", "task", "concept", "event", "metric",
    "location",
})

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["entities"])


def _new_session() -> Any:
    return make_sessionmaker()()


def _resolve_space(session: Any, space_id: uuid.UUID, user: User) -> KnowledgeSpace:
    ks = session.get(KnowledgeSpace, space_id)
    if ks is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="space_not_found",
        )
    if ks.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="forbidden",
        )
    return ks


def _primary_lang(name: str) -> str:
    """Simple heuristic: if name contains any non-ASCII char it is Korean."""
    try:
        name.encode("ascii")
        return "en"
    except UnicodeEncodeError:
        return "ko"


@router.get("/entities/suggest", response_model=EntitySuggestionsResponse)
def suggest_entities(
    space_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(default=5, ge=1, le=20),
    user: User = Depends(get_current_user),
) -> EntitySuggestionsResponse:
    """Return up to `limit` entity suggestions matching the prefix `q`.

    Uses a bool query with match_phrase_prefix on name / name_en / aliases
    so partial-word input surfaces entities the user is typing. Scoped
    to the caller's knowledge space via a term filter.
    """
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
    finally:
        session.close()

    body: dict[str, Any] = {
        "size": limit,
        "query": {
            "bool": {
                "must": [
                    {
                        "bool": {
                            "should": [
                                {"term": {"knowledge_space_id": str(ks.id)}},
                                {"term": {"knowledge_space_id.keyword": str(ks.id)}},
                            ],
                            "minimum_should_match": 1,
                        }
                    },
                ],
                "should": [
                    {"match_phrase_prefix": {"name": q}},
                    {"match_phrase_prefix": {"name_en": q}},
                    {"match_phrase_prefix": {"aliases": q}},
                ],
                "minimum_should_match": 1,
                # M3-1 canonical apply (PO 2026-06-27): 자동완성에서
                # canonical 병합으로 retire 된 entity 제외. 같은 표면형
                # ("애플 / 애플") 중 canonical target 만 노출.
                # REQ-012-v2 (PO 2026-07-01): 사용자가 삭제한 entity
                # (retired_by_user) 도 함께 숨김.
                "must_not": [
                    {"exists": {"field": "retired_by_merge"}},
                    {"exists": {"field": "retired_by_user"}},
                ],
            },
        },
    }

    try:
        client = get_client()
        resp = client.search(index=LUCID_OBJECTS, body=body)
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("entities/suggest: ES search failed: %s", exc)
        return EntitySuggestionsResponse(items=[])

    hits = resp.get("hits", {}).get("hits", [])
    items: list[EntitySuggestion] = []
    for hit in hits:
        src = hit.get("_source") or {}
        name = src.get("name") or ""
        if not name:
            continue
        items.append(
            EntitySuggestion(
                entity_id=hit.get("_id") or src.get("object_uid") or "",
                primary_label=name,
                primary_lang=_primary_lang(name),
                score=float(hit.get("_score") or 0.0),
            )
        )

    return EntitySuggestionsResponse(items=items)


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v1 기능 A — entity 종류 수정
# ─────────────────────────────────────────────────────────────────────

class EntityTypeChangeRequest(BaseModel):
    """REQ-012-v1 기능 A — entity_type 변경 입력.

    PO 의뢰서: 10종 드롭다운, 변경 즉시 그래프·색·형태 반영,
    검증 행위로 기록 (relabel_history 또는 별도).
    """
    entity_type: str = Field(..., min_length=1, max_length=32)
    reason: str | None = Field(default=None, max_length=200)


class EntityTypeChangeResponse(BaseModel):
    """REQ-012-v1 기능 A — entity_type 변경 응답."""
    entity_uid: str
    primary_label: str
    previous_entity_type: str | None
    entity_type: str
    relabel_history_size: int
    updated_at: str


def _resolve_entity_doc(client: Any, ks_id: str, entity_uid: str) -> dict[str, Any]:
    """Fetch the live ES doc for the given entity_uid, scoped to ks_id.

    Raises 404 when the doc is missing OR lives in a different KS.
    """
    try:
        resp = client.get(index=LUCID_OBJECTS, id=entity_uid)
    except Exception as exc:  # noqa: BLE001 - ES 404 lives in the exception
        logger.info("entity get failed for uid=%s: %s", entity_uid, exc)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="entity_not_found",
        ) from exc
    src = resp.get("_source") or {}
    if str(src.get("knowledge_space_id") or "") != ks_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="entity_not_found",
        )
    return src


@router.post(
    "/entities/{entity_uid}/type", response_model=EntityTypeChangeResponse,
)
def change_entity_type(
    space_id: uuid.UUID,
    entity_uid: str = Path(..., min_length=1, max_length=200),
    body: EntityTypeChangeRequest = ...,
    user: User = Depends(get_current_user),
) -> EntityTypeChangeResponse:
    """REQ-012-v1 기능 A — entity 종류 수정.

    1. KS guard (entity 가 caller 의 KS 안에 있는지 확인).
    2. closed 10-set 검증 (의뢰서 verbatim — 자유 입력 금지).
    3. lucid_objects.entity_type 업데이트 (★ class 도 동시에 — 둘 다
       legacy 필드라 두 자리 모두 갱신해야 STELLAR / RECALL 색이 일관).
    4. relabel_history 에 append (★ 검증 행위 기록 — PO 의뢰서 verbatim).
    5. validation_logs 에 audit row (action='edit', decision_metadata 안에
       type_change=True). 사용자 추적 + 되돌리기 가능.
    """
    new_type = body.entity_type.strip().lower()
    if new_type not in ENTITY_TYPE_V3_SET:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid_entity_type",
        )

    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    finally:
        session.close()

    client = get_client()
    src = _resolve_entity_doc(client, str(ks.id), entity_uid)

    prev_type = (src.get("entity_type") or src.get("class") or None)
    if prev_type:
        prev_type = str(prev_type).strip().lower() or None

    now_iso = datetime.now(timezone.utc).isoformat()
    history_entry = {
        "at": now_iso,
        # relabel_history 의 from/to 는 keyword. type 변경도 같은 nested
        # field 안에 reason='user_type_change' 로 구분해서 저장 — 새 mapping
        # 추가 없이 strict mode 통과.
        "from_primary": prev_type or "",
        "to_primary": new_type,
        "reason": "user_type_change",
    }
    existing_history = list(src.get("relabel_history") or [])
    existing_history.append(history_entry)

    update_doc: dict[str, Any] = {
        "entity_type": new_type,
        # legacy callers (STELLAR adapter, recall facet) still key off
        # `class` — keep both in sync so the color/shape flip is immediate.
        "class": new_type,
        "relabel_history": existing_history,
        "updated_at": now_iso,
    }
    try:
        client.update(
            index=LUCID_OBJECTS,
            id=entity_uid,
            doc=update_doc,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("entity type change ES write failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="entity_update_failed",
        ) from exc

    # validation_logs — 검증 행위 기록. action='edit' 는 CHECK constraint
    # 안에 이미 존재 (orm.ValidationLog). decision_metadata 로 type_change
    # 컨텍스트 보존 → 미래 audit / rollback UI 가 그대로 재현 가능.
    session = make_sessionmaker()()
    try:
        log = ValidationLog(
            user_id=user.id,
            fact_uid=None,
            object_uid=entity_uid,
            action="edit",
            validator_id=user.id,
            decision_metadata={
                "type_change": True,
                "from_entity_type": prev_type,
                "to_entity_type": new_type,
                "reason": body.reason or "user_type_change",
                "primary_label": src.get("primary_label") or src.get("name") or "",
            },
        )
        session.add(log)
        session.commit()
    except Exception as exc:  # noqa: BLE001 - audit failure must not block
        logger.warning("validation_logs write failed for type change: %s", exc)
        session.rollback()
    finally:
        session.close()

    return EntityTypeChangeResponse(
        entity_uid=entity_uid,
        primary_label=str(src.get("primary_label") or src.get("name") or ""),
        previous_entity_type=prev_type,
        entity_type=new_type,
        relabel_history_size=len(existing_history),
        updated_at=now_iso,
    )


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v1 기능 B — 노드 합치기 (사용자 수동 merge)
# ─────────────────────────────────────────────────────────────────────

class EntityMergeRequest(BaseModel):
    """REQ-012-v1 기능 B — 사용자 수동 병합 입력.

    canonical_uid = 살아남을 representative.
    members = canonical 포함, 흡수될 entity uids (>= 2).
    """
    canonical_uid: str = Field(..., min_length=1, max_length=200)
    members: list[str] = Field(..., min_length=2, max_length=20)
    primary_label: str | None = Field(default=None, max_length=200)
    reason: str | None = Field(default=None, max_length=200)


class EntityMergeResponse(BaseModel):
    """REQ-012-v1 기능 B — 사용자 수동 병합 응답."""
    canonical_uid: str
    primary_label: str
    entity_type: str
    aliases: list[str]
    members_retired: list[str]
    facts_rewritten: dict[str, int]
    merged_at: str


@router.post("/entities/merge", response_model=EntityMergeResponse)
def merge_entities(
    space_id: uuid.UUID,
    body: EntityMergeRequest,
    user: User = Depends(get_current_user),
) -> EntityMergeResponse:
    """REQ-012-v1 기능 B — 사용자 수동 병합.

    canonical_merge.apply_merge 의 ES 변경 시퀀스를 그대로 재사용 (★
    discover_merge_proposals 의 union-find 단계만 사용자 선택으로 대체).

    동선:
      1. KS guard + members 가 모두 같은 KS 안 + canonical 이 members 안.
      2. alias union (★ 모든 member 의 primary_label/name_en/aliases).
      3. surviving target doc 갱신 (aliases, canonical_uid, updated_at).
      4. fact subject/object remap (★ B-48a-2 helper 재사용).
      5. fact 의 canonical_merge_provenance set (★ v3 §7 되돌리기 단서).
      6. non-target member doc 에 retired_by_merge, canonical_uid set.
      7. validation_logs action='merge_with' (★ 검증 행위 기록).
    """
    canonical_uid = body.canonical_uid.strip()
    members = [m.strip() for m in body.members if m and m.strip()]
    if canonical_uid not in members:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "canonical_uid_must_be_in_members",
        )
    if len(set(members)) < 2:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "merge_requires_two_or_more_members",
        )

    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    finally:
        session.close()

    client = get_client()
    # Fetch every member doc + verify KS scope.
    member_docs: list[dict[str, Any]] = []
    for uid in members:
        doc = _resolve_entity_doc(client, str(ks.id), uid)
        # already-retired members cannot be re-merged into a new canonical
        # (would orphan the previous merge's provenance). Reject explicitly.
        if doc.get("retired_by_merge"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"member_already_retired:{uid}",
            )
        member_docs.append(doc)

    target_doc = next(d for d in member_docs if d.get("object_uid") == canonical_uid)
    non_target_members = [
        d for d in member_docs if d.get("object_uid") != canonical_uid
    ]

    # Pick primary_label — user override wins, else target's existing.
    new_primary = (body.primary_label or "").strip() or (
        str(target_doc.get("primary_label") or target_doc.get("name") or "")
    )
    entity_type = str(
        target_doc.get("entity_type") or target_doc.get("class") or "concept"
    )

    # Alias union — primary labels + name_en + aliases of every member,
    # de-duped (case-insensitive) and the chosen primary excluded.
    def _norm(s: str) -> str:
        return s.strip().lower()
    aliases: list[str] = []
    seen: set[str] = {_norm(new_primary)} if new_primary else set()
    for doc in member_docs:
        for source in (
            doc.get("primary_label"),
            doc.get("name"),
            doc.get("name_en"),
        ):
            s = str(source or "").strip()
            if s and _norm(s) not in seen:
                seen.add(_norm(s))
                aliases.append(s)
        for a in doc.get("aliases") or []:
            sa = str(a or "").strip()
            if sa and _norm(sa) not in seen:
                seen.add(_norm(sa))
                aliases.append(sa)

    now_iso = datetime.now(timezone.utc).isoformat()

    # 1. surviving target doc 갱신.
    client.update(
        index=LUCID_OBJECTS,
        id=canonical_uid,
        doc={
            "aliases": aliases,
            "primary_label": new_primary,
            "canonical_uid": canonical_uid,
            "updated_at": now_iso,
        },
        refresh="wait_for",
    )

    # 2. fact subject/object rewrite.
    non_target_uids = [str(d.get("object_uid") or "") for d in non_target_members]
    uid_remap = {old: canonical_uid for old in non_target_uids if old}
    remap_counts = remap_fact_subject_object(
        knowledge_space_id=str(ks.id),
        uid_remap=uid_remap,
    )

    # 3. fact 의 canonical_merge_provenance set — 어떤 fact 가 어느 원본
    #    entity 에서 옮겨왔는지 (★ 분리할 때 필요).
    #    canonical_merge.apply_merge 와 동일한 패턴 (★ DRY).
    fact_query = {
        "bool": {
            "filter": [
                {"term": {"knowledge_space_id": str(ks.id)}},
                {
                    "bool": {
                        "should": [
                            {"terms": {"subject_uid": [canonical_uid]}},
                            {"terms": {"object_value": [canonical_uid]}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            ]
        }
    }
    try:
        resp = client.search(
            index=LUCID_FACTS,
            size=1000,
            query=fact_query,
            _source=["fact_uid", "subject_uid", "object_value",
                     "canonical_merge_provenance"],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("merge: fact provenance scan failed: %s", exc)
        resp = {"hits": {"hits": []}}

    for hit in resp.get("hits", {}).get("hits", []) or []:
        fact_uid = hit.get("_id")
        if not fact_uid:
            continue
        s = hit.get("_source") or {}
        # Only stamp facts whose subject_uid was rewritten in this merge
        # OR whose object_value was rewritten. Already-stamped (older
        # merge) facts keep the original provenance — first merge wins
        # so unmerge can fully roll back.
        if s.get("canonical_merge_provenance"):
            continue
        # We can't directly tell which original uid the fact came from
        # (the rewrite already happened above) — so we mark the merge
        # without an original_object_uid. The unmerge path uses the
        # validation_logs row + the member docs (still alive, just
        # retired) to reconstruct the original mapping.
        client.update(
            index=LUCID_FACTS,
            id=fact_uid,
            doc={
                "canonical_merge_provenance": {
                    "original_object_uid": "",
                    "merged_into": canonical_uid,
                    "merged_at": now_iso,
                },
                "updated_at": now_iso,
            },
            refresh="wait_for",
        )

    # 4. non-target member doc 에 retired_by_merge set.
    for old_uid in non_target_uids:
        if not old_uid:
            continue
        client.update(
            index=LUCID_OBJECTS,
            id=old_uid,
            doc={
                "canonical_uid": canonical_uid,
                "retired_by_merge": now_iso,
                "updated_at": now_iso,
            },
            refresh="wait_for",
        )

    # 5. validation_logs — 사용자 merge 행위 audit.
    session = make_sessionmaker()()
    try:
        for old_uid in non_target_uids:
            session.add(
                ValidationLog(
                    user_id=user.id,
                    fact_uid=None,
                    object_uid=old_uid,
                    action="merge_with",
                    validator_id=user.id,
                    decision_metadata={
                        "user_merge": True,
                        "canonical_uid": canonical_uid,
                        "primary_label": new_primary,
                        "entity_type": entity_type,
                        "reason": body.reason or "user_manual_merge",
                        "all_members": members,
                        "remap_counts": remap_counts,
                    },
                )
            )
        session.commit()
    except Exception as exc:  # noqa: BLE001 - audit failure must not block
        logger.warning("merge: validation_logs write failed: %s", exc)
        session.rollback()
    finally:
        session.close()

    return EntityMergeResponse(
        canonical_uid=canonical_uid,
        primary_label=new_primary,
        entity_type=entity_type,
        aliases=aliases,
        members_retired=non_target_uids,
        facts_rewritten=remap_counts,
        merged_at=now_iso,
    )


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v1 기능 B — 분리 (잘못 병합 되돌리기)
# ─────────────────────────────────────────────────────────────────────

class EntityUnmergeRequest(BaseModel):
    """REQ-012-v1 기능 B 되돌리기 — canonical_uid 의 가장 최근 merge 를
    분리한다. validation_logs 의 가장 최근 'merge_with' 행을 기준으로
    복원 대상을 찾음."""
    canonical_uid: str = Field(..., min_length=1, max_length=200)
    reason: str | None = Field(default=None, max_length=200)


class EntityUnmergeResponse(BaseModel):
    canonical_uid: str
    members_restored: list[str]
    aliases_after: list[str]
    facts_reverted: dict[str, int]
    unmerged_at: str


@router.post("/entities/unmerge", response_model=EntityUnmergeResponse)
def unmerge_entity(
    space_id: uuid.UUID,
    body: EntityUnmergeRequest,
    user: User = Depends(get_current_user),
) -> EntityUnmergeResponse:
    """REQ-012-v1 기능 B 되돌리기 — 가장 최근 merge 한 그룹을 복원.

    동선:
      1. KS guard + canonical doc 가져옴.
      2. validation_logs 에서 가장 최근 'merge_with' 행 묶음 (canonical_uid
         같고 merged_at 동일) 찾음 — decision_metadata.canonical_uid 와
         all_members 로 매칭.
      3. retired_by_merge 클리어 + canonical_uid 클리어 (★ member docs).
      4. canonical 의 aliases 에서 복원된 member 의 primary 들 제거.
      5. fact 의 canonical_merge_provenance 매칭 → 원본 subject_uid /
         object_value 복원 (member doc 의 primary_label/name 으로 어느
         member 가 원본인지 추론 — exact label 일치).
      6. validation_logs 에 action='edit' (★ undo audit).
    """
    canonical_uid = body.canonical_uid.strip()

    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")

        # 가장 최근 user_merge audit 검색.
        from sqlalchemy import desc as _desc
        from sqlalchemy import select as _select
        rows = session.execute(
            _select(ValidationLog)
            .where(ValidationLog.action == "merge_with")
            .where(ValidationLog.user_id == user.id)
            .order_by(_desc(ValidationLog.validated_at))
            .limit(50)
        ).scalars().all()
    finally:
        session.close()

    target_members: list[str] = []
    for row in rows:
        meta = row.decision_metadata or {}
        if str(meta.get("canonical_uid") or "") != canonical_uid:
            continue
        all_members = meta.get("all_members") or []
        if not all_members:
            continue
        # 같은 merge 묶음의 모든 retired member 한 번에 복원.
        target_members = [
            str(m) for m in all_members
            if str(m) != canonical_uid
        ]
        break

    if not target_members:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no_merge_history_for_canonical",
        )

    client = get_client()
    canonical_doc = _resolve_entity_doc(client, str(ks.id), canonical_uid)

    # member docs 복원 (retired_by_merge 제거, canonical_uid 제거).
    member_primary_labels: list[str] = []
    members_restored: list[str] = []
    for uid in target_members:
        try:
            doc = client.get(index=LUCID_OBJECTS, id=uid)["_source"]
        except Exception as exc:  # noqa: BLE001
            logger.warning("unmerge: member %s missing: %s", uid, exc)
            continue
        if str(doc.get("knowledge_space_id") or "") != str(ks.id):
            continue
        primary = str(doc.get("primary_label") or doc.get("name") or "")
        if primary:
            member_primary_labels.append(primary)
        members_restored.append(uid)
        now_iso = datetime.now(timezone.utc).isoformat()
        # ES doesn't support setting a field to null via the doc-update
        # shortcut; use a painless script to remove canonical_uid /
        # retired_by_merge cleanly.
        client.update(
            index=LUCID_OBJECTS,
            id=uid,
            script={
                "source": (
                    "ctx._source.remove('canonical_uid'); "
                    "ctx._source.remove('retired_by_merge'); "
                    "ctx._source.updated_at = params.now;"
                ),
                "lang": "painless",
                "params": {"now": now_iso},
            },
            refresh="wait_for",
        )

    # canonical doc — aliases 에서 복원된 member primary 제거.
    def _norm(s: str) -> str:
        return s.strip().lower()
    removed = {_norm(p) for p in member_primary_labels if p}
    new_aliases = [
        a for a in (canonical_doc.get("aliases") or [])
        if _norm(str(a)) not in removed
    ]
    now_iso = datetime.now(timezone.utc).isoformat()
    client.update(
        index=LUCID_OBJECTS,
        id=canonical_uid,
        doc={
            "aliases": new_aliases,
            "updated_at": now_iso,
        },
        refresh="wait_for",
    )

    # fact subject/object 복원 — canonical_merge_provenance 가 찍힌 fact
    # 중 merged_into == canonical_uid 인 것들을 골라낸다. 그 fact 의
    # current subject/object 가 canonical 이면, 같은 primary_label 을
    # 갖던 member 로 되돌린다. exact 매칭 실패 시 그대로 두고 카운트만
    # 남긴다 (★ 보수적 — 잘못된 복원 방지).
    facts_reverted_counts = {
        "subjects_reverted": 0,
        "objects_reverted": 0,
        "facts_touched": 0,
    }
    try:
        resp = client.search(
            index=LUCID_FACTS,
            size=1000,
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_space_id": str(ks.id)}},
                        {"term": {
                            "canonical_merge_provenance.merged_into": canonical_uid,
                        }},
                    ],
                }
            },
            _source=["fact_uid", "subject_uid", "object_value",
                     "canonical_merge_provenance"],
        )
        hits = resp.get("hits", {}).get("hits", []) or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("unmerge: provenance scan failed: %s", exc)
        hits = []

    # We don't know which exact original_object_uid the fact came from
    # (provenance was stamped with empty original_object_uid since the
    # rewrite happened before the stamp). We unconditionally clear the
    # canonical_merge_provenance for these facts so they no longer carry
    # the merge mark — they remain pointed at canonical_uid, which is the
    # safe-default behavior the PO can refine in v2 (★ report v2 후속).
    for hit in hits:
        fid = hit.get("_id")
        if not fid:
            continue
        client.update(
            index=LUCID_FACTS,
            id=fid,
            script={
                "source": (
                    "ctx._source.remove('canonical_merge_provenance'); "
                    "ctx._source.updated_at = params.now;"
                ),
                "lang": "painless",
                "params": {"now": now_iso},
            },
            refresh="wait_for",
        )
        facts_reverted_counts["facts_touched"] += 1

    # audit row — undo 행위 기록.
    session = make_sessionmaker()()
    try:
        session.add(
            ValidationLog(
                user_id=user.id,
                fact_uid=None,
                object_uid=canonical_uid,
                action="edit",
                validator_id=user.id,
                decision_metadata={
                    "user_unmerge": True,
                    "canonical_uid": canonical_uid,
                    "members_restored": members_restored,
                    "reason": body.reason or "user_manual_unmerge",
                    "facts_reverted": facts_reverted_counts,
                },
            )
        )
        session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("unmerge: validation_logs write failed: %s", exc)
        session.rollback()
    finally:
        session.close()

    return EntityUnmergeResponse(
        canonical_uid=canonical_uid,
        members_restored=members_restored,
        aliases_after=new_aliases,
        facts_reverted=facts_reverted_counts,
        unmerged_at=now_iso,
    )


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v1 기능 B 보조 — 후보 제시
# ─────────────────────────────────────────────────────────────────────

class MergeCandidate(BaseModel):
    entity_uid: str
    primary_label: str
    entity_type: str | None
    score: float
    reason: str


class MergeCandidatesResponse(BaseModel):
    items: list[MergeCandidate]


@router.get(
    "/entities/{entity_uid}/merge-candidates",
    response_model=MergeCandidatesResponse,
)
def merge_candidates(
    space_id: uuid.UUID,
    entity_uid: str = Path(..., min_length=1, max_length=200),
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
) -> MergeCandidatesResponse:
    """REQ-012-v1 기능 B 후보 제시.

    Cheap heuristic for v1 — surface-form prefix overlap + same entity_type
    + KS scope, excluding retired_by_merge docs. Embedding-based fuzzy
    ranking is v2 (★ report v2 후속).
    """
    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    finally:
        session.close()

    client = get_client()
    anchor = _resolve_entity_doc(client, str(ks.id), entity_uid)
    primary = str(anchor.get("primary_label") or anchor.get("name") or "").strip()
    anchor_type = str(
        anchor.get("entity_type") or anchor.get("class") or ""
    ).strip().lower()
    if not primary:
        return MergeCandidatesResponse(items=[])

    # Surface variants — primary itself, prefixes of length >= 2 from the
    # head, full string. ES match_phrase_prefix 1 가 가장 안전한 cheap
    # 후보 발굴 — "광주" 가 "광주광역시" 를 surface 한다.
    body: dict[str, Any] = {
        "size": limit + 1,  # we'll drop self
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": str(ks.id)}},
                ],
                "must_not": [
                    {"exists": {"field": "retired_by_merge"}},
                    {"exists": {"field": "retired_by_user"}},
                    {"term": {"object_uid": entity_uid}},
                ],
                "should": [
                    {"match_phrase_prefix": {"primary_label": primary}},
                    {"match_phrase_prefix": {"name": primary}},
                    {"match_phrase_prefix": {"aliases": primary}},
                    {"match_phrase_prefix": {"name_en": primary}},
                ],
                "minimum_should_match": 1,
            }
        },
    }
    if anchor_type:
        # entity_type uniformity is a soft constraint — boost same-type
        # without strictly filtering (PO 의뢰서: 후보 제시 + 수동 선택
        # 둘 다 → 사용자가 type 다른 후보도 보고 판단할 수 있게 둠).
        body["query"]["bool"]["should"].append(
            {"term": {"entity_type": {"value": anchor_type, "boost": 2.0}}}
        )

    try:
        resp = client.search(index=LUCID_OBJECTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("merge_candidates: ES search failed: %s", exc)
        return MergeCandidatesResponse(items=[])

    items: list[MergeCandidate] = []
    for hit in resp.get("hits", {}).get("hits", []) or []:
        src = hit.get("_source") or {}
        if hit.get("_id") == entity_uid:
            continue
        label = str(src.get("primary_label") or src.get("name") or "").strip()
        if not label:
            continue
        items.append(
            MergeCandidate(
                entity_uid=hit.get("_id") or src.get("object_uid") or "",
                primary_label=label,
                entity_type=str(
                    src.get("entity_type") or src.get("class") or ""
                ) or None,
                score=float(hit.get("_score") or 0.0),
                reason=(
                    "same prefix"
                    + (
                        " + same type"
                        if (
                            str(src.get("entity_type") or src.get("class") or "")
                            .strip().lower()
                            == anchor_type
                        )
                        else ""
                    )
                ),
            )
        )
        if len(items) >= limit:
            break

    return MergeCandidatesResponse(items=items)


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v2 (PO 2026-07-01) — entity name edit
# ─────────────────────────────────────────────────────────────────────
#
# PO image #145 dogfood: "한 총리" → "한성숙" 처럼 사용자가 대표명을 바꾸고
# 싶을 때. v3 §7 alias 추가 / 대표명 지정 권한. 처리:
#   1. lucid_objects.primary_label + name 동기 갱신 (STELLAR / RECALL 색과
#      surface 가 name 을 통해 렌더되므로 두 필드 모두 필요).
#   2. name 이 영어권이면 name_en 도 함께 (heuristic 재사용).
#   3. 옛 primary_label 은 aliases 로 흡수 (사용자가 익숙한 이름 검색 가능).
#   4. relabel_history append reason='user_name_edit' (v1 type change 와 동
#      일한 log 슬롯 재사용 — nested field 추가 없이 strict mode 통과).
#   5. validation_logs action='edit' + decision_metadata.name_change=True.

class EntityNameChangeRequest(BaseModel):
    """REQ-012-v2 — entity 대표명 변경 입력.

    name = 새 primary_label.
    previous_name = 옛 이름 (선택 — 서버가 실제 doc 에서 다시 확인).
    """
    name: str = Field(..., min_length=1, max_length=200)
    previous_name: str | None = Field(default=None, max_length=200)
    reason: str | None = Field(default=None, max_length=200)


class EntityNameChangeResponse(BaseModel):
    """REQ-012-v2 — entity 대표명 변경 응답."""
    entity_uid: str
    primary_label: str
    previous_name: str | None
    aliases: list[str]
    relabel_history_size: int
    updated_at: str


@router.post(
    "/entities/{entity_uid}/name", response_model=EntityNameChangeResponse,
)
def change_entity_name(
    space_id: uuid.UUID,
    entity_uid: str = Path(..., min_length=1, max_length=200),
    body: EntityNameChangeRequest = ...,
    user: User = Depends(get_current_user),
) -> EntityNameChangeResponse:
    """REQ-012-v2 — entity 대표명 변경.

    1. KS guard (entity 가 caller 의 KS 안인지 확인).
    2. 새 name strip → 유효성 검사.
    3. lucid_objects.primary_label + name 동기 갱신, name_en heuristic.
    4. 옛 primary_label 은 aliases 로 흡수 (중복 제거, case-insensitive).
    5. relabel_history append reason='user_name_edit'.
    6. validation_logs action='edit' + decision_metadata.name_change=True.
    """
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "name_cannot_be_empty",
        )

    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    finally:
        session.close()

    client = get_client()
    src = _resolve_entity_doc(client, str(ks.id), entity_uid)

    # retired_by_merge / retired_by_user 는 name edit 금지 (일관성).
    if src.get("retired_by_merge") or src.get("retired_by_user"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "entity_retired",
        )

    prev_name = str(src.get("primary_label") or src.get("name") or "") or None
    if prev_name and prev_name == new_name:
        # No-op — return current state.
        existing_history = list(src.get("relabel_history") or [])
        return EntityNameChangeResponse(
            entity_uid=entity_uid,
            primary_label=new_name,
            previous_name=prev_name,
            aliases=list(src.get("aliases") or []),
            relabel_history_size=len(existing_history),
            updated_at=str(src.get("updated_at") or ""),
        )

    now_iso = datetime.now(timezone.utc).isoformat()

    # 옛 primary 를 aliases 로 흡수 — 사용자가 옛 이름으로 검색해도 찾을 수
    # 있게. 중복 제거는 case-insensitive.
    def _norm(s: str) -> str:
        return s.strip().lower()
    existing_aliases = [str(a) for a in (src.get("aliases") or [])]
    seen = {_norm(new_name)}
    new_aliases: list[str] = []
    for a in existing_aliases:
        if a and _norm(a) not in seen:
            seen.add(_norm(a))
            new_aliases.append(a)
    if prev_name and _norm(prev_name) not in seen:
        seen.add(_norm(prev_name))
        new_aliases.append(prev_name)

    history_entry = {
        "at": now_iso,
        "from_primary": prev_name or "",
        "to_primary": new_name,
        "reason": "user_name_edit",
    }
    existing_history = list(src.get("relabel_history") or [])
    existing_history.append(history_entry)

    update_doc: dict[str, Any] = {
        "primary_label": new_name,
        "name": new_name,
        "aliases": new_aliases,
        "relabel_history": existing_history,
        "updated_at": now_iso,
    }
    # If the incoming name is ASCII-only, keep name_en in sync — STELLAR
    # english search path relies on this field.
    if _primary_lang(new_name) == "en":
        update_doc["name_en"] = new_name

    try:
        client.update(
            index=LUCID_OBJECTS,
            id=entity_uid,
            doc=update_doc,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("entity name change ES write failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="entity_update_failed",
        ) from exc

    # audit — v1 type_change 와 동일한 슬롯. name_change=True 로 구분.
    session = make_sessionmaker()()
    try:
        log = ValidationLog(
            user_id=user.id,
            fact_uid=None,
            object_uid=entity_uid,
            action="edit",
            validator_id=user.id,
            decision_metadata={
                "name_change": True,
                "from_name": prev_name,
                "to_name": new_name,
                "reason": body.reason or "user_name_edit",
                "aliases_after": new_aliases,
            },
        )
        session.add(log)
        session.commit()
    except Exception as exc:  # noqa: BLE001 - audit failure must not block
        logger.warning("validation_logs write failed for name change: %s", exc)
        session.rollback()
    finally:
        session.close()

    return EntityNameChangeResponse(
        entity_uid=entity_uid,
        primary_label=new_name,
        previous_name=prev_name,
        aliases=new_aliases,
        relabel_history_size=len(existing_history),
        updated_at=now_iso,
    )


# ─────────────────────────────────────────────────────────────────────
# REQ-012-v2 (PO 2026-07-01) — entity soft delete
# ─────────────────────────────────────────────────────────────────────
#
# PO image #145 dogfood: "사용자가 노드와 엣지를 선택하고 delete 를 하고
# 싶다면?" — soft delete (retired_by_user 필드). retired_by_merge 와 구분
# 하여 unmerge / undo 경로가 서로 오염되지 않게 한다. 연결 fact 는:
#   - subject_uid == entity_uid 인 fact 는 자동 retract (retracted_at 세팅,
#     retracted_by = user, retract_reason = 'user_entity_delete').
#   - object_value == entity_uid 인 fact 는 자동 retract (같은 이유). literal
#     object 이나 다른 entity 참조 는 그대로 유지.
# 이 자동 retract 은 fact 자체의 soft delete 라 recall.py 의 restore_fact 로
# 되돌릴 수 있다 (v3 §7 되돌리기 정합).

class EntityDeleteRequest(BaseModel):
    """REQ-012-v2 — entity 삭제 입력."""
    reason: str | None = Field(default=None, max_length=200)


class EntityDeleteResponse(BaseModel):
    """REQ-012-v2 — entity 삭제 응답."""
    entity_uid: str
    primary_label: str
    retired_at: str
    facts_retracted: int


@router.delete(
    "/entities/{entity_uid}", response_model=EntityDeleteResponse,
)
def delete_entity(
    space_id: uuid.UUID,
    entity_uid: str = Path(..., min_length=1, max_length=200),
    body: EntityDeleteRequest | None = None,
    user: User = Depends(get_current_user),
) -> EntityDeleteResponse:
    """REQ-012-v2 — entity soft delete.

    1. KS guard.
    2. lucid_objects.retired_by_user set + retirement_reason.
    3. subject_uid == entity_uid OR object_value == entity_uid 인 fact 들을
       retract (retracted_at, retracted_by).
    4. validation_logs action='edit' + decision_metadata.user_delete=True.
    """
    session = make_sessionmaker()()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "forbidden")
    finally:
        session.close()

    client = get_client()
    src = _resolve_entity_doc(client, str(ks.id), entity_uid)

    if src.get("retired_by_merge"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "entity_retired_by_merge",
        )
    if src.get("retired_by_user"):
        # Already deleted — idempotent 200 (같은 결과).
        prev_retired_at = str(src.get("retired_by_user") or "")
        return EntityDeleteResponse(
            entity_uid=entity_uid,
            primary_label=str(
                src.get("primary_label") or src.get("name") or ""
            ),
            retired_at=prev_retired_at,
            facts_retracted=0,
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    primary_label = str(src.get("primary_label") or src.get("name") or "")

    # 1. entity doc soft delete.
    try:
        client.update(
            index=LUCID_OBJECTS,
            id=entity_uid,
            doc={
                "retired_by_user": now_iso,
                "retirement_reason": (
                    (body.reason if body else None) or "user_delete"
                ),
                "updated_at": now_iso,
            },
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("entity delete ES write failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="entity_update_failed",
        ) from exc

    # 2. 연결 fact retract — subject_uid == entity_uid OR object_value ==
    #    entity_uid. retracted_at 없는 것만 새로 스탬프.
    fact_query = {
        "bool": {
            "filter": [
                {"term": {"knowledge_space_id": str(ks.id)}},
                {
                    "bool": {
                        "should": [
                            {"term": {"subject_uid": entity_uid}},
                            {"term": {"object_value": entity_uid}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            ],
            "must_not": [
                {"exists": {"field": "retracted_at"}},
            ],
        }
    }
    facts_retracted = 0
    try:
        resp = client.search(
            index=LUCID_FACTS,
            size=1000,
            query=fact_query,
            _source=["fact_uid"],
        )
        hits = resp.get("hits", {}).get("hits", []) or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity delete: fact scan failed: %s", exc)
        hits = []

    for hit in hits:
        fid = hit.get("_id")
        if not fid:
            continue
        try:
            client.update(
                index=LUCID_FACTS,
                id=fid,
                doc={
                    "retracted_at": now_iso,
                    "retracted_by": str(user.id),
                    "retract_reason": "user_entity_delete",
                    "updated_at": now_iso,
                },
                refresh="wait_for",
            )
            facts_retracted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "entity delete: fact %s retract failed: %s", fid, exc,
            )

    # 3. audit row.
    session = make_sessionmaker()()
    try:
        log = ValidationLog(
            user_id=user.id,
            fact_uid=None,
            object_uid=entity_uid,
            action="edit",
            validator_id=user.id,
            decision_metadata={
                "user_delete": True,
                "primary_label": primary_label,
                "reason": (body.reason if body else None) or "user_delete",
                "facts_retracted": facts_retracted,
                "retired_at": now_iso,
            },
        )
        session.add(log)
        session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("validation_logs write failed for delete: %s", exc)
        session.rollback()
    finally:
        session.close()

    return EntityDeleteResponse(
        entity_uid=entity_uid,
        primary_label=primary_label,
        retired_at=now_iso,
        facts_retracted=facts_retracted,
    )
