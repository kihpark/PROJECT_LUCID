"""metrics_logs: precision_logs + negation_logs + contradiction_logs (DCR-001)

Revision ID: 0008_metrics_logs
Revises: 0007_disambiguation_logs
Create Date: 2026-05-28

Anonymized aggregate decision history used by the M1 / M2 / M3 internal
accuracy metrics. NO claim text is stored — only fact_uid + decision
pattern + user_id (FK cascade so deletes propagate). Dashboard
visualization is Sprint 7 scope.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008_metrics_logs"
down_revision: str | None = "0007_disambiguation_logs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # M1 — Extraction Precision (Validate decision history)
    op.create_table(
        "precision_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("fact_uid", sa.String, nullable=False, index=True),
        sa.Column(
            "decision",
            sa.String,
            nullable=False,
        ),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "decision IN ('accept', 'edit', 'reject', 'discard')",
            name="ck_precision_log_decision",
        ),
    )

    # M2 — Negation Error Rate (negation correction history)
    op.create_table(
        "negation_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("fact_uid", sa.String, nullable=False, index=True),
        sa.Column(
            "ai_negation_flag",
            sa.Boolean,
            nullable=False,
        ),
        sa.Column(
            "user_corrected_flag",
            sa.Boolean,
            nullable=False,
        ),
        sa.Column(
            "ai_scope",
            sa.String,
            nullable=True,
        ),
        sa.Column(
            "user_corrected_scope",
            sa.String,
            nullable=True,
        ),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "ai_scope IS NULL OR ai_scope IN ('full', 'partial')",
            name="ck_negation_log_ai_scope",
        ),
        sa.CheckConstraint(
            "user_corrected_scope IS NULL OR user_corrected_scope IN ('full', 'partial')",
            name="ck_negation_log_user_scope",
        ),
    )

    # M3 — Contradiction Recall (Contradiction confirmation history)
    op.create_table(
        "contradiction_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("pair_uid", sa.String, nullable=False, index=True),
        sa.Column(
            "pattern",
            sa.String,
            nullable=False,
        ),
        sa.Column(
            "user_confirmed",
            sa.Boolean,
            nullable=False,
        ),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "pattern IN ('A', 'B', 'C')",
            name="ck_contradiction_log_pattern",
        ),
    )


def downgrade() -> None:
    op.drop_table("contradiction_logs")
    op.drop_table("negation_logs")
    op.drop_table("precision_logs")
