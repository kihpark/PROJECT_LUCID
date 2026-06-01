"""DCR-001 Object matcher.

Returns a `MatchResult` per candidate Object emitted by the Structure
decomposer. Routing:

  Exact name match (case-insensitive, knowledge_space-scoped)
    single hit  -> auto-merge to existing
    multi  hit  -> disambiguation_required=True (multiple existing
                   objects share the name; user picks)

  Vector kNN (over `lucid_objects.embedding`)
    auto-merge threshold:
      Person / Organization / Service  -> score >= 0.98
      everything else                  -> score >= 0.95
    disambiguation band:
      0.70 <= score < auto-threshold   -> disambiguation_required=True
    below band:
      score < 0.70                     -> create_new (no existing match)

DR-065 explicitly RETIRED the 0.85-0.95 semi-auto band; everything
between 0.70 and the auto-threshold goes to the Validate UI's
disambiguation queue rather than being silently merged.
"""
from __future__ import annotations

import logging
from typing import Any

from pydantic import Field

from api.models.base import UID, LucidBaseModel, new_uid
from api.models.objects import ObjectClass

logger = logging.getLogger("lucid.structure.matcher")

# DCR-001 / DR-065 thresholds
AUTO_THRESHOLD_TIGHT = 0.98  # Person / Organization / Service
AUTO_THRESHOLD_STANDARD = 0.95
DISAMBIG_FLOOR = 0.70  # below this -> create_new

TIGHT_CLASSES = frozenset(
    {ObjectClass.PERSON, ObjectClass.ORGANIZATION, ObjectClass.SERVICE}
)


class CandidateMatch(LucidBaseModel):
    """One match candidate returned by the matcher (for disambig queue)."""

    object_uid: UID
    name: str
    object_class: str
    score: float


class MatchResult(LucidBaseModel):
    """The matcher's verdict for one decomposer-emitted Object."""

    matched_object_uid: UID | None = None
    disambiguation_required: bool = False
    candidates: list[CandidateMatch] = Field(default_factory=list)
    created_new: bool = False
    new_object_uid: UID | None = None
    decision_reason: str = ""  # human-readable: "exact_match", "knn_auto", etc.


def _auto_threshold_for(object_class: ObjectClass) -> float:
    return AUTO_THRESHOLD_TIGHT if object_class in TIGHT_CLASSES else AUTO_THRESHOLD_STANDARD


def _exact_name_search(
    name: str, knowledge_space_id: str, object_class: ObjectClass | None
) -> list[dict[str, Any]]:
    """Look for existing objects with the same `name` (case-insensitive,
    space-scoped, optionally class-scoped)."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client

    client = get_client()
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": knowledge_space_id}},
        {"term": {"name.keyword": name}},
    ]
    if object_class is not None:
        filters.append({"term": {"class": object_class.value}})
    body = {
        "query": {"bool": {"filter": filters}},
        "size": 10,
    }
    try:
        resp = client.search(index=LUCID_OBJECTS, body=body)
    except Exception as exc:  # noqa: BLE001 - matcher must never raise out
        logger.warning("exact_name_search failed: %s; treating as miss", exc)
        return []
    return [h["_source"] for h in resp["hits"]["hits"]]


def match_or_create_object(
    candidate_name: str,
    candidate_class: ObjectClass,
    knowledge_space_id: str,
    *,
    candidate_embedding: list[float] | None = None,
    knn_k: int = 5,
) -> MatchResult:
    """Decide whether `candidate_name` matches an existing Object,
    needs user disambiguation, or should create a new Object."""
    # Step 1 — exact name match (case-insensitive happens at the
    # `name.keyword` field if we lowered the input first).
    exact = _exact_name_search(
        candidate_name.strip(), knowledge_space_id, candidate_class
    )
    if len(exact) == 1:
        match = exact[0]
        return MatchResult(
            matched_object_uid=match["object_uid"],
            decision_reason="exact_match",
        )
    if len(exact) > 1:
        candidates = [
            CandidateMatch(
                object_uid=m["object_uid"],
                name=m["name"],
                object_class=m.get("class") or candidate_class.value,
                score=1.0,
            )
            for m in exact
        ]
        return MatchResult(
            disambiguation_required=True,
            candidates=candidates,
            decision_reason="exact_match_multi",
        )

    # Step 2 — vector kNN (only if we have an embedding).
    if candidate_embedding is not None:
        from api.storage.elasticsearch.queries import knn_search_objects

        try:
            hits = knn_search_objects(
                candidate_embedding,
                k=knn_k,
                knowledge_space_id=knowledge_space_id,
                object_class=candidate_class.value,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("knn_search_objects failed: %s; falling back to create_new", exc)
            hits = []

        if hits:
            auto_threshold = _auto_threshold_for(candidate_class)
            top = hits[0]
            top_score = float(top.get("_score") or 0.0)

            if top_score >= auto_threshold:
                return MatchResult(
                    matched_object_uid=top["object_uid"],
                    decision_reason=f"knn_auto (score={top_score:.3f}, thr={auto_threshold:.2f})",
                )

            disambig_hits = [
                h for h in hits if float(h.get("_score") or 0.0) >= DISAMBIG_FLOOR
            ]
            if disambig_hits:
                candidates = [
                    CandidateMatch(
                        object_uid=h["object_uid"],
                        name=h["name"],
                        object_class=h.get("class") or candidate_class.value,
                        score=float(h.get("_score") or 0.0),
                    )
                    for h in disambig_hits
                ]
                return MatchResult(
                    disambiguation_required=True,
                    candidates=candidates,
                    decision_reason=f"knn_disambig (top={top_score:.3f}, thr={auto_threshold:.2f})",
                )

    # Step 3 — nothing matched; mark for create
    return MatchResult(
        created_new=True,
        new_object_uid=new_uid(),
        decision_reason="create_new",
    )
