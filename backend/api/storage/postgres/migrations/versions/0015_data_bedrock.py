"""data_bedrock — B-62 Predicate / Tag / FactRelation + OPL v0 seed

Revision ID: 0015_data_bedrock
Revises: 0014_validation_logs
Create Date: 2026-06-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0015_data_bedrock"
down_revision: str | None = "0014_validation_logs"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


# OPL v0 controlled vocabulary (10 codes). Re-ordering or renaming
# any code is a breaking change — append new codes with a higher
# sort_order instead.
OPL_V0_SEED: list[tuple[str, str, str, int]] = [
    ("IS_A",          "분류",     "is a",          1),
    ("HAS_VALUE",     "값",       "has value",     2),
    ("HAS_ATTRIBUTE", "속성",     "has attribute", 3),
    ("PART_OF",       "구성",     "part of",       4),
    ("LOCATED_IN",    "위치",     "located in",    5),
    ("FOUNDED_BY",    "설립자",   "founded by",    6),
    ("LED_BY",        "수장",     "led by",        7),
    ("PRODUCES",      "생산",     "produces",      8),
    ("OCCURRED_ON",   "발생일",   "occurred on",   9),
    ("RELATED_TO",    "일반연관", "related to",    10),
]


def upgrade() -> None:
    op.create_table(
        "predicates",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("label_ko", sa.String(120), nullable=False),
        sa.Column("label_en", sa.String(120), nullable=False),
        sa.Column(
            "sort_order", sa.Integer(),
            nullable=False, server_default="0",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
    )

    op.create_table(
        "tags",
        sa.Column(
            "tag_id", UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "label", sa.String(120),
            nullable=False, unique=True,
        ),
        sa.Column("color", sa.String(16), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
    )

    op.create_table(
        "fact_relations",
        sa.Column(
            "relation_id", UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("from_fact_uid", sa.String(64), nullable=False),
        sa.Column("to_fact_uid", sa.String(64), nullable=False),
        sa.Column("relation_type", sa.String(32), nullable=False),
        sa.Column(
            "corroboration_source_count", sa.Integer(),
            nullable=False, server_default="0",
        ),
        sa.Column(
            "corroboration_source_diversity", sa.Integer(),
            nullable=False, server_default="0",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "validated_at", sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_fact_relations_from",
        "fact_relations", ["from_fact_uid"],
    )
    op.create_index(
        "ix_fact_relations_to",
        "fact_relations", ["to_fact_uid"],
    )

    # Seed OPL v0 controlled vocabulary.
    predicates_table = sa.table(
        "predicates",
        sa.column("code", sa.String),
        sa.column("label_ko", sa.String),
        sa.column("label_en", sa.String),
        sa.column("sort_order", sa.Integer),
    )
    op.bulk_insert(
        predicates_table,
        [
            {
                "code": code,
                "label_ko": label_ko,
                "label_en": label_en,
                "sort_order": sort_order,
            }
            for (code, label_ko, label_en, sort_order) in OPL_V0_SEED
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_fact_relations_to", table_name="fact_relations")
    op.drop_index("ix_fact_relations_from", table_name="fact_relations")
    op.drop_table("fact_relations")
    op.drop_table("tags")
    op.drop_table("predicates")
