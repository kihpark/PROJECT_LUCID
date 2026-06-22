"""Structure-stage BackgroundTasks worker (Sprint 3 PR-3-2).

`process_extracted_job(job_id)` is the entry point Sprint 2C's
`extractors/processor.py::_record_success()` will call once a
SourceJob's status flips to 'extracted'.

Lifecycle:
  extracted --(lock)--> structuring --(decompose+match+link)--> structured
                                                          + structure_failed

Steps:
  1. Load the SourceJob, sanity-check status='extracted', flip to
     'structuring' as a coarse lock.
  2. Run the decomposer on `source_job.extracted_text` (PR-3-1).
  3. For each candidate Object emitted by the decomposer: match-or-create
     via api.structure.object_matcher.
       - exact_match / knn_auto -> auto-merged to existing object_uid
       - knn_disambig / exact_match_multi -> stash in
         extracted_metadata['structure']['disambiguation_pending']
         (Sprint 4A Validate UI surfaces these)
       - create_new -> persist with a fresh object_uid (ES persistence
         lands in PR-3-3; for now we keep them in extracted_metadata)
  4. Run api.structure.link_creator over the decomposer's edges; ES
     Object<->Object adjacency updates fire when the target Objects
     exist in ES.
  5. Stamp counts + result onto source_job.extracted_metadata under
     a 'structure' key. PR-3-3 will then index the FactNodes into ES;
     PR-3-2 only persists the matcher / linker outputs onto the
     SourceJob.
  6. status='structured' (success) or 'structure_failed' (any error
     wrapped uniformly; error_message preserved).

Idempotency:
  - structured / structure_failed -> silent return
  - structuring -> silent return (another worker holds it; in beta
    single-process this only fires across restarts)
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from api.models.base import new_uid
from api.models.objects import ObjectClass
from api.models.source_job import SourceStatus
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.postgres.orm import SourceJobORM
from api.storage.postgres.session import make_sessionmaker
from api.structure.brand_resolver import resolve_korean_brand
from api.structure.decomposer import decompose
from api.structure.entity_resolver import _detect_lang, _looks_like_brand
from api.structure.link_creator import LinkCreationResult, create_links
from api.structure.models import StructureFact, StructureObject, StructureResult
from api.structure.object_matcher import MatchResult, match_or_create_object
from api.structure.predicate_mapper import map_predicate_to_type_and_label
from api.structure.surface_extractor import (
    detect_violation,
    strip_korean_particles,
)

logger = logging.getLogger("lucid.structure.processor")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _safe_object_class(raw: Any) -> ObjectClass | None:
    """Coerce a decomposer-emitted class string to ObjectClass; None on fail."""
    if raw is None:
        return None
    if isinstance(raw, ObjectClass):
        return raw
    try:
        return ObjectClass(str(raw))
    except ValueError:
        logger.warning("unknown object_class from decomposer: %r", raw)
        return None


def _build_surface_map(decomp: StructureResult) -> dict[str, str]:
    """Walk `decomp.facts` and collect `{obj_uid: source-text surface}`.

    For each fact:
      - `fact.subject_surface` is the verbatim span for `fact.subject_uid`
        when that uid matches the obj-N placeholder shape.
      - `fact.object_surface` is the span for `fact.object_value` when
        the object_value is itself an obj-N reference (the LLM is
        pointing at another decomposed entity, not a literal).

    Multiple facts may reference the same obj. We keep the longest
    non-empty surface; ties resolve to the first seen. The longest
    rule defends against trailing-particle differences ("중국 상무부"
    vs "중국 상무부는") — `strip_korean_particles` in the resolver
    normalises both to the same lookup form anyway, but preferring
    the longer string preserves more context for the eventual
    primary_label seed.

    B-62-fix-v2 wiring: the result is threaded into
    `match_or_create_object(..., surface=..., surface_lang=...)` so
    the v2-defended `resolve_entity` runs on the production path.
    """
    surface_map: dict[str, str] = {}

    def _consider(uid: str | None, surface: str | None) -> None:
        if not uid or not surface:
            return
        if not _OBJ_PLACEHOLDER_RE.match(uid):
            return
        s = surface.strip()
        if not s:
            return
        existing = surface_map.get(uid)
        if existing is None or len(s) > len(existing):
            surface_map[uid] = s

    for fact in decomp.facts:
        _consider(fact.subject_uid, fact.subject_surface)
        _consider(fact.object_value, fact.object_surface)
    return surface_map


def _find_claim_for_obj(
    decomp: StructureResult | None, obj_uid: str,
) -> str | None:
    """Return the first fact.claim whose subject_uid or object_value
    references `obj_uid`. Used by the Mode A surface derivation
    defense (B-62-fix-v3) to find a claim text that an entity
    appears in so we can scan it for a Korean substring.

    Returns None when no fact references the object (defensive — the
    obj almost certainly appears in at least one fact, but we never
    raise if it doesn't)."""
    if decomp is None:
        return None
    for fact in decomp.facts:
        if fact.subject_uid == obj_uid or fact.object_value == obj_uid:
            return fact.claim
    return None


def _match_object(
    obj: StructureObject,
    knowledge_space_id: str,
    surface_map: dict[str, str] | None = None,
    decomp: StructureResult | None = None,
) -> tuple[MatchResult | None, ObjectClass | None, bool]:
    """Compute embedding + run the matcher.

    Returns ``(match_result, resolved_class, needs_review)``.

    The third element is the **verbatim-substring violation flag**
    introduced by B-62-fix-v3-general (PO 2026-06-22,
    feat/spo-surface-content-language). It is True when the LLM-
    supplied surface for this object violates the verbatim rule
    (Korean source + Latin non-brand surface that is NOT a substring
    of the source). Callers propagate the flag onto every fact whose
    subject or object references this obj.

    Mechanism (replaces the prior curated KO↔EN dictionary):

      1. Take the LLM-supplied surface (from `surface_map`) and strip
         trailing Korean postpositions.

      2. Brand canonical: if the bare surface is a known Korean
         transliteration of an international brand (스페이스X), map
         to the English canonical (SpaceX) via `brand_resolver`.
         This is a narrow brands-only step; it does NOT translate
         Korean common nouns or ministries.

      3. Verbatim violation detection: against the claim text the
         object appears in, check whether a Hangul source + Latin
         non-brand surface is NOT a substring. When violated, we
         KEEP the LLM surface unchanged (no dictionary guess) and
         flag `needs_review=True` so HITL can resolve.

    When no per-fact surface span is recorded (LLM omitted
    subject_surface), the obj's `name` is the fallback surface and
    the same violation check applies — anglicized Korean entities
    are still flagged.
    """
    resolved_class = _safe_object_class(obj.class_)
    if resolved_class is None:
        return None, None, False
    emb = get_embedding(obj.name)
    embedding_list = list(emb) if emb is not None else None
    raw_surface = (surface_map or {}).get(obj.uid)

    # Use the LLM-supplied surface span when present; otherwise fall
    # back to the obj's `name`. The fallback IS subject to the same
    # verbatim check below (Mode A — LLM omitted subject_surface but
    # emitted English `name`).
    surface_seed = raw_surface or obj.name
    bare_surface = strip_korean_particles(surface_seed)

    # Step (1) — brand canonical for Korean transliterations of
    # international brands. 스페이스X → SpaceX. The map is narrow and
    # brands-only; ministries / persons / arbitrary companies stay
    # Korean.
    brand_en = resolve_korean_brand(bare_surface)
    surface = brand_en if brand_en else surface_seed

    # Step (2) — verbatim violation detection. Source text is the
    # claim the entity appears in. When no claim is available
    # (defensive), we cannot validate and assume no violation.
    source_text = _find_claim_for_obj(decomp, obj.uid) or ""
    surface_for_check = bare_surface if not brand_en else brand_en
    needs_review = detect_violation(
        surface=surface_for_check,
        source=source_text,
        looks_like_brand=_looks_like_brand(surface_for_check),
    )
    if needs_review:
        logger.warning(
            "B-62-fix-v3-general verbatim violation: obj=%s "
            "surface=%r is Latin non-brand but claim is Korean "
            "(%r); surface is NOT a substring of claim. Keeping "
            "LLM surface and flagging needs_review=True.",
            obj.uid, surface, source_text,
        )

    surface_lang = _detect_lang(surface) if surface else None
    # Point-2 instrumentation kept (DEBUG-gated, zero prod cost).
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "B-62-v3-general MATCHER_INPUT obj_uid=%s candidate_name=%r "
            "surface=%r surface_lang=%r llm_name_en=%r "
            "raw_surface_from_map=%r brand_en=%r needs_review=%s",
            obj.uid, obj.name, surface, surface_lang, obj.name_en,
            raw_surface, brand_en, needs_review,
        )
    try:
        result = match_or_create_object(
            obj.name,
            resolved_class,
            knowledge_space_id,
            candidate_embedding=embedding_list,
            surface=surface,
            surface_lang=surface_lang,
            llm_name_en=obj.name_en,
        )
    except Exception as exc:  # noqa: BLE001 - matcher never raises out to caller
        logger.exception("matcher failed for %r: %s", obj.name, exc)
        return None, resolved_class, needs_review
    return result, resolved_class, needs_review


