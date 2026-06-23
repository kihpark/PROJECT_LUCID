"""Integration: indexing a fact / object with the full B-62 entity-
layer field set succeeds against the canonical mapping.

feat/mappings-sync-permanent (2026-06-23): regression guard for the
strict_dynamic_mapping_exception that crashed every bulk_create_facts
call on PO's dev ES. We index raw docs (not FactNode / ObjectNode) so
the test covers the wire-shape the writer actually emits — including
display-only fields like subject_label / object_label /
predicate_violation that aren't on the pydantic model but ARE on the
serialized doc.
"""
from __future__ import annotations

import pytest

from api.models.base import new_uid

pytestmark = pytest.mark.integration


def _full_fact_doc(space: str) -> dict:
    """Wire-shape doc with every B-62 entity-layer field populated.

    Mirrors what `processor._serialize_struct_fact` emits onto a
    bulk-index request: structural fact + canonical-resolve fields +
    decide-payload display labels + violation flag.
    """
    fact_uid = new_uid()
    return {
        "fact_uid": fact_uid,
        "claim": "Apple acquired Beats",
        "claim_en": "Apple acquired Beats",
        "type": "proposition",
        "subject_uid": "ent_apple",
        "predicate": "acquired",
        "predicate_label": "acquired",
        "object_value": "Beats",
        "validation_method": "manual",
        "validator_id": new_uid(),
        "source_uids": [],
        "tags": ["m&a"],
        "aliases": [],
        "knowledge_space_id": space,
        # B-62 structure-resolve + natural-spo
        "predicate_code": "ACQUIRED",
        "original_surface": "Apple acquired Beats",
        "capture_lang": "en",
        "object_canonical": "ent_beats",
        "canonical_key": "ent_apple|ACQUIRED|ent_beats",
        "needs_review": False,
        # B-62 spo-decide-payload-wire (this PR)
        "subject_label": "Apple",
        "object_label": "Beats",
        "predicate_violation": False,
    }


def test_index_full_fact_doc_succeeds(es_indexes):
    """A fact doc that names every B-62 entity-layer field indexes
    cleanly under the declared mapping. Pre-fix this raised
    `strict_dynamic_mapping_exception` for subject_label, object_label
    and predicate_violation.
    """
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client

    client = get_client()
    space = new_uid()
    doc = _full_fact_doc(space)

    client.index(index=LUCID_FACTS, id=doc["fact_uid"], document=doc, refresh=True)

    # Verify the doc round-trips with all the new fields preserved.
    got = client.get(index=LUCID_FACTS, id=doc["fact_uid"])["_source"]
    assert got["subject_label"] == "Apple"
    assert got["object_label"] == "Beats"
    assert got["predicate_violation"] is False
    assert got["predicate_code"] == "ACQUIRED"
    assert got["canonical_key"] == "ent_apple|ACQUIRED|ent_beats"


def test_index_partial_fact_doc_succeeds(es_indexes):
    """A legacy-shaped doc (entity-layer fields absent) still indexes
    cleanly — the new fields are additive, not required.
    """
    from api.storage.elasticsearch.client import LUCID_FACTS, get_client

    client = get_client()
    space = new_uid()
    doc = {
        "fact_uid": new_uid(),
        "claim": "Legacy fact, pre-B-62",
        "type": "proposition",
        "subject_uid": new_uid(),
        "predicate": "p",
        "object_value": "o",
        "validation_method": "manual",
        "validator_id": new_uid(),
        "knowledge_space_id": space,
    }

    client.index(index=LUCID_FACTS, id=doc["fact_uid"], document=doc, refresh=True)
    got = client.get(index=LUCID_FACTS, id=doc["fact_uid"])["_source"]
    assert got["fact_uid"] == doc["fact_uid"]
    # Optional fields absent, not defaulted:
    assert "subject_label" not in got
    assert "predicate_violation" not in got


def test_index_full_object_doc_succeeds(es_indexes):
    """An object doc with primary_label / primary_lang / entity_type
    indexes cleanly under the declared mapping. Pre-fix this raised
    `strict_dynamic_mapping_exception` for primary_label / primary_lang
    on drifted live clusters.
    """
    from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client

    client = get_client()
    space = new_uid()
    object_uid = new_uid()
    doc = {
        "object_uid": object_uid,
        "class": "Organization",
        "name": "Apple",
        "name_en": "Apple",
        "primary_label": "Apple",
        "primary_lang": "en",
        "entity_type": "Organization",
        "aliases": ["애플"],
        "fact_uids": [],
        "knowledge_space_id": space,
    }

    client.index(index=LUCID_OBJECTS, id=object_uid, document=doc, refresh=True)
    got = client.get(index=LUCID_OBJECTS, id=object_uid)["_source"]
    assert got["primary_label"] == "Apple"
    assert got["primary_lang"] == "en"
    assert got["entity_type"] == "Organization"
