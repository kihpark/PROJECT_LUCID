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
import re
import sys
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select

from api.models.base import new_uid
from api.models.facts import FactNode, FactType
from api.models.objects import Object, ObjectClass
from api.storage.elasticsearch.client import LUCID_FACTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding
from api.storage.elasticsearch.facts import (
    attach_source_to_fact,
    create_fact,
    find_fact_by_spo,
)
from api.storage.elasticsearch.objects import create_object
from api.storage.elasticsearch.sources import create_or_update_source
from api.storage.postgres.orm import SourceJobORM, ValidationLog
from api.storage.postgres.session import make_sessionmaker

# B-48a: same placeholder shape as the processor uses.
_FACT_PLACEHOLDER_RE = re.compile(r"^fn-\d+(?:-[a-z])?$", re.IGNORECASE)


def _ensure_source_for_job_replay(
    job: SourceJobORM, knowledge_space_id: str,
) -> str | None:
    """Mirror of the validate-path helper, but reachable from replay
    (no FastAPI dependencies). Returns the source_uid (creates the
    lucid_sources doc on first call per URL)."""
    domain = ""
    try:
        domain = urlparse(job.source_url).hostname or ""
    except Exception:  # noqa: BLE001
        pass
    try:
        src = create_or_update_source(
            domain=domain,
            source_type=str(job.source_type),
            url=job.source_url,
            knowledge_space_id=knowledge_space_id,
            source_job_id=str(job.id),
            captured_at=job.captured_at.isoformat() if job.captured_at else None,
        )
        return src.get("source_uid")
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay: ensure_source failed: %s", exc)
        return None

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
    fact_uid_override: str | None = None,
    source_uid: str | None = None,
    object_uid_remap: dict[str, str] | None = None,
) -> FactNode:
    """Reconstruct a FactNode from the structure-stage summary.

    Mirrors api/routes/validate.py:_coerce_fact_to_factnode but
    operates from THIS module's import surface so the replay can be
    called outside the request lifecycle.

    B-48a: `fact_uid_override` substitutes the LLM placeholder
    (fn-N) with a canonical UUID4 issued at replay time, so multi-job
    `fn-1` collisions stop overwriting each other in ES. `source_uid`
    seeds the FactNode's provenance from the start.

    B-48a-2: `object_uid_remap` maps THIS job's structure-metadata
    object uids (mostly LLM placeholders like `obj-5`) to their
    canonical UUID4. Applied to `subject_uid` always; applied to
    `object_value` only when it shapes like an entity ref (so
    literals like '135 USD' stay untouched).
    """
    raw_type = fact_summary.get("type") or fact_summary.get("type_") or "proposition"
    try:
        fact_type = FactType(raw_type)
    except ValueError:
        fact_type = FactType.PROPOSITION
    raw_fact_uid = fact_uid_override or (
        fact_summary.get("fact_uid") or fact_summary["uid"]
    )

    subject_uid = fact_summary.get("subject_uid") or "unknown"
    object_value = fact_summary.get("object_value") or ""
    if object_uid_remap:
        if subject_uid in object_uid_remap:
            subject_uid = object_uid_remap[subject_uid]
        if object_value in object_uid_remap:
            object_value = object_uid_remap[object_value]

    return FactNode(
        fact_uid=raw_fact_uid,
        claim=fact_summary.get("claim") or "",
        type=fact_type,
        subject_uid=subject_uid,
        predicate=fact_summary.get("predicate") or "claim",
        object_value=object_value,
        validation_method="manual",
        validator_id=validator_id,
        knowledge_space_id=knowledge_space_id,
        source_uids=[source_uid] if source_uid else [],
        negation_flag=bool(fact_summary.get("negation_flag", False)),
        negation_scope=fact_summary.get("negation_scope"),
    )