def _summarize_result(result: MatchResult) -> dict[str, Any]:
    """Convert a MatchResult into a small dict for storage in JSONB."""
    return {
        "matched_object_uid": result.matched_object_uid,
        "disambiguation_required": result.disambiguation_required,
        "candidates": [
            {
                "object_uid": c.object_uid,
                "name": c.name,
                "object_class": c.object_class,
                "score": round(c.score, 4),
            }
            for c in result.candidates
        ],
        "created_new": result.created_new,
        "new_object_uid": result.new_object_uid,
        "decision_reason": result.decision_reason,
    }


def _build_uid_mapping(
    decomp: StructureResult,
    match_per_object: dict[str, MatchResult],
) -> dict[str, str]:
    """Map decomposer-issued obj-N uids to real Object UIDs.

    `decomp.objects[i].uid` is something like "obj-1" emitted by the LLM.
    The downstream link_creator needs to refer to either:
      - the existing matched_object_uid (auto-merge or exact match),
      - the freshly-issued new_object_uid (create_new), or
      - the original LLM uid placeholder (disambiguation_required —
        Sprint 4A user picks).
    """
    mapping: dict[str, str] = {}
    for obj in decomp.objects:
        m = match_per_object.get(obj.uid)
        if m is None:
            mapping[obj.uid] = obj.uid  # leave placeholder
            continue
        if m.matched_object_uid:
            mapping[obj.uid] = m.matched_object_uid
        elif m.new_object_uid:
            mapping[obj.uid] = m.new_object_uid
        else:
            mapping[obj.uid] = obj.uid
    return mapping


