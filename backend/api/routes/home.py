"""Home brief — B-55.

A single endpoint that powers the post-login landing surface:

  GET /api/home/brief?space_id=<optional uuid>

The brief is purely a re-arrangement of already-validated state. It
never paraphrases, never generates, never re-runs a model. Every
counter is an Elasticsearch `count` (NOT a scan) plus one bounded
`search` (size=5) and one terms aggregation (size=1). When ES is
unreachable each field degrades to zero/empty so the response shape
is stable.

Resolution rules:
  - If `space_id` is in the query string, resolve + 403/404 just like
    /api/spaces/{space_id}/recall.
  - Otherwise pick the user's earliest-created KnowledgeSpace.
  - A user with no KnowledgeSpace at all is a 404 — the home shell
    is expected to redirect to onboarding before calling this.

pending_validation is sourced from Postgres SourceJobORM (`status =
'structured'`) — that's the "extracted + structured, waiting on the
user to decide" cohort. Other states (pending_extract, extracting,
extracted, structuring) are not yet review-ready; failed states
(*_failed) are not actionable as validations.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from api.models.recall import (
    HomeBrief,
    HomeBriefRecentItem,
    HomeBriefTopCluster,
    HomeBriefTotals,
)
from api.security import get_current_user
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.postgres.orm import KnowledgeSpace, SourceJobORM, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.home")

router = APIRouter(prefix="/api/home", tags=["home"])

# Decide-ready SourceJob statuses. PO directive: "structured" is the
# cohort that has been extracted + structured and is sitting in the
# user's validate queue. Failed states are not "pending" — the user
# would have to retry capture, not validate. Future work can add
# more statuses to this set without touching the response shape.
PENDING_VALIDATION_STATUSES: frozenset[str] = frozenset({"structured"})

# 7-day window for "this week validated" + top cluster. UTC-anchored
# so the answer is deterministic across the user's local timezone
# (the home UI shows it in their local tz; the window itself is
# server-defined).
THIS_WEEK_DAYS = 7
RECENT_VALIDATED_SIZE = 5


def _new_session() -> Any:
    return make_sessionmaker()()


def _resolve_space(
    session: Any, space_id: uuid.UUID, user: User,
) -> KnowledgeSpace:
    """Same auth pattern as recall._resolve_space — 404 on unknown,
    403 when the KS exists but isn't owned by the caller."""
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


def _default_space_for(session: Any, user: User) -> KnowledgeSpace:
    """Earliest-created KS owned by `user`. 404 when the user has
    no KS — the home shell is expected to redirect to onboarding."""
    ks = (
        session.query(KnowledgeSpace)
        .filter(KnowledgeSpace.user_id == user.id)
        .order_by(KnowledgeSpace.created_at.asc())
        .first()
    )
    if ks is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="no_space",
        )
    return ks


def _ks_manual_filters(ks_id: str) -> list[dict[str, Any]]:
    """Stock filter list for `lucid_facts` queries: this KS + manual
    validation only. The home brief never surfaces auto-validated
    rows for the same zero-hallucination reasons as recall."""
    return [
        {"term": {"knowledge_space_id": ks_id}},
        {"term": {"validation_method": "manual"}},
    ]


def _ks_filter(ks_id: str) -> list[dict[str, Any]]:
    """Single-filter helper for objects / sources counts."""
    return [{"term": {"knowledge_space_id": ks_id}}]


def _week_range_filter(now: datetime) -> dict[str, Any]:
    """ES range clause for validated_at >= now - 7d."""
    since = (now - timedelta(days=THIS_WEEK_DAYS)).isoformat()
    return {"range": {"validated_at": {"gte": since}}}


def _safe_count(index: str, filters: list[dict[str, Any]]) -> int:
    """Run an ES count with `bool.filter` — return 0 on any error."""
    body = {"query": {"bool": {"filter": filters}}}
    try:
        client = get_client()
        resp = client.count(index=index, body=body)
        return int(resp.get("count") or 0)
    except Exception as exc:  # noqa: BLE001 - degrade quietly
        logger.warning("home: count failed on %s: %s", index, exc)
        return 0


