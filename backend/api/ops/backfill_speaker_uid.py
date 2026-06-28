"""Backfill speaker_uid for CLAIM facts with obj-N placeholders.

Stage 1 (M3-2a discovery 발견): processor.py:558 의 speaker_uid 가
uid_map 미적용 → live KS 의 99/100 CLAIM 이 obj-N placeholder.
Stage 1 hotfix (5d32169) 가 새 캡처 정상. 옛 99 docs 복구 필요.

Lookup path (★ 2-hop, fact doc 에 source_job_id 없음):
    fact.source_uids[0] → lucid_sources/_doc/{source_uid} → source_job_id
    → source_jobs.extracted_metadata.structure.objects[N-1].uid
    (이미 canonical UID 로 매핑됨 — _serialize_struct_object 가
    uid_map 적용 후 저장)

Safety net: if structure.objects[N-1] missing/malformed, fall back to
name+class lookup on lucid_objects.

Default dry-run; pass --apply to mutate.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import text

from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.ops.backfill_speaker_uid")

_OBJ_PLACEHOLDER_RE = re.compile(r"^obj-(\d+)$", re.IGNORECASE)


def _candidate_query(ks_id: str | None) -> dict[str, Any]:
    q: dict[str, Any] = {
        "bool": {
            "filter": [
                {"term": {"fact_type": "claim"}},
                {"regexp": {"speaker_uid": "obj-[0-9]+"}},
            ]
        }
    }
    if ks_id:
        q["bool"]["filter"].append({"term": {"knowledge_space_id": ks_id}})
    return q


def _lookup_source_job_id(client, source_uid: str) -> str | None:
    """Fetch lucid_sources doc and return its source_job_id."""
    try:
        doc = client.get(index=LUCID_SOURCES, id=source_uid)
        return doc["_source"].get("source_job_id")
    except Exception:  # noqa: BLE001 - missing source doc => skip
        return None


def _resolve_canonical_uid_from_structure(
    objects: list[dict[str, Any]], placeholder: str
) -> tuple[str | None, dict[str, Any] | None]:
    """Map obj-N -> canonical UID using positional structure.objects.

    Returns (canonical_uid_or_None, obj_dict_for_fallback_or_None).
    """
    m = _OBJ_PLACEHOLDER_RE.match(placeholder)
    if not m:
        return None, None
    idx = int(m.group(1)) - 1
    if idx < 0 or idx >= len(objects):
        return None, None
    obj = objects[idx] or {}
    canonical = obj.get("uid") or obj.get("object_uid")
    if isinstance(canonical, str) and canonical and not _OBJ_PLACEHOLDER_RE.match(canonical):
        return canonical, obj
    return None, obj


def _resolve_canonical_uid_via_objects_index(
    client,
    ks_id: str,
    obj_dict: dict[str, Any],
) -> str | None:
    """Safety net: look up canonical lucid_objects by name + class."""
    name = obj_dict.get("name") or obj_dict.get("primary_label")
    class_ = obj_dict.get("class") or obj_dict.get("entity_type")
    if not name:
        return None
    filters: list[dict[str, Any]] = [
        {"term": {"knowledge_space_id": ks_id}},
        {"term": {"name.keyword": name}},
    ]
    if class_:
        filters.append({"term": {"class": class_}})
    obj_q = {
        "bool": {
            "filter": filters,
            "must_not": [{"exists": {"field": "retired_by_merge"}}],
        }
    }
    try:
        res = client.search(index=LUCID_OBJECTS, size=1, query=obj_q)
    except Exception:  # noqa: BLE001
        return None
    hits = res["hits"]["hits"]
    if not hits:
        return None
    src = hits[0]["_source"]
    return src.get("object_uid") or hits[0]["_id"]


def backfill_speaker_uid(
    ks_id: str | None = None, dry_run: bool = True
) -> dict[str, Any]:
    """Resolve obj-N placeholder speaker_uid -> canonical Object UID.

    Iterates CLAIM facts whose speaker_uid matches obj-N. For each,
    walks fact -> source_uids[0] -> lucid_sources -> source_job_id ->
    source_jobs.extracted_metadata.structure.objects[N-1].uid.
    """
    client = get_client()
    Session = make_sessionmaker()

    cand_q = _candidate_query(ks_id)
    res = client.search(
        index=LUCID_FACTS,
        size=500,
        query=cand_q,
        _source=[
            "fact_uid",
            "source_uids",
            "speaker_uid",
            "speaker_label",
            "knowledge_space_id",
        ],
    )
    hits = res["hits"]["hits"]

    updated = 0
    skipped = 0
    not_found = 0

    with Session() as session:
        for hit in hits:
            src = hit["_source"]
            placeholder = src.get("speaker_uid")
            source_uids = src.get("source_uids") or []
            ks_id_doc = src.get("knowledge_space_id")

            if not placeholder or not source_uids or not ks_id_doc:
                skipped += 1
                continue

            source_job_id = _lookup_source_job_id(client, source_uids[0])
            if not source_job_id:
                skipped += 1
                continue

            row = session.execute(
                text("SELECT extracted_metadata FROM source_jobs WHERE id = :j"),
                {"j": source_job_id},
            ).fetchone()
            if not row:
                skipped += 1
                continue
            meta = row[0] or {}
            structure = (meta.get("structure") or {}) if isinstance(meta, dict) else {}
            objects = structure.get("objects") or []
            if not isinstance(objects, list):
                skipped += 1
                continue

            canonical_uid, obj_dict = _resolve_canonical_uid_from_structure(
                objects, placeholder
            )

            if canonical_uid is None:
                if obj_dict is None:
                    not_found += 1
                    continue
                canonical_uid = _resolve_canonical_uid_via_objects_index(
                    client, ks_id_doc, obj_dict
                )
                if canonical_uid is None:
                    not_found += 1
                    continue

            if dry_run:
                updated += 1
                continue

            try:
                client.update(
                    index=LUCID_FACTS,
                    id=hit["_id"],
                    doc={"speaker_uid": canonical_uid},
                    refresh="wait_for",
                )
                updated += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "speaker_uid update failed for %s: %s", hit["_id"], exc
                )
                skipped += 1

    return {
        "ks_id": ks_id,
        "dry_run": dry_run,
        "total_candidates": len(hits),
        "updated": updated,
        "skipped": skipped,
        "not_found": not_found,
    }


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description=(
            "Backfill CLAIM facts speaker_uid: obj-N placeholder -> "
            "canonical Object UID. Default dry-run."
        )
    )
    parser.add_argument("--ks", default=None, help="knowledge_space_id")
    parser.add_argument("--apply", action="store_true", help="mutate ES")
    args = parser.parse_args()
    result = backfill_speaker_uid(args.ks, dry_run=not args.apply)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