# B-48a: shape check for an LLM placeholder fact uid like "fn-1" /
# "fn-12" / "fn-1-a" (the coord_splitter appends -a/-b/...). Anything
# else (e.g. a canonical UUID4 already, an unexpected blank) is left
# untouched by the remap.
_FACT_PLACEHOLDER_RE = re.compile(r"^fn-\d+(?:-[a-z])?$", re.IGNORECASE)


def _build_fact_uid_mapping(decomp: StructureResult) -> dict[str, str]:
    """B-48a: map every decomposer-issued LLM placeholder fact uid
    ('fn-1', 'fn-1-a', ...) to a fresh canonical UUID4.

    Mirrors the Object-side `_build_uid_mapping` from B-35. Each
    `decomp.facts[i].uid` and every `fact_uid` referenced by the
    fact_object / fact_fact links is rewritten through this map so
    the FactNode that lands in ES has a non-colliding doc id. Prior
    to this remap, multiple jobs all emitted `fn-1` and the ES
    `index(id='fn-1')` calls overwrote each other — the silent
    cause of the 86→23 fact-count discrepancy after replay.

    The mapping only touches placeholder-shaped uids; anything that
    already looks canonical (e.g. a UUID4) maps to itself.
    """
    mapping: dict[str, str] = {}
    seen: set[str] = set()
    for f in decomp.facts:
        if f.uid in seen:
            continue
        seen.add(f.uid)
        if _FACT_PLACEHOLDER_RE.match(f.uid):
            mapping[f.uid] = new_uid()
        else:
            mapping[f.uid] = f.uid
    # The link records may reference fact uids the `facts` list didn't
    # cover (split coord children referenced before they appear, or
    # legacy payloads); fall back to identity so the link still points
    # somewhere stable.
    for fo in decomp.fact_object_links:
        mapping.setdefault(
            fo.fact_uid,
            new_uid() if _FACT_PLACEHOLDER_RE.match(fo.fact_uid) else fo.fact_uid,
        )
    for ff in decomp.fact_fact_links:
        for u in (ff.from_uid, ff.to_uid):
            mapping.setdefault(
                u, new_uid() if _FACT_PLACEHOLDER_RE.match(u) else u,
            )
    return mapping


