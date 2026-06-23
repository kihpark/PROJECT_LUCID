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
from urllib.parse import urlparse

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
from api.routes.home import _decide_ready_jobs
from api.security import get_current_user
from api.storage.postgres.orm import GraphNote, KnowledgeSpace, SourceJobORM, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.validate")

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["validate"])

# decide-status-transition: terminal state set after Submit. The home
# brief's _pending_validation_count filters by status='structured', so
# flipping to 'validated' is what makes the "검증 대기" count actually
# drop. DO NOT add 'validated' to the pending-queue filters in
# list_pending / list_disambig — those are decide-ready filters and
# validated rows have already been decided.
VALIDATED_STATUS = "validated"


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


def _hostname_from_url(url: str | None) -> str:
    """Best-effort hostname extraction. Returns the trimmed URL when
    parsing fails so the caller always has *something* renderable."""
    if not url:
        return ""
    try:
        host = urlparse(url).hostname
    except (ValueError, AttributeError):
        return url
    return host or url


def _resolve_title(job: SourceJobORM, hostname: str) -> str:
    """Resolve the human-readable card title with a graceful fallback chain.

    pending-card-title-date: PO complaint was that Pending cards showed
    the hostname ("n.news.naver.com") as the headline. The web_article
    extractor already discovers the `<title>` (and content-script
    `page_title`) and surfaces it on ExtractResult.title; the extract
    processor folds that into `extracted_metadata.title` so this
    function can find it without a schema migration. The chain is
    intentionally generous because older capture rows predate the
    title-persistence change and only carry hostname/body data:

      1. extracted_metadata.title                (post-fix captures)
      2. extracted_metadata.og_title             (open graph fallback)
      3. extracted_metadata.structure.title      (defensive — never set today)
      4. first 60 chars of extracted_metadata.body / structure.body
      5. hostname (legacy behavior, still useful when the article had no <title>)
      6. "(제목 없음)" so the card is never empty
    """
    md = job.extracted_metadata or {}
    structure = md.get("structure") or {}

    raw = (
        md.get("title")
        or md.get("og_title")
        or structure.get("title")
    )
    if isinstance(raw, str):
        title = raw.strip()
        if title:
            return title

    body = (md.get("body") or structure.get("body") or "")
    if isinstance(body, str):
        body_trim = body.strip()
        if body_trim:
            # Take the first non-empty line up to 60 chars so noisy
            # paywall pages don't surface a navbar string.
            first_line = body_trim.split("\n", 1)[0].strip()
            if first_line:
                return first_line[:60]

    if hostname:
        return hostname
    return "(제목 없음)"


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
    hostname = _hostname_from_url(job.source_url)
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
        title=_resolve_title(job, hostname),
        hostname=hostname,
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
    """Return the caller's structured-but-not-yet-validated SourceJobs.

    feat/count-source-unification (2026-06-23): the prefilter
    now flows through `_decide_ready_jobs` from home.py — the
    ONE TRUE FILTER shared with the home brief's
    `pending_validation` field and the AppShell "검증(N)" badge.
    Previously this route filtered `status='structured'` only,
    while the home brief had no fact_count filter and the
    /pending list had its own _job_summary>0 drop — three numbers,
    no agreement.
    """
    session = _new_session()
    try:
        ks = _resolve_space(session, space_id, user)
        query = _decide_ready_jobs(session, user.id, ks.id)
        if source_url:
            query = query.filter(SourceJobORM.source_url == source_url)
        if source_type:
            query = query.filter(SourceJobORM.source_type == source_type)
        if captured_after is not None:
            query = query.filter(SourceJobORM.captured_at >= captured_after)
        if captured_before is not None:
            query = query.filter(SourceJobORM.captured_at < captured_before)

        rows = list(query.all())

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
    source_uid: str | None = None,
) -> FactNode:
    """Build a FactNode from the structure-stage fact summary + user edits.

    B-48a: `source_uid`, when supplied, is seeded into the FactNode's
    source_uids list so the validated fact carries provenance from
    the moment it lands in ES. Callers MUST pass a source_uid in
    production; the optional default exists only to keep legacy
    tests (that don't care about provenance) compiling.
    """
    claim = edited_claim if edited_claim else fact_summary["claim"]
    meta = dict(fact_summary)
    if edited_metadata:
        meta.update(edited_metadata)
    raw_type = meta.get("type") or meta.get("type_") or "proposition"
    try:
        fact_type = FactType(raw_type)
    except ValueError:
        fact_type = FactType.PROPOSITION
    # B-62 structure-resolve: surface canonical fields onto the FactNode
    # so the persisted ES doc carries predicate_code / original_surface
    # / capture_lang / object_canonical / canonical_key / needs_review.
    # When the structure stage did not annotate these (legacy paths),
    # the fields stay None and the recall display path keeps reading
    # the surface fields exactly as before.
    canonical_kwargs: dict[str, Any] = {}
    for canon_field in (
        "predicate_code", "original_surface", "capture_lang",
        "object_canonical", "canonical_key", "predicate_label",
    ):
        if meta.get(canon_field):
            canonical_kwargs[canon_field] = meta[canon_field]
    if meta.get("needs_review"):
        canonical_kwargs["needs_review"] = bool(meta["needs_review"])
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
        source_uids=[source_uid] if source_uid else [],
        negation_flag=bool(meta.get("negation_flag", False)),
        negation_scope=meta.get("negation_scope"),
        **canonical_kwargs,
    )


