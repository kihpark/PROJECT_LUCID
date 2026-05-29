"""Unit tests for api.structure.link_creator (PR-3-2)."""
from __future__ import annotations

from unittest.mock import patch

from api.structure.link_creator import (
    FACT_FACT_LINK_TYPES,
    FACT_OBJECT_LINK_TYPES,
    OBJECT_OBJECT_LINK_TYPES,
    LinkCreationResult,
    create_links,
)


def test_link_type_sets_have_16_total():
    assert len(FACT_OBJECT_LINK_TYPES) == 5
    assert len(OBJECT_OBJECT_LINK_TYPES) == 4
    assert len(FACT_FACT_LINK_TYPES) == 7
    assert (
        len(FACT_OBJECT_LINK_TYPES)
        + len(OBJECT_OBJECT_LINK_TYPES)
        + len(FACT_FACT_LINK_TYPES)
        == 16
    )
    assert "negates" in FACT_FACT_LINK_TYPES


def test_all_fact_object_types_accepted():
    fo = [
        {"fact_uid": f"fn-{i}", "object_uid": f"obj-{i}", "link_type": lt}
        for i, lt in enumerate(FACT_OBJECT_LINK_TYPES, start=1)
    ]
    result = create_links(fact_object_links=fo,
                         es_update_object_adjacency=False)
    assert result.fact_object_count == 5
    assert result.skipped_count == 0


def test_all_fact_fact_types_accepted_and_negates_tracked():
    ff = [
        {"from_uid": f"fn-{i}", "to_uid": f"fn-{i+10}", "link_type": lt}
        for i, lt in enumerate(FACT_FACT_LINK_TYPES, start=1)
    ]
    result = create_links(fact_fact_links=ff, es_update_object_adjacency=False)
    assert result.fact_fact_count == 7
    assert result.negates_count == 1
    assert result.skipped_count == 0


def test_unknown_link_type_is_skipped_and_logged():
    fo = [{"fact_uid": "fn-1", "object_uid": "obj-1",
           "link_type": "FAKE_TYPE"}]
    result = create_links(fact_object_links=fo,
                         es_update_object_adjacency=False)
    assert result.fact_object_count == 0
    assert result.skipped_count == 1


def test_object_object_self_link_skipped():
    oo = [{"from_uid": "obj-1", "to_uid": "obj-1", "link_type": "part_of"}]
    result = create_links(object_object_links=oo,
                         es_update_object_adjacency=False)
    assert result.object_object_count == 0
    assert result.skipped_count == 1


def test_object_object_calls_es_link_objects_when_enabled():
    oo = [
        {"from_uid": "obj-a", "to_uid": "obj-b", "link_type": "part_of"},
        {"from_uid": "obj-b", "to_uid": "obj-c", "link_type": "located_in"},
    ]
    with patch(
        "api.storage.elasticsearch.objects.link_objects"
    ) as mock_link:
        result = create_links(object_object_links=oo,
                             es_update_object_adjacency=True)
    assert result.object_object_count == 2
    assert mock_link.call_count == 2


def test_object_object_does_not_call_es_when_disabled():
    oo = [{"from_uid": "obj-a", "to_uid": "obj-b", "link_type": "part_of"}]
    with patch(
        "api.storage.elasticsearch.objects.link_objects"
    ) as mock_link:
        create_links(object_object_links=oo,
                    es_update_object_adjacency=False)
    mock_link.assert_not_called()


def test_link_creation_result_is_pydantic_model():
    out = create_links(es_update_object_adjacency=False)
    assert isinstance(out, LinkCreationResult)
    dumped = out.model_dump()
    assert dumped["fact_object_count"] == 0
    assert dumped["object_object_count"] == 0
    assert dumped["fact_fact_count"] == 0
    assert dumped["negates_count"] == 0
