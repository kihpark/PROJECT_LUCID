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

from api.models.objects import ObjectClass
from api.models.source_job import SourceStatus
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.postgres.orm import SourceJobORM
from api.storage.postgres.session import make_sessionmaker
from api.structure.decomposer import decompose
from api.structure.link_creator import LinkCreationResult, create_links
from api.structure.models import StructureFact, StructureObject, StructureResult
from api.structure.object_matcher import MatchResult, match_or_create_object

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


def _match_object(
    obj: StructureObject, knowledge_space_id: str
) -> tuple[MatchResult | None, ObjectClass | None]:
    """Compute embedding + run the matcher. Returns (result, resolved_class)."""
    resolved_class = _safe_object_class(obj.class_)
    if resolved_class is None:
        return None, None
    emb = get_embedding(obj.name)
    embedding_list = list(emb) if emb is not None else None
    try:
        result = match_or_create_object(
            obj.name,
            resolved_class,
            knowledge_space_id,
            candidate_embedding=embedding_list,
        )
    except Exception as exc:  # noqa: BLE001 - matcher never raises out to caller
        logger.exception("matcher failed for %r: %s", obj.name, exc)
        return None, resolved_class
    return result, resolved_class


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


def _remap_links(
    decomp: StructureResult,
    uid_map: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Apply the uid_map to fact_object and fact_fact link payloads.
    Fact uids are left as-is (FactNode persistence is PR-3-3 scope)."""
    fact_object: list[dict[str, Any]] = []
    for fo in decomp.fact_object_links:
        fact_object.append({
            "fact_uid": fo.fact_uid,
            "object_uid": uid_map.get(fo.object_uid, fo.object_uid),
            "link_type": str(fo.link_type),
            "properties": fo.properties,
        })
    fact_fact: list[dict[str, Any]] = []
    for ff in decomp.fact_fact_links:
        fact_fact.append({
            "from_uid": ff.from_uid,
            "to_uid": ff.to_uid,
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
    """
    d = f.model_dump(by_alias=True, mode="json")
    if "uid" in d and "fact_uid" not in d:
        d["fact_uid"] = d["uid"]
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
        for obj in decomp.objects:
            mr, _resolved_class = _match_object(obj, kspace_id)
            if mr is None:
                continue
            match_per_object[obj.uid] = mr
            summary = _summarize_result(mr)
            summary["llm_uid"] = obj.uid
            summary["candidate_name"] = obj.name
            match_summaries.append(summary)
            if mr.disambiguation_required:
                disambig_pending.append(summary)

        # Compose links with remapped Object UIDs
        uid_map = _build_uid_mapping(decomp, match_per_object)
        fo_links, ff_links = _remap_links(decomp, uid_map)
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
            _serialize_struct_fact(f, uid_map=uid_map) for f in decomp.facts
        ]
        objects_payload = [
            _serialize_struct_object(o, uid_map=uid_map) for o in decomp.objects
        ]
        fact_object_links_detail = [
            {
                "fact_uid": fo.fact_uid,
                "object_uid": uid_map.get(fo.object_uid, fo.object_uid),
                "link_type": str(fo.link_type),
                "properties": dict(fo.properties or {}),
            }
            for fo in decomp.fact_object_links
        ]
        fact_fact_links_detail = [
            {
                "from_uid": ff.from_uid,
                "to_uid": ff.to_uid,
                "link_type": str(ff.link_type),
            }
            for ff in decomp.fact_fact_links
        ]

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
