"""Integration tests: Object CRUD + symmetric linking + 1-hop."""
from __future__ import annotations

import pytest

from api.models.base import new_uid
from api.models.objects import Concept, Knowledge, Person

pytestmark = pytest.mark.integration


def test_create_object_with_adjacency(es_indexes, fake_embedding):
    from api.storage.elasticsearch import objects
    obj = Concept(
        object_uid=new_uid(),
        name="Loss aversion",
        knowledge_space_id=new_uid(),
    )
    uid = objects.create_object(obj)
    stored = objects.get_object_by_uid(uid)
    assert stored["name"] == "Loss aversion"


def test_link_objects_symmetric(es_indexes, fake_embedding):
    from api.storage.elasticsearch import objects
    space = new_uid()
    a = Concept(object_uid=new_uid(), name="A", knowledge_space_id=space)
    b = Concept(object_uid=new_uid(), name="B", knowledge_space_id=space)
    objects.create_object(a)
    objects.create_object(b)
    objects.link_objects(a.object_uid, b.object_uid, "part_of")

    a_stored = objects.get_object_by_uid(a.object_uid)
    b_stored = objects.get_object_by_uid(b.object_uid)
    a_targets = [c["target_uid"] for c in a_stored["connected_objects"]]
    b_targets = [c["target_uid"] for c in b_stored["connected_objects"]]
    assert b.object_uid in a_targets
    assert a.object_uid in b_targets


def test_unlink_objects_symmetric(es_indexes, fake_embedding):
    from api.storage.elasticsearch import objects
    space = new_uid()
    a = Concept(object_uid=new_uid(), name="A", knowledge_space_id=space)
    b = Concept(object_uid=new_uid(), name="B", knowledge_space_id=space)
    objects.create_object(a)
    objects.create_object(b)
    objects.link_objects(a.object_uid, b.object_uid, "part_of")
    objects.unlink_objects(a.object_uid, b.object_uid)
    a_stored = objects.get_object_by_uid(a.object_uid)
    b_stored = objects.get_object_by_uid(b.object_uid)
    assert all(c["target_uid"] != b.object_uid for c in a_stored.get("connected_objects", []))
    assert all(c["target_uid"] != a.object_uid for c in b_stored.get("connected_objects", []))


def test_1hop_traversal(es_indexes, fake_embedding):
    from api.storage.elasticsearch import objects
    space = new_uid()
    a = Concept(object_uid=new_uid(), name="A", knowledge_space_id=space)
    b = Concept(object_uid=new_uid(), name="B", knowledge_space_id=space)
    c = Knowledge(object_uid=new_uid(), name="C", knowledge_space_id=space)
    for obj in (a, b, c):
        objects.create_object(obj)
    objects.link_objects(a.object_uid, b.object_uid, "part_of")
    objects.link_objects(a.object_uid, c.object_uid, "instance_of")

    neighbors = objects.get_1hop_neighbors(a.object_uid)
    names = {n["name"] for n in neighbors}
    assert names == {"B", "C"}


def test_1hop_traversal_filtered_by_link_type(es_indexes, fake_embedding):
    from api.storage.elasticsearch import objects
    space = new_uid()
    a = Concept(object_uid=new_uid(), name="A", knowledge_space_id=space)
    b = Concept(object_uid=new_uid(), name="B", knowledge_space_id=space)
    c = Knowledge(object_uid=new_uid(), name="C", knowledge_space_id=space)
    for obj in (a, b, c):
        objects.create_object(obj)
    objects.link_objects(a.object_uid, b.object_uid, "part_of")
    objects.link_objects(a.object_uid, c.object_uid, "instance_of")
    only_part_of = objects.get_1hop_neighbors(a.object_uid, link_type="part_of")
    assert {n["name"] for n in only_part_of} == {"B"}


def test_source_create_or_update_increments_on_same_url(es_indexes):
    """B-48a: dedup key is (KS, url). Capturing the SAME URL twice
    bumps capture_count on the existing doc. Two DIFFERENT URLs on
    the same domain land as two separate Source docs so the
    "검증된 출처 N건" count reflects independent articles, not
    domain-level repetition."""
    from api.storage.elasticsearch import sources
    space = new_uid()
    first = sources.create_or_update_source(
        domain="wsj.com",
        source_type="web_article",
        url="https://wsj.com/a/1",
        knowledge_space_id=space,
        title="article 1",
    )
    same_url = sources.create_or_update_source(
        domain="wsj.com",
        source_type="web_article",
        url="https://wsj.com/a/1",
        knowledge_space_id=space,
        title="article 1 (recaptured)",
    )
    different_url = sources.create_or_update_source(
        domain="wsj.com",
        source_type="web_article",
        url="https://wsj.com/a/2",
        knowledge_space_id=space,
        title="article 2",
    )
    # Same URL → bump; different URL → fresh doc with capture_count=1.
    assert same_url["source_uid"] == first["source_uid"]
    assert same_url["capture_count"] == 2
    assert different_url["source_uid"] != first["source_uid"]
    assert different_url["capture_count"] == 1


def test_index_idempotent_recreation(es_indexes):
    """Calling create_indexes() on a live cluster is a no-op."""
    from api.storage.elasticsearch import indexes
    second = indexes.create_indexes()
    assert all(status == "exists" for status in second.values())
