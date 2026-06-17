"""Validate HITL routes — /api/spaces/{space_id}/... (Sprint 4B PR-4B-1).

Endpoint families:

  A. Pending Queue
     GET    /api/spaces/{space_id}/pending
     GET    /api/spaces/{space_id}/pending/{job_id}

  B. Decide (per-fact accept/edit/discard + per-Object resolution)
     POST   /api/spaces/{space_id}/pending/{job_id}/decide
     POST   /api/spaces/{space_id}/pending/{job_id}/accept-all
     POST   /api/spaces/{space_id}/pending/{job_id}/discard

  C. Disambiguation (DCR-001 user-delegated)
     GET    /api/spaces/{space_id}/disambig
     POST   /api/spaces/{space_id}/disambig/{disambig_id}/resolve

  D. Review-mode graph notes (V-2)
     POST   /api/spaces/{space_id}/facts/{fact_uid}/notes
     GET    /api/spaces/{space_id}/facts/{fact_uid}/notes
     DELETE /api/spaces/{space_id}/facts/{fact_uid}/notes/{note_id}

Source of pending data: the structure output stamped into
`SourceJob.extracted_metadata['structure']` by Sprint 3 PR-3-3's
processor. We DO NOT maintain a separate `pending_facts` table —
the JSONB on the source_job row is the canonical staging area until
the user accepts a fact, at which point it is promoted to a real
FactNode document in the `lucid_facts` ES index.

Every decide / resolve / discard action records an anonymized row in
`validation_logs` via `api.metrics.precision.record_validation_decision`.
The full edited claim text never enters validation_logs; only its
length lands there (DR-036 puts the edit history on lucid_facts).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from api.metrics.precision import record_validation_decision
from api.models.facts import FactNode, FactType
from api.models.validate import (
    DecideRequest,
    DecideResponse,
    DisambigEntry,
    DisambigResolveRequest,
    GraphNoteCreateRequest,
    GraphNoteResponse,
    PendingJobDetail,
    PendingJobSummary,
    PendingPage,
)
from api.security import get_current_user
from api.storage.postgres.orm import GraphNote, KnowledgeSpace, SourceJobORM, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.validate")

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["validate"])


def _new_session():
    return make_sessionmaker()()


def _resolve_space(session, space_id: uuid.UUID, user: User) -> KnowledgeSpace:
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


def _resolve_job(session, job_id: uuid.UUID, ks: KnowledgeSpace) -> SourceJobORM:
    job = session.get(SourceJobORM, job_id)
    if job is None or job.knowledge_space_id != ks.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="job_not_found",
        )
    return job


def _structure_meta(job: SourceJobORM) -> dict[str, Any]:
    return (job.extracted_metadata or {}).get("structure", {}) or {}


def _job_summary(job: SourceJobORM) -> PendingJobSummary:
    """Build the list-card summary.

    B-29 defect 1: `fact_count` here means the PENDING fact count
    (total facts emitted by the decomposer minus those already
    accepted/edited/discarded), NOT the all-time decomposer count.
    The pre-B-29 implementation used the raw `fact_count` from the
    structure metadata, which is the count at extraction time. After
    the user finishes a Decide pass it never decreased, so the list
    card showed "facts 12" for a job whose Decide detail view
    correctly showed "0 pending fact(s)". List and detail now agree:
    the list card's number IS the post-decided pending count, which
    is the same number the Decide overlay renders one click later.
    """
    s = _structure_meta(job)
    total_facts: int = s.get("fact_count", 0)
    facts_summary: list[dict[str, Any]] = s.get("facts_summary") or s.get("facts") or []
    decided: set[str] = set(s.get("decided_fact_uids") or [])
    if decided:
        pending_count = sum(
            1
            for m in facts_summary
            if (m.get("fact_uid") or m.get("uid")) not in decided
        )
    else:
        pending_count = total_facts
    objs = s.get("object_count", 0)
    disambig = s.get("object_disambig_pending", 0)
    # Negation indicator only counts PENDING facts now — a job whose
    # only negated fact was already decided no longer wears the ⚠
    # badge on the list.
    negation = any(
        bool(m.get("negation_flag"))
        for m in facts_summary
        if (m.get("fact_uid") or m.get("uid")) not in decided
    )
    return PendingJobSummary(
        job_id=str(job.id),
        source_url=job.source_url,
        source_type=job.source_type,
        captured_at=job.captured_at,
        captured_from=job.captured_from,
        fact_count=pending_count,
        object_count=objs,
        has_negation=negation,
        has_disambiguation=disambig > 0,
    )


# ===========================================================================
# A. Pending Queue
# ===========================================================================

@router.get("/pending", response_model=PendingPage)
def list_pending(
    space_id: uuid.UUID,
    source_url: str | None = Query(default=None),
    source_type: str | None = Query(default=None),
    captured_after: datetime | None = Query(default=None),
    captured_before: datetime | None = Query(default=None),
    has_negation_flag: bool | None = Query(default=None),
    has_disambiguation: bool | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
) -> PendingPage:
    """Return the caller's structured-but-not-yet-validated SourceJobs."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        stmt = (
            select(SourceJobORM)
            .where(SourceJobORM.knowledge_space_id == ks.id)
            .where(SourceJobORM.status == "structured")
        )
        if source_url:
            stmt = stmt.where(SourceJobORM.source_url == source_url)
        if source_type:
            stmt = stmt.where(SourceJobORM.source_type == source_type)
        if captured_after is not None:
            stmt = stmt.where(SourceJobORM.captured_at >= captured_after)
        if captured_before is not None:
            stmt = stmt.where(SourceJobORM.captured_at < captured_before)

        rows = list(session.scalars(stmt).all())

        # The has_negation / has_disambiguation filters require a peek
        # at extracted_metadata which is per-row JSONB — apply after fetch.
        if has_disambiguation is not None:
            rows = [
                j for j in rows
                if (_structure_meta(j).get("object_disambig_pending", 0) > 0)
                == has_disambiguation
            ]
        if has_negation_flag is not None:
            rows = [
                j for j in rows
                if any(
                    bool(m.get("negation_flag"))
                    for m in (_structure_meta(j).get("facts_summary") or [])
                ) == has_negation_flag
            ]

        # Sort: captured_at desc (the spec default).
        rows.sort(key=lambda j: j.captured_at, reverse=True)

        # B-29: build summaries first so we can drop fully-decided
        # (or never-had-any-facts) jobs from the queue. The PO
        # directive: "facts 0 빈 카드를 큐에 쌓지 말 것" applies to both
        # the empty-duplicate case (defect 3) and the all-decided case.
        # The drop happens AFTER filters and AFTER sorting but BEFORE
        # pagination so the `total` reflects what the user can actually
        # act on.
        summaries = [_job_summary(j) for j in rows]
        summaries = [s for s in summaries if s.fact_count > 0]

        total = len(summaries)
        sliced = summaries[offset : offset + limit]
        return PendingPage(
            items=sliced,
            total=total, offset=offset, limit=limit,
        )
    finally:
        session.close()


