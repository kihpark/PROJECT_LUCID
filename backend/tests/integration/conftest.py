"""Shared fixtures for Postgres integration tests.

B-30 — Test database isolation
==============================
Integration tests run against a DEDICATED database (`lucid_test`),
NEVER the dev database (`lucid`). The conftest enforces this by
rewriting the DB name on every URL it constructs — there is no
env-var path that can route tests back to the dev DB.

Root cause this prevents:
  `test_alembic_downgrade_drops_all_tables` runs
  `alembic downgrade base`. On the dev DB that DROPS every table —
  including users / knowledge_spaces / sessions. Every real account
  (including the PO's kihpark85@gmail.com) was being wiped on every
  test run. The downgrade test itself is correct; the bug was that
  it pointed at the wrong database.

A single session-scoped engine is built once per pytest run; tests
that use the pg_session fixture roll back; tests that use the
TestClient `client` fixture commit to the test DB only.
"""
from __future__ import annotations

import os

import pytest

DEV_DB_NAME = "lucid"
TEST_DB_NAME = "lucid_test"


def _force_test_es_index_prefix_env() -> None:
    """Set LUCID_INDEX_PREFIX so every ES index name the backend
    constructs during this test session is prefixed `test_`.
    Mirrors `_force_test_database_url_env`: the override is in place
    BEFORE any fixture runs, so module-level captures of
    LUCID_FACTS / LUCID_OBJECTS / LUCID_SOURCES land on the test
    namespace.
    """
    os.environ["LUCID_INDEX_PREFIX"] = "test_"


_force_test_es_index_prefix_env()


def _force_test_database_url_env() -> None:
    """Rewrite DATABASE_URL in os.environ to point at lucid_test.

    Alembic's env.py reads DATABASE_URL and uses it to override
    sqlalchemy.url from the config. If we left the env var pointing
    at the dev DB, every alembic command (`upgrade`, `downgrade`) would
    silently target the dev DB even though our pg_engine connects to
    lucid_test. test_alembic_downgrade_drops_all_tables would then
    drop the dev DB's tables — the exact bug B-30 is fixing.

    Called at conftest import time so the override is in place before
    ANY test fixture runs.
    """
    from sqlalchemy.engine.url import make_url

    base = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg2://lucid:lucid@localhost:5432/lucid",
    )
    try:
        url = make_url(base)
    except Exception:  # noqa: BLE001
        return
    drivername = url.drivername
    if drivername == "postgresql":
        drivername = "postgresql+psycopg2"
    test_url = url.set(drivername=drivername, database=TEST_DB_NAME)
    os.environ["DATABASE_URL"] = test_url.render_as_string(hide_password=False)


_force_test_database_url_env()


def _make_test_url():
    """Return a SQLAlchemy URL whose database segment is ALWAYS
    `lucid_test`, regardless of DATABASE_URL.

    Returns the URL object (not a string) so the password isn't
    masked when SQLAlchemy renders it for `create_engine`.

    The host/port/credentials are taken from DATABASE_URL (so the
    container picks up its own postgres hostname) but the database
    name is forcibly normalised so a misconfigured env var cannot
    nuke the dev DB.
    """
    from sqlalchemy.engine.url import make_url

    base = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://lucid:lucid@localhost:5432/lucid",
    )
    url = make_url(base)
    # SQLAlchemy 1.4+ make_url keeps the `postgresql://` dialect when
    # env passes the bare form. Normalise back to psycopg2 since
    # that's what requirements.txt pins.
    drivername = url.drivername
    if drivername == "postgresql":
        drivername = "postgresql+psycopg2"
    return url.set(drivername=drivername, database=TEST_DB_NAME)


def _ensure_test_db_exists() -> None:
    """Create `lucid_test` if it doesn't already exist.

    Connects to the admin `postgres` DB to run CREATE DATABASE.
    Idempotent — if the DB exists, this is a no-op. If postgres
    itself is unreachable, raises and the pg_engine fixture skips
    the session like before.
    """
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine.url import make_url

    base = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://lucid:lucid@localhost:5432/lucid",
    )
    url = make_url(base)
    drivername = url.drivername
    if drivername == "postgresql":
        drivername = "postgresql+psycopg2"
    admin_url = url.set(drivername=drivername, database="postgres")
    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": TEST_DB_NAME},
            ).first()
            if not exists:
                # Quote identifier defensively — TEST_DB_NAME is a
                # constant, not user input, so this is double-locked.
                conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    finally:
        admin.dispose()


def _assert_test_db_only(engine) -> None:
    """Belt-and-braces guard. Raise if the engine somehow points at
    the dev DB."""
    if engine.url.database == DEV_DB_NAME:
        raise RuntimeError(
            f"Integration test engine is pointed at the dev database "
            f"({DEV_DB_NAME!r}). The conftest must always rewrite the "
            f"database name to {TEST_DB_NAME!r}. Refusing to run."
        )


@pytest.fixture(scope="session")
def pg_engine():
    """Session-scoped sync engine against the isolated test DB.

    Skips the session if Postgres is unreachable. Auto-creates
    `lucid_test` on first run.
    """
    try:
        from sqlalchemy import create_engine, text
    except ImportError:
        pytest.skip("sqlalchemy not installed")

    try:
        _ensure_test_db_exists()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres admin connection failed: {exc}")

    url = _make_test_url()
    try:
        engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
        _assert_test_db_only(engine)
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

    _assert_test_db_only(pg_engine)

    cfg = Config("alembic.ini")
    # Use render_as_string(hide_password=False) — str(url) masks the
    # password as "***" and alembic would then try to authenticate
    # with the literal string "***".
    cfg.set_main_option(
        "sqlalchemy.url",
        pg_engine.url.render_as_string(hide_password=False),
    )
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
