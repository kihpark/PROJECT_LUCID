"""disambiguation_logs (DCR-001 / DR-065)

Revision ID: 0007_disambiguation_logs
Revises: 0006_user_password
Create Date: 2026-05-28

Stores every Object disambiguation decision made in the Validate UI.
Records the mention text + the chosen object_uid (or null when the
user picked "create new") + which user made the decision.

Used by M3 contradiction-recall analysis later; never exposed to
the user as their own history.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007_disambiguation_logs"
down_revision: str | None = "0006_user_password"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "disambiguation_logs",
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
        sa.Column("mention_text", sa.String, nullable=False),
        sa.Column("resolved_to_uid", sa.String, nullable=True),
        sa.Column(
            "decision_method",
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
            "decision_method IN ('existing', 'new')",
            name="ck_disambiguation_decision_method",
        ),
    )


def downgrade() -> None:
    op.drop_table("disambiguation_logs")