def _ensure_source_for_job(
    job: SourceJobORM, knowledge_space_id: str,
) -> str | None:
    """B-48a: ensure a lucid_sources doc exists for this SourceJob and
    return its source_uid. Idempotent (URL-keyed dedup).

    Quietly returns None when the ES sources index is unavailable so
    the validate flow falls back to writing facts without provenance
    rather than 500-ing on the user."""
    try:
        from api.storage.elasticsearch.sources import create_or_update_source
    except Exception as exc:  # noqa: BLE001
        logger.warning("ES sources module unavailable: %s", exc)
        return None
    domain = ""
    try:
        from urllib.parse import urlparse
        domain = urlparse(job.source_url).hostname or ""
    except Exception:  # noqa: BLE001
        pass
    try:
        src = create_or_update_source(
            domain=domain,
            source_type=str(job.source_type),
            url=job.source_url,
            knowledge_space_id=knowledge_space_id,
            source_job_id=str(job.id),
            captured_at=job.captured_at.isoformat() if job.captured_at else None,
        )
        return src.get("source_uid")
    except Exception as exc:  # noqa: BLE001
        logger.warning("ensure_source_for_job failed: %s", exc)
        return None


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
        dedup_lookup = None
        attach_source = None
        try:
            from api.storage.elasticsearch.facts import (
                attach_source_to_fact,
                bulk_create_facts,
                find_fact_by_spo,
            )
            bulk_module = bulk_create_facts
            dedup_lookup = find_fact_by_spo
            attach_source = attach_source_to_fact
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES facts module unavailable: %s", exc)

        # B-48a: one source_uid per job (the job's URL → one Source doc).
        source_uid = _ensure_source_for_job(job, str(ks.id))

        pending_nodes: list[Any] = []
        # B-48a: when dedup hits, we don't create a new fact — we push
        # the source_uid onto the existing doc instead. Track these so
        # they happen after the per-fact loop.
        dedup_pushes: list[str] = []  # existing fact_uids to attach source_uid to
        # Within a single submit, two accepts with the same S/P/O
        # should also collapse — track the pending node's S/P/O.
        pending_spo_to_node: dict[tuple[str, str, str], Any] = {}

        def _key(node: Any) -> tuple[str, str, str]:
            return (node.subject_uid, node.predicate, node.object_value)

        def _route_node(node: Any, fact_uid: str) -> None:
            """Decide whether `node` is a fresh insert, a dedup-hit
            against an existing fact, or a collision with a same-submit
            pending node. Mutates `pending_nodes` / `dedup_pushes` /
            `pending_spo_to_node` accordingly."""
            # 1. Same-submit collision: another node already buffered.
            existing_pending = pending_spo_to_node.get(_key(node))
            if existing_pending is not None:
                # Two structure-stage facts collapse to one; the
                # validation_log entries still record both fact_uids
                # for audit, but ES sees a single doc.
                if source_uid and source_uid not in existing_pending.source_uids:
                    existing_pending.source_uids = list(
                        existing_pending.source_uids,
                    ) + [source_uid]
                return
            # 2. ES dedup: an already-validated fact in this KS.
            if dedup_lookup is not None:
                try:
                    existing = dedup_lookup(
                        str(ks.id),
                        node.subject_uid,
                        node.predicate,
                        node.object_value,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("dedup lookup failed for %s: %s", fact_uid, exc)
                    existing = None
                if existing is not None:
                    existing_uid = existing.get("fact_uid")
                    if existing_uid:
                        dedup_pushes.append(existing_uid)
                        return
            # 3. Genuine new fact.
            pending_nodes.append(node)
            pending_spo_to_node[_key(node)] = node

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
                            source_uid=source_uid,
                        )
                        _route_node(node, d.fact_uid)
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
                            source_uid=source_uid,
                        )
                        # The original claim is preserved as an alias so search
                        # still hits the original wording (DR-036).
                        node.aliases = list(node.aliases) + [f["claim"]]
                        _route_node(node, d.fact_uid)
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

        # B-48a: push source_uid onto every dedup-hit fact. One small
        # update per hit — at dogfood scale (≤10 facts per submit, most
        # are fresh) this is negligible; we can batch later if it
        # ever shows up in latency.
        if attach_source is not None and source_uid and dedup_pushes:
            for existing_uid in dedup_pushes:
                try:
                    attach_source(existing_uid, source_uid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "attach_source_to_fact failed for %s: %s",
                        existing_uid, exc,
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

        # decide-status-transition: flip the SourceJob to the terminal
        # 'validated' state so the home brief's "검증 대기" count drops
        # to reflect what the user actually completed.
        #
        # Frontend contract (DecideOverlay.onSubmit): every pending
        # fact carries a default decision (action='accept'), so a
        # single Submit click sends decisions for ALL pending facts on
        # the job. There is no partial-Submit UI today, so reaching
        # this point means the job is fully decided. We still trust
        # the contract rather than counting validation_logs because:
        #   (1) ValidationLogORM has no job_id column — counting back
        #       to a job requires URL+timestamp heuristics that are
        #       fragile under concurrent submits, and
        #   (2) accept-all and discard_job already mark the whole job
        #       'done' implicitly via decided_fact_uids; flipping
        #       status on Submit puts /decide on the same footing.
        _mark_job_validated(job)
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


def _mark_job_validated(job: SourceJobORM) -> None:
    """Flip a SourceJob to the terminal `validated` state.

    Idempotent: re-marking an already-validated job is a no-op (the
    DB CHECK constraint accepts the same value). We DO NOT downgrade
    a job whose status is not 'structured' (defensive: if a future
    flow lands us here with an unexpected status — e.g. a manual DB
    edit — we leave it alone rather than overwrite). The expected
    pre-state is 'structured' or 'validated'.
    """
    if job.status in ("structured", "validated"):
        job.status = VALIDATED_STATUS


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
            from api.storage.elasticsearch.facts import (
                attach_source_to_fact,
                create_fact,
                find_fact_by_spo,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES facts module unavailable for accept-all: %s", exc)
            create_fact = None  # type: ignore[assignment]
            attach_source_to_fact = None  # type: ignore[assignment]
            find_fact_by_spo = None  # type: ignore[assignment]

        # B-48a: one source_uid per job.
        source_uid = _ensure_source_for_job(job, str(ks.id))
        # Track same-submit S/P/O collisions so two pending facts
        # collapse to a single ES doc.
        seen_spo: set[tuple[str, str, str]] = set()

        for fu in pending_fact_uids:
            f = facts_by_uid[fu]
            if create_fact is None:
                continue
            try:
                node = _coerce_fact_to_factnode(
                    f, edited_claim=None, edited_metadata=None,
                    knowledge_space_id=str(ks.id),
                    validator_id=str(user.id),
                    source_uid=source_uid,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("accept-all coerce failed for %s: %s", fu, exc)
                continue
            spo = (node.subject_uid, node.predicate, node.object_value)
            if spo in seen_spo:
                # Already handled in this submit (either an insert or
                # an attach); skip.
                continue
            seen_spo.add(spo)
            # ES dedup against already-validated facts.
            existing_uid: str | None = None
            if find_fact_by_spo is not None:
                try:
                    existing = find_fact_by_spo(
                        str(ks.id), node.subject_uid, node.predicate, node.object_value,
                    )
                    if existing is not None:
                        existing_uid = existing.get("fact_uid")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("accept-all dedup lookup failed for %s: %s", fu, exc)
            if existing_uid and attach_source_to_fact is not None and source_uid:
                try:
                    attach_source_to_fact(existing_uid, source_uid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "accept-all attach_source failed for %s: %s",
                        existing_uid, exc,
                    )
            else:
                try:
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
        # decide-status-transition: accept-all also terminates validation
        # for the job — flip status so the home count drops.
        _mark_job_validated(job)
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
        # decide-status-transition: whole-job discard also terminates
        # validation — flip status so the home count drops.
        _mark_job_validated(job)
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