def _remap_links(
    decomp: StructureResult,
    uid_map: dict[str, str],
    fact_uid_map: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Apply the uid_map to fact_object and fact_fact link payloads.

    B-48a: `fact_uid_map` rewrites the fact-side uids the same way the
    decomposer Object-side `uid_map` rewrites object uids. When None
    (legacy path), fact uids are left as-is.
    """
    fum = fact_uid_map or {}
    fact_object: list[dict[str, Any]] = []
    for fo in decomp.fact_object_links:
        fact_object.append({
            "fact_uid": fum.get(fo.fact_uid, fo.fact_uid),
            "object_uid": uid_map.get(fo.object_uid, fo.object_uid),
            "link_type": str(fo.link_type),
            "properties": fo.properties,
        })
    fact_fact: list[dict[str, Any]] = []
    for ff in decomp.fact_fact_links:
        fact_fact.append({
            "from_uid": fum.get(ff.from_uid, ff.from_uid),
            "to_uid": fum.get(ff.to_uid, ff.to_uid),
            "link_type": str(ff.link_type),
        })
    return fact_object, fact_fact


# B-35: shape check for an LLM placeholder uid like "obj-1" / "obj-12".
# Object values that DON'T match this pattern are literals
# ("85.7 billion USD", "흑자", "1938-01-01") and stay untouched.
_OBJ_PLACEHOLDER_RE = re.compile(r"^obj-\d+$", re.IGNORECASE)


def _serialize_struct_fact(
    f: StructureFact,
    uid_map: dict[str, str] | None = None,
    fact_uid_map: dict[str, str] | None = None,
    violation_per_object: dict[str, bool] | None = None,
) -> dict[str, Any]:
    """Pydantic StructureFact -> dict suitable for JSONB.

    `model_dump(by_alias=True, mode='json')` rewrites `type_` -> `type`
    and turns enums/datetimes into strings. The Decide Overlay's
    FactCard reads `fact.fact_uid || fact.uid` so we also project
    `uid` -> `fact_uid` to match the FactNode terminology.

    B-35: when `uid_map` is supplied, the fact's `subject_uid` is
    remapped through it (LLM placeholder "obj-1" -> canonical Object
    UID issued by `match_or_create_object`), and `object_value` is
    likewise remapped IF it matches the obj-N shape — pure literal
    object values (numbers, dates, "흑자" etc.) are left as-is.
    This is what fuses the cross-fact and cross-job entity graph:
    a fact whose subject is "SpaceX" in one article will share its
    subject_uid with another fact (potentially from a different
    article) whose object is also "SpaceX", because both ran through
    the same KS-scoped object matcher.

    B-48a: when `fact_uid_map` is supplied, both `uid` and `fact_uid`
    are rewritten from the LLM placeholder (fn-N) to a canonical
    UUID4. Submit then indexes into ES with the canonical id; the
    Decide overlay continues to round-trip through whichever uid it
    receives — its only contract is "use whatever the backend gave
    you as the React key and as the accept/discard parameter".
    """
    d = f.model_dump(by_alias=True, mode="json")
    if "uid" in d and "fact_uid" not in d:
        d["fact_uid"] = d["uid"]
    if fact_uid_map:
        original = d.get("uid")
        if isinstance(original, str) and original in fact_uid_map:
            canonical = fact_uid_map[original]
            d["uid"] = canonical
            d["fact_uid"] = canonical
    if uid_map:
        subject = d.get("subject_uid")
        if isinstance(subject, str) and subject in uid_map:
            d["subject_uid"] = uid_map[subject]
        obj_val = d.get("object_value")
        if (
            isinstance(obj_val, str)
            and _OBJ_PLACEHOLDER_RE.match(obj_val)
            and obj_val in uid_map
        ):
            d["object_value"] = uid_map[obj_val]
    # B-62 structure-resolve + natural-spo-display: enrich the JSONB
    # fact with canonical fields so validate.py persists them via
    # insert_or_dedup_fact. The new map_predicate_to_type_and_label
    # also computes the natural-English predicate_label used by recall.
    raw_predicate = d.get("predicate") or ""
    opl_code, opl_label, needs_review = map_predicate_to_type_and_label(
        raw_predicate,
    )
    d["predicate_code"] = opl_code
    d["predicate_label"] = opl_label
    d["original_surface"] = raw_predicate
    # B-62-fix-v3-general: OR-in the per-object verbatim-violation
    # flag. Either the subject obj OR (if the object_value is an
    # obj-N reference) the object obj's violation propagates to the
    # fact's needs_review. The predicate-mapper flag is preserved
    # from the prior behavior.
    vpo = violation_per_object or {}
    subj_uid_raw = f.subject_uid
    obj_val_raw = f.object_value if isinstance(f.object_value, str) else ""
    surface_violation = bool(
        vpo.get(subj_uid_raw, False)
        or (
            _OBJ_PLACEHOLDER_RE.match(obj_val_raw)
            and vpo.get(obj_val_raw, False)
        )
    )
    d["needs_review"] = bool(needs_review) or surface_violation
    # capture_lang is a per-fact best-effort guess; the processor
    # overrides it with a job-level detected lang in the metadata
    # stamp. We seed it here so older readers see a non-null value.
    d.setdefault(
        "capture_lang", _detect_lang(d.get("claim") or d.get("object_value") or ""),
    )
    # B-62-fix-v2 (PO 2026-06-22): fall back the LLM-emitted surface
    # to the subject/object entity name. The entity resolver (when
    # wired into the processor's create path) will pass `subject_surface`
    # as `surface` so the canonical primary_label preserves the
    # source-language form. Until that wiring lands, surface_fact_uid_map
    # carries enough information for downstream readers (validate.py)
    # to recover the verbatim span. The fallback uses StructureObject
    # `name` because pre-v2 LLM payloads never emitted *_surface.
    d.setdefault("subject_surface", d.get("subject_surface") or None)
    d.setdefault("object_surface", d.get("object_surface") or None)
    # tags carries the LLM's tags_suggested when present (we don't
    # synthesize tags in this PR; real tagging is a later ticket).
    d.setdefault("tags", list(d.get("tags_suggested") or []))
    return d


def _serialize_struct_object(
    o: StructureObject,
    uid_map: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Pydantic StructureObject -> dict suitable for JSONB.

    `class_` -> `class` is handled by `by_alias=True`. We also
    coerce `properties` to a plain dict so `extra='forbid'` re-validation
    in tests doesn't trip on Mapping subclasses.

    B-37 defect 2: when `uid_map` is supplied (the same map the
    decomposer uses to remap fact.subject_uid via B-35), the object's
    `uid` is rewritten too. Without this, fact triples carry canonical
    UUIDs while the objects array keeps LLM "obj-N" placeholders, so
    the Decide overlay's label lookup fails and FactCard shows raw
    UUIDs to the user.
    """
    d = o.model_dump(by_alias=True, mode="json")
    d["properties"] = dict(d.get("properties") or {})
    if uid_map:
        original = d.get("uid")
        if isinstance(original, str) and original in uid_map:
            d["uid"] = uid_map[original]
    return d



def _attach_video_locators(
    facts_payload: list[dict],
    segment_timecodes: list[dict],
    merged_text: str,
    media_url: str,
    source_uid: str,
) -> None:
    """B-46: attach a video locator to each fact in-place.

    For each serialised fact, find the segment whose ``[char_start,
    char_end]`` range contains the first occurrence of the fact's
    surface text inside ``merged_text``. When no match is found, fall
    back to segment 0 (defensive). The locator is written into
    ``fact["locators"]`` so the validate / surface layer can render
    a timestamped playback link.

    This function mutates ``facts_payload`` in place and only runs when
    ``segment_timecodes`` is non-empty, so non-video jobs are unaffected.
    """
    if not segment_timecodes or not facts_payload:
        return

    def _find_segment(surface: str) -> dict:
        """Find the timecode segment that contains `surface`."""
        if not surface:
            return segment_timecodes[0]
        idx = merged_text.find(surface)
        if idx == -1:
            logger.debug(
                "_attach_video_locators: surface %r not found in merged_text; using seg 0",
                surface[:80],
            )
            return segment_timecodes[0]
        for seg in segment_timecodes:
            if seg["char_start"] <= idx < seg["char_end"]:
                return seg
        # Fallback: nearest segment by char_start
        return segment_timecodes[0]

    for fact in facts_payload:
        # Try claim text first, then subject_surface, then empty string
        surface = (
            fact.get("claim")
            or fact.get("subject_surface")
            or ""
        )
        seg = _find_segment(surface)
        fact["locators"] = [
            {
                "kind": "video",
                "source_uid": source_uid,
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "media_url": media_url,
            }
        ]

def process_extracted_job(job_id: uuid.UUID | str) -> None:
    """BackgroundTasks entry. Safe to call on missing / terminal jobs."""
    if isinstance(job_id, str):
        try:
            job_id = uuid.UUID(job_id)
        except ValueError:
            logger.warning("process_extracted_job: invalid job_id=%r", job_id)
            return

    session = make_sessionmaker()()
    try:
        job: SourceJobORM | None = session.get(SourceJobORM, job_id)
        if job is None:
            logger.info("process_extracted_job: job %s not found; skipping", job_id)
            return

        if job.status in (
            SourceStatus.STRUCTURED.value,
            SourceStatus.STRUCTURE_FAILED.value,
            SourceStatus.STRUCTURING.value,
        ):
            logger.info(
                "process_extracted_job: job %s already in state %s; skipping",
                job_id, job.status,
            )
            return

        if job.status != SourceStatus.EXTRACTED.value:
            logger.info(
                "process_extracted_job: job %s not in extracted state (%s); skipping",
                job_id, job.status,
            )
            return

        # Lock by status
        job.status = SourceStatus.STRUCTURING.value
        job.updated_at = _utc_now()
        session.commit()

        merged_text = job.extracted_text or ""
        if not merged_text.strip():
            _record_failure(session, job, "extracted_text is empty")
            return

        try:
            decomp = decompose(
                merged_text,
                {
                    "source_url": job.source_url,
                    "captured_from": job.captured_from,
                    "knowledge_space_id": str(job.knowledge_space_id),
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("decompose failed for job %s", job_id)
            _record_failure(session, job, f"decompose error: {type(exc).__name__}")
            return

        # Match each Object
        match_per_object: dict[str, MatchResult] = {}
        match_summaries: list[dict[str, Any]] = []
        disambig_pending: list[dict[str, Any]] = []
        kspace_id = str(job.knowledge_space_id)
        # B-62-fix-v2 wiring: collect verbatim source-text surfaces for
        # the decomposer's obj-N placeholders BEFORE the per-object
        # loop, so each `_match_object` call can route through
        # `resolve_entity` with the Korean surface (not the LLM's
        # English translation).
        surface_map = _build_surface_map(decomp)
        # B-62-fix-v3-general (feat/spo-surface-content-language,
        # PO 2026-06-22): per-object verbatim-violation flag. When the
        # LLM anglicized a Korean entity (against the verbatim rule
        # in the prompt) and there is no English substring in the
        # source to match, this flag is True. Propagated onto every
        # fact referencing this obj so HITL surfaces them.
        violation_per_object: dict[str, bool] = {}
        for obj in decomp.objects:
            mr, _resolved_class, needs_review = _match_object(
                obj, kspace_id, surface_map, decomp=decomp,
            )
            violation_per_object[obj.uid] = needs_review
            if mr is None:
                continue
            match_per_object[obj.uid] = mr
            summary = _summarize_result(mr)
            summary["llm_uid"] = obj.uid
            summary["candidate_name"] = obj.name
            summary["needs_review"] = needs_review
            match_summaries.append(summary)
            if mr.disambiguation_required:
                disambig_pending.append(summary)

        # Compose links with remapped Object UIDs + fact UIDs (B-48a).
        uid_map = _build_uid_mapping(decomp, match_per_object)
        fact_uid_map = _build_fact_uid_mapping(decomp)
        fo_links, ff_links = _remap_links(decomp, uid_map, fact_uid_map)
        link_result: LinkCreationResult = create_links(
            fact_object_links=fo_links,
            fact_fact_links=ff_links,
            es_update_object_adjacency=False,
        )

        # Serialise the decomposer payloads for the Decide Overlay (DR-067).
        # The route reads facts / objects / *_links_detail directly from the
        # structure metadata; before chore 5 these were never written, so
        # the UI showed "0 pending fact(s)" even on a successful structure.
        facts_payload = [
            _serialize_struct_fact(
                f,
                uid_map=uid_map,
                fact_uid_map=fact_uid_map,
                violation_per_object=violation_per_object,
            )
            for f in decomp.facts
        ]
        objects_payload = [
            _serialize_struct_object(o, uid_map=uid_map) for o in decomp.objects
        ]
        fact_object_links_detail = [
            {
                "fact_uid": fact_uid_map.get(fo.fact_uid, fo.fact_uid),
                "object_uid": uid_map.get(fo.object_uid, fo.object_uid),
                "link_type": str(fo.link_type),
                "properties": dict(fo.properties or {}),
            }
            for fo in decomp.fact_object_links
        ]
        fact_fact_links_detail = [
            {
                "from_uid": fact_uid_map.get(ff.from_uid, ff.from_uid),
                "to_uid": fact_uid_map.get(ff.to_uid, ff.to_uid),
                "link_type": str(ff.link_type),
            }
            for ff in decomp.fact_fact_links
        ]


        # B-46: attach per-fact video locators when the job is VIDEO_STT.
        video_stt = (job.extracted_metadata or {}).get("video_stt", {})
        if video_stt:
            _attach_video_locators(
                facts_payload=facts_payload,
                segment_timecodes=video_stt.get("segment_timecodes", []),
                merged_text=merged_text,
                media_url=video_stt.get("media_url", ""),
                source_uid=str(job.id),
            )
        # M1 / E telemetry + DR-067 content payload.
        meta = dict(job.extracted_metadata or {})
        meta["structure"] = {
            "fact_count": len(decomp.facts),
            "object_count": len(decomp.objects),
            "object_auto_matched": sum(
                1 for m in match_per_object.values() if m.matched_object_uid is not None
            ),
            "object_created_new": sum(
                1 for m in match_per_object.values() if m.created_new
            ),
            "object_disambig_pending": len(disambig_pending),
            # Pre-chore-5 names kept for back-compat — these were ints
            # (counts) so anything reading them as numbers still works.
            "fact_object_links": link_result.fact_object_count,
            "fact_fact_links": link_result.fact_fact_count,
            "negates_links": link_result.negates_count,
            "links_skipped": link_result.skipped_count,
            "extraction_status": decomp.extraction_status,
            "failure_reason": decomp.failure_reason,
            "model_used": decomp.model_used,
            "latency_ms": decomp.latency_ms,
            "input_token_estimate": decomp.input_token_estimate,
            "output_token_estimate": decomp.output_token_estimate,
            "matches": match_summaries,
            "disambiguation_pending": disambig_pending,
            # chore 5 — full content payloads the Decide Overlay reads.
            "facts": facts_payload,
            "objects": objects_payload,
            "fact_object_links_detail": fact_object_links_detail,
            "fact_fact_links_detail": fact_fact_links_detail,
        }
        job.extracted_metadata = meta
        # M1-style anonymized aggregate row (DCR-001 privacy invariant:
        # counts + model + latency only — no claim text, no object names).
        try:
            from api.metrics.precision import record_structure_metrics
            record_structure_metrics(
                session,
                user_id=job.user_id,
                source_job_id=job.id,
                fact_count=len(decomp.facts),
                object_count_auto=sum(
                    1 for m in match_per_object.values()
                    if m.matched_object_uid is not None
                ),
                object_count_new=sum(
                    1 for m in match_per_object.values() if m.created_new
                ),
                object_count_disambig=len(disambig_pending),
                link_count=(
                    link_result.fact_object_count
                    + link_result.fact_fact_count
                    + link_result.object_object_count
                ),
                negates_count=link_result.negates_count,
                decomposer_model=decomp.model_used,
                latency_ms=decomp.latency_ms,
            )
        except Exception:  # noqa: BLE001 - never fail the structure stage on telemetry
            logger.exception(
                "record_structure_metrics failed for job %s; success path continues",
                job_id,
            )
        job.status = SourceStatus.STRUCTURED.value
        job.updated_at = _utc_now()
        session.commit()
        logger.info(
            "process_extracted_job: job %s structured "
            "(facts=%d, objects=%d, disambig=%d, links=%d)",
            job_id,
            len(decomp.facts),
            len(decomp.objects),
            len(disambig_pending),
            link_result.fact_object_count + link_result.fact_fact_count,
        )

    finally:
        session.close()


def _record_failure(session: Any, job: SourceJobORM, message: str) -> None:
    """Persist a terminal structure_failed state with the error message."""
    job.status = SourceStatus.STRUCTURE_FAILED.value
    job.error_message = (message or "")[:2000]
    job.updated_at = _utc_now()
    session.commit()


