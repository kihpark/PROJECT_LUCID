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
    s = _structure_meta(job)
    facts = s.get("fact_count", 0)
    objs = s.get("object_count", 0)
    disambig = s.get("object_disambig_pending", 0)
    # Negation indicator: we count facts whose stored structure carried
    # any negation_flag.  Beta keeps this as a coarse boolean — the
    # processor stamps per-fact flags into extracted_metadata.
    negation = any(
        bool(m.get("negation_flag"))
        for m in s.get("facts_summary", []) or []
    )
    return PendingJobSummary(
        job_id=str(job.id),
        source_url=job.source_url,
        source_type=job.source_type,
        captured_at=job.captured_at,
        captured_from=job.captured_from,
        fact_count=facts,
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
        total = len(rows)
        sliced = rows[offset : offset + limit]
        return PendingPage(
            items=[_job_summary(j) for j in sliced],
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
        return PendingJobDetail(
            job_id=str(job.id),
            source_url=job.source_url,
            source_type=job.source_type,
            captured_at=job.captured_at,
            captured_from=job.captured_from,
            knowledge_space_id=str(ks.id),
            extracted_text_preview=(job.extracted_text or "")[:2000],
            facts=s.get("facts_summary", []) or s.get("facts", []),
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

        try:
            from api.storage.elasticsearch.facts import create_fact
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES facts module unavailable: %s", exc)
            create_fact = None  # type: ignore[assignment]

        for d in req.decisions:
            f = facts_by_uid.get(d.fact_uid)
            if f is None:
                logger.info("decide: unknown fact %s in job %s", d.fact_uid, job_id)
                continue
            if d.action == "accept":
                if create_fact is not None:
                    try:
                        node = _coerce_fact_to_factnode(
                            f, edited_claim=None, edited_metadata=None,
                            knowledge_space_id=str(ks.id),
                            validator_id=str(user.id),
                        )
                        create_fact(node, with_embedding=False)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "create_fact failed for %s: %s", d.fact_uid, exc,
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
                if create_fact is not None:
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
                        create_fact(node, with_embedding=False)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "create_fact (edit) failed for %s: %s",
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
