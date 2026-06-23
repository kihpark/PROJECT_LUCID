"""Admin endpoint — retroactive entity class backfill.

POST /api/admin/entities/backfill-class
  Body:
    {
      "ks_id": str | null,     # null -> admin's first KS
      "use_llm": bool = true,  # heuristic-only when false
      "apply": bool = false,   # DRY-RUN by default
    }

Idempotent: skips entities whose class is already set to a non-concept
value. Never deletes anything. Default `apply=false` returns a preview
of what WOULD change without writing.

Wired by `feat/entity-class-backfill`. The lookup-time backfill on the
hot path (`_maybe_backfill_class` in entity_resolver.py) handles future
captures; this route is for the one-shot cleanup of legacy data.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from api.security import require_admin
from api.storage.elasticsearch.client import get_client
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker
from api.structure.entity_reclassifier import run_backfill

logger = logging.getLogger("lucid.routes.admin_entities")

router = APIRouter(
    prefix="/api/admin/entities",
    tags=["admin", "entities"],
)


# Module-level session factory hook — tests rebind this to a test
# sessionmaker (mirrors admin_applications._new_session).
def _new_session():
    return make_sessionmaker()()


class BackfillRequest(BaseModel):
    ks_id: str | None = None
    use_llm: bool = True
    apply: bool = False


class BackfillResponse(BaseModel):
    status: str
    ks_id: str
    applied: bool
    scanned: int
    updated: int
    skipped: int
    by_class: dict[str, int]
    samples: list[dict[str, Any]]


def _resolve_ks_id(admin: User, requested: str | None) -> str:
    """Resolve which KS to target. Explicit ks_id wins; otherwise pick
    the admin's first knowledge_space. Raises 400 when neither path
    yields a ks."""
    if requested:
        return requested
    session = _new_session()
    try:
        ks = session.execute(
            select(KnowledgeSpace.id)
            .where(KnowledgeSpace.user_id == admin.id)
            .order_by(KnowledgeSpace.created_at)
        ).scalars().first()
    finally:
        session.close()
    if ks is None:
        raise HTTPException(400, "no_knowledge_space")
    return str(ks)


@router.post("/backfill-class", response_model=BackfillResponse)
def backfill_class(
    body: BackfillRequest,
    admin: User = Depends(require_admin),
) -> BackfillResponse:
    """Retroactively reclassify legacy concept-stuck entities."""
    ks_id = _resolve_ks_id(admin, body.ks_id)
    client = get_client()

    logger.info(
        "admin_entities.backfill_class: admin=%s ks=%s use_llm=%s apply=%s",
        admin.id, ks_id, body.use_llm, body.apply,
    )

    result = run_backfill(
        client,
        ks_id,
        use_llm=body.use_llm,
        apply=body.apply,
    )

    return BackfillResponse(
        status="ok",
        ks_id=ks_id,
        applied=result["applied"],
        scanned=result["scanned"],
        updated=result["updated"],
        skipped=result["skipped"],
        by_class=result["by_class"],
        samples=result["samples"],
    )
