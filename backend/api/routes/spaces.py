"""KnowledgeSpace routes — /api/spaces (Sprint 1B).

Endpoints:
  GET    /api/spaces/me              List spaces owned by the caller
  GET    /api/spaces/{sid}            Detail (must be owned by caller)
  PATCH  /api/spaces/{sid}            Update name (beta locks `type` as
                                      'personal'; team/policy/public
                                      blocked at API layer per DR-054)

Future expansions (Sprint 4 / Stellar) land at /api/spaces/{sid}/...
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from api.models.auth import KnowledgeSpacePublic, UpdateSpaceRequest
from api.security import get_current_user
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker

router = APIRouter(prefix="/api/spaces", tags=["spaces"])


def _new_session():
    return make_sessionmaker()()


def _to_public(ks: KnowledgeSpace) -> KnowledgeSpacePublic:
    return KnowledgeSpacePublic(
        id=str(ks.id),
        type=ks.type,  # type: ignore[arg-type]  # ORM string -> Pydantic Literal coerced
        name=ks.name,
        user_id=str(ks.user_id),
    )


@router.get("/me", response_model=list[KnowledgeSpacePublic])
def list_my_spaces(user: User = Depends(get_current_user)) -> list[KnowledgeSpacePublic]:
    """Return every space owned by the authenticated user."""
    session = _new_session()
    try:
        rows = (
            session.query(KnowledgeSpace)
            .filter(KnowledgeSpace.user_id == user.id)
            .all()
        )
        return [_to_public(ks) for ks in rows]
    finally:
        session.close()


@router.get("/{space_id}", response_model=KnowledgeSpacePublic)
def get_space(
    space_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> KnowledgeSpacePublic:
    """Fetch one space by id. 404 if unknown; 403 if not owned by caller."""
    session = _new_session()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return _to_public(ks)
    finally:
        session.close()


@router.patch("/{space_id}", response_model=KnowledgeSpacePublic)
def update_space(
    space_id: uuid.UUID,
    req: UpdateSpaceRequest,
    user: User = Depends(get_current_user),
) -> KnowledgeSpacePublic:
    """Update a space. Beta locks `type`; only `name` is editable."""
    session = _new_session()
    try:
        ks = session.get(KnowledgeSpace, space_id)
        if ks is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="space_not_found")
        if ks.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")

        if req.name is not None:
            ks.name = req.name
        session.commit()
        session.refresh(ks)
        return _to_public(ks)
    finally:
        session.close()
