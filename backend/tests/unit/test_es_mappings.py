"""Unit test: index mapping structure (no live ES needed)."""
from __future__ import annotations

from api.storage.elasticsearch.mappings import (
    EMBEDDING_DIMS,
    INDEX_MAPPINGS,
    LUCID_FACTS_MAPPING,
    LUCID_OBJECTS_MAPPING,
    LUCID_SOURCES_MAPPING,
)


def test_three_indexes_defined():
    """B-38: keys now reflect the LUCID_INDEX_PREFIX in effect. We
    assert the SUFFIXES match the canonical names so the test passes
    both under prod (no prefix) and integration (test_ prefix).

    B-62 landing-integration: `applications` joins the set as a
    public, pre-account intake index. The smoke contract is still
    facts / objects / sources (asserted separately by the smoke check).
    """
    suffixes = {k.split("lucid_")[-1] for k in INDEX_MAPPINGS}
    assert suffixes == {"facts", "objects", "sources", "applications"}


def test_lucid_facts_uses_nori_for_korean_and_aliases():
    props = LUCID_FACTS_MAPPING["mappings"]["properties"]
    assert props["claim"]["analyzer"] == "korean_analyzer"
    assert props["aliases"]["analyzer"] == "korean_analyzer"
    assert props["claim_en"]["analyzer"] == "standard"


def test_lucid_facts_no_stale_fields():
    """DR-053 / C-14: never let valid_until / is_stale / stale_at sneak in."""
    props = LUCID_FACTS_MAPPING["mappings"]["properties"]
    for forbidden in ("valid_until", "is_stale", "stale_at"):
        assert forbidden not in props, f"{forbidden} is forbidden on lucid_facts"


def test_dense_vector_dims_match_openai():
    props = LUCID_FACTS_MAPPING["mappings"]["properties"]
    assert props["embedding"]["dims"] == EMBEDDING_DIMS == 1536
    assert props["embedding"]["similarity"] == "cosine"
    assert props["embedding"]["index_options"]["type"] == "hnsw"


def test_lucid_objects_has_nested_connected_objects():
    props = LUCID_OBJECTS_MAPPING["mappings"]["properties"]
    assert props["connected_objects"]["type"] == "nested"
    inner = props["connected_objects"]["properties"]
    assert "target_uid" in inner
    assert "link_type" in inner


def test_lucid_facts_has_entity_layer_fields():
    """feat/mappings-sync-permanent (2026-06-23): codify B-62 entity-
    layer fields on lucid_facts. Without these declarations, the next
    fresh-index create would reproduce the strict_dynamic_mapping_exception
    that crashed every bulk_create_facts call on PO's dev ES.
    """
    props = LUCID_FACTS_MAPPING["mappings"]["properties"]
    for must_have in (
        # spo-decide-payload-wire (this PR)
        "subject_label",
        "object_label",
        "predicate_violation",
        # earlier B-62 natural-spo / structure-resolve fields the
        # runtime put_mapping also patched (already declared in file,
        # asserted here so regressions surface immediately):
        "predicate_code",
        "predicate_label",
        "original_surface",
        "capture_lang",
        "tags",
        "canonical_key",
        "object_canonical",
        "needs_review",
    ):
        assert must_have in props, f"missing {must_have} on lucid_facts"
    # Type sanity on the three new fields:
    assert props["subject_label"]["type"] == "keyword"
    assert props["object_label"]["type"] == "keyword"
    assert props["predicate_violation"]["type"] == "boolean"


def test_lucid_objects_has_entity_layer_fields():
    """feat/mappings-sync-permanent (2026-06-23): codify B-62 entity-
    layer fields on lucid_objects (`primary_label` + `primary_lang`).
    """
    props = LUCID_OBJECTS_MAPPING["mappings"]["properties"]
    for must_have in (
        "primary_label",
        "primary_lang",
        "entity_type",
    ):
        assert must_have in props, f"missing {must_have} on lucid_objects"
    assert props["primary_lang"]["type"] == "keyword"


def test_lucid_sources_minimal_shape():
    props = LUCID_SOURCES_MAPPING["mappings"]["properties"]
    for must_have in (
        "source_uid",
        "domain",
        "source_type",
        "url",
        "first_captured_at",
        "capture_count",
        "knowledge_space_id",
    ):
        assert must_have in props, f"missing {must_have}"
