"""Shared fixtures for Postgres integration tests.

A single session-scoped engine is built once per pytest run; each test
that mutates state opens its own transaction and rolls back on teardown,
so the DB state is reset between tests without re-running migrations.
"""
from __future__ import annotations

import os

import pytest


def _postgres_url() -> str:
    return os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://lucid:lucid@localhost:5432/lucid",
    )


@pytest.fixture(scope="session")
def pg_engine():
    """Session-scoped sync engine. Skips the test if Postgres is unreachable."""
    try:
        from sqlalchemy import create_engine, text
    except ImportError:
        pytest.skip("sqlalchemy not installed")

    url = _postgres_url()
    try:
        engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable at {url}: {exc}")

    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def alembic_upgrade(pg_engine):
    """Run `alembic upgrade head` once for the session."""
    from alembic import command
    from alembic.config import Config

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", str(pg_engine.url))
    command.upgrade(cfg, "head")
    yield cfg
    # Teardown: leave the DB schema as-is so subsequent runs are idempotent.


@pytest.fixture()
def pg_session(pg_engine, alembic_upgrade):
    """Per-test session opened inside a savepoint and rolled back on teardown."""
    from sqlalchemy.orm import sessionmaker

    connection = pg_engine.connect()
    transaction = connection.begin()
    SessionLocal = sessionmaker(bind=connection, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