@router.get("/pending/{job_id}", response_model=PendingJobDetail)
def get_pending_detail(
    space_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> PendingJobDetail:
    """Return the full structure decomposition for one SourceJob."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        job = _resolve_job(session, job_id, ks)
        s = _structure_meta(job)
        decided = set(s.get("decided_fact_uids") or [])
        all_facts: list[dict[str, Any]] = (
            s.get("facts_summary", []) or s.get("facts", []) or []
        )
        pending_facts = [
            f for f in all_facts
            if (f.get("fact_uid") or f.get("uid")) not in decided
        ]
        return PendingJobDetail(
            job_id=str(job.id),
            source_url=job.source_url,
            source_type=job.source_type,
            captured_at=job.captured_at,
            captured_from=job.captured_from,
            knowledge_space_id=str(ks.id),
            extracted_text_preview=(job.extracted_text or "")[:2000],
            facts=pending_facts,
            decided_fact_uids=sorted(decided),
            objects=s.get("objects_summary", []) or s.get("objects", []),
            fact_object_links=s.get("fact_object_links_detail", []),
            fact_fact_links=s.get("fact_fact_links_detail", []),
            disambiguation_pending=s.get("disambiguation_pending", []),
        )
    finally:
        session.close()


# ===========================================================================
# B. Decide
# ===========================================================================

def _upsert_referenced_objects(
    nodes: list[Any],
    *,
    meta: dict[str, Any],
    knowledge_space_id: str,
) -> None:
    """Index every Object referenced by `nodes` into lucid_objects.

    Idempotent: ES doc id is `object_uid`, so re-running on the same
    nodes overwrites with the same payload. Only entity-shape refs
    qualify — literals on object_value are skipped via the same
    regex the recall route uses.
    """
    import re

    from api.models.objects import Object, ObjectClass
    from api.storage.elasticsearch.objects import create_object

    struct = meta.get("structure") or {}
    objects_by_uid: dict[str, dict[str, Any]] = {}
    for o in struct.get("objects") or []:
        uid = o.get("uid") or o.get("object_uid")
        if uid:
            objects_by_uid[uid] = o

    if not objects_by_uid:
        return

    OBJECT_REF_RE = re.compile(
        r"^(?:obj-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
        re.IGNORECASE,
    )

    seen: set[str] = set()
    for node in nodes:
        candidates = [getattr(node, "subject_uid", None)]
        ov = getattr(node, "object_value", None)
        if isinstance(ov, str) and OBJECT_REF_RE.match(ov):
            candidates.append(ov)
        for uid in candidates:
            if not uid or uid in seen:
                continue
            seen.add(uid)
            src = objects_by_uid.get(uid)
            if src is None:
                continue
            try:
                cls_value = src.get("class") or src.get("class_") or "concept"
                cls = ObjectClass(cls_value) if not isinstance(
                    cls_value, ObjectClass
                ) else cls_value
            except ValueError:
                cls = ObjectClass.CONCEPT
            try:
                obj = Object.model_validate(
                    {
                        "object_uid": uid,
                        "class": cls,
                        "name": src.get("name") or uid,
                        "name_en": src.get("name_en"),
                        "properties": src.get("properties") or {},
                        "knowledge_space_id": knowledge_space_id,
                    },
                )
                create_object(obj, with_embedding=False)
            except Exception as exc:  # noqa: BLE001 - keep going
                logger.warning(
                    "B-41: upsert object %s failed: %s", uid, exc,
                )


def _coerce_fact_to_factnode(
    fact_summary: dict[str, Any],
    *,
    edited_claim: str | None,
    edited_metadata: dict[str, Any] | None,
    knowledge_space_id: str,
    validator_id: str,
) -> FactNode:
    """Build a FactNode from the structure-stage fact summary + user edits."""
    claim = edited_claim if edited_claim else fact_summary["claim"]
    meta = dict(fact_summary)
    if edited_metadata:
        meta.update(edited_metadata)
    raw_type = meta.get("type") or meta.get("type_") or "proposition"
    try:
        fact_type = FactType(raw_type)
    except ValueError:
        fact_type = FactType.PROPOSITION
    return FactNode(
        fact_uid=meta["fact_uid"] if "fact_uid" in meta else meta["uid"],
        claim=claim,
        type=fact_type,
        subject_uid=meta.get("subject_uid") or "unknown",
        predicate=meta.get("predicate") or "claim",
        object_value=meta.get("object_value") or "",
        validation_method="manual",
        validator_id=validator_id,
        knowledge_space_id=knowledge_space_id,
        negation_flag=bool(meta.get("negation_flag", False)),
        negation_scope=meta.get("negation_scope"),
    )


def _facts_index(meta: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """fact_uid -> fact summary dict from the structure metadata."""
    out: dict[str, dict[str, Any]] = {}
    for f in (meta.get("facts_summary") or meta.get("facts") or []):
        key = f.get("fact_uid") or f.get("uid")
        if key:
            out[key] = f
    return out


@router.post("/pending/{job_id}/decide", response_model=DecideResponse)
def decide(
    space_id: uuid.UUID,
    job_id: uuid.UUID,
    req: DecideRequest,
    user: User = Depends(get_current_user),
) -> DecideResponse:
    """Apply the user's per-fact / per-Object decisions to the graph."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        job = _resolve_job(session, job_id, ks)
        meta = _structure_meta(job)
        facts_by_uid = _facts_index(meta)

        accepted: list[str] = []
        edited: list[str] = []
        discarded: list[str] = []
        log_count = 0

        # B-40 defect 3: collect FactNodes to bulk-index in one ES call
        # at the end of the per-fact loop. This drops Submit latency
        # from "1 HTTP+refresh per fact" to "1 HTTP+refresh for the
        # whole submission". validation_logs writes stay inline since
        # they're cheap Postgres inserts.
        bulk_module = None
        try:
            from api.storage.elasticsearch.facts import bulk_create_facts
            bulk_module = bulk_create_facts
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES facts module unavailable: %s", exc)

        pending_nodes: list[Any] = []

        for d in req.decisions:
            f = facts_by_uid.get(d.fact_uid)
            if f is None:
                logger.info("decide: unknown fact %s in job %s", d.fact_uid, job_id)
                continue
            if d.action == "accept":
                if bulk_module is not None:
                    try:
                        node = _coerce_fact_to_factnode(
                            f, edited_claim=None, edited_metadata=None,
                            knowledge_space_id=str(ks.id),
                            validator_id=str(user.id),
                        )
                        pending_nodes.append(node)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "coerce(accept) failed for %s: %s", d.fact_uid, exc,
                        )
                accepted.append(d.fact_uid)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=d.fact_uid,
                    object_uid=None, action="accept",
                )
                log_count += 1
            elif d.action == "edit":
                if not d.edited_claim:
                    raise HTTPException(
                        status_code=400,
                        detail=f"edit on {d.fact_uid} requires edited_claim",
                    )
                if bulk_module is not None:
                    try:
                        node = _coerce_fact_to_factnode(
                            f, edited_claim=d.edited_claim,
                            edited_metadata=d.edited_metadata,
                            knowledge_space_id=str(ks.id),
                            validator_id=str(user.id),
                        )
                        # The original claim is preserved as an alias so search
                        # still hits the original wording (DR-036).
                        node.aliases = list(node.aliases) + [f["claim"]]
                        pending_nodes.append(node)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "coerce(edit) failed for %s: %s",
                            d.fact_uid, exc,
                        )
                edited.append(d.fact_uid)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=d.fact_uid,
                    object_uid=None, action="edit",
                    edited_claim_len=len(d.edited_claim),
                )
                log_count += 1
            else:  # discard
                discarded.append(d.fact_uid)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=d.fact_uid,
                    object_uid=None, action="discard",
                )
                log_count += 1

        # Single ES round-trip for all accept + edit nodes.
        if bulk_module is not None and pending_nodes:
            try:
                bulk_module(pending_nodes, with_embedding=False)
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "bulk_create_facts failed (%d nodes): %s",
                    len(pending_nodes), exc,
                )

        # B-41 P0: mirror the related Objects into lucid_objects so the
        # recall label lookup can resolve canonical UUIDs to names.
        # `objects` lives on the structure metadata under canonical
        # uids (B-35 + B-37 serialiser); we just copy each one over.
        if pending_nodes:
            try:
                _upsert_referenced_objects(
                    pending_nodes,
                    meta=meta,
                    knowledge_space_id=str(ks.id),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "B-41: upsert_referenced_objects failed: %s", exc,
                )

        created_objs: list[str] = []
        merged_objs: list[str] = []
        skipped_objs: list[str] = []
        for o in req.object_decisions:
            if o.action == "create_new":
                created_objs.append(o.candidate_id)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=o.candidate_id, action="create_new",
                )
                log_count += 1
            elif o.action == "merge_with":
                if not o.merge_target_uid:
                    raise HTTPException(
                        status_code=400,
                        detail=f"merge_with on {o.candidate_id} requires merge_target_uid",
                    )
                merged_objs.append(o.candidate_id)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=o.candidate_id, action="merge_with",
                    decision_metadata={"merge_target_uid": o.merge_target_uid},
                )
                log_count += 1
            else:  # skip
                skipped_objs.append(o.candidate_id)
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=o.candidate_id, action="skip",
                )
                log_count += 1

        # Surface progress on the SourceJob row so the UI can hide
        # already-decided facts on the next fetch.
        meta_out = dict(job.extracted_metadata or {})
        s = dict(meta_out.get("structure") or {})
        decided = set(s.get("decided_fact_uids") or [])
        decided.update(accepted + edited + discarded)
        s["decided_fact_uids"] = sorted(decided)
        s["last_decided_at"] = datetime.utcnow().isoformat()
        meta_out["structure"] = s
        job.extracted_metadata = meta_out
        session.commit()

        return DecideResponse(
            accepted_facts=accepted,
            edited_facts=edited,
            discarded_facts=discarded,
            created_objects=created_objs,
            merged_objects=merged_objs,
            skipped_objects=skipped_objs,
            validation_log_count=log_count,
        )
    finally:
        session.close()


