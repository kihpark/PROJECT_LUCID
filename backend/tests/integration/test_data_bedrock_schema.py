"""Integration tests for the B-62 data bedrock schema.

Covers:
  * OPL v0 seed: all 10 controlled-vocabulary predicate codes load,
    every row has non-empty Korean + English labels.
  * Tag uniqueness: the unique constraint on ``label`` rejects a
    duplicate insert.
  * FactRelation defaults: schema-only fields land with the expected
    nullable / zero defaults so future B-54 inserts don't need to
    spell them out.
  * Additive ES read: a legacy lucid_facts document that lacks the
    new ``predicate_code`` / ``original_surface`` / ``capture_lang``
    fields still flows back through ``get_fact_by_uid`` unchanged.

The Postgres cases use the session-scoped ``pg_session`` /
``alembic_upgrade`` fixtures from ``conftest.py``. The ES case uses
``monkeypatch`` to swap ``api.storage.elasticsearch.facts.get_client``
for a ``MagicMock`` so the test never touches a real ES cluster.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from api.storage.postgres.orm import FactRelation, Predicate, Tag

pytestmark = pytest.mark.integration


EXPECTED_OPL_V0_CODES: set[str] = {
    "IS_A",
    "HAS_VALUE",
    "HAS_ATTRIBUTE",
    "PART_OF",
    "LOCATED_IN",
    "FOUNDED_BY",
    "LED_BY",
    "PRODUCES",
    "OCCURRED_ON",
    "RELATED_TO",
}


# --- OPL v0 seed ----------------------------------------------------------


def test_opl_v0_seed_loaded(pg_session) -> None:
    rows = pg_session.scalars(sa.select(Predicate)).all()
    assert len(rows) >= 10, f"expected >= 10 predicates, got {len(rows)}"

    codes = {row.code for row in rows}
    missing = EXPECTED_OPL_V0_CODES - codes
    assert not missing, f"OPL v0 codes missing from seed: {missing}"


def test_opl_v0_seed_has_bilingual_labels(pg_session) -> None:
    rows = pg_session.scalars(
        sa.select(Predicate).where(Predicate.code.in_(EXPECTED_OPL_V0_CODES))
    ).all()
    for row in rows:
        assert row.label_ko, f"{row.code} missing Korean label"
        assert row.label_en, f"{row.code} missing English label"


# --- Tag uniqueness -------------------------------------------------------


def test_tag_insert_persists_label(pg_session) -> None:
    tag = Tag(label="data-bedrock-test-tag-1", color="#ff00aa")
    pg_session.add(tag)
    pg_session.flush()

    fetched = pg_session.scalar(
        sa.select(Tag).where(Tag.label == "data-bedrock-test-tag-1")
    )
    assert fetched is not None
    assert fetched.label == "data-bedrock-test-tag-1"
    assert fetched.color == "#ff00aa"
    assert fetched.created_at is not None


def test_tag_label_unique_constraint(pg_session) -> None:
    pg_session.add(Tag(label="data-bedrock-test-tag-dup"))
    pg_session.flush()

    with pytest.raises(IntegrityError):
        pg_session.add(Tag(label="data-bedrock-test-tag-dup"))
        pg_session.flush()


# --- FactRelation defaults -----------------------------------------------


def test_fact_relation_defaults(pg_session) -> None:
    rel = FactRelation(
        from_fact_uid="fact-aaa",
        to_fact_uid="fact-bbb",
        relation_type="SUPPORTS",
    )
    pg_session.add(rel)
    pg_session.flush()
    pg_session.refresh(rel)

    assert rel.relation_id is not None
    assert rel.corroboration_source_count == 0
    assert rel.corroboration_source_diversity == 0
    assert rel.validated_at is None
    assert rel.created_at is not None
    assert rel.relation_type == "SUPPORTS"


# --- Additive ES read: legacy facts still parse --------------------------


def test_legacy_fact_read_without_b62_fields(monkeypatch) -> None:
    """A legacy lucid_facts doc that pre-dates the B-62 mapping
    additions must still flow back through ``get_fact_by_uid`` without
    raising — proving the new fields are truly additive / nullable."""
    from api.storage.elasticsearch import facts as facts_mod

    legacy_doc = {
        "fact_uid": "legacy-fact-1",
        "claim": "Legacy fact claim",
        "subject_uid": "subj-legacy",
        "predicate": "ipo_price",
        "object_value": "135",
        "knowledge_space_id": "ks-legacy",
        "validated_at": "2026-06-15T09:00:00Z",
        "validator_id": "u-1",
        # Deliberately NO predicate_code, original_surface, capture_lang.
    }

    mock_client = MagicMock()
    mock_client.exists.return_value = True
    mock_client.get.return_value = {"_source": legacy_doc}

    monkeypatch.setattr(facts_mod, "get_client", lambda: mock_client)

    result = facts_mod.get_fact_by_uid("legacy-fact-1")
    assert result is not None
    assert result["fact_uid"] == "legacy-fact-1"
    # New B-62 fields are either absent or None — both prove the read
    # path doesn't require them.
    assert result.get("predicate_code") is None
    assert result.get("original_surface") is None
    assert result.get("capture_lang") is None
