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
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    deferred,
    mapped_column,
    relationship,
)


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


class DisambiguationLog(Base):
    """One Object-disambiguation decision (DCR-001 / DR-065)."""

    __tablename__ = "disambiguation_logs"
    __table_args__ = (
        CheckConstraint(
            "decision_method IN ('existing', 'new')",
            name="ck_disambiguation_decision_method",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    fact_uid: Mapped[str] = mapped_column(String, nullable=False, index=True)
    mention_text: Mapped[str] = mapped_column(String, nullable=False)
    resolved_to_uid: Mapped[str | None] = mapped_column(String, nullable=True)
    decision_method: Mapped[str] = mapped_column(String, nullable=False)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class PrecisionLog(Base):
    """M1: Extraction Precision — per-fact Validate decision history."""

    __tablename__ = "precision_logs"
    __table_args__ = (
        CheckConstraint(
            "decision IN ('accept', 'edit', 'reject', 'discard')",
            name="ck_precision_log_decision",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    fact_uid: Mapped[str] = mapped_column(String, nullable=False, index=True)
    decision: Mapped[str] = mapped_column(String, nullable=False)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class NegationLog(Base):
    """M2: Negation Error Rate — AI vs user-corrected negation tags."""

    __tablename__ = "negation_logs"
    __table_args__ = (
        CheckConstraint(
            "ai_scope IS NULL OR ai_scope IN ('full', 'partial')",
            name="ck_negation_log_ai_scope",
        ),
        CheckConstraint(
            "user_corrected_scope IS NULL OR user_corrected_scope IN ('full', 'partial')",
            name="ck_negation_log_user_scope",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    fact_uid: Mapped[str] = mapped_column(String, nullable=False, index=True)
    ai_negation_flag: Mapped[bool] = mapped_column(Boolean, nullable=False)
    user_corrected_flag: Mapped[bool] = mapped_column(Boolean, nullable=False)
    ai_scope: Mapped[str | None] = mapped_column(String, nullable=True)
    user_corrected_scope: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ContradictionLog(Base):
    """M3: Contradiction Recall — user confirmation of detected pairs."""

    __tablename__ = "contradiction_logs"
    __table_args__ = (
        CheckConstraint(
            "pattern IN ('A', 'B', 'C')",
            name="ck_contradiction_log_pattern",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    pair_uid: Mapped[str] = mapped_column(String, nullable=False, index=True)
    pattern: Mapped[str] = mapped_column(String, nullable=False)
    user_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SourceJobORM(Base):
    """SourceJob persistence (Sprint 2C PR-2C-1).

    `raw_payload` is gzip-compressed before storage (see
    api.storage.postgres.compression). The status CHECK enumerates
    only the Sprint 2C lifecycle values; Sprint 3 extends the CHECK
    via a separate migration when 'pending_structure' and downstream
    states land.
    """

    __tablename__ = "source_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed', "
            "'structuring', 'structured', 'structure_failed')",
            name="ck_source_job_status",
        ),
        CheckConstraint(
            "captured_from IN ('chrome_ext', 'pwa_share', 'api')",
            name="ck_source_job_captured_from",
        ),
        CheckConstraint(
            "policy_at_capture IN ('trusted', 'careful')",
            name="ck_source_job_policy",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    knowledge_space_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("knowledge_spaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    source_type: Mapped[str] = mapped_column(String, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    captured_from: Mapped[str] = mapped_column(String, nullable=False)
    raw_payload: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    status: Mapped[str] = mapped_column(
        String, nullable=False, server_default="pending_extract", index=True
    )
    policy_at_capture: Mapped[str] = mapped_column(
        String, nullable=False, server_default="careful"
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    client_metadata: Mapped[dict | None] = mapped_column(  # type: ignore[type-arg]
        JSONB, nullable=True
    )
    # PR-2C-3: extracted content lives on source_jobs (no separate table).
    # extracted_text is deferred() so list queries don't pay the TEXT bytes.
    extracted_text: Mapped[str | None] = deferred(mapped_column(Text, nullable=True))
    extracted_metadata: Mapped[dict] = mapped_column(  # type: ignore[type-arg]
        JSONB, server_default=text("'{}'::jsonb"), nullable=False
    )
    extraction_warnings: Mapped[list] = mapped_column(  # type: ignore[type-arg]
        JSONB, server_default=text("'[]'::jsonb"), nullable=False
    )
    extracted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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
    "DisambiguationLog",
    "PrecisionLog",
    "NegationLog",
    "ContradictionLog",
    "SourceJobORM",
]


class StructureMetricsLog(Base):
    """Sprint 3 PR-3-3 — Structure-stage aggregate telemetry per SourceJob.

    Privacy invariants (DCR-001):
      - NO claim text
      - NO source URL or object names
      - source_job_id + user_id give analytic joinability inside the
        user's own KS only; user delete cascades on both FKs
    """

    __tablename__ = "structure_metrics_logs"
    __table_args__ = (
        CheckConstraint(
            "fact_count >= 0 AND object_count_auto >= 0 "
            "AND object_count_new >= 0 AND object_count_disambig >= 0 "
            "AND link_count >= 0 AND negates_count >= 0",
            name="ck_structure_metrics_nonneg",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("source_jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    fact_count: Mapped[int] = mapped_column(Integer, nullable=False)
    object_count_auto: Mapped[int] = mapped_column(Integer, nullable=False)
    object_count_new: Mapped[int] = mapped_column(Integer, nullable=False)
    object_count_disambig: Mapped[int] = mapped_column(Integer, nullable=False)
    link_count: Mapped[int] = mapped_column(Integer, nullable=False)
    negates_count: Mapped[int] = mapped_column(Integer, nullable=False)
    decomposer_model: Mapped[str | None] = mapped_column(String, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    logged_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class UnderstandingDepthLog(Base):
    """DCR-002 v2 — anonymized per-KS aggregate understanding-depth.

    Privacy invariants (DCR-001):
      - NO fact UIDs
      - NO claim text, no source urls, no object names
      - aggregate ratios only: average / max / isolated count / total
    """

    __tablename__ = "understanding_depth_logs"
    __table_args__ = (
        CheckConstraint(
            "average_depth >= 0 AND max_depth >= 0 "
            "AND isolated_facts_count >= 0 AND total_facts >= 0",
            name="ck_understanding_depth_nonneg",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    knowledge_space_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True,
    )
    average_depth: Mapped[float] = mapped_column(Float, nullable=False)
    max_depth: Mapped[int] = mapped_column(Integer, nullable=False)
    isolated_facts_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_facts: Mapped[int] = mapped_column(Integer, nullable=False)
    measured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