@router.post("/pending/{job_id}/accept-all", response_model=DecideResponse)
def accept_all(
    space_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> DecideResponse:
    """Quick path — accept every PendingFact on this job in one shot."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        job = _resolve_job(session, job_id, ks)
        meta = _structure_meta(job)
        facts_by_uid = _facts_index(meta)
        already_decided = set(meta.get("decided_fact_uids") or [])
        pending_fact_uids = [u for u in facts_by_uid if u not in already_decided]

        try:
            from api.storage.elasticsearch.facts import create_fact
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES facts module unavailable for accept-all: %s", exc)
            create_fact = None  # type: ignore[assignment]

        for fu in pending_fact_uids:
            f = facts_by_uid[fu]
            if create_fact is not None:
                try:
                    node = _coerce_fact_to_factnode(
                        f, edited_claim=None, edited_metadata=None,
                        knowledge_space_id=str(ks.id),
                        validator_id=str(user.id),
                    )
                    create_fact(node, with_embedding=False)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("accept-all create_fact failed for %s: %s", fu, exc)

        record_validation_decision(
            session, user_id=user.id, validator_id=user.id,
            source_job_id=job.id, fact_uid=None, object_uid=None,
            action="accept_all",
            decision_metadata={"fact_count": len(pending_fact_uids)},
        )

        meta_out = dict(job.extracted_metadata or {})
        s = dict(meta_out.get("structure") or {})
        decided = set(s.get("decided_fact_uids") or [])
        decided.update(pending_fact_uids)
        s["decided_fact_uids"] = sorted(decided)
        s["last_decided_at"] = datetime.utcnow().isoformat()
        meta_out["structure"] = s
        job.extracted_metadata = meta_out
        session.commit()

        return DecideResponse(
            accepted_facts=pending_fact_uids,
            validation_log_count=1,
        )
    finally:
        session.close()


@router.post("/pending/{job_id}/discard", response_model=DecideResponse)
def discard_job(
    space_id: uuid.UUID,
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> DecideResponse:
    """Discard the entire job's PendingFacts / disambig in one shot."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        job = _resolve_job(session, job_id, ks)
        meta = _structure_meta(job)
        facts_by_uid = _facts_index(meta)
        already_decided = set(meta.get("decided_fact_uids") or [])
        pending = [u for u in facts_by_uid if u not in already_decided]

        record_validation_decision(
            session, user_id=user.id, validator_id=user.id,
            source_job_id=job.id, fact_uid=None, object_uid=None,
            action="discard_job",
            decision_metadata={"fact_count": len(pending)},
        )

        meta_out = dict(job.extracted_metadata or {})
        s = dict(meta_out.get("structure") or {})
        decided = set(s.get("decided_fact_uids") or [])
        decided.update(pending)
        s["decided_fact_uids"] = sorted(decided)
        s["job_discarded"] = True
        s["last_decided_at"] = datetime.utcnow().isoformat()
        meta_out["structure"] = s
        job.extracted_metadata = meta_out
        session.commit()

        return DecideResponse(
            discarded_facts=pending,
            validation_log_count=1,
        )
    finally:
        session.close()


# ===========================================================================
# C. Disambig
# ===========================================================================

def _disambig_entries_for_job(job: SourceJobORM) -> list[DisambigEntry]:
    s = _structure_meta(job)
    out: list[DisambigEntry] = []
    for entry in s.get("disambiguation_pending") or []:
        llm_uid = entry.get("llm_uid") or entry.get("candidate_id") or ""
        out.append(DisambigEntry(
            disambig_id=f"{job.id}:{llm_uid}",
            job_id=str(job.id),
            candidate_name=entry.get("candidate_name") or entry.get("name") or "",
            decision_reason=entry.get("decision_reason") or "",
            candidates=entry.get("candidates") or [],
        ))
    return out


@router.get("/disambig", response_model=list[DisambigEntry])
def list_disambig(
    space_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> list[DisambigEntry]:
    """All PendingDisambig entries across the caller's structured jobs."""
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        rows = list(session.scalars(
            select(SourceJobORM)
            .where(SourceJobORM.knowledge_space_id == ks.id)
            .where(SourceJobORM.status == "structured")
        ).all())
        out: list[DisambigEntry] = []
        for j in rows:
            out.extend(_disambig_entries_for_job(j))
        return out
    finally:
        session.close()


@router.post("/disambig/{disambig_id}/resolve", response_model=DecideResponse)
def resolve_disambig(
    space_id: uuid.UUID,
    disambig_id: str,
    req: DisambigResolveRequest,
    user: User = Depends(get_current_user),
) -> DecideResponse:
    """Apply the user's choice on a single PendingDisambig entry."""
    if ":" not in disambig_id:
        raise HTTPException(status_code=400, detail="invalid disambig_id")
    job_id_s, _, llm_uid = disambig_id.partition(":")
    try:
        job_id = uuid.UUID(job_id_s)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="invalid disambig_id job uuid",
        ) from exc

    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        job = _resolve_job(session, job_id, ks)
        meta = _structure_meta(job)

        resolved: list[str] = []
        kept: list[str] = []
        for entry in list(meta.get("disambiguation_pending") or []):
            if (entry.get("llm_uid") or entry.get("candidate_id")) != llm_uid:
                kept.append(entry)
                continue
            if req.action == "merge_with":
                if not req.merge_target_uid:
                    raise HTTPException(
                        status_code=400, detail="merge_target_uid required",
                    )
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=llm_uid, action="merge_with",
                    decision_metadata={"merge_target_uid": req.merge_target_uid},
                )
                resolved.append(llm_uid)
            elif req.action == "create_new":
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=llm_uid, action="create_new",
                )
                resolved.append(llm_uid)
            else:  # skip
                record_validation_decision(
                    session, user_id=user.id, validator_id=user.id,
                    source_job_id=job.id, fact_uid=None,
                    object_uid=llm_uid, action="skip",
                )
                kept.append(entry)

        # Rewrite the JSONB so resolved disambig vanish from the queue.
        meta_out = dict(job.extracted_metadata or {})
        s = dict(meta_out.get("structure") or {})
        s["disambiguation_pending"] = kept
        s["object_disambig_pending"] = len(kept)
        meta_out["structure"] = s
        job.extracted_metadata = meta_out
        session.commit()

        return DecideResponse(
            created_objects=[llm_uid] if req.action == "create_new" else [],
            merged_objects=[llm_uid] if req.action == "merge_with" else [],
            skipped_objects=[llm_uid] if req.action == "skip" else [],
            validation_log_count=1,
        )
    finally:
        session.close()


