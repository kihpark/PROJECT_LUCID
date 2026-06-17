"""B-39 fix 3: idempotent replay of accepted/edited validation_logs
into lucid_facts.

Why this exists
---------------
The Validate route writes BOTH to validation_logs (Postgres,
anonymised per DCR-001) AND to lucid_facts (Elasticsearch, the
searchable surface for recall). The two layers are durable in
different ways: Postgres rides the `postgres_data` named volume
that has always been there; lucid_facts rides `es_data` (added with
the same pattern) but was wiped at least once by the
integration-test session fixture (B-38). After such a wipe the
validation_logs row count is intact while lucid_facts is empty —
the user keeps their audit trail but recall returns nothing.

This module replays every accept/edit log into lucid_facts using
the source job's stored structure metadata to reconstruct the
FactNode body. Discard logs are skipped (correctly absent from
recall surfaces). Re-running the replay produces the same set of
documents (ES `id=fact_uid` per the normal create_fact path).

CLI
---
    docker compose exec backend python -m api.storage.elasticsearch.replay

Returns a small JSON-shaped summary on stdout for ops use.
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from api.models.facts import FactNode, FactType
from api.models.objects import Object, ObjectClass
from api.storage.elasticsearch.client import LUCID_FACTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.elasticsearch.facts import create_fact
from api.storage.elasticsearch.objects import create_object
from api.storage.postgres.orm import SourceJobORM, ValidationLog
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.replay")


def _facts_index(job: SourceJobORM) -> dict[str, dict[str, Any]]:
    """Build a fact_uid -> fact dict from the job's structure metadata."""
    meta = job.extracted_metadata or {}
    struct = meta.get("structure") or {}
    facts = struct.get("facts") or struct.get("facts_summary") or []
    out: dict[str, dict[str, Any]] = {}
    for f in facts:
        key = f.get("fact_uid") or f.get("uid")
        if key:
            out[key] = f
    return out


def _coerce_to_factnode(
    fact_summary: dict[str, Any],
    *,
    knowledge_space_id: str,
    validator_id: str,
) -> FactNode:
    """Reconstruct a FactNode from the structure-stage summary.

    Mirrors api/routes/validate.py:_coerce_fact_to_factnode but
    operates from THIS module's import surface so the replay can be
    called outside the request lifecycle.
    """
    raw_type = fact_summary.get("type") or fact_summary.get("type_") or "proposition"
    try:
        fact_type = FactType(raw_type)
    except ValueError:
        fact_type = FactType.PROPOSITION
    fact_uid = fact_summary.get("fact_uid") or fact_summary["uid"]
    return FactNode(
        fact_uid=fact_uid,
        claim=fact_summary.get("claim") or "",
        type=fact_type,
        subject_uid=fact_summary.get("subject_uid") or "unknown",
        predicate=fact_summary.get("predicate") or "claim",
        object_value=fact_summary.get("object_value") or "",
        validation_method="manual",
        validator_id=validator_id,
        knowledge_space_id=knowledge_space_id,
        negation_flag=bool(fact_summary.get("negation_flag", False)),
        negation_scope=fact_summary.get("negation_scope"),
    )


def _upsert_objects_for_job(
    job: SourceJobORM,
    *,
    knowledge_space_id: str,
    seen_uids: set[str],
) -> int:
    """Idempotent ES upsert for every object stored on the job's
    structure metadata. Returns the count of NEW uids written this
    call (already-seen uids are skipped to keep the running counter
    accurate across multiple replay rounds)."""
    meta = job.extracted_metadata or {}
    struct = meta.get("structure") or {}
    objects = struct.get("objects") or []
    written = 0
    for o in objects:
        uid = o.get("uid") or o.get("object_uid")
        if not uid or uid in seen_uids:
            continue
        try:
            cls_value = o.get("class") or o.get("class_") or "concept"
            try:
                cls = (
                    ObjectClass(cls_value)
                    if not isinstance(cls_value, ObjectClass)
                    else cls_value
                )
            except ValueError:
                cls = ObjectClass.CONCEPT
            obj = Object.model_validate(
                {
                    "object_uid": uid,
                    "class": cls,
                    "name": o.get("name") or uid,
                    "name_en": o.get("name_en"),
                    "properties": o.get("properties") or {},
                    "knowledge_space_id": knowledge_space_id,
                },
            )
            create_object(obj, with_embedding=False)
            seen_uids.add(uid)
            written += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("replay: upsert object %s failed: %s", uid, exc)
    return written


