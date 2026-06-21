"""opl_v1_expansion — B-62 natural-spo-display: expand OPL vocabulary

Adds ~20 new OPL controlled-vocabulary predicate codes covering the
finance / news / governance domains so the natural-SPO display path
has enough type coverage to render rich English glosses rather than
collapsing everything to RELATED_TO.

The original v0 seed (10 codes) stays untouched; this migration only
APPENDS new rows with higher sort_order values.

Revision ID: 0016_opl_v1_expansion
Revises: 0015_data_bedrock
Create Date: 2026-06-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0016_opl_v1_expansion"
down_revision: str | None = "0015_data_bedrock"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


# OPL v1 expansion. sort_order picks up at 11 (v0 ended at 10).
# Categories:
#   - planning / cognition:  PLANS, DISCUSSES, ESTIMATES, INTENDS,
#                            REPORTS, DEFINES, CAUSES
#   - news / corporate:      ANNOUNCES, ACQUIRES, INVESTS_IN,
#                            PARTNERS_WITH, EMPLOYS, COMPETES_WITH,
#                            TARGETS
#   - finance / capital:     PRICED_AT, RAISES, ALLOCATES, HAS_RATE
#   - governance / legal:    APPROVES, REGULATES
OPL_V1_SEED: list[tuple[str, str, str, int]] = [
    # planning / cognition
    ("PLANS",          "계획",       "plans",          11),
    ("DISCUSSES",      "논의",       "discusses",      12),
    ("ESTIMATES",      "추정",       "estimates",      13),
    ("INTENDS",        "의도",       "intends",        14),
    ("REPORTS",        "보고",       "reports",        15),
    ("DEFINES",        "정의",       "defines",        16),
    ("CAUSES",         "원인",       "causes",         17),
    # news / corporate
    ("ANNOUNCES",      "발표",       "announces",      18),
    ("ACQUIRES",       "인수",       "acquires",       19),
    ("INVESTS_IN",     "투자",       "invests in",     20),
    ("PARTNERS_WITH",  "제휴",       "partners with",  21),
    ("EMPLOYS",        "고용",       "employs",        22),
    ("COMPETES_WITH",  "경쟁",       "competes with",  23),
    ("TARGETS",        "대상",       "targets",        24),
    # finance / capital
    ("PRICED_AT",      "가격",       "priced at",      25),
    ("RAISES",         "조달",       "raises",         26),
    ("ALLOCATES",      "배정",       "allocates",      27),
    ("HAS_RATE",       "비율",       "has rate",       28),
    # governance / legal
    ("APPROVES",       "승인",       "approves",       29),
    ("REGULATES",      "규제",       "regulates",      30),
]


def upgrade() -> None:
    """Append the OPL v1 expansion rows. The v0 seed is preserved."""
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
            for (code, label_ko, label_en, sort_order) in OPL_V1_SEED
        ],
    )


def downgrade() -> None:
    """Drop only the v1 codes; v0 rows stay intact."""
    codes_csv = ",".join(f"'{code}'" for (code, _, _, _) in OPL_V1_SEED)
    op.execute(sa.text(f"DELETE FROM predicates WHERE code IN ({codes_csv})"))
