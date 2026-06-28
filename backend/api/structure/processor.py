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
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from api.models.base import new_uid
from api.models.objects import ObjectClass
from api.models.source_job import SourceStatus
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.postgres.orm import SourceJobORM
from api.storage.postgres.session import make_sessionmaker
from api.structure.brand_resolver import resolve_korean_brand
from api.structure.completeness_validator import (
    check_completeness,
    check_measurement_completeness,
)
from api.structure.decomposer import decompose
from api.structure.entity_resolver import _detect_lang
from api.structure.fact_dedup import dedup_facts, filter_links_by_fact_uids
from api.structure.link_creator import LinkCreationResult, create_links
from api.structure.models import StructureFact, StructureObject, StructureResult
from api.structure.object_matcher import MatchResult, match_or_create_object
from api.structure.predicate_mapper import map_predicate_to_type_and_label
from api.structure.subject_recovery import recover_korean_subject_from_claim
from api.structure.surface_extractor import (
    detect_predicate_violation,
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
    # B-62-fix-v6 (PO 2026-06-22, feat/spo-subject-claim-recovery):
    # When `brand_en` is set, `brand_resolver` has already canonicalized
    # a known Korean transliteration (스페이스X → SpaceX) — skip the
    # violation check entirely; the brand mapping is the authoritative
    # decision.
    # Otherwise pass `looks_like_brand=False` to detect_violation. The
    # brand-shape regex was previously letting country anglicizations
    # ("Japan" / "Korea" / "China") through as brand-shaped, which
    # silently bypassed recovery. The verbatim-substring exemption
    # inside detect_violation still legitimately keeps "SpaceX" when
    # it appears literally in the source.
    if brand_en:
        violation = False
    else:
        violation = detect_violation(
            surface=surface_for_check,
            source=source_text,
            looks_like_brand=False,
        )
    needs_review = False
    if violation:
        # B-62-fix-v6 (PO 2026-06-22, feat/spo-subject-claim-recovery):
        # DETERMINISTIC Korean subject recovery — replace the LLM's
        # English surface with the noun phrase parsed from the Korean
        # claim using particle boundaries (은/는/이/가/께서/에서). No
        # LLM, no dictionary, no translation — pure text parsing.
        # When recovery succeeds, we drop the English surface and keep
        # the Korean form, NEEDS_REVIEW=False.
        # When recovery fails (no particle in the claim — rare), we
        # keep the LLM surface and flag NEEDS_REVIEW=True. This is
        # the only genuine HITL case left in the loop.
        recovered = recover_korean_subject_from_claim(source_text)
        if recovered:
            logger.info(
                "B-62-fix-v6 claim-recovery: obj=%s replaced LLM "
                "surface %r with Korean %r (parsed from claim %r)",
                obj.uid, surface, recovered, source_text[:120],
            )
            surface = recovered
            # B-62-fix-v6: also override the LLM-supplied entity name
            # passed into the resolver. Without this, the downstream
            # `pick_natural_primary` sees `llm_name="Japan"` and the
            # brand-shape regex re-promotes "Japan" over the recovered
            # Korean "일본" — undoing the recovery. Threading the
            # recovered Korean into both surface AND candidate_name
            # makes the resolver's natural-primary picker land on the
            # Korean form. The original English LLM name lives on in
            # `name_en` so cross-language alias / co-mention still works.
            candidate_name_override = recovered
            needs_review = False
        else:
            logger.warning(
                "B-62-fix-v6 claim-recovery FAILED: obj=%s claim=%r "
                "has no subject particle; keeping LLM surface %r and "
                "flagging needs_review=True.",
                obj.uid, source_text[:120], surface,
            )
            needs_review = True
            candidate_name_override = None
    else:
        candidate_name_override = None

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
    candidate_name = candidate_name_override or obj.name
    try:
        result = match_or_create_object(
            candidate_name,
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


def _extract_roles(
    fact: StructureFact,
    uid_map: dict[str, str] | None,
) -> dict[str, str]:
    """m32a-stage2-role-channel (PO 2026-06-28 decision 4).

    Pull the LLM-emitted `roles` map off the fact, apply uid_map to each
    value when the value is an obj-N placeholder so role targets land
    on canonical Object UIDs (the same fusion path subject_uid takes
    in `_serialize_struct_fact`).

    ★ Enum 경직 금지: the PO directive says recipient/instrument/
    location are the SEED roles, not the exhaustive set. Any role key
    the LLM emits (e.g. "witness", "topic", "co-actor") passes through
    untouched. ES dynamic mapping on `fact_object_role` then auto-
    indexes it without a migration.

    Empty / non-string / blank role values are silently dropped so a
    sparse LLM payload (only one role present) doesn't pollute the
    fact doc with empty strings.

    Returns an empty dict when the LLM emitted no roles — caller can
    write it through to the fact doc unconditionally without a null-
    branch.
    """
    raw = fact.roles or {}
    if not isinstance(raw, dict):
        return {}
    um = uid_map or {}
    resolved: dict[str, str] = {}
    for role_name, role_value in raw.items():
        if not isinstance(role_name, str) or not role_name.strip():
            continue
        if not isinstance(role_value, str) or not role_value.strip():
            continue
        # obj-N placeholder -> canonical UID. Non-placeholders (literal
        # entity names like "트럼프" before the matcher created an
        # object for it, or when the LLM keeps a raw surface) pass
        # through unchanged - same fall-through as subject_uid.
        resolved[role_name] = um.get(role_value, role_value)
    return resolved


def _extract_related_entity_uids(
    fact: StructureFact,
    uid_map: dict[str, str] | None,
) -> list[str]:
    """m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6).

    CLAIM 의 내용 속 entity uid 들을 추출 + canonical UUID 매핑.

    ★ PO 결정 6 — 같은 fact 안 array, 별도 doc 아님 (성능 + 단순성).
    ★ provenance 게이트 (P2 가 구조에 박힘): 이 array 는 검증된 사실이
    아니라 claim 노드를 경유한 "주장된 연결" 만 담는다. AI/시스템이
    미검증 entity 관계를 실선으로 못 그음 — 의뢰서 점선 related-to 의
    데이터 표현. Stage 4 (link_status verified/claimed) 가 이 array
    위에 얹혀 점/실선을 결정한다.

    의뢰서 example verbatim:
        "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다."
            -> related_entity_uids=[<aweb canonical UID>,
                                    <6·3선거 canonical UID>]

    값 정규화:
        - LLM placeholder (obj-N) -> uid_map 으로 canonical UID 변환,
          subject_uid / speaker_uid 와 같은 fusion 경로.
        - 빈 array / non-list / non-string ref -> 안전 무시.
        - 빈 문자열 / whitespace -> drop.

    Returns:
        list[str] — canonical UID 또는 (uid_map 미적중) 원본 ref.
        empty list 가 기본 — caller 는 fact_type=='claim' 일 때만
        의미를 부여하지만, 평탄 처리 위해 helper 는 fact_type 분기
        없이 결정한다.
    """
    raw = getattr(fact, "related_entity_uids", None) or []
    if not isinstance(raw, list):
        return []
    um = uid_map or {}
    resolved: list[str] = []
    seen: set[str] = set()
    for ref in raw:
        if not isinstance(ref, str):
            continue
        bare = ref.strip()
        if not bare:
            continue
        mapped = um.get(bare, bare)
        if not mapped or not isinstance(mapped, str):
            continue
        # dedup while preserving order — LLM occasionally repeats refs.
        if mapped in seen:
            continue
        seen.add(mapped)
        resolved.append(mapped)
    return resolved


def _serialize_struct_fact(
    f: StructureFact,
    uid_map: dict[str, str] | None = None,
    fact_uid_map: dict[str, str] | None = None,
    violation_per_object: dict[str, bool] | None = None,
    match_per_object: dict[str, MatchResult] | None = None,
    decomp_objects: dict[str, StructureObject] | None = None,
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
        # m32a-stage1-speaker-uid-hotfix: speaker_uid is a CLAIM-only
        # entity reference using the same LLM placeholder shape (obj-N)
        # as subject_uid. Without this remap it leaks through to ES
        # raw, breaking entity-graph fusion for CLAIM facts (the
        # M3-2a discovery report measured 99/100 placeholder leak on
        # live KS 4a3a8bb7). Mirror the subject_uid rewrite path.
        speaker = d.get("speaker_uid")
        if isinstance(speaker, str) and speaker in uid_map:
            d["speaker_uid"] = uid_map[speaker]
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
    # feat/spo-decide-payload-wire (PO 2026-06-23): predicate script-
    # violation. The prompt now mandates source-language verb phrases
    # ("발표했다", "elected"); when the LLM still emits English snake_case
    # ("elected_president") on a Korean claim, we flag — but never rewrite.
    predicate_violation = detect_predicate_violation(
        raw_predicate, f.claim,
    )
    d["needs_review"] = (
        bool(needs_review)
        or surface_violation
        or predicate_violation
    )
    d["predicate_violation"] = predicate_violation
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
    # v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim — back-compat
    # default 'action' when the LLM omits the field on a legacy payload.
    # The recall facet aggregation `terms` on fact_type is null-safe but
    # cleaner buckets fall out when every doc carries a value.
    d.setdefault("fact_type", d.get("fact_type") or "action")
    # Claim-only fields. model_dump emits None when unset, which is
    # fine — ES `keyword` indexes None as missing, the recall facet
    # doesn't bucket it, and the FactCard branches on `fact_type==claim`
    # before reading these so missing values never render.
    d.setdefault("speaker_uid", d.get("speaker_uid"))
    d.setdefault("speaker_label", d.get("speaker_label"))
    d.setdefault("speech_act", d.get("speech_act"))
    d.setdefault("content_claim", d.get("content_claim"))
    d.setdefault("stance", d.get("stance"))
    # v0.2.0 step 2 (fact-measurement-layer-v1): measurement-only
    # fields. Same null-safe pattern as the claim-only block above
    # — non-measurement docs emit None for all four, and the FactCard
    # branches on `fact_type=='measurement'` before reading them.
    # measurement_value is float (or None); ES `double` carries it.
    d.setdefault("metric", d.get("metric"))
    d.setdefault("measurement_value", d.get("measurement_value"))
    d.setdefault("measurement_unit", d.get("measurement_unit"))
    d.setdefault("as_of", d.get("as_of"))
    # m32a-stage2-role-channel (PO 2026-06-28 decision 4): write the
    # multi-participant role channel onto the fact doc. The helper
    # applies uid_map so placeholder targets resolve to canonical
    # Object UIDs — the same entity-graph fusion path subject_uid /
    # speaker_uid use. Empty roles dict (the common case for simple
    # SPO facts) lands as {} so the ES mapping always sees an object,
    # never a null, which keeps the dynamic-mapping gate predictable.
    d["fact_object_role"] = _extract_roles(f, uid_map)
    # m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6):
    # CLAIM 의 내용 속 entity 들을 같은 fact 안 array 로 보존. ★ 별도
    # doc 아님. _extract_related_entity_uids 가 uid_map 으로 placeholder
    # (obj-N) 를 canonical UID 로 매핑 — subject_uid / speaker_uid /
    # fact_object_role 의 fusion 경로와 동일.
    #
    # ★ provenance 게이트: 이 array 는 검증된 사실이 아니라 claim 노드
    # 를 경유한 "주장된 연결" 만 담는다 (의뢰서 점선 related-to).
    # Stage 4 (link_status) 가 이 위에 얹혀 점/실선을 결정.
    #
    # 비-CLAIM fact 에서는 LLM 이 보통 emit 하지 않음 — 그 경우 helper
    # 가 [] 를 돌려주므로 ES 의 keyword array 는 missing 으로 처리되어
    # recall facet / count 에 영향 없음. fact_type 분기 없이 동일하게
    # 직렬화한다 (단순성 — 분기 = 미래 버그).
    d["related_entity_uids"] = _extract_related_entity_uids(f, uid_map)
    # feat/spo-decide-payload-wire (PO 2026-06-23): propagate the
    # corrected canonical surface from `match_per_object` so the
    # Decide UI sees the brand-canonical / claim-recovered form (not
    # the LLM's raw English anglicization). The override walks:
    #
    #   match_per_object[subject_uid].primary_label   # corrected
    #     ↓ fallback
    #   decomp_objects[subject_uid].name              # LLM raw
    #     ↓ fallback
    #   d["subject_surface"]                          # unchanged
    #
    # Same logic for the object side when `object_value` is an
    # obj-N entity reference (literals — numbers, "흑자", dates —
    # are NOT touched). The Decide UI reads `subject_label` /
    # `object_label` directly when present and falls back to the
    # objects-array lookup; either path now lands on the corrected
    # primary_label because `_serialize_struct_object` also writes
    # the corrected surface to `objects_payload[i].name`.
    mpo = match_per_object or {}
    dobjs = decomp_objects or {}

    def _corrected_and_raw(uid: str) -> tuple[str | None, str | None]:
        """Return (corrected_primary_label, llm_raw_name) for `uid`."""
        mr = mpo.get(uid)
        obj = dobjs.get(uid)
        corrected = (mr.primary_label if mr and mr.primary_label else None)
        raw = (obj.name if obj and obj.name else None)
        return corrected, raw

    def _resolve_label(uid: str) -> str | None:
        corrected, raw = _corrected_and_raw(uid)
        return corrected or raw

    def _was_corrected(uid: str, current_surface: str | None) -> bool:
        """True when the matcher's primary_label differs from BOTH the
        LLM's raw object name AND the current subject_surface — meaning
        claim_recovery / brand_resolver / pick_natural_primary chose a
        different canonical surface that the caller has not yet seen.
        """
        corrected, raw = _corrected_and_raw(uid)
        if not corrected:
            return False
        if raw and corrected != raw:
            return True
        if current_surface and corrected != current_surface:
            return True
        return False

    subject_label = _resolve_label(subj_uid_raw)
    if subject_label:
        d["subject_label"] = subject_label
        # Patch subject_surface when (a) it's empty, OR (b) the matcher
        # chose a primary_label that differs from the LLM-raw — meaning
        # a correction fired (claim_recovery / brand_resolver). The
        # legitimate non-correction spans (e.g. "SpaceX" inside Korean
        # text) leave subject_surface untouched because corrected == raw.
        if (
            not d.get("subject_surface")
            or _was_corrected(subj_uid_raw, d.get("subject_surface"))
        ):
            d["subject_surface"] = subject_label
    if (
        isinstance(obj_val_raw, str)
        and _OBJ_PLACEHOLDER_RE.match(obj_val_raw)
    ):
        object_label = _resolve_label(obj_val_raw)
        if object_label:
            d["object_label"] = object_label
            if (
                not d.get("object_surface")
                or _was_corrected(obj_val_raw, d.get("object_surface"))
            ):
                d["object_surface"] = object_label
    # feat/spo-decomp-completeness (PO 2026-06-23): deterministic
    # completeness check. Verifies the SPO surface (subject_label +
    # predicate + object_value/label) covers the claim's content
    # tokens. PO directive: 자르기만, 내용 추가 금지 — we ONLY flag,
    # never re-decompose. The Decide UI surfaces incomplete facts so
    # the human can repair manually.
    #
    # Use the CORRECTED surfaces (subject_label / object_label) when
    # available — those are post-recovery / post-brand-canonicalization
    # so the coverage check measures what the user will actually see
    # in the Decide UI, not the LLM's raw output.
    #
    # v0.2.0 step 2.5 (feat/measurement-completeness, PO 2026-06-24):
    # measurement facts use a DIFFERENT validator — the SPO triple is
    # the wrong surface to check against the claim because a measurement
    # claim's content is carried in the (entity, metric, value, unit,
    # as_of) quadruple, not in (subject, predicate, object). PO's 노사
    # case: the LLM-emitted predicate ("시급 기준 차이이다") and object
    # ("1680원") together cover most of the claim, so the SPO validator
    # falsely passes — yet metric="최초 요구안 차이" is missing 주체/기준
    # qualifiers. The measurement validator catches that.
    subject_for_check = (
        d.get("subject_label") or d.get("subject_surface") or ""
    )
    if f.fact_type == "measurement":
        completeness = check_measurement_completeness(
            claim=f.claim or "",
            metric=f.metric,
            measurement_value=f.measurement_value,
            measurement_unit=f.measurement_unit,
            as_of=f.as_of,
            entity_label=subject_for_check,
        )
    else:
        object_for_check_raw = d.get("object_label") or d.get("object_surface") or ""
        # When object_value is a literal (e.g. "750억달러", "흑자"), use it.
        # When object_value is an obj-N reference, prefer the resolved label.
        if not object_for_check_raw and isinstance(f.object_value, str):
            if _OBJ_PLACEHOLDER_RE.match(f.object_value):
                # No resolved label and it's just a placeholder uid — empty.
                object_for_check_raw = ""
            else:
                object_for_check_raw = f.object_value
        completeness = check_completeness(
            claim=f.claim or "",
            subject=subject_for_check,
            predicate=raw_predicate,
            object_text=object_for_check_raw,
        )
    if not completeness["complete"]:
        d["needs_review"] = True
        logger.info(
            "completeness check fail (fact_type=%s): claim=%r missing=%s coverage=%.2f",
            f.fact_type,
            (f.claim or "")[:80],
            list(completeness["missing"])[:5],
            float(completeness["coverage"]),
        )
    d["completeness"] = {
        "complete": bool(completeness["complete"]),
        "missing": list(completeness["missing"])[:10],
        "coverage": round(float(completeness["coverage"]), 2),
    }
    # tags carries the LLM's tags_suggested when present (we don't
    # synthesize tags in this PR; real tagging is a later ticket).
    d.setdefault("tags", list(d.get("tags_suggested") or []))
    return d


def _serialize_struct_object(
    o: StructureObject,
    uid_map: dict[str, str] | None = None,
    match_per_object: dict[str, MatchResult] | None = None,
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

    feat/spo-decide-payload-wire (PO 2026-06-23): when
    `match_per_object[o.uid].primary_label` is non-empty and differs
    from the LLM's raw `name`, write the corrected primary_label as
    `name` and stash the original LLM name as an alias. This is what
    fixes the rendered subject in the Decide UI — `FactCard.tsx::
    resolveEntity` reads `obj.name` directly to display the subject.
    """
    d = o.model_dump(by_alias=True, mode="json")
    d["properties"] = dict(d.get("properties") or {})
    # feat/spo-decide-payload-wire: corrected surface override. We do
    # this BEFORE the uid rewrite so we can key off the LLM-side uid
    # (o.uid) as it appears in match_per_object.
    mpo = match_per_object or {}
    mr = mpo.get(o.uid)
    if mr is not None and mr.primary_label:
        original_name = d.get("name") or ""
        corrected = mr.primary_label
        if corrected and corrected != original_name:
            d["name"] = corrected
            existing_aliases = list(d.get("aliases") or [])
            # Preserve the LLM's raw name as alias (e.g. English form
            # cross-language lookup keeps working).
            if (
                original_name
                and original_name not in existing_aliases
                and original_name != corrected
            ):
                existing_aliases.append(original_name)
            d["aliases"] = existing_aliases
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

        # feat/prompts-classification-recovery: log fact_type distribution
        # right after decompose so production drift (e.g. 100% defaulting
        # to 'action' because the LLM omits the field) is visible in
        # structure-stage logs without needing to re-index ES.
        fact_type_dist = Counter(
            getattr(f, "fact_type", None) or "unknown" for f in decomp.facts
        )
        logger.info(
            "structure: fact_type distribution: %s (total=%d, job=%s)",
            dict(fact_type_dist),
            len(decomp.facts),
            job_id,
        )

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
        # feat/spo-decide-payload-wire: thread match_per_object +
        # decomp_objects into both serializers so the corrected surface
        # (from claim_recovery / brand_resolver / pick_natural_primary)
        # propagates to the Decide UI payload.
        decomp_objects_by_uid = {o.uid: o for o in decomp.objects}
        facts_payload = [
            _serialize_struct_fact(
                f,
                uid_map=uid_map,
                fact_uid_map=fact_uid_map,
                violation_per_object=violation_per_object,
                match_per_object=match_per_object,
                decomp_objects=decomp_objects_by_uid,
            )
            for f in decomp.facts
        ]
        # fix/fact-dedup-on-structure-output (PO 2026-06-27): drop facts
        # whose canonical (subject, predicate_code, object) tuple has
        # already been seen earlier in the payload. PO live evidence
        # (job_id 3bab7b79…): a single article emitted 14 facts of
        # which four were exact dups (RELATED_TO fallback on Korean verbs
        # the OPL mapper does not cover). The dedup keeps the first
        # occurrence and cascades the dropped fact_uids onto the link
        # detail lists so the Decide overlay stays consistent. The
        # processor's downstream telemetry (fact_count, metrics row)
        # then reads the deduped length — not the raw LLM count — so
        # the dashboard reflects what the user actually sees.
        pre_dedup_count = len(facts_payload)
        facts_payload, _dropped_dup_fact_uids = dedup_facts(facts_payload)
        if _dropped_dup_fact_uids:
            logger.info(
                "structure: dedup dropped %d duplicate fact(s) "
                "(pre=%d, post=%d, job=%s)",
                pre_dedup_count - len(facts_payload),
                pre_dedup_count,
                len(facts_payload),
                job_id,
            )
        objects_payload = [
            _serialize_struct_object(
                o,
                uid_map=uid_map,
                match_per_object=match_per_object,
            )
            for o in decomp.objects
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
        # Cascade the dedup onto the link detail lists so no ghost edge
        # references a dropped fact_uid.
        if _dropped_dup_fact_uids:
            fact_object_links_detail = filter_links_by_fact_uids(
                fact_object_links_detail,
                _dropped_dup_fact_uids,
                uid_fields=("fact_uid",),
            )
            fact_fact_links_detail = filter_links_by_fact_uids(
                fact_fact_links_detail,
                _dropped_dup_fact_uids,
                uid_fields=("from_uid", "to_uid"),
            )


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
            # fix/fact-dedup-on-structure-output: report the deduped count
            # so the dashboard / Decide overlay header agree with the
            # actual `facts` list length below.
            "fact_count": len(facts_payload),
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
                fact_count=len(facts_payload),
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


