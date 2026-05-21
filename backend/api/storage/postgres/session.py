"""Postgres session helpers.

PR-1A-2 wires up the sync engine + sessionmaker. Async support comes in
Sprint 1B (Auth routes) — the sketch below shows the intended shape so
that migration is mechanical.
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker


def _database_url() -> str:
    """Fetch the Postgres connection string. Used by both runtime and tests."""
    return os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://lucid:lucid@localhost:5432/lucid",
    )


def make_engine() -> Engine:
    """Return a sync SQLAlchemy 2.x engine.

    Called once at startup (via the FastAPI lifespan in Sprint 1B) and at
    test fixture setup. `pool_pre_ping=True` survives idle Postgres
    connections being killed by the connection pooler.
    """
    return create_engine(_database_url(), pool_pre_ping=True)


def make_sessionmaker(engine: Engine | None = None) -> sessionmaker[Session]:
    """Return a sessionmaker bound to the supplied engine (or a fresh one)."""
    if engine is None:
        engine = make_engine()
    return sessionmaker(bind=engine, expire_on_commit=False)


# Future: async wrapper. Add when API routes need it (Sprint 1B).
# Will pair sqlalchemy.ext.asyncio.create_async_engine() with asyncpg.
# Kept as a comment so the import surface stays minimal in PR-1A-2.


def session_scope(engine: Engine | None = None) -> Iterator[Session]:
    """Context-manager style session iterator for ad-hoc scripts and tests."""
    sm = make_sessionmaker(engine)
    session = sm()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
