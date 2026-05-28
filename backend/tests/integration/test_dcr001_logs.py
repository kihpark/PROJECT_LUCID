"""Integration: alembic 0007 + 0008 + ORM CRUD for DCR-001 tables."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


EXPECTED_DCR001_TABLES = {
    "disambiguation_logs",
    "precision_logs",
    "negation_logs",
    "contradiction_logs",
}


def test_alembic_0007_and_0008_create_dcr001_tables(pg_engine, alembic_upgrade):
    from sqlalchemy import inspect
    insp = inspect(pg_engine)
    tables = set(insp.get_table_names())
    assert EXPECTED_DCR001_TABLES.issubset(tables), (
        f"missing: {EXPECTED_DCR001_TABLES - tables}"
    )


def test_disambiguation_log_check_constraint(pg_engine, alembic_upgrade):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    with pg_engine.begin() as conn:
        uid = conn.execute(
            text("INSERT INTO users (email) VALUES ('dcr@lucid') RETURNING id")
        ).scalar()
    try:
        with pg_engine.begin() as conn:
            with pytest.raises(IntegrityError):
                conn.execute(
                    text(
                        "INSERT INTO disambiguation_logs "
                        "(user_id, fact_uid, mention_text, resolved_to_uid, decision_method) "
                        "VALUES (:u, 'fn-x', 'Apple', NULL, 'invalid')"
                    ),
                    {"u": uid},
                )
    finally:
        with pg_engine.begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": uid})


def test_precision_log_check_constraint(pg_engine, alembic_upgrade):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    with pg_engine.begin() as conn:
        uid = conn.execute(
            text("INSERT INTO users (email) VALUES ('precc@lucid') RETURNING id")
        ).scalar()
    try:
        with pg_engine.begin() as conn:
            with pytest.raises(IntegrityError):
                conn.execute(
                    text(
                        "INSERT INTO precision_logs (user_id, fact_uid, decision) "
                        "VALUES (:u, 'fn-y', 'maybe')"
                    ),
                    {"u": uid},
                )
    finally:
        with pg_engine.begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = :u"), {"u": uid})


def test_metric_recorders_round_trip(pg_session):
    """The 3 metric helpers persist anonymized rows and cascade with user."""
    import uuid as _uuid

    from api.metrics import (
        record_contradiction_confirmation,
        record_negation_correction,
        record_validate_decision,
    )
    from api.storage.postgres.orm import (
        ContradictionLog,
        NegationLog,
        PrecisionLog,
        User,
    )

    u = User(email="metrics-recorder@lucid.example")
    pg_session.add(u)
    pg_session.flush()

    pid = record_validate_decision(
        pg_session, user_id=u.id, fact_uid="fn-metric-1", decision="accept"
    )
    nid = record_negation_correction(
        pg_session,
        user_id=u.id,
        fact_uid="fn-metric-1",
        ai_negation_flag=True,
        user_corrected_flag=True,
        ai_scope="partial",
        user_corrected_scope="full",
    )
    cid = record_contradiction_confirmation(
        pg_session,
        user_id=u.id,
        pair_uid="pair-1",
        pattern="A",
        user_confirmed=True,
    )

    assert pg_session.get(PrecisionLog, pid).decision == "accept"
    assert pg_session.get(NegationLog, nid).user_corrected_scope == "full"
    assert pg_session.get(ContradictionLog, cid).user_confirmed is True


def test_disambiguation_log_fk_cascade(pg_session):
    """Deleting a user cascades to its disambiguation_logs rows."""
    from api.storage.postgres.orm import DisambiguationLog, User

    u = User(email="cascade@lucid.example")
    pg_session.add(u)
    pg_session.flush()

    pg_session.add(
        DisambiguationLog(
            user_id=u.id,
            fact_uid="fn-cascade",
            mention_text="Apple",
            resolved_to_uid=None,
            decision_method="new",
        )
    )
    pg_session.flush()
    pg_session.delete(u)
    pg_session.flush()
    pg_session.expire_all()
    rows = (
        pg_session.query(DisambiguationLog)
        .filter(DisambiguationLog.fact_uid == "fn-cascade")
        .all()
    )
    assert rows == []
