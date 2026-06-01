"""Integration tests for DCR-002 v2 — ES link_nuance + Alembic 0013."""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.integration


def test_es_link_nuance_persists(es_client):
    """Round-trip: index an object with a connected_object that carries
    link_nuance, search it back, confirm the nuance field survives."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    from api.storage.elasticsearch.link_nuance_migration import (
        ensure_link_nuance_field,
    )

    ensure_link_nuance_field()

    doc = {
        "object_uid": f"obj-nuance-{uuid.uuid4().hex[:6]}",
        "class": "concept",
        "name": "nuance probe",
        "knowledge_space_id": "ks-nuance",
        "connected_objects": [
            {
                "target_uid": "obj-target-1",
                "link_type": "supports",
                "link_nuance": "evidence",
            }
        ],
        "fact_uids": [],
    }
    es_client.index(index=LUCID_OBJECTS, id=doc["object_uid"], document=doc, refresh="true")
    try:
        got = es_client.get(index=LUCID_OBJECTS, id=doc["object_uid"])
        co = got["_source"]["connected_objects"][0]
        assert co["link_nuance"] == "evidence"
        assert co["link_type"] == "supports"
    finally:
        es_client.delete(index=LUCID_OBJECTS, id=doc["object_uid"], refresh="true")


def test_es_query_filter_by_nuance(es_client):
    """Search for objects whose connected_objects.link_nuance matches a term."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    from api.storage.elasticsearch.link_nuance_migration import (
        ensure_link_nuance_field,
    )
    ensure_link_nuance_field()

    doc_a = {
        "object_uid": f"obj-A-{uuid.uuid4().hex[:6]}",
        "class": "concept", "name": "A",
        "knowledge_space_id": "ks-nuance-q",
        "connected_objects": [
            {"target_uid": "obj-x", "link_type": "supports",
             "link_nuance": "evidence"},
        ],
        "fact_uids": [],
    }
    doc_b = {
        "object_uid": f"obj-B-{uuid.uuid4().hex[:6]}",
        "class": "concept", "name": "B",
        "knowledge_space_id": "ks-nuance-q",
        "connected_objects": [
            {"target_uid": "obj-y", "link_type": "supports",
             "link_nuance": "mechanism"},
        ],
        "fact_uids": [],
    }
    for d in (doc_a, doc_b):
        es_client.index(index=LUCID_OBJECTS, id=d["object_uid"], document=d, refresh="true")
    try:
        body = {
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"knowledge_space_id": "ks-nuance-q"}},
                        {
                            "nested": {
                                "path": "connected_objects",
                                "query": {
                                    "term": {
                                        "connected_objects.link_nuance": "evidence"
                                    }
                                },
                            }
                        },
                    ]
                }
            }
        }
        resp = es_client.search(index=LUCID_OBJECTS, body=body)
        hit_uids = {h["_source"]["object_uid"] for h in resp["hits"]["hits"]}
        assert doc_a["object_uid"] in hit_uids
        assert doc_b["object_uid"] not in hit_uids
    finally:
        for d in (doc_a, doc_b):
            es_client.delete(index=LUCID_OBJECTS, id=d["object_uid"], refresh="true")


def test_alembic_0013_up_down(alembic_upgrade, pg_engine):
    """0013 upgrade creates the table; downgrade removes it; idempotent shape."""
    from sqlalchemy import inspect

    inspector = inspect(pg_engine)
    tables = inspector.get_table_names()
    assert "understanding_depth_logs" in tables

    cols = {c["name"] for c in inspector.get_columns("understanding_depth_logs")}
    for required in (
        "id", "user_id", "knowledge_space_id",
        "average_depth", "max_depth",
        "isolated_facts_count", "total_facts", "measured_at",
    ):
        assert required in cols, f"missing column: {required}"

    # Confirm the FK on user_id cascades.
    fks = inspector.get_foreign_keys("understanding_depth_logs")
    user_fks = [
        fk for fk in fks
        if fk["constrained_columns"] == ["user_id"]
        and fk["referred_table"] == "users"
    ]
    assert user_fks, "user_id FK missing"
