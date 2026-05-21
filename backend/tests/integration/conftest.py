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


# --- ES fixtures (added by PR-1A-3) ----------------------------------

@pytest.fixture(scope="session")
def es_client():
    """Session-scoped ES client. Skips the session if ES is unreachable."""
    try:
        from elasticsearch import Elasticsearch
    except ImportError:
        pytest.skip("elasticsearch not installed")

    import os

    url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    try:
        c = Elasticsearch(url, request_timeout=5, verify_certs=False)
        if not c.ping():
            pytest.skip(f"Elasticsearch not reachable at {url}")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Elasticsearch not reachable: {exc}")

    yield c
    c.close()


@pytest.fixture(scope="session")
def es_indexes(es_client):
    """Recreate the three ES indexes once per session."""
    from api.storage.elasticsearch import indexes
    from api.storage.elasticsearch.client import reset_client

    reset_client()
    indexes.delete_indexes()
    indexes.create_indexes()
    yield
    indexes.delete_indexes()


@pytest.fixture()
def fake_embedding(monkeypatch):
    """Replace get_embedding with a deterministic fake (1536-dim 0.5 vec).

    Use this in any test that creates a Fact or Object so the OpenAI
    call is mocked. Returns a tuple (hashable for the LRU cache).
    """
    from api.storage.elasticsearch import embeddings

    fake = tuple([0.5] * 1536)
    monkeypatch.setattr(embeddings, "get_embedding", lambda text: fake if text and text.strip() else None)
    # Also patch the symbol where each module imported it:
    from api.storage.elasticsearch import facts as facts_mod
    from api.storage.elasticsearch import objects as objects_mod
    monkeypatch.setattr(facts_mod, "get_embedding", lambda text: fake if text and text.strip() else None)
    monkeypatch.setattr(objects_mod, "get_embedding", lambda text: fake if text and text.strip() else None)
    return fake
