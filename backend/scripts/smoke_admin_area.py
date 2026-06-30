"""★ M-Dogfood-B live smoke: 광주 / 광주광역시 → same entity_id?

★ Strategy:
  1. seed (idempotent): "광주광역시" location entity 가 KS 안에 있는지 확인,
     없으면 1회 insert (★ refresh=wait_for).
  2. resolve("광주", lang="ko", ks) → ★ admin-area normalize 후 exact hit?
  3. resolve("광주광역시", lang="ko", ks) → ★ 동일 entity_id?
  4. ★ 보수성: resolve("SK", "ko", ks) ≠ resolve("SK하이닉스", "ko", ks)
     (★ admin-area dict 영향 X, 별도 entity)

★ 실행:
    docker compose exec backend python -m scripts.smoke_admin_area
or directly:
    set ELASTICSEARCH_URL=http://localhost:9200 && python -m scripts.smoke_admin_area
"""
from __future__ import annotations

import json
import os
import sys

# Ensure backend/ is on path when invoked as `python scripts/smoke_admin_area.py`
_HERE = os.path.abspath(os.path.dirname(__file__))
_BACKEND = os.path.abspath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from elasticsearch import Elasticsearch

from api.models.base import new_uid
from api.storage.elasticsearch.client import LUCID_OBJECTS
from api.structure.resolution_gateway import resolve

# ★ Smoke 전용 KS (★ 실제 KS 오염 방지)
KS_ID = "smoke-admin-area-ks"

GWANGJU_FULL = "광주광역시"
GWANGJU_SHORT = "광주"


def _es() -> Elasticsearch:
    url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    return Elasticsearch(url, request_timeout=15)


def _find_existing(client: Elasticsearch, name: str) -> str | None:
    # ★ name field 는 text + korean_analyzer — keyword 서브필드로 exact match
    resp = client.search(
        index=LUCID_OBJECTS,
        size=1,
        query={
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": KS_ID}},
                    {"term": {"name.keyword": name}},
                ]
            }
        },
    )
    hits = (resp.get("hits") or {}).get("hits") or []
    if not hits:
        return None
    return hits[0]["_id"]


def _seed_full(client: Elasticsearch) -> str:
    """★ idempotent: 광주광역시 entity 가 없으면 insert."""
    existing = _find_existing(client, GWANGJU_FULL)
    if existing:
        return existing
    entity_id = new_uid()
    client.index(
        index=LUCID_OBJECTS,
        id=entity_id,
        document={
            "object_uid": entity_id,
            "name": GWANGJU_FULL,
            "primary_label": GWANGJU_FULL,
            "primary_lang": "ko",
            "class": "location",
            "entity_type": "location",
            "aliases": [],
            "properties": {"type_confidence": 1.0, "needs_review": False},
            "fact_uids": [],
            "connected_objects": [],
            "knowledge_space_id": KS_ID,
            "relabel_history": [
                {
                    "from_primary": "",
                    "to_primary": GWANGJU_FULL,
                    "reason": "M-Dogfood-B smoke seed",
                }
            ],
        },
        refresh="wait_for",
    )
    return entity_id


def main() -> int:
    client = _es()
    print(f"== M-Dogfood-B live smoke (ES={os.getenv('ELASTICSEARCH_URL', 'http://localhost:9200')}) ==")

    seeded_id = _seed_full(client)
    print(f"[seed] {GWANGJU_FULL} entity_id = {seeded_id}")

    # 1) 광주 short form
    r_short = resolve(GWANGJU_SHORT, "ko", KS_ID, client=client)
    print(
        f"[resolve] {GWANGJU_SHORT!r} → entity_id={r_short.entity_id} "
        f"source={r_short.source} type={r_short.entity_type} "
        f"conf={r_short.confidence:.3f} canonical={r_short.canonical_name!r}"
    )

    # 2) 광주광역시 full form
    r_full = resolve(GWANGJU_FULL, "ko", KS_ID, client=client)
    print(
        f"[resolve] {GWANGJU_FULL!r} → entity_id={r_full.entity_id} "
        f"source={r_full.source} type={r_full.entity_type} "
        f"conf={r_full.confidence:.3f} canonical={r_full.canonical_name!r}"
    )

    same = r_short.entity_id == r_full.entity_id and r_short.entity_id == seeded_id
    print(f"\n[ASSERT 1] 광주 vs 광주광역시 same entity_id? {same}")
    if not same:
        print(
            f"  ★ MISMATCH: short={r_short.entity_id!r} full={r_full.entity_id!r} "
            f"seed={seeded_id!r}"
        )
        return 2

    # 3) 보수성: SK / SK하이닉스 별도 entity (★ admin-area dict 영향 X)
    r_sk = resolve("SK", "ko", KS_ID, client=client)
    r_skhy = resolve("SK하이닉스", "ko", KS_ID, client=client)
    print(
        f"\n[resolve] 'SK' → entity_id={r_sk.entity_id} source={r_sk.source}\n"
        f"[resolve] 'SK하이닉스' → entity_id={r_skhy.entity_id} source={r_skhy.source}"
    )
    distinct = r_sk.entity_id != r_skhy.entity_id and bool(r_sk.entity_id) and bool(r_skhy.entity_id)
    print(f"\n[ASSERT 2] SK vs SK하이닉스 distinct entity_id? {distinct}")
    if not distinct:
        print(f"  ★ CONSERVATISM BREACH: sk={r_sk.entity_id!r} skhy={r_skhy.entity_id!r}")
        return 3

    print("\nOK - admin-area canonical merge works, conservatism preserved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
