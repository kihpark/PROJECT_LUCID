"""M4a — verified-knowledge briefing assistant."""
from __future__ import annotations

import logging
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status

from api.models.assistant import (
    AssistantBriefRequest,
    AssistantBriefResponse,
    VerifiedFactEntry,
)
from api.routes.recall import (
    _enrich_with_labels,
    _facts_for_entity,
    _hit_to_fact,
    _knn_facts_validated_only,
    _new_session,
    _resolve_entities_by_name,
    _resolve_space,
)
from api.security import get_current_user
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.postgres.orm import User
from api.structure.claude_client import call_claude_structured

logger = logging.getLogger("lucid.routes.assistant")
router = APIRouter(prefix="/api/assistant", tags=["assistant"])

K_MAX = 12
INFERENCE_TOKEN_CAP = 600

# ★ fix/recall-entity-exact-match-hallucination-block (PO 2026-07-01) —
# HEARTH assistant brief LLM prompt boost. Diagnosis: HEARTH 임베딩
# 유사도로 타 entity fact (더불어민주당) 를 근거로 반환 → LLM 이
# "조국혁신당은 더불어민주당과 함께..."로 합성 = 검증 안 된 관계 창작
# = 환각. Lucid P1: LLM 이 근거 없이 관계를 조합하면 안 됨. 知之為知之.
# 답변 합성 단계에서도 "명시된 것만" 원칙을 못 박는다.
SYSTEM_PROMPT = """\
system: 당신은 Lucid 의 검증된 지식만 답합니다.
* 근거 fact 에 명시된 관계만 답변에 포함
* 근거에 없는 entity 나 관계 창작 금지
* "A 는 B 와 함께 X 했다" 같은 조합 문장 = A, B, X 가 모두 같은 근거 fact 에 있을 때만
* 근거 부족 시 "이 질문에 대한 검증된 사실이 부족합니다" 답변

출력 규칙:
1. relevant_fact_uids: 질문과 관련된 사실의 fact_uid 목록 (최대 8개, 없으면 빈 배열)
2. inference: 위 검증된 사실만을 근거로 한 간결한 답변 (1-3문장, 한국어).
   근거 부족 시 "이 질문에 대한 검증된 사실이 부족합니다".
3. grounded: relevant_fact_uids가 비어있지 않고 답변이 검증된 사실에 근거하면 true

반드시 JSON만 출력하세요:
{"relevant_fact_uids": [...], "inference": "...", "grounded": true/false}"""


