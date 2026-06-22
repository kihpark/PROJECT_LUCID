"""Predicate vocabulary endpoint — spo-pending-ux.

GET /api/predicates

Returns all rows from the `predicates` table ordered by sort_order, code.
No auth required — predicates are global controlled vocabulary.
Used by FactCard predicate autocomplete.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from api.models.predicates import PredicateEntry, PredicatesListResponse
from api.storage.postgres.orm import Predicate
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.routes.predicates")

router = APIRouter(prefix="/api/predicates", tags=["predicates"])


def _new_session() -> Any:
    return make_sessionmaker()()


@router.get("", response_model=PredicatesListResponse)
def list_predicates() -> PredicatesListResponse:
    """Return all predicates ordered by sort_order then code.

    No auth required — predicates are a global controlled vocabulary
    shared across all users and knowledge spaces.
    """
    session = _new_session()
    try:
        rows = (
            session.query(Predicate)
            .order_by(Predicate.sort_order, Predicate.code)
            .all()
        )
        items = [
            PredicateEntry(
                code=row.code,
                label_ko=row.label_ko,
                label_en=row.label_en,
            )
            for row in rows
        ]
        return PredicatesListResponse(items=items)
    finally:
        session.close()