def _augment_remap_with_fact_subjects(
    job: SourceJobORM,
    uid_remap: dict[str, str],
    canonical_by_name_class: dict[tuple[str, str], str],
) -> None:
    """B-48a-2 second pass: some old jobs' structure metadata holds the
    LLM placeholder uid in `objects[]` but stores an *already-canonical*
    UUID4 in `fact.subject_uid` (a previous B-35 run remapped the fact
    but never the metadata's objects array). The first pass only built
    `placeholder → canonical` entries; this pass adds `stale_canonical →
    canonical` entries by matching the fact's subject_uid back to one
    of this job's objects through the fact_object_links — and, as a
    fallback, by detecting which object's `name` appears in the claim.
    Mutates `uid_remap` in place.
    """
    meta = job.extracted_metadata or {}
    struct = meta.get("structure") or {}
    facts = struct.get("facts") or []
    objects = struct.get("objects") or []
    # The structure metadata stores the link COUNT under
    # `fact_object_links` (int) and the actual list under
    # `fact_object_links_detail`. Only the list is iterable.
    raw_links = struct.get("fact_object_links_detail")
    if not isinstance(raw_links, list):
        raw_links = struct.get("fact_object_links")
    links = raw_links if isinstance(raw_links, list) else []
    obj_by_orig: dict[str, dict[str, str]] = {}
    for o in objects:
        u = o.get("uid") or o.get("object_uid")
        n = o.get("name")
        c = (o.get("class") or o.get("class_") or "concept")
        if u and n:
            obj_by_orig[u] = {"name": n, "class": c}
    if not obj_by_orig:
        return
    for f in facts:
        subj = f.get("subject_uid")
        if not subj or subj in uid_remap:
            continue
        fact_uid = f.get("uid") or f.get("fact_uid")
        # Path 1: linked objects via fact_object_links — common case.
        candidate_objs: list[dict[str, str]] = []
        for link in links:
            if link.get("fact_uid") != fact_uid:
                continue
            link_obj_uid = link.get("object_uid")
            if link_obj_uid in obj_by_orig:
                candidate_objs.append(obj_by_orig[link_obj_uid])
        # Path 2: fall back to name-in-claim if exactly one matches.
        if not candidate_objs:
            claim = f.get("claim") or ""
            for info in obj_by_orig.values():
                if info["name"] and info["name"] in claim:
                    candidate_objs.append(info)
        if not candidate_objs:
            continue
        # Prefer the first object whose name appears at the very start
        # of the claim (subject is usually first); else take the first
        # candidate.
        claim = f.get("claim") or ""
        chosen = None
        for info in candidate_objs:
            if claim.startswith(info["name"]):
                chosen = info
                break
        if chosen is None:
            chosen = candidate_objs[0]
        key = (chosen["name"], chosen["class"])
        canonical = canonical_by_name_class.get(key)
        if canonical:
            uid_remap[subj] = canonical


def _upsert_objects_for_job(
    job: SourceJobORM,
    *,
    knowledge_space_id: str,
    seen_canonical_uids: set[str],
    canonical_by_name_class: dict[tuple[str, str], str],
) -> tuple[int, dict[str, str]]:
    """Idempotent ES upsert for every object stored on the job's
    structure metadata.

    B-48a-2 (entity canonical merge):
    - Each object is keyed by its (KS, name, class) — NOT by the
      structure-metadata uid, which is a per-job LLM placeholder
      (`obj-5` can mean a different entity in two jobs).
    - If a same (KS, name, class) already lives in `lucid_objects`,
      its canonical UUID4 is reused; otherwise a fresh UUID4 is minted
      and a new doc indexed. Placeholder uids never reach the index.
    - Returns (newly_written_count, job_local_uid_remap) where the
      remap maps THIS job's `obj-N` placeholders to their canonical
      UUID4 — the caller threads this through every FactNode build so
      `subject_uid` / `object_value` join correctly against the
      canonical Object doc.
    """
    from api.models.base import new_uid
    from api.storage.elasticsearch.objects import find_object_by_name_class

    meta = job.extracted_metadata or {}
    struct = meta.get("structure") or {}
    objects = struct.get("objects") or []
    written = 0
    uid_remap: dict[str, str] = {}
    for o in objects:
        raw_uid = o.get("uid") or o.get("object_uid")
        name = o.get("name")
        if not raw_uid or not name:
            continue
        cls_value = o.get("class") or o.get("class_") or "concept"
        try:
            cls = (
                ObjectClass(cls_value)
                if not isinstance(cls_value, ObjectClass)
                else cls_value
            )
        except ValueError:
            cls = ObjectClass.CONCEPT
        key = (name, cls.value)
        canonical_uid = canonical_by_name_class.get(key)
        if canonical_uid is None:
            try:
                existing = find_object_by_name_class(
                    knowledge_space_id, name, cls.value,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("replay: find_object lookup failed for %s: %s", name, exc)
                existing = None
            if existing is not None:
                canonical_uid = existing["object_uid"]
            else:
                canonical_uid = new_uid()
                try:
                    obj = Object.model_validate(
                        {
                            "object_uid": canonical_uid,
                            "class": cls,
                            "name": name,
                            "name_en": o.get("name_en"),
                            "properties": o.get("properties") or {},
                            "knowledge_space_id": knowledge_space_id,
                        },
                    )
                    create_object(obj, with_embedding=False)
                    seen_canonical_uids.add(canonical_uid)
                    written += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "replay: upsert object %s failed: %s", name, exc,
                    )
                    continue
            canonical_by_name_class[key] = canonical_uid
        uid_remap[raw_uid] = canonical_uid
    return written, uid_remap


