"""Integration test: ORM CRUD + FK cascade + uniqueness constraints."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from api.storage.postgres.orm import (
    ArchetypeSurvey,
    AuthSession,
    GraphNote,
    KnowledgeSpace,
    SourcePolicyORM,
    User,
)

pytestmark = pytest.mark.integration


def test_create_user_and_knowledge_space(pg_session):
    u = User(email="alice@lucid.example", name="Alice")
    pg_session.add(u)
    pg_session.flush()
    assert u.id is not None

    ks = KnowledgeSpace(user_id=u.id, type="personal", name="Alice personal")
    pg_session.add(ks)
    pg_session.flush()
    assert ks.id is not None
    assert ks.created_at is not None


def test_knowledge_space_cascade_deletes_with_user(pg_session):
    u = User(email="bob@lucid.example")
    pg_session.add(u)
    pg_session.flush()
    ks = KnowledgeSpace(user_id=u.id, type="personal")
    pg_session.add(ks)
    pg_session.flush()
    ks_id = ks.id

    pg_session.delete(u)
    pg_session.flush()
    pg_session.expire_all()

    survivor = pg_session.get(KnowledgeSpace, ks_id)
    assert survivor is None, "KS should cascade-delete with the user"


def test_session_token_hash_unique(pg_session):
    u = User(email="carol@lucid.example")
    pg_session.add(u)
    pg_session.flush()
    expires = datetime.now(UTC) + timedelta(hours=1)
    pg_session.add(AuthSession(user_id=u.id, token_hash="abc", expires_at=expires))
    pg_session.flush()

    with pytest.raises(IntegrityError):
        pg_session.add(AuthSession(user_id=u.id, token_hash="abc", expires_at=expires))
        pg_session.flush()


def test_source_policy_unique_per_user_domain(pg_session):
    u = User(email="dave@lucid.example")
    pg_session.add(u)
    pg_session.flush()

    pg_session.add(
        SourcePolicyORM(user_id=u.id, source_domain="wsj.com", policy="trusted")
    )
    pg_session.flush()

    with pytest.raises(IntegrityError):
        pg_session.add(
            SourcePolicyORM(user_id=u.id, source_domain="wsj.com", policy="careful")
        )
        pg_session.flush()


def test_archetype_survey_single_per_user(pg_session):
    u = User(email="eve@lucid.example")
    pg_session.add(u)
    pg_session.flush()

    pg_session.add(
        ArchetypeSurvey(
            user_id=u.id,
            consumption_intensity="heavy",
            validation_frequency="careful",
            surface_usage="active",
            domain_diversity="broad",
            device_environment="mixed",
        )
    )
    pg_session.flush()

    with pytest.raises(IntegrityError):
        pg_session.add(ArchetypeSurvey(user_id=u.id, skipped=True))
        pg_session.flush()


def test_graph_note_creation_and_fact_uid_string(pg_session):
    u = User(email="fred@lucid.example")
    pg_session.add(u)
    pg_session.flush()

    note = GraphNote(
        fact_uid="fn-fake-uuid",  # stays a string; ES owns the fact
        user_id=u.id,
        note="reason for saving",
    )
    pg_session.add(note)
    pg_session.flush()
    assert note.id is not None
    assert note.fact_uid == "fn-fake-uuid"
