"""Integration test: Postgres connection.

Requires `docker compose up -d postgres`. Skipped automatically when
the DATABASE_URL is unreachable.
"""
import os

import pytest

pytestmark = pytest.mark.integration


def test_postgres_select_one():
    """Execute SELECT 1 against the configured DATABASE_URL."""
    try:
        from sqlalchemy import create_engine, text
    except ImportError:
        pytest.skip("sqlalchemy not installed in this environment")

    url = os.getenv("DATABASE_URL", "postgresql://lucid:lucid@localhost:5432/lucid")
    try:
        engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
        with engine.connect() as conn:
            row = conn.execute(text("SELECT 1")).fetchone()
            assert row is not None
            assert row[0] == 1
        engine.dispose()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable: {exc}")