def replay_validation_logs() -> dict[str, Any]:
    """Replay accept + edit validation_logs into lucid_facts.

    Discards are skipped (they correctly never reach the recall
    surface). Errors on individual facts are logged but don't abort
    the run — the goal is to recover as much as possible after a wipe.

    B-48a:
    - Every LLM-placeholder fact uid (fn-N) is mapped to a fresh
      canonical UUID4 per (job, placeholder) so multi-job `fn-1`
      collisions stop overwriting each other (the 86→23 mystery).
    - Every job gets a lucid_sources doc; every replayed fact carries
      that source_uid in its source_uids list.
    - S/P/O dedup runs: when two replayed facts share the canonical
      triple in the same KS, the second one attaches its source_uid
      to the first instead of creating a duplicate doc.

    B-48a-2 (entity canonical merge):
    - Object upsert is now (KS, name, class)-keyed. Placeholder uids
      (`obj-N`) NEVER reach lucid_objects; they are replaced with a
      canonical UUID4 the moment the structure metadata is replayed.
    - The same job's `obj-N → canonical` map is threaded into the
      FactNode build so `subject_uid` and entity-shaped `object_value`
      join correctly. A fact whose subject was `obj-1` in Job A and
      `obj-4` in Job B — both meaning "SpaceX" — converges on a
      single canonical Object doc and a single facet bar.
    """
    sm = make_sessionmaker()
    s = sm()
    client = get_client()
    indexed = 0
    deduped = 0  # B-48a: count of replays that merged into an existing doc
    sources_created = 0  # number of UNIQUE source URLs we ensured
    skipped_discard = 0
    skipped_no_fact = 0
    skipped_no_job = 0
    errors: list[str] = []
    indexed_uids: set[str] = set()
    upserted_object_uids: set[str] = set()
    # B-48a per-job canonical fact_uid assignments, so the same
    # placeholder seen twice within a job's logs (e.g. an edit after
    # an accept) maps to the same UUID4.
    fact_uid_remap: dict[tuple[str, str], str] = {}
    # B-48a per-job source_uid cache, populated lazily.
    source_uid_cache: dict[str, str | None] = {}
    # B-48a-2 per-job object uid remap, computed on first object
    # upsert for that job and reused for every fact thereafter.
    object_uid_remap_by_job: dict[str, dict[str, str]] = {}
    # B-48a-2 cross-job canonical lookup so two jobs that mention the
    # same (name, class) entity converge on a single canonical uid.
    canonical_by_name_class: dict[tuple[str, str], str] = {}

    def _canonical_for(job_id: str, raw_fact_uid: str) -> str:
        if not _FACT_PLACEHOLDER_RE.match(raw_fact_uid):
            return raw_fact_uid
        key = (job_id, raw_fact_uid)
        if key not in fact_uid_remap:
            fact_uid_remap[key] = new_uid()
        return fact_uid_remap[key]

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
                ks_id = str(job.knowledge_space_id)
                job_key = str(job.id)

                # B-48a: ensure source for this job (cached).
                if job_key not in source_uid_cache:
                    source_uid_cache[job_key] = _ensure_source_for_job_replay(
                        job, ks_id,
                    )
                    if source_uid_cache[job_key]:
                        sources_created += 1
                source_uid = source_uid_cache[job_key]

                # B-48a-2: ensure objects + per-job placeholder→canonical
                # remap (cached). The remap is what makes facts converge
                # on a single canonical Object doc instead of carrying
                # job-local `obj-N` shadows into ES. The second pass
                # (_augment) handles the harder case where fact.subject_uid
                # is a stale canonical from a prior B-35 run that doesn't
                # appear in this job's objects[] array.
                if job_key not in object_uid_remap_by_job:
                    written, remap = _upsert_objects_for_job(
                        job,
                        knowledge_space_id=ks_id,
                        seen_canonical_uids=upserted_object_uids,
                        canonical_by_name_class=canonical_by_name_class,
                    )
                    _augment_remap_with_fact_subjects(
                        job, remap, canonical_by_name_class,
                    )
                    object_uid_remap_by_job[job_key] = remap
                obj_remap = object_uid_remap_by_job[job_key]

                # B-48a: canonical fact_uid for this (job, placeholder).
                canonical_uid = _canonical_for(job_key, log.fact_uid or "")

                node = _coerce_to_factnode(
                    fact,
                    knowledge_space_id=ks_id,
                    validator_id=str(log.validator_id),
                    fact_uid_override=canonical_uid,
                    source_uid=source_uid,
                    object_uid_remap=obj_remap,
                )

                # B-48a S/P/O dedup: if this triple already exists in
                # the index (from a prior replay round, or another job
                # in this same round), attach the source_uid instead
                # of writing a duplicate fact doc.
                existing = None
                try:
                    existing = find_fact_by_spo(
                        ks_id, node.subject_uid, node.predicate, node.object_value,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "replay: dedup lookup failed for %s: %s",
                        log.fact_uid, exc,
                    )
                if existing is not None and source_uid:
                    existing_uid = existing.get("fact_uid")
                    if existing_uid:
                        try:
                            attach_source_to_fact(existing_uid, source_uid)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "replay: attach_source failed for %s: %s",
                                existing_uid, exc,
                            )
                        deduped += 1
                        # B-48a-2: objects + remap already ensured above
                        # (the cached upsert ran when this job was first
                        # touched). Nothing to do on the dedup path.
                        continue

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
                # B-48a-2: objects + remap already ensured above when
                # this job was first touched; nothing to do here.
            except Exception as exc:  # noqa: BLE001 - keep going
                errors.append(f"{log.fact_uid}: {exc}")
                logger.exception("replay failed for %s", log.fact_uid)

    finally:
        s.close()

    # B-48a-2 final pass: any fact whose subject_uid still doesn't
    # have a doc in lucid_objects (rare — abstract subjects like
    # "the issue", or test fixtures) gets a stub Object so the recall
    # label lookup never falls back to displaying a raw uid. The stub
    # class is `concept` (deliberately not a strong claim about the
    # entity's nature); the name is derived from the claim's first
    # noun-ish substring. B-48b can let the user rename it.
    try:
        stub_written = _create_stub_objects_for_orphans(client)
        summary_stubs = stub_written
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay: stub-object pass failed: %s", exc)
        summary_stubs = 0

    summary = {
        "indexed": indexed,
        "unique_fact_uids": len(indexed_uids),
        "deduped_into_existing": deduped,
        "sources_created": sources_created,
        "objects_indexed": len(upserted_object_uids),
        "stub_objects_created": summary_stubs,
        "skipped_discard": skipped_discard,
        "skipped_fact_missing": skipped_no_fact,
        "skipped_job_missing": skipped_no_job,
        "errors": errors,
    }
    return summary


