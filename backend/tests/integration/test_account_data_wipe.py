"""Integration tests for the account-data-wipe script (PR feat/account-data-wipe).

Seeds a user (+ KS + UserSettings via the conftest helper) plus a
source_job, a graph_note, and a fact in ES. Drives the script via its
public `run()` entry point (refactored out of `main()` for testability),
then asserts on the post-state in PG and ES.

Every test uses the test-DB engine (lucid_test) and the test-prefixed
ES indices (test_lucid_facts / test_lucid_objects / test_lucid_sources).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from api.models.base import new_uid
from api.models.facts import FactNode
from api.storage.elasticsearch import facts as es_facts
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
)
from api.storage.postgres.orm import (
    GraphNote,
    Predicate,
    SourceJobORM,
    User,
    UserSettings,
)
from scripts import wipe_account_knowledge as wipe
from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


def _seed_user_data(
    pg_engine,
    es_client,
    fake_embedding,
    email: str,
    is_admin: bool = False,
) -> tuple[str, str, str]:
    """Bootstrap a user + KS + UserSettings, a fact in ES, plus a
    source_job + a graph_note in PG. Returns (user_id, space_id, fact_uid).
    """
    user_id, space_id = create_user_via_orm(
        pg_engine, email, "pw", is_admin=is_admin,
    )

    fact_uid = new_uid()
    fact = FactNode(
        fact_uid=fact_uid,
        claim=f"claim for {email}",
        type="proposition",
        subject_uid=new_uid(),
        predicate="is_a",
        object_value="thing",
        validation_method="manual",
        validator_id=user_id,
        knowledge_space_id=space_id,
    )
    es_facts.create_fact(fact)

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    s = sm()
    try:
        sj = SourceJobORM(
            user_id=user_id,
            knowledge_space_id=space_id,
            source_url="https://example.com",
            source_type="article",
            captured_from="api",
            policy_at_capture="careful",
            status="extracted",
        )
        s.add(sj)
        gn = GraphNote(user_id=user_id, fact_uid=fact_uid, note="my note")
        s.add(gn)
        s.commit()
    finally:
        s.close()

    return user_id, space_id, fact_uid


def _fresh_session(pg_engine):
    """Return a new committed session bound to the test engine."""
    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    return sm()


def _cleanup_user(pg_engine, es_client, user_id: str, space_id: str) -> None:
    """Best-effort cleanup. The integration tests do not rely on
    transactional rollback (the script commits its own transaction)
    so we delete the seeded user + its KS at the end of each test.
    """
    s = _fresh_session(pg_engine)
    try:
        s.execute(
            __import__("sqlalchemy").text(
                "DELETE FROM users WHERE id = :uid"
            ),
            {"uid": user_id},
        )
        s.commit()
    except Exception:
        s.rollback()
    finally:
        s.close()
    try:
        es_client.delete_by_query(
            index=LUCID_FACTS,
            query={"term": {"knowledge_space_id": space_id}},
            refresh=True,
            conflicts="proceed",
        )
    except Exception:
        pass
    try:
        es_client.delete_by_query(
            index=LUCID_OBJECTS,
            query={"term": {"knowledge_space_id": space_id}},
            refresh=True,
            conflicts="proceed",
        )
    except Exception:
        pass
    try:
        es_client.delete_by_query(
            index=LUCID_SOURCES,
            query={"term": {"knowledge_space_id": space_id}},
            refresh=True,
            conflicts="proceed",
        )
    except Exception:
        pass


def test_dry_run_reports_counts_no_delete(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """Dry-run must NOT delete anything (PG row + ES doc both remain)."""
    email = f"wipe-dry-{uuid.uuid4().hex[:8]}@example.com"
    user_id, space_id, fact_uid = _seed_user_data(
        pg_engine, es_client, fake_embedding, email,
    )
    try:
        session = _fresh_session(pg_engine)
        try:
            rc = wipe.run(
                email=email,
                apply=False,
                session=session,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            session.close()
        assert rc == 0

        # source_job row still present
        s2 = _fresh_session(pg_engine)
        try:
            sj_count = s2.execute(
                select(func.count()).select_from(SourceJobORM).where(
                    SourceJobORM.user_id == user_id
                )
            ).scalar_one()
            gn_count = s2.execute(
                select(func.count()).select_from(GraphNote).where(
                    GraphNote.user_id == user_id
                )
            ).scalar_one()
        finally:
            s2.close()
        assert sj_count == 1, "source_jobs row should remain in dry-run"
        assert gn_count == 1, "graph_notes row should remain in dry-run"

        # ES fact still present
        es_count = es_client.count(
            index=LUCID_FACTS,
            query={"term": {"knowledge_space_id": space_id}},
        )["count"]
        assert es_count == 1, "ES fact should remain in dry-run"
    finally:
        _cleanup_user(pg_engine, es_client, user_id, space_id)


def test_apply_deletes_user_data(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """`--apply` removes the source_job, graph_note, and ES fact, but
    the user row and KS shells are preserved (choice a)."""
    email = f"wipe-apply-{uuid.uuid4().hex[:8]}@example.com"
    user_id, space_id, fact_uid = _seed_user_data(
        pg_engine, es_client, fake_embedding, email,
    )
    try:
        session = _fresh_session(pg_engine)
        try:
            rc = wipe.run(
                email=email,
                apply=True,
                session=session,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            session.close()
        assert rc == 0

        s2 = _fresh_session(pg_engine)
        try:
            sj_count = s2.execute(
                select(func.count()).select_from(SourceJobORM).where(
                    SourceJobORM.user_id == user_id
                )
            ).scalar_one()
            gn_count = s2.execute(
                select(func.count()).select_from(GraphNote).where(
                    GraphNote.user_id == user_id
                )
            ).scalar_one()
            user_row = s2.execute(
                select(User).where(User.id == user_id)
            ).scalar_one_or_none()
        finally:
            s2.close()
        assert sj_count == 0
        assert gn_count == 0
        # User row + KS shells preserved.
        assert user_row is not None

        # KS shells preserved.
        s3 = _fresh_session(pg_engine)
        try:
            ks_count = s3.execute(
                __import__("sqlalchemy").text(
                    "SELECT COUNT(*) FROM knowledge_spaces "
                    "WHERE user_id = :u"
                ),
                {"u": user_id},
            ).scalar_one()
        finally:
            s3.close()
        assert ks_count >= 1, "KS shells must be preserved (choice a)"

        # ES fact gone.
        es_count = es_client.count(
            index=LUCID_FACTS,
            query={"term": {"knowledge_space_id": space_id}},
        )["count"]
        assert es_count == 0
    finally:
        _cleanup_user(pg_engine, es_client, user_id, space_id)


def test_other_users_untouched(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """Wiping user A must NOT affect user B's source_job / graph_note / ES fact."""
    email_a = f"wipe-a-{uuid.uuid4().hex[:8]}@example.com"
    email_b = f"wipe-b-{uuid.uuid4().hex[:8]}@example.com"
    a_uid, a_space, _a_fact = _seed_user_data(
        pg_engine, es_client, fake_embedding, email_a,
    )
    b_uid, b_space, _b_fact = _seed_user_data(
        pg_engine, es_client, fake_embedding, email_b,
    )
    try:
        session = _fresh_session(pg_engine)
        try:
            rc = wipe.run(
                email=email_a,
                apply=True,
                session=session,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            session.close()
        assert rc == 0

        # B intact.
        s2 = _fresh_session(pg_engine)
        try:
            sj_b = s2.execute(
                select(func.count()).select_from(SourceJobORM).where(
                    SourceJobORM.user_id == b_uid
                )
            ).scalar_one()
            gn_b = s2.execute(
                select(func.count()).select_from(GraphNote).where(
                    GraphNote.user_id == b_uid
                )
            ).scalar_one()
        finally:
            s2.close()
        assert sj_b == 1, "user B source_job must be untouched"
        assert gn_b == 1, "user B graph_note must be untouched"

        es_b_count = es_client.count(
            index=LUCID_FACTS,
            query={"term": {"knowledge_space_id": b_space}},
        )["count"]
        assert es_b_count == 1, "user B ES fact must be untouched"
    finally:
        _cleanup_user(pg_engine, es_client, a_uid, a_space)
        _cleanup_user(pg_engine, es_client, b_uid, b_space)


def test_user_row_and_is_admin_preserved(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """is_admin=True must remain True; user_settings row must remain."""
    email = f"wipe-admin-{uuid.uuid4().hex[:8]}@example.com"
    user_id, space_id, _fact_uid = _seed_user_data(
        pg_engine, es_client, fake_embedding, email, is_admin=True,
    )
    try:
        session = _fresh_session(pg_engine)
        try:
            rc = wipe.run(
                email=email,
                apply=True,
                session=session,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            session.close()
        assert rc == 0

        s2 = _fresh_session(pg_engine)
        try:
            user_row = s2.execute(
                select(User).where(User.id == user_id)
            ).scalar_one_or_none()
            settings_count = s2.execute(
                select(func.count()).select_from(UserSettings).where(
                    UserSettings.user_id == user_id
                )
            ).scalar_one()
        finally:
            s2.close()
        assert user_row is not None
        assert user_row.is_admin is True, "is_admin must remain True"
        assert settings_count == 1, "user_settings row must be preserved"
    finally:
        _cleanup_user(pg_engine, es_client, user_id, space_id)


def test_opl_seed_preserved(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """The global predicates table is untouched by a user-scoped wipe."""
    email = f"wipe-opl-{uuid.uuid4().hex[:8]}@example.com"
    user_id, space_id, _fact_uid = _seed_user_data(
        pg_engine, es_client, fake_embedding, email,
    )
    try:
        s_pre = _fresh_session(pg_engine)
        try:
            pre = s_pre.execute(
                select(func.count()).select_from(Predicate)
            ).scalar_one()
        finally:
            s_pre.close()

        session = _fresh_session(pg_engine)
        try:
            rc = wipe.run(
                email=email,
                apply=True,
                session=session,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            session.close()
        assert rc == 0

        s_post = _fresh_session(pg_engine)
        try:
            post = s_post.execute(
                select(func.count()).select_from(Predicate)
            ).scalar_one()
        finally:
            s_post.close()
        assert pre == post, "predicates count must be unchanged"
    finally:
        _cleanup_user(pg_engine, es_client, user_id, space_id)


def test_idempotent_second_apply(
    pg_engine, es_client, es_indexes, fake_embedding, alembic_upgrade,
):
    """A second `--apply` after a successful wipe is a no-op (all zero deletes)."""
    email = f"wipe-idem-{uuid.uuid4().hex[:8]}@example.com"
    user_id, space_id, _fact_uid = _seed_user_data(
        pg_engine, es_client, fake_embedding, email,
    )
    try:
        # First apply: deletes the seeded data.
        s1 = _fresh_session(pg_engine)
        try:
            rc1 = wipe.run(
                email=email,
                apply=True,
                session=s1,
                client=es_client,
                output=lambda _s: None,
            )
        finally:
            s1.close()
        assert rc1 == 0

        # Second apply: nothing left to delete; rc still 0 and all
        # post-counts are zero.
        s2 = _fresh_session(pg_engine)
        try:
            user = wipe.find_user(s2, email)
            assert user is not None
            space_ids = wipe.find_space_ids(s2, user.id)
            fact_uids = wipe.find_fact_uids_in_es(es_client, space_ids)
            deleted = wipe.apply_wipe(
                s2, es_client, user.id, space_ids, fact_uids
            )
        finally:
            s2.close()
        # Every value in deleted must be 0 (nothing was left to delete).
        assert all(v == 0 for v in deleted.values()), (
            f"second apply not idempotent: {deleted}"
        )
    finally:
        _cleanup_user(pg_engine, es_client, user_id, space_id)