def _facts_count(ks_id: str) -> int:
    return _safe_count(LUCID_FACTS, _ks_manual_filters(ks_id))


def _entities_count(ks_id: str) -> int:
    return _safe_count(LUCID_OBJECTS, _ks_filter(ks_id))


def _sources_count(ks_id: str) -> int:
    return _safe_count(LUCID_SOURCES, _ks_filter(ks_id))


def _this_week_count(ks_id: str, now: datetime) -> int:
    filters = _ks_manual_filters(ks_id) + [_week_range_filter(now)]
    return _safe_count(LUCID_FACTS, filters)


def _pending_validation_count(
    session: Any, user_id: uuid.UUID, ks_id: uuid.UUID,
) -> int:
    """SourceJobORM rows for this user + KS whose status sits in the
    decide-ready set. Returns 0 on any DB error so a Postgres
    hiccup can't 500 the home shell.
    """
    try:
        return int(
            session.query(SourceJobORM)
            .filter(
                SourceJobORM.user_id == user_id,
                SourceJobORM.knowledge_space_id == ks_id,
                SourceJobORM.status.in_(PENDING_VALIDATION_STATUSES),
            )
            .count()
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("home: pending_validation count failed: %s", exc)
        return 0


def _resolve_subject_labels(
    subject_uids: list[str], ks_id: str,
) -> dict[str, str]:
    """One mget against `lucid_objects` keyed by uid. Returns a
    {uid: name} mapping; uids that don't resolve are simply absent.
    Empty / failure → {}, never raises."""
    if not subject_uids:
        return {}
    uniq = list(dict.fromkeys(subject_uids))  # dedup, preserve order
    try:
        client = get_client()
        resp = client.mget(index=LUCID_OBJECTS, body={"ids": uniq})
    except Exception as exc:  # noqa: BLE001
        logger.warning("home: subject label mget failed: %s", exc)
        return {}
    out: dict[str, str] = {}
    for doc in resp.get("docs", []) or []:
        if not doc.get("found"):
            continue
        src = doc.get("_source") or {}
        if src.get("knowledge_space_id") and src["knowledge_space_id"] != ks_id:
            # Defensive — never leak names from another KS.
            continue
        uid = src.get("object_uid") or doc.get("_id")
        name = src.get("name")
        if uid and name:
            out[uid] = name
    return out


def _recent_validated(
    ks_id: str, now: datetime,
) -> list[HomeBriefRecentItem]:
    """ES search size=5, sort validated_at desc over the last 7 days,
    manual + this KS. Labels are resolved in a single mget so the
    cost is one round-trip regardless of how many rows surface.
    """
    body: dict[str, Any] = {
        "size": RECENT_VALIDATED_SIZE,
        "sort": [{"validated_at": {"order": "desc"}}],
        "query": {
            "bool": {
                "filter": _ks_manual_filters(ks_id) + [_week_range_filter(now)],
            },
        },
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("home: recent_validated search failed: %s", exc)
        return []
    hits = list(resp.get("hits", {}).get("hits") or [])
    if not hits:
        return []

    subject_uids = [
        (h.get("_source") or {}).get("subject_uid", "") for h in hits
    ]
    subject_uids = [u for u in subject_uids if u]
    labels = _resolve_subject_labels(subject_uids, ks_id)

    out: list[HomeBriefRecentItem] = []
    for h in hits:
        src = h.get("_source") or {}
        fact_uid = src.get("fact_uid") or h.get("_id")
        claim = src.get("claim") or ""
        validated_at = src.get("validated_at")
        subject_uid = src.get("subject_uid") or ""
        if not fact_uid or not validated_at:
            continue
        try:
            item = HomeBriefRecentItem(
                fact_uid=str(fact_uid),
                claim=str(claim),
                subject_label=labels.get(subject_uid),
                validated_at=validated_at,
            )
        except (TypeError, ValueError) as exc:
            logger.warning("home: dropping malformed recent fact: %s", exc)
            continue
        out.append(item)
    return out[:RECENT_VALIDATED_SIZE]


def _top_cluster(ks_id: str, now: datetime) -> HomeBriefTopCluster:
    """One terms aggregation over subject_uid (size=1) inside the
    7-day manual window. The winning bucket's uid is resolved via a
    single lucid_objects get; failures collapse to the empty cluster.
    """
    body: dict[str, Any] = {
        "size": 0,
        "query": {
            "bool": {
                "filter": _ks_manual_filters(ks_id) + [_week_range_filter(now)],
            },
        },
        "aggs": {
            "top_subject": {"terms": {"field": "subject_uid", "size": 1}},
        },
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("home: top_cluster aggregation failed: %s", exc)
        return HomeBriefTopCluster()
    buckets = (
        (resp.get("aggregations") or {}).get("top_subject") or {}
    ).get("buckets") or []
    if not buckets:
        return HomeBriefTopCluster()
    top = buckets[0]
    uid = top.get("key")
    count = int(top.get("doc_count") or 0)
    if not uid or count <= 0:
        return HomeBriefTopCluster()

    name: str | None = None
    try:
        client = get_client()
        if client.exists(index=LUCID_OBJECTS, id=uid):
            doc = client.get(index=LUCID_OBJECTS, id=uid)["_source"]
            if doc.get("knowledge_space_id") == ks_id:
                name = doc.get("name")
    except Exception as exc:  # noqa: BLE001
        logger.warning("home: top_cluster name lookup failed: %s", exc)

    return HomeBriefTopCluster(
        entity_uid=str(uid), entity_name=name, linked_count=count,
    )


@router.get("/brief", response_model=HomeBrief)
def home_brief(
    response: Response,
    space_id: uuid.UUID | None = Query(
        default=None,
        description="Optional KS override. Defaults to the user's earliest KS.",
    ),
    user: User = Depends(get_current_user),
) -> HomeBrief:
    """B-55: post-login landing surface.

    Resolves a knowledge_space (query param or user's default),
    then assembles the brief from cheap ES counts + one bounded
    search + one terms aggregation, plus a Postgres count for the
    decide-ready SourceJob cohort.

    Heavy reads — kNN, full-scans, mget over hundreds of ids — are
    forbidden. The endpoint is sized to render in <100ms even on a
    KS with tens of thousands of facts.

    Failure mode: every individual ES call is wrapped in a quiet
    try/except. A complete ES outage produces all-zero counters
    and an empty recent list, with `is_empty=True`, NEVER a 500.
    Auth and KS resolution still raise 401/403/404 normally —
    they're not part of the "degrade quietly" contract.
    """
    session = _new_session()
    try:
        if space_id is not None:
            ks = _resolve_space(session, space_id, user)
        else:
            ks = _default_space_for(session, user)
        ks_id = str(ks.id)
        ks_uuid = ks.id

        now = datetime.now(UTC)

        facts = _facts_count(ks_id)
        entities = _entities_count(ks_id)
        sources = _sources_count(ks_id)
        this_week_validated = _this_week_count(ks_id, now)
        pending = _pending_validation_count(session, user.id, ks_uuid)
    finally:
        session.close()

    recent = _recent_validated(ks_id, now)
    cluster = _top_cluster(ks_id, now)

    totals = HomeBriefTotals(
        facts=facts,
        entities=entities,
        sources=sources,
        this_week_validated=this_week_validated,
    )

    # feat/entity-layer-restore (PO 2026-06-23): the home brief is the
    # nav-badge data source. After a wipe (or any retract / detach)
    # the user MUST see the new totals immediately; a cached response
    # makes the badge lie. Backend is already a fresh DB+ES read on
    # every request, so cache-busting on the response keeps the client
    # honest. `no-store` defeats the browser disk cache; `Pragma`
    # covers older proxies.
    response.headers["Cache-Control"] = (
        "no-store, no-cache, must-revalidate, max-age=0"
    )
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"

    return HomeBrief(
        totals=totals,
        pending_validation=pending,
        recent_validated=recent,
        top_cluster=cluster,
        is_empty=(facts == 0),
    )