def _create_stub_objects_for_orphans(client: Any) -> int:
    """B-48a-2 fallback: scan lucid_facts for any subject_uid not
    present in lucid_objects and index a minimal concept Object so
    recall's label lookup resolves to *something* readable. Returns
    the count of stubs created."""
    from api.models.base import utc_now
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    written = 0
    facts = client.search(index=LUCID_FACTS, size=1000)["hits"]["hits"]
    seen_orphans: set[tuple[str, str]] = set()
    for h in facts:
        s = h["_source"]
        subj = s.get("subject_uid")
        ks = s.get("knowledge_space_id")
        if not subj or not ks:
            continue
        key = (ks, subj)
        if key in seen_orphans:
            continue
        if client.exists(index=LUCID_OBJECTS, id=subj):
            continue
        seen_orphans.add(key)
        # Derive a readable name from the claim — first 40 chars, no
        # trailing whitespace. Better than "(unknown)".
        claim = (s.get("claim") or "").strip()
        stub_name = (claim[:40] + "…") if len(claim) > 40 else (claim or subj)
        body = {
            "object_uid": subj,
            "class": "concept",
            "name": stub_name,
            "name_en": None,
            "properties": {"stub": "true"},
            "knowledge_space_id": ks,
            "created_at": utc_now().isoformat(),
            "updated_at": utc_now().isoformat(),
        }
        # Drop the None so the strict mapping doesn't reject.
        if body["name_en"] is None:
            body.pop("name_en", None)
        try:
            client.index(
                index=LUCID_OBJECTS, id=subj, document=body, refresh="wait_for",
            )
            written += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("replay: stub object index failed for %s: %s", subj, exc)
    return written


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    result = replay_validation_logs()
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
