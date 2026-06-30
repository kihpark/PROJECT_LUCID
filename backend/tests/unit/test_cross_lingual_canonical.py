"""
★ PO 2026-06-30 (fix/canonical-cross-lingual-samsung): cross-lingual
canonical 보강 검증.

★ 현장 진단:
  - cosine('삼성전자', 'Samsung Electronics') = 0.6439 (< DISAMBIG_FLOOR 0.70)
  - 옛 entity 169 / 0 = embedding 누락 → kNN 무의미
  → ★ Option C: BM25 후보 + Claude "동일 entity?" 게이트 + alias 자동 추가.

Coverage:
  1. exact miss → BM25 → Claude "match" → 기존 entity_id 반환 + alias 추가
  2. exact miss → BM25 → Claude "no match" → kNN/candidate path
  3. ANTHROPIC_API_KEY 없음 → cross-lingual skip (★ test/dev env)
  4. Claude confidence < 0.85 → reject
  5. CROSS_LINGUAL_CANONICAL_ENABLED=0 → skip
  6. candidate insert 시 embedding 생성 + body 에 포함
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from api.structure.resolution_gateway import (
    CROSS_LINGUAL_MIN_CONFIDENCE,
    ResolvedEntity,
    resolve,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _exact_miss_responses(count: int = 4) -> list[dict]:
    """★ 4-tier exact cascade 전부 miss."""
    return [{"hits": {"hits": []}} for _ in range(count)]


def _bm25_candidates_response(candidates: list[dict]) -> dict:
    """★ Cross-lingual BM25 후보 응답."""
    return {"hits": {"hits": candidates}}


def _knn_no_match_response() -> dict:
    """★ kNN 도 score=0 (★ embedding 없는 옛 entity 흉내)."""
    return {"hits": {"hits": []}}


# ---------------------------------------------------------------------------
# 1) exact miss → BM25 → Claude "match" → 기존 entity_id 반환
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "1"})
@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_samsung_match_returns_existing_entity(mock_emb, mock_claude):
    """★ "Samsung Electronics" 입력 → BM25 에서 기존 "삼성전자" entity 잡힘
    → Claude "match_index=0, confidence=0.95" → 기존 entity_id 반환."""
    mock_emb.return_value = None  # ★ kNN 미진입
    mock_claude.return_value = {
        "match_index": 0,
        "confidence": 0.95,
        "reason": "삼성전자 is the Korean name for Samsung Electronics",
    }
    client = MagicMock()
    existing_samsung = {
        "_id": "samsung-ko-uid",
        "_source": {
            "object_uid": "samsung-ko-uid",
            "name": "삼성전자",
            "name_en": None,
            "aliases": [],
            "class": "organization",
            "entity_type": "organization",
            "primary_lang": "ko",
            "knowledge_space_id": "ks-1",
        },
    }
    # ★ 4 exact miss + 1 BM25 hit (★ multi_match 첫 query 에서 잡힘)
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [_bm25_candidates_response([existing_samsung])]
    )

    result = resolve("Samsung Electronics", "en", "ks-1", client=client)

    assert isinstance(result, ResolvedEntity)
    assert result.entity_id == "samsung-ko-uid"
    assert result.source == "exact"  # ★ cross-lingual = exact 한 종류
    assert result.confidence >= CROSS_LINGUAL_MIN_CONFIDENCE
    assert result.entity_type == "organization"
    # ★ alias 자동 추가: client.update 호출됐는지
    assert client.update.called
    update_kwargs = client.update.call_args.kwargs
    assert update_kwargs["id"] == "samsung-ko-uid"
    assert update_kwargs["script"]["params"]["alias"] == "Samsung Electronics"


@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "1"})
@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_ko_to_en_match(mock_emb, mock_claude):
    """★ "삼성전자" 입력 → BM25 에서 기존 "Samsung Electronics" entity 잡힘
    → Claude "match" → 기존 entity_id 반환 (★ 양방향 cross-lingual)."""
    mock_emb.return_value = None
    mock_claude.return_value = {
        "match_index": 0,
        "confidence": 0.92,
        "reason": "same entity, EN canonical",
    }
    client = MagicMock()
    existing_samsung_en = {
        "_id": "samsung-en-uid",
        "_source": {
            "object_uid": "samsung-en-uid",
            "name": "Samsung Electronics",
            "name_en": "Samsung Electronics",
            "aliases": [],
            "class": "organization",
            "entity_type": "organization",
            "primary_lang": "en",
        },
    }
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [_bm25_candidates_response([existing_samsung_en])]
    )

    result = resolve("삼성전자", "ko", "ks-1", client=client)
    assert result.entity_id == "samsung-en-uid"
    assert result.source == "exact"


# ---------------------------------------------------------------------------
# 2) Claude "no match" → fallthrough to kNN / candidate
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "1"})
@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_no_match_falls_through(mock_emb, mock_claude):
    """★ Claude "match_index=null" → cross-lingual reject → kNN/candidate path."""
    mock_emb.return_value = None  # ★ kNN miss → LLM type 분류 → candidate
    mock_claude.return_value = {
        "match_index": None,
        "confidence": 0.0,
        "reason": "different entities",
    }
    client = MagicMock()
    unrelated = {
        "_id": "other-uid",
        "_source": {
            "object_uid": "other-uid",
            "name": "다른 회사",
            "class": "organization",
        },
    }
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [_bm25_candidates_response([unrelated])]
    )

    result = resolve("Samsung Electronics", "en", "ks-1", client=client)
    # ★ candidate path → 새 entity_id (UUID4 like, non-empty)
    assert result.source == "candidate"
    assert result.entity_id  # ★ non-empty (★ 1c-ii 가 보장)
    assert result.entity_id != "other-uid"
    # ★ alias 추가 X (★ match 아니므로)
    assert not client.update.called


# ---------------------------------------------------------------------------
# 3) ANTHROPIC_API_KEY 없음 → cross-lingual skip
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_skipped_without_api_key(mock_emb):
    """★ ANTHROPIC_API_KEY 없으면 BM25 도 안 함 (★ no extra ES search)."""
    mock_emb.return_value = None
    with patch.dict(os.environ, {}, clear=False):
        # ★ ANTHROPIC_API_KEY 제거
        os.environ.pop("ANTHROPIC_API_KEY", None)
        client = MagicMock()
        # ★ exact miss 만 응답 — cross-lingual BM25 호출 안 되어야 함
        client.search.side_effect = _exact_miss_responses(4)
        # ★ search 가 4번 이상 호출되면 IndexError 로 빨리 실패하게 둔다.

        result = resolve("Samsung Electronics", "en", "ks-1", client=client)
        # ★ kNN 미진입 (get_embedding=None) + LLM type 분류 path → candidate
        assert result.source == "candidate"
        # ★ exact 4번만 호출됐는지 (★ cross-lingual 진입 X)
        assert client.search.call_count == 4


# ---------------------------------------------------------------------------
# 4) Claude confidence < 0.85 → reject
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "1"})
@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_low_confidence_rejected(mock_emb, mock_claude):
    """★ Claude 가 match_index 줘도 confidence < 0.85 면 reject."""
    mock_emb.return_value = None
    mock_claude.return_value = {
        "match_index": 0,
        "confidence": 0.70,  # ★ below 0.85 floor
        "reason": "ambiguous",
    }
    client = MagicMock()
    cand = {
        "_id": "ambiguous-uid",
        "_source": {"object_uid": "ambiguous-uid", "name": "SK", "class": "organization"},
    }
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [_bm25_candidates_response([cand])]
    )

    result = resolve("SK하이닉스", "ko", "ks-1", client=client)
    # ★ reject → candidate path
    assert result.source == "candidate"
    assert result.entity_id != "ambiguous-uid"
    assert not client.update.called  # ★ alias 추가 X


# ---------------------------------------------------------------------------
# 5) CROSS_LINGUAL_CANONICAL_ENABLED=0 → skip
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "0"})
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_env_disabled_skips(mock_emb):
    """★ env 로 끄면 BM25 호출도 안 됨 (★ Claude 는 별도로 type 분류에서
    여전히 호출될 수 있으므로 BM25 ES 호출 수로만 검증)."""
    mock_emb.return_value = None
    client = MagicMock()
    client.search.side_effect = _exact_miss_responses(4)

    result = resolve("Samsung Electronics", "en", "ks-1", client=client)
    assert result.source == "candidate"
    # ★ exact 4 만, cross-lingual BM25 호출 X (★ env disabled)
    assert client.search.call_count == 4


# ---------------------------------------------------------------------------
# 6) candidate insert 시 embedding 생성 + body 에 포함
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "0"})
@patch("api.structure.resolution_gateway.get_embedding")
def test_candidate_insert_includes_embedding(mock_emb):
    """★ get_embedding 가 vector 주면 → ES insert body 에 embedding 포함.
    ★ 옛 entity 169 / 0 embedding 누락 문제의 ★ root cause fix."""
    # ★ 단순 vector
    fake_vec = tuple([0.1] * 1536)
    mock_emb.return_value = fake_vec
    client = MagicMock()
    # ★ exact miss 4번 + kNN: score=0.0 (★ 옛 entity 흉내)
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [{"hits": {"hits": [{"_id": "x", "_score": 0.0, "_source": {}}]}}]
    )

    result = resolve("새 회사 ABC", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.entity_id  # non-empty
    # ★ index() 호출 시 body 에 embedding 들어갔는지
    assert client.index.called
    index_kwargs = client.index.call_args.kwargs
    body = index_kwargs["document"]
    assert "embedding" in body, "candidate insert must persist embedding for future kNN"
    assert len(body["embedding"]) == 1536


@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "0"})
@patch("api.structure.resolution_gateway.get_embedding")
def test_candidate_insert_omits_embedding_when_unavailable(mock_emb):
    """★ get_embedding=None (★ OPENAI_API_KEY 없음) → body 에 embedding field 생략."""
    mock_emb.return_value = None
    client = MagicMock()
    # ★ exact 4 miss, kNN 진입 안 함 (get_embedding=None)
    client.search.side_effect = _exact_miss_responses(4)

    result = resolve("새 회사 ABC", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert client.index.called
    body = client.index.call_args.kwargs["document"]
    # ★ embedding field 가 ★ 절대 들어가면 안 됨 (★ dense_vector dims=1536 의 None 은 ES strict reject)
    assert "embedding" not in body


# ---------------------------------------------------------------------------
# Alias dedup & cap
# ---------------------------------------------------------------------------

@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "CROSS_LINGUAL_CANONICAL_ENABLED": "1"})
@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_cross_lingual_alias_dedup_skips_when_present(mock_emb, mock_claude):
    """★ Cross-lingual match 후 surface 가 이미 aliases 에 있으면 update skip."""
    mock_emb.return_value = None
    mock_claude.return_value = {
        "match_index": 0,
        "confidence": 0.95,
        "reason": "same entity",
    }
    client = MagicMock()
    existing = {
        "_id": "samsung-uid",
        "_source": {
            "object_uid": "samsung-uid",
            "name": "삼성전자",
            "aliases": ["Samsung Electronics"],  # ★ 이미 있음
            "class": "organization",
        },
    }
    client.search.side_effect = (
        _exact_miss_responses(4)
        + [_bm25_candidates_response([existing])]
    )

    result = resolve("Samsung Electronics", "en", "ks-1", client=client)
    assert result.entity_id == "samsung-uid"
    # ★ alias 이미 있으니 update 호출 X
    assert not client.update.called
