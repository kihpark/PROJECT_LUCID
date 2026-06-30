"""
REQ-004 STAGE 1a — Entity resolution gateway 골격.

★ v3 §2·§5 verbatim:
- 모든 entity 참조 = entity_id (★ 문자열 저장 경로 제거)
- 전역 검색: 임베딩 유사도 + alias 표면형
- 확신 → 기존 entity_id / 새것 → 새 entity / 애매 → 새 + "후보" (P2)
- 타입 10종 분류 (+ confidence)

★ STAGE 1a 범위: 골격 + embedding 연결. 기존 5 resolver 흡수는 STAGE 1b.
"""

from dataclasses import dataclass
from typing import Literal, Optional

from elasticsearch import Elasticsearch

from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
from api.storage.elasticsearch.embeddings import get_embedding


# v3 §3: 10종 closed set
ENTITY_TYPE_V3 = Literal[
    "person", "organization", "group",
    "knowledge", "resource", "task", "concept", "event", "metric",
    "location",
]


@dataclass
class ResolvedEntity:
    """Gateway 의 단일 contract — 모든 호출이 이 type 반환."""
    entity_id: str
    canonical_name: str
    entity_type: str  # ENTITY_TYPE_V3 (★ STAGE 1b 에서 closed enforcement)
    confidence: float
    source: Literal["embedding", "exact", "new", "candidate"]
    # ★ "candidate" = 애매 → 새 entity + P2 사용자 통합 대기


def resolve(
    surface: str,
    lang: str,
    knowledge_space_id: str,
    *,
    client: Optional[Elasticsearch] = None,
) -> ResolvedEntity:
    """
    Single ingest-time entry point.

    Args:
        surface: 추출된 자연어 표면 (예: '한국은행', 'Apple Inc.')
        lang: 'ko' | 'en' | other
        knowledge_space_id: KS scope
        client: ES client (테스트 주입용)

    Returns:
        ResolvedEntity (★ entity_id 강제)

    ★ STAGE 1a: 골격 + embedding 매칭만.
    ★ STAGE 1b: 기존 5 resolver 흡수 + exact match cascade.
    """
    if client is None:
        client = get_client()

    # 1. embedding 으로 kNN 검색 (★ 1a 의 단일 path)
    vec = get_embedding(surface)
    if vec is not None:
        knn_resp = client.search(
            index=LUCID_OBJECTS,
            size=3,
            query={
                "bool": {
                    "filter": [{"term": {"knowledge_space_id": knowledge_space_id}}],
                }
            },
            knn={
                "field": "embedding",
                "query_vector": list(vec),
                "k": 3,
                "num_candidates": 50,
            },
        )

        hits = knn_resp.get("hits", {}).get("hits", [])
        if hits:
            top = hits[0]
            score = top.get("_score", 0)
            # ★ 1a 의 ★ stub threshold (1b 에서 정교화)
            if score >= 0.85:
                src = top["_source"]
                return ResolvedEntity(
                    entity_id=top["_id"],
                    canonical_name=src.get("name") or surface,
                    entity_type=src.get("class") or "concept",
                    confidence=float(score),
                    source="embedding",
                )

    # 2. fallback: 새 entity (★ candidate 표시 — P2)
    # ★ STAGE 1a 는 ★ 실제 entity 생성 안 함 (★ 1c 에서 저장 경로 통합)
    return ResolvedEntity(
        entity_id="",  # ★ 1c 에서 ES insert 후 entity_id 채움
        canonical_name=surface,
        entity_type="concept",  # ★ 1b 에서 LLM 분류 통합
        confidence=0.0,
        source="candidate",
    )
