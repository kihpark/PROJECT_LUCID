"""Integration tests for api.ops.backfill_speaker_uid.

Contracts:
- dry-run never writes
- obj-N placeholder resolves to canonical UID via
  fact -> source_uids[0] -> lucid_sources -> source_job_id ->
  source_jobs.extracted_metadata.structure.objects[N-1].uid
- not_found counts when the placeholder cannot be resolved
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from api.ops.backfill_speaker_uid import backfill_speaker_uid
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_SOURCES,
    get_client,
)
from tests.integration.conftest import create_user_via_orm

pytestmark = pytest.mark.integration


def _seed_source_doc(es_client, *, source_uid, ks_id, source_job_id):
    doc = {
        "source_uid": source_uid,
        "knowledge_space_id": ks_id,
        "source_job_id": str(source_job_id),
        "url": "https://example.com/test",
        "title": "test source",
    }
    es_client.index(
        index=LUCID_SOURCES, id=source_uid, document=doc, refresh="wait_for"
    )
    return source_uid


def _seed_claim_fact(es_client, *, ks_id, source_uid, speaker_uid):
    fact_uid = f"f-{uuid.uuid4().hex[:12]}"
    doc = {
        "fact_uid": fact_uid,
        "fact_type": "claim",
        "knowledge_space_id": ks_id,
        "subject_uid": "subj-x",
        "predicate": "said",
        "source_uids": [source_uid],
        "speaker_uid": speaker_uid,
        "speaker_label": "test speaker",
    }
    es_client.index(
        index=LUCID_FACTS, id=fact_uid, document=doc, refresh="wait_for"
    )
    return fact_uid


def _delete(es_client, index, doc_id):
    try:
        es_client.delete(index=index, id=doc_id, refresh="wait_for")
    except Exception:
        pass


def _seed_source_job(pg_engine, user_id, space_id, structure_objects):
    from api.storage.postgres.orm import SourceJobORM
    from sqlalchemy.orm import sessionmaker

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    with sm() as s:
        j = SourceJobORM(
            user_id=uuid.UUID(user_id),
            knowledge_space_id=uuid.UUID(space_id),
            source_url="https://example.com/test",
            source_type="web_article",
            captured_from="chrome_ext",
            captured_at=datetime.now(UTC),
            raw_payload=b"",
            status="structured",
            extracted_text="text",
            extracted_metadata={"structure": {"objects": structure_objects}},
        )
        s.add(j)
        s.commit()
        s.refresh(j)
        return str(j.id)


def _delete_source_job(pg_engine, job_id):
    from api.storage.postgres.orm import SourceJobORM
    from sqlalchemy.orm import sessionmaker

    sm = sessionmaker(bind=pg_engine, expire_on_commit=False)
    with sm() as s:
        j = s.get(SourceJobORM, uuid.UUID(job_id))
        if j:
            s.delete(j)
            s.commit()


@pytest.fixture
def fresh_user_and_ks(pg_engine, alembic_upgrade, es_indexes):
    """Create a real user + ks (FK satisfied) and re-ensure indexes."""
    from api.storage.elasticsearch import indexes
    indexes.create_indexes()
    email = f"bsu-{uuid.uuid4().hex[:8]}@lucid.example"
    user_id, space_id = create_user_via_orm(
        pg_engine, email, "longerthan8chars!"
    )
    return user_id, space_id


def test_dry_run_does_not_write(es_client, pg_engine, fresh_user_and_ks):
    """Dry-run reports updated=1 but ES doc still has obj-1."""
    user_id, space_id = fresh_user_and_ks
    job_id = None
    source_uid = f"src-{uuid.uuid4().hex[:12]}"
    fact_uid = None
    try:
        job_id = _seed_source_job(
            pg_engine, user_id, space_id,
            [{"uid": "canonical-x", "name": "foo", "class": "person"}],
        )
        _seed_source_doc(
            es_client, source_uid=source_uid, ks_id=space_id,
            source_job_id=job_id,
        )
        fact_uid = _seed_claim_fact(
            es_client, ks_id=space_id, source_uid=source_uid,
            speaker_uid="obj-1",
        )

        es_client.indices.refresh(index=LUCID_FACTS)
        result = backfill_speaker_uid(space_id, dry_run=True)

        assert result["dry_run"] is True
        assert result["updated"] == 1
        assert result["not_found"] == 0

        es_client.indices.refresh(index=LUCID_FACTS)
        src = es_client.get(index=LUCID_FACTS, id=fact_uid)["_source"]
        assert src["speaker_uid"] == "obj-1", "dry-run must not write"
    finally:
        if fact_uid:
            _delete(es_client, LUCID_FACTS, fact_uid)
        _delete(es_client, LUCID_SOURCES, source_uid)
        if job_id:
            _delete_source_job(pg_engine, job_id)


def test_apply_maps_obj_n_to_canonical(es_client, pg_engine, fresh_user_and_ks):
    """Apply: speaker_uid obj-2 becomes structure.objects[1].uid."""
    user_id, space_id = fresh_user_and_ks
    job_id = None
    source_uid = f"src-{uuid.uuid4().hex[:12]}"
    fact_uid = None
    try:
        job_id = _seed_source_job(
            pg_engine, user_id, space_id,
            [
                {"uid": "canonical-zero", "name": "first", "class": "person"},
                {"uid": "canonical-one", "name": "second", "class": "person"},
            ],
        )
        _seed_source_doc(
            es_client, source_uid=source_uid, ks_id=space_id,
            source_job_id=job_id,
        )
        fact_uid = _seed_claim_fact(
            es_client, ks_id=space_id, source_uid=source_uid,
            speaker_uid="obj-2",
        )

        es_client.indices.refresh(index=LUCID_FACTS)
        result = backfill_speaker_uid(space_id, dry_run=False)

        assert result["dry_run"] is False
        assert result["updated"] == 1
        assert result["not_found"] == 0

        es_client.indices.refresh(index=LUCID_FACTS)
        src = es_client.get(index=LUCID_FACTS, id=fact_uid)["_source"]
        assert src["speaker_uid"] == "canonical-one"
    finally:
        if fact_uid:
            _delete(es_client, LUCID_FACTS, fact_uid)
        _delete(es_client, LUCID_SOURCES, source_uid)
        if job_id:
            _delete_source_job(pg_engine, job_id)


def test_missing_canonical_counts_as_not_found(
    es_client, pg_engine, fresh_user_and_ks
):
    """obj-99 has no position in structure.objects -> not_found."""
    user_id, space_id = fresh_user_and_ks
    job_id = None
    source_uid = f"src-{uuid.uuid4().hex[:12]}"
    fact_uid = None
    try:
        job_id = _seed_source_job(
            pg_engine, user_id, space_id,
            [{"uid": "canonical-zero", "name": "only", "class": "person"}],
        )
        _seed_source_doc(
            es_client, source_uid=source_uid, ks_id=space_id,
            source_job_id=job_id,
        )
        fact_uid = _seed_claim_fact(
            es_client, ks_id=space_id, source_uid=source_uid,
            speaker_uid="obj-99",
        )

        es_client.indices.refresh(index=LUCID_FACTS)
        result = backfill_speaker_uid(space_id, dry_run=False)

        assert result["updated"] == 0
        assert result["not_found"] == 1

        es_client.indices.refresh(index=LUCID_FACTS)
        src = es_client.get(index=LUCID_FACTS, id=fact_uid)["_source"]
        assert src["speaker_uid"] == "obj-99"
    finally:
        if fact_uid:
            _delete(es_client, LUCID_FACTS, fact_uid)
        _delete(es_client, LUCID_SOURCES, source_uid)
        if job_id:
            _delete_source_job(pg_engine, job_id)
