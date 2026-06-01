"""validation_logs (Sprint 4B PR-4B-1)

Revision ID: 0014
Revises: 0013
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "validation_logs",
        sa.Column(
            "id", UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id", UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_job_id", UUID(as_uuid=True),
            sa.ForeignKey("source_jobs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("fact_uid", sa.String(), nullable=True),
        sa.Column("object_uid", sa.String(), nullable=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("edited_claim_len", sa.Integer(), nullable=True),
        sa.Column(
            "validator_id", UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "validated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("decision_metadata", JSONB(), nullable=True),
        sa.CheckConstraint(
            "action IN ('accept','edit','discard','merge_with','create_new','skip','accept_all','discard_job')",
            name="ck_validation_logs_action",
        ),
    )
    op.create_index(
        "ix_validation_logs_source_job_id",
        "validation_logs", ["source_job_id"],
    )
    op.create_index(
        "ix_validation_logs_fact_uid",
        "validation_logs", ["fact_uid"],
    )


def downgrade() -> None:
    op.drop_index("ix_validation_logs_fact_uid", table_name="validation_logs")
    op.drop_index("ix_validation_logs_source_job_id", table_name="validation_logs")
    op.drop_table("validation_logs")
