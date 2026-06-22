"""Entity suggestion endpoint — spo-pending-ux.

GET /api/spaces/{space_id}/entities/suggest?q=<partial>&limit=5

Returns up to `limit` entity suggestions from lucid_objects scoped to
the knowledge space. Used by the FactCard subject/object chip inputs to
provide smart autocomplete without the old flat dropdown.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api.models.entities import EntitySuggestion, EntitySuggestionsResponse
from api.security import get_current_user
from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.entities")

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
                    {"term": {"knowledge_space_id": str(ks.id)}},
                ],
                "should": [
                    {"match_phrase_prefix": {"name": q}},
                    {"match_phrase_prefix": {"name_en": q}},
                    {"match_phrase_prefix": {"aliases": q}},
                ],
                "minimum_should_match": 1,
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
