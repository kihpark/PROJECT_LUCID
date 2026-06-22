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

# B-62-fix-v2 wiring: module-level import so unit tests can patch
# `api.structure.object_matcher.resolve_entity` directly. There is no
# back-dep (entity_resolver does not import this module), so no cycle.
from api.structure.entity_resolver import _detect_lang, resolve_entity

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
    surface: str | None = None,
    surface_lang: str | None = None,
    llm_name_en: str | None = None,
) -> MatchResult:
    """Decide whether `candidate_name` matches an existing Object,
    needs user disambiguation, or should create a new Object.

    B-62-fix-v2 wiring (PO 2026-06-22):
      When `surface` is supplied (the verbatim source-text span from
      `StructureFact.subject_surface` / `object_surface`), delegate to
      `resolve_entity` so the v2 defenses fire on the production
      extraction path: Korean primary_label preservation,
      `_maybe_repromote_on_hit`, brand-shape guard via
      `_looks_like_brand`, and `strip_korean_particles`. The
      `(uid, was_created)` tuple from the resolver is wrapped into a
      `MatchResult` so the rest of the processor pipeline (uid_map,
      summaries, disambig queue) keeps working unchanged.

      Legacy callers (no `surface`) keep the original exact+kNN
      behavior. This preserves direct unit tests of the matcher and
      any future legacy call sites that have no source-text span.
    """
    if surface and surface.strip():
        # B-62-fix-v2: v2-defended path. resolve_entity does its own
        # exact lookups across primary_label/name/name_en/aliases (the
        # v2 canonical fields), handles cross-language merge via
        # co_mention_en, applies re-promote on hit, and uses
        # pick_natural_primary on the create path. The kNN /
        # disambiguation band is intentionally skipped here — once
        # exact surface-based lookup is the source of truth there is
        # nothing for kNN to disambiguate.
        lang = surface_lang or _detect_lang(surface)
        try:
            entity_uid, was_created = resolve_entity(
                surface,
                lang,
                space_id=knowledge_space_id,
                co_mention_en=llm_name_en,
                llm_name=candidate_name,
            )
        except Exception as exc:  # noqa: BLE001 - matcher must never raise out
            logger.warning(
                "resolve_entity failed for surface=%r: %s; "
                "falling back to legacy exact+kNN path", surface, exc,
            )
        else:
            if was_created:
                return MatchResult(
                    created_new=True,
                    new_object_uid=entity_uid,
                    decision_reason="resolve_entity_create",
                )
            return MatchResult(
                matched_object_uid=entity_uid,
                decision_reason="resolve_entity_match",
            )

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
