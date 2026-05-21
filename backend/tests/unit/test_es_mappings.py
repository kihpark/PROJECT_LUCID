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
    assert set(INDEX_MAPPINGS.keys()) == {
        "lucid_facts",
        "lucid_objects",
        "lucid_sources",
    }


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
