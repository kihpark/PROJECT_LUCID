"""SQLAlchemy 2.x ORM for the Postgres tables.

Six tables (alembic migrations 0001..0004 in api/storage/postgres/migrations/):
  - users               authentication
  - knowledge_spaces    one per user in beta (type='personal'); team/policy/
                        public are valid enum values but blocked at the API
                        layer in beta (Sprint 1B)
  - sessions            opaque token sessions (renamed `AuthSession` in
                        Python to avoid shadowing sqlalchemy.orm.Session)
  - source_policies     per-user, per-domain Trusted/Careful policy
                        (Settings SET-2 — PO directive [변경 3])
  - archetype_surveys   5-dimension wedge-discovery survey, one per user
  - graph_notes         Review-mode (V-2) personal notes keyed on ES
                        fact_uid (no FK; the ES doc owns the fact)

`Base` is the DeclarativeBase. Alembic env.py imports `target_metadata
= Base.metadata`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Common metadata holder for every Postgres table."""


def _uuid_pk() -> Mapped[uuid.UUID]:
    """UUID4 primary key column, populated server-side via gen_random_uuid()."""
    return mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    knowledge_spaces: Mapped[list[KnowledgeSpace]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )
    sessions: Mapped[list[AuthSession]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class KnowledgeSpace(Base):
    __tablename__ = "knowledge_spaces"
    __table_args__ = (
        CheckConstraint(
            "type IN ('personal', 'team', 'policy', 'public')",
            name="ck_knowledge_space_type",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    type: Mapped[str] = mapped_column(String, nullable=False, default="personal")
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="knowledge_spaces")


class AuthSession(Base):
    """Auth session token (renamed to avoid shadowing sqlalchemy.orm.Session)."""

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="sessions")


class SourcePolicyORM(Base):
    """User-scoped per-domain Trusted/Careful policy (Settings SET-2)."""

    __tablename__ = "source_policies"
    __table_args__ = (
        UniqueConstraint("user_id", "source_domain", name="uq_user_source_domain"),
        CheckConstraint(
            "policy IN ('trusted', 'careful')",
            name="ck_source_policy_value",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_domain: Mapped[str] = mapped_column(String, nullable=False)
    policy: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ArchetypeSurvey(Base):
    """One survey per user (Sprint 7 Onboarding O-2)."""

    __tablename__ = "archetype_surveys"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    consumption_intensity: Mapped[str | None] = mapped_column(String, nullable=True)
    validation_frequency: Mapped[str | None] = mapped_column(String, nullable=True)
    surface_usage: Mapped[str | None] = mapped_column(String, nullable=True)
    domain_diversity: Mapped[str | None] = mapped_column(String, nullable=True)
    device_environment: Mapped[str | None] = mapped_column(String, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    skipped: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)


class GraphNote(Base):
    """Review-mode (V-2) personal note keyed on the ES fact_uid.

    `fact_uid` is a plain string (no FK to Postgres) because the
    authoritative fact lives in the lucid_facts ES index. ES doc deletion
    cleanup is handled at the API layer in Sprint 4A.
    """

    __tablename__ = "graph_notes"

    id: Mapped[uuid.UUID] = _uuid_pk()
    fact_uid: Mapped[str] = mapped_column(String, nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class UserSettings(Base):
    """Per-user beta settings.

    `validation_mode` is the duplicate-fact policy (DR-037: Quick / Strict /
    Hybrid). `surface_on_by_default` is the Mode 0 default at signup
    (later toggled per device by the user). Trusted sources live in the
    separate `source_policies` table (per Settings SET-2).
    """

    __tablename__ = "user_settings"
    __table_args__ = (
        CheckConstraint(
            "validation_mode IN ('quick', 'strict', 'hybrid')",
            name="ck_user_settings_validation_mode",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    validation_mode: Mapped[str] = mapped_column(
        String, nullable=False, default="quick"
    )
    surface_on_by_default: Mapped[bool] = mapped_column(
        Boolean, server_default="true", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


__all__ = [
    "Base",
    "User",
    "KnowledgeSpace",
    "AuthSession",
    "SourcePolicyORM",
    "ArchetypeSurvey",
    "GraphNote",
    "UserSettings",
]
