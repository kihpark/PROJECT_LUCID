"""Integration test: alembic up/down + schema introspection.

Requires `docker compose up -d postgres`. Skipped automatically when the
DATABASE_URL is unreachable (see conftest.py).
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


EXPECTED_TABLES = {
    "users",
    "knowledge_spaces",
    "sessions",
    "source_policies",
    "archetype_surveys",
    "graph_notes",
}


def test_alembic_upgrade_creates_all_tables(pg_engine, alembic_upgrade):
    from sqlalchemy import inspect

    insp = inspect(pg_engine)
    tables = set(insp.get_table_names())
    assert EXPECTED_TABLES.issubset(tables), (
        f"missing tables: {EXPECTED_TABLES - tables}"
    )


def test_alembic_upgrade_is_idempotent(pg_engine, alembic_upgrade):
    """Re-running `alembic upgrade head` after the first run is a no-op."""
    from alembic import command

    command.upgrade(alembic_upgrade, "head")  # second invocation
    from sqlalchemy import inspect

    insp = inspect(pg_engine)
    tables = set(insp.get_table_names())
    assert EXPECTED_TABLES.issubset(tables)


def test_knowledge_space_type_check_constraint(pg_engine, alembic_upgrade):
    """`type` CHECK constraint rejects values outside the four allowed."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    with pg_engine.begin() as conn:
        # Create a user first (FK target).
        result = conn.execute(
            text("INSERT INTO users (email) VALUES ('checktest@lucid') RETURNING id")
        )
        user_id = result.scalar()

    try:
        with pg_engine.begin() as conn:
            with pytest.raises(IntegrityError):
                conn.execute(
                    text(
                        "INSERT INTO knowledge_spaces (user_id, type, name) "
                        "VALUES (:u, 'enterprise', 'bad')"
                    ),
                    {"u": user_id},
                )
    finally:
        with pg_engine.begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})


def test_source_policy_check_constraint(pg_engine, alembic_upgrade):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    with pg_engine.begin() as conn:
        result = conn.execute(
            text("INSERT INTO users (email) VALUES ('pol@lucid') RETURNING id")
        )
        user_id = result.scalar()

    try:
        with pg_engine.begin() as conn:
            with pytest.raises(IntegrityError):
                conn.execute(
                    text(
                        "INSERT INTO source_policies (user_id, source_domain, policy) "
                        "VALUES (:u, 'wsj.com', 'maybe')"
                    ),
                    {"u": user_id},
                )
    finally:
        with pg_engine.begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})


def test_alembic_downgrade_drops_all_tables(pg_engine, alembic_upgrade):
    """Run downgrade to base, confirm tables gone, then re-upgrade for other tests."""
    from alembic import command
    from sqlalchemy import inspect

    command.downgrade(alembic_upgrade, "base")
    insp = inspect(pg_engine)
    tables_after = set(insp.get_table_names())
    assert not EXPECTED_TABLES.intersection(tables_after - {"alembic_version"}), (
        f"tables still present after downgrade: "
        f"{EXPECTED_TABLES.intersection(tables_after - {'alembic_version'})}"
    )

    # Restore for the remainder of the session.
    command.upgrade(alembic_upgrade, "head")