# ===========================================================================
# D. Graph notes (Review mode)
# ===========================================================================

@router.post("/facts/{fact_uid}/notes", response_model=GraphNoteResponse,
             status_code=status.HTTP_201_CREATED)
def create_note(
    space_id: uuid.UUID,
    fact_uid: str,
    req: GraphNoteCreateRequest,
    user: User = Depends(get_current_user),
) -> GraphNoteResponse:
    """Attach a personal note to a fact_uid."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
        n = GraphNote(fact_uid=fact_uid, user_id=user.id, note=req.note)
        session.add(n)
        session.commit()
        session.refresh(n)
        return GraphNoteResponse(
            id=str(n.id), fact_uid=n.fact_uid, note=n.note or "",
            created_at=n.created_at, updated_at=n.updated_at,
        )
    finally:
        session.close()


@router.get("/facts/{fact_uid}/notes", response_model=list[GraphNoteResponse])
def list_notes(
    space_id: uuid.UUID,
    fact_uid: str,
    user: User = Depends(get_current_user),
) -> list[GraphNoteResponse]:
    """All notes on a fact, oldest first."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
        rows = list(session.scalars(
            select(GraphNote)
            .where(GraphNote.fact_uid == fact_uid)
            .where(GraphNote.user_id == user.id)
            .order_by(GraphNote.created_at.asc())
        ).all())
        return [
            GraphNoteResponse(
                id=str(r.id), fact_uid=r.fact_uid, note=r.note or "",
                created_at=r.created_at, updated_at=r.updated_at,
            )
            for r in rows
        ]
    finally:
        session.close()


@router.delete(
    "/facts/{fact_uid}/notes/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_note(
    space_id: uuid.UUID,
    fact_uid: str,
    note_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> None:
    """Delete one note. 404 if missing or owned by a different user."""
    session = _new_session()
    try:
        _resolve_space(session, space_id, user)
        n = session.get(GraphNote, note_id)
        if n is None or n.user_id != user.id or n.fact_uid != fact_uid:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="note_not_found",
            )
        session.delete(n)
        session.commit()
        return None
    finally:
        session.close()
