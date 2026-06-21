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
    _hit_to_fact,
    _knn_facts_validated_only,
    _new_session,
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

SYSTEM_PROMPT = """\
당신은 Lucid 검증 지식 어시스턴트입니다. 아래 검증된 사실 목록에서만 답변하세요.

규칙:
1. relevant_fact_uids: 질문과 관련된 사실의 fact_uid 목록 (최대 8개, 없으면 빈 배열)
2. inference: 검증된 사실을 바탕으로 한 간결한 답변 (1-3문장, 한국어)
3. grounded: relevant_fact_uids가 비어있지 않고 답변이 검증된 사실에 근거하면 true

반드시 JSON만 출력하세요:
{"relevant_fact_uids": [...], "inference": "...", "grounded": true/false}"""


def _retrieve_candidates(query: str, space_id: str, k: int) -> list[dict[str, Any]]:
    """Return up to k candidate hits as plain dicts."""
    embedding = get_embedding(query)
    if embedding is None:
        return []
    try:
        hits = _knn_facts_validated_only(list(embedding), space_id, k)
    except Exception as exc:  # noqa: BLE001
        logger.warning("assistant: ES kNN failed: %s", exc)
        return []
    candidates: list[dict[str, Any]] = []
    for hit in hits:
        fact = _hit_to_fact(hit)
        if fact is None:
            continue
        src = hit.get("_source") or {}
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