def replay_validation_logs() -> dict[str, Any]:
    """Replay accept + edit validation_logs into lucid_facts.

    Discards are skipped (they correctly never reach the recall
    surface). Errors on individual facts are logged but don't abort
    the run — the goal is to recover as much as possible after a wipe.
    """
    sm = make_sessionmaker()
    s = sm()
    client = get_client()
    indexed = 0
    skipped_discard = 0
    skipped_no_fact = 0
    skipped_no_job = 0
    errors: list[str] = []
    indexed_uids: set[str] = set()
    upserted_object_uids: set[str] = set()

    try:
        # Pull accept + edit logs only; one row per (fact, action) pair.
        # Order by validated_at so the LAST decision on a given fact_uid
        # wins (mirrors the live route which overwrites in ES).
        rows = s.scalars(
            select(ValidationLog)
            .where(ValidationLog.action.in_(("accept", "edit")))
            .where(ValidationLog.fact_uid.is_not(None))
            .order_by(ValidationLog.validated_at),
        ).all()

        # Cache jobs we've fetched so multi-fact replays don't requery.
        job_cache: dict[str, SourceJobORM | None] = {}

        for log in rows:
            if log.source_job_id is None:
                skipped_no_job += 1
                continue
            job = job_cache.get(str(log.source_job_id))
            if job is None and str(log.source_job_id) not in job_cache:
                job = s.get(SourceJobORM, log.source_job_id)
                job_cache[str(log.source_job_id)] = job
            if job is None:
                skipped_no_job += 1
                continue

            facts_by_uid = _facts_index(job)
            fact = facts_by_uid.get(log.fact_uid or "")
            if fact is None:
                skipped_no_fact += 1
                continue

            try:
                node = _coerce_to_factnode(
                    fact,
                    knowledge_space_id=str(job.knowledge_space_id),
                    validator_id=str(log.validator_id),
                )
                # Embedding: best-effort. On API failure / no key, fall
                # back to a zero vector so the doc still indexes (kNN
                # against the zero vector just won't match meaningfully).
                emb_text = node.claim
                try:
                    embedding = get_embedding(emb_text)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "embedding failed for %s: %s; using zero vector",
                        node.fact_uid, exc,
                    )
                    embedding = None
                # `with_embedding=False` keeps create_fact from doing its
                # own embedding lookup — we set it explicitly here.
                create_fact(node, with_embedding=False)
                # Patch the document with the embedding + validated_at
                # we just computed.
                client.update(
                    index=LUCID_FACTS,
                    id=node.fact_uid,
                    doc={
                        "embedding": list(embedding) if embedding is not None else [0.0] * 1536,
                        "validated_at": (
                            log.validated_at.isoformat()
                            if log.validated_at
                            else datetime.now(UTC).isoformat()
                        ),
                    },
                    refresh="wait_for",
                )
                indexed += 1
                indexed_uids.add(node.fact_uid)
                # B-41: idempotently mirror this job's Objects into
                # lucid_objects so the recall label lookup can resolve
                # canonical UUIDs to names.
                _upsert_objects_for_job(
                    job,
                    knowledge_space_id=str(job.knowledge_space_id),
                    seen_uids=upserted_object_uids,
                )
            except Exception as exc:  # noqa: BLE001 - keep going
                errors.append(f"{log.fact_uid}: {exc}")
                logger.exception("replay failed for %s", log.fact_uid)

    finally:
        s.close()

    summary = {
        "indexed": indexed,
        "unique_fact_uids": len(indexed_uids),
        "objects_indexed": len(upserted_object_uids),
        "skipped_discard": skipped_discard,
        "skipped_fact_missing": skipped_no_fact,
        "skipped_job_missing": skipped_no_job,
        "errors": errors,
    }
    return summary


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    result = replay_validation_logs()
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