def _retrieve_candidates(query: str, space_id: str, k: int) -> list[dict[str, Any]]:
    """Return up to k candidate hits as plain dicts.

    feat/entity-layer-restore (PO 2026-06-23): mirror Recall's three-
    stage retrieval so the assistant never returns empty when Recall
    has hits. Stages:

      1. Semantic kNN over `lucid_facts.embedding` (same as before).
      2. Entity-name fallback: when kNN returns no above-floor hits,
         resolve the query as an entity name in `lucid_objects` and
         pull every fact where that uid sits on subject_uid or
         object_value (the same path `recall.py` lines 867-891 uses).
      3. Labels are enriched after the union so the assistant sees
         the corrected primary_label rather than the raw uid in the
         subject / object fields it shows the LLM.

    Asymmetry repro: "중국 상무부" — kNN scores ≤ 0.56 (below recall's
    0.72 floor). Pre-fix: assistant returned empty. Post-fix: the
    entity lookup returns 4 facts (same as Recall), the LLM gets a
    populated candidate set, and the briefing returns grounded.
    """
    embedding = get_embedding(query)
    if embedding is None:
        return []
    try:
        hits = _knn_facts_validated_only(list(embedding), space_id, k)
    except Exception as exc:  # noqa: BLE001
        logger.warning("assistant: ES kNN failed: %s", exc)
        hits = []

    # Stage 1 — kNN results, deduped by fact_uid.
    seen: set[str] = set()
    facts: list[Any] = []
    src_by_uid: dict[str, dict[str, Any]] = {}
    for hit in hits:
        fact = _hit_to_fact(hit)
        if fact is None:
            continue
        if fact.fact_uid in seen:
            continue
        seen.add(fact.fact_uid)
        facts.append(fact)
        src_by_uid[fact.fact_uid] = hit.get("_source") or {}

    # Stage 2 — entity-name fallback when kNN found nothing.
    if not facts:
        try:
            matched_entities = _resolve_entities_by_name(query, space_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("assistant: name-lookup fallback failed: %s", exc)
            matched_entities = []
        entity_uids = [
            uid for uid in (
                doc.get("object_uid") for doc in matched_entities
            )
            if isinstance(uid, str)
        ]
        if entity_uids:
            try:
                seed_hits = _facts_for_entity(
                    entity_uids, space_id, max_hits=k * 3,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "assistant: name-lookup fact fetch failed: %s", exc,
                )
                seed_hits = []
            for hit in seed_hits:
                fact = _hit_to_fact(hit)
                if fact is None or fact.fact_uid in seen:
                    continue
                seen.add(fact.fact_uid)
                facts.append(fact)
                src_by_uid[fact.fact_uid] = hit.get("_source") or {}
                if len(facts) >= k:
                    break

    if not facts:
        return []

    # Enrich labels (subject_label / object_label) so the LLM sees the
    # corrected primary_label rather than raw UUIDs. Same path Recall
    # uses; safe to call on a small list.
    try:
        facts = _enrich_with_labels(facts, space_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("assistant: label enrichment failed: %s", exc)

    candidates: list[dict[str, Any]] = []
    for fact in facts[:k]:
        src = src_by_uid.get(fact.fact_uid, {})
        candidates.append({
            "fact_uid": fact.fact_uid,
            "claim": fact.claim,
            "subject": fact.subject_label or fact.subject_uid,
            "predicate_label": fact.predicate_label or fact.predicate,
            "object": fact.object_label or fact.object_value,
            "sources": list(src.get("source_uids") or []),
        })
    return candidates


def _to_verified(c: dict[str, Any]) -> VerifiedFactEntry:
    return VerifiedFactEntry(
        fact_uid=c["fact_uid"],
        subject=c.get("subject") or "",
        predicate_label=c.get("predicate_label") or "",
        object=c.get("object") or "",
        sources=list(c.get("sources") or []),
    )


def _call_llm(query: str, candidates: list[dict[str, Any]]) -> dict[str, Any]:
    facts_text = "\n".join(
        f'[{c["fact_uid"]}] {c["claim"]}'
        for c in candidates
    )
    user_prompt = f"검증된 사실:\n{facts_text}\n\n질문: {query}"
    return call_claude_structured(SYSTEM_PROMPT, user_prompt, INFERENCE_TOKEN_CAP)


@router.post("/brief", response_model=AssistantBriefResponse)
def brief(
    req: AssistantBriefRequest,
    user: Annotated[User, Depends(get_current_user)],
) -> AssistantBriefResponse:
    session = _new_session()
    try:
        try:
            space_uuid = uuid.UUID(req.space_id)
        except (ValueError, AttributeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid_space_id",
            ) from exc
        _resolve_space(session, space_uuid, user)
    except HTTPException:
        raise
    finally:
        session.close()

    candidates = _retrieve_candidates(req.query, req.space_id, K_MAX)
    if not candidates:
        return AssistantBriefResponse(
            verified=[],
            inference="검증된 지식에 이 주제가 없습니다. 캡처가 더 필요할 수 있습니다.",
            grounded=False,
        )
    candidate_index = {c["fact_uid"]: c for c in candidates}
    try:
        llm_out = _call_llm(req.query, candidates)
    except Exception as exc:
        logger.warning("assistant.brief: LLM call failed: %s", exc)
        return AssistantBriefResponse(
            verified=[_to_verified(c) for c in candidates[:5]],
            inference="(AI 추론 일시 불가 — 검증된 사실만 표시합니다.)",
            grounded=True,
        )
    picked_uids = [
        uid for uid in (llm_out.get("relevant_fact_uids") or [])
        if uid in candidate_index
    ]
    grounded = bool(picked_uids) and bool(llm_out.get("grounded", False))
    if not grounded or not picked_uids:
        return AssistantBriefResponse(
            verified=[],
            inference=llm_out.get("inference") or "검증된 지식에 이 주제가 없습니다.",
            grounded=False,
        )
    verified = [_to_verified(candidate_index[uid]) for uid in picked_uids]
    return AssistantBriefResponse(
        verified=verified,
        inference=llm_out.get("inference") or "",
        grounded=True,
    )
