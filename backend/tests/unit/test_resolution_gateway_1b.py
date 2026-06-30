"""
REQ-004 STAGE 1b — gateway 의 5 resolver 흡수 검증.

★ PO acceptance: "gateway 가 5 resolver 기능 흡수, 단독 entity 해석 가능"

Coverage:
  1b-i   exact match cascade   → source="exact", confidence=1.0
  1b-ii  LLM type 분류         → v3 10종 closed set, confidence 기록
  1b-iii brand alias + KO particles → pre-resolve normalize
  1b-iv  kNN 다단계 band       → 0.95+ embedding, 0.70-0.95 candidate
  1b-v   action_object_resolver STOP guard → 0 import of 5 resolvers
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

from api.structure.resolution_gateway import (
    KNN_AUTO_THRESHOLD,
    KNN_DISAMBIG_FLOOR,
    ResolvedEntity,
    resolve,
)


# ---------------------------------------------------------------------------
# ★ 1b-i: exact match cascade (★ entity_resolver 5-tier 흡수)
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_i_exact_match_returns_source_exact(mock_emb):
    """★ 1b-i: primary_label/name/aliases exact match → source=exact, conf=1.0."""
    mock_emb.return_value = None  # ★ kNN path 미진입 (★ exact win 확인)
    client = MagicMock()
    # ★ 첫 tier (primary_label) hit
    client.search.return_value = {"hits": {"hits": [{
        "_id": "e1",
        "_source": {
            "object_uid": "e1",
            "primary_label": "한국은행",
            "name": "한국은행",
            "class": "organization",
            "entity_type": "organization",
        },
    }]}}
    result = resolve("한국은행", "ko", "ks-1", client=client)
    assert isinstance(result, ResolvedEntity)
    assert result.source == "exact"
    assert result.entity_id == "e1"
    assert result.confidence == 1.0
    assert result.entity_type == "organization"


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_i_exact_cascade_falls_through_tiers(mock_emb):
    """★ 1b-i: primary_label miss → name miss → aliases hit (★ 5-tier cascade)."""
    mock_emb.return_value = None
    client = MagicMock()
    # primary_label miss, name miss, name_en miss, aliases hit
    client.search.side_effect = [
        {"hits": {"hits": []}},  # primary_label
        {"hits": {"hits": []}},  # name
        {"hits": {"hits": []}},  # name_en
        {"hits": {"hits": [{
            "_id": "e2",
            "_source": {
                "object_uid": "e2",
                "name": "SpaceX",
                "aliases": ["스페이스X"],
                "entity_type": "organization",
            },
        }]}},
    ]
    result = resolve("스페이스X", "ko", "ks-1", client=client)
    # ★ NOTE: "스페이스X" 는 brand alias 정규화로 "SpaceX" 로 변환 후 lookup
    assert result.source == "exact"
    assert result.entity_id == "e2"


# ---------------------------------------------------------------------------
# ★ 1b-iii: brand alias + KO particles 흡수
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iii_brand_alias_normalized_before_lookup(mock_emb):
    """★ 1b-iii: brand alias normalize (스페이스엑스 → SpaceX)."""
    mock_emb.return_value = None
    client = MagicMock()
    captured_queries: list[dict] = []

    def _search(**kwargs):
        captured_queries.append(kwargs)
        return {"hits": {"hits": [{
            "_id": "e3",
            "_source": {"object_uid": "e3", "name": "SpaceX", "class": "organization"},
        }]}}
    client.search.side_effect = _search

    result = resolve("스페이스엑스", "ko", "ks-1", client=client)
    assert result.source == "exact"
    # ★ 첫 query 의 lookup value 가 "SpaceX" (★ 정규화 후) 인지
    first_q = captured_queries[0]["query"]["bool"]["filter"]
    term_filter = next(f for f in first_q if "term" in f and "knowledge_space_id" not in f["term"])
    looked_up_value = next(iter(term_filter["term"].values()))
    assert looked_up_value == "SpaceX"


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iii_korean_particles_stripped(mock_emb):
    """★ 1b-iii: 한국어 particles ('이', '는') strip 후 lookup."""
    mock_emb.return_value = None
    client = MagicMock()
    captured_queries: list[dict] = []

    def _search(**kwargs):
        captured_queries.append(kwargs)
        return {"hits": {"hits": [{
            "_id": "e4",
            "_source": {"object_uid": "e4", "name": "한국은행", "class": "organization"},
        }]}}
    client.search.side_effect = _search

    result = resolve("한국은행이", "ko", "ks-1", client=client)
    assert result.entity_id == "e4"
    first_q = captured_queries[0]["query"]["bool"]["filter"]
    term_filter = next(f for f in first_q if "term" in f and "knowledge_space_id" not in f["term"])
    looked_up_value = next(iter(term_filter["term"].values()))
    assert looked_up_value == "한국은행"  # ★ "이" 가 strip 됨


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iii_brand_alias_after_particle_strip(mock_emb):
    """★ 1b-iii: KO particle 붙은 brand alias → strip → brand 재정규화."""
    mock_emb.return_value = None
    client = MagicMock()
    captured_queries: list[dict] = []

    def _search(**kwargs):
        captured_queries.append(kwargs)
        return {"hits": {"hits": [{
            "_id": "e5",
            "_source": {"object_uid": "e5", "name": "Apple", "class": "organization"},
        }]}}
    client.search.side_effect = _search

    # "애플이" → strip "이" → "애플" → brand alias → "Apple"
    result = resolve("애플이", "ko", "ks-1", client=client)
    assert result.entity_id == "e5"
    first_q = captured_queries[0]["query"]["bool"]["filter"]
    term_filter = next(f for f in first_q if "term" in f and "knowledge_space_id" not in f["term"])
    looked_up_value = next(iter(term_filter["term"].values()))
    assert looked_up_value == "Apple"


# ---------------------------------------------------------------------------
# ★ 1b-iv: kNN 다단계 band (★ object_matcher 0.70-0.95 흡수)
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iv_embedding_kNN_high_score_returns_embedding(mock_emb):
    """★ 1b-iv: kNN score >= 0.95 → source=embedding."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    # exact path = miss (4 tier), kNN = hit 0.97
    client.search.side_effect = [
        {"hits": {"hits": []}},  # primary_label
        {"hits": {"hits": []}},  # name
        {"hits": {"hits": []}},  # name_en
        {"hits": {"hits": []}},  # aliases
        {"hits": {"hits": [{
            "_id": "e6",
            "_score": 0.97,
            "_source": {"object_uid": "e6", "name": "유사 회사", "class": "organization"},
        }]}},
    ]
    result = resolve("어떤 회사", "ko", "ks-1", client=client)
    assert result.source == "embedding"
    assert result.entity_id == "e6"
    assert result.confidence >= KNN_AUTO_THRESHOLD


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iv_embedding_kNN_disambig_band_returns_candidate(mock_emb):
    """★ 1b-iv: 0.70 ≤ score < 0.95 → source=candidate (★ disambig)."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.side_effect = [
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": [{
            "_id": "e7",
            "_score": 0.80,  # ★ disambig band
            "_source": {"object_uid": "e7", "name": "비슷한 회사", "class": "organization"},
        }]}},
    ]
    result = resolve("어떤 회사", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    # REQ-004 STAGE 1c-ii: gateway 가 ★ 반드시 entity_id 를 채워서 반환.
    # disambig band 도 새 candidate entity 를 ES 에 insert 한다 (★ v3
    # 모든 entity 참조 = entity_id, 빈 문자열 path 폐기). entity_id 는
    # new_uid() 형태 (UUID4) — non-empty 면 충분.
    assert result.entity_id, "★ 1c-ii: candidate must carry non-empty entity_id"
    assert KNN_DISAMBIG_FLOOR <= result.confidence < KNN_AUTO_THRESHOLD


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_iv_embedding_kNN_below_floor_falls_to_llm(mock_emb):
    """★ 1b-iv: score < 0.70 → LLM 분류 path → candidate."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    client.search.side_effect = [
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": []}}, {"hits": {"hits": []}},
        {"hits": {"hits": [{
            "_id": "e8",
            "_score": 0.40,
            "_source": {"object_uid": "e8", "name": "전혀 다른"},
        }]}},
    ]
    result = resolve("새로운 주식회사 ABC", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    # ★ 1c-ii: gateway 가 ES insert 후 entity_id 채움 (non-empty)
    assert result.entity_id, "★ 1c-ii: candidate must carry non-empty entity_id"


# ---------------------------------------------------------------------------
# ★ 1b-ii: LLM type 분류 (★ v3 10종 closed set, confidence 기록)
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_ii_candidate_uses_llm_type_classification_organization(mock_emb):
    """★ 1b-ii: candidate 의 type = LLM 분류 (★ '주식회사' → organization)."""
    mock_emb.return_value = None  # ★ kNN 미진입 → 바로 LLM path
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}  # all exact miss
    result = resolve("새로운 주식회사 ABC", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.entity_type == "organization"
    assert result.confidence > 0  # ★ LLM confidence 기록


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_ii_candidate_type_in_v3_closed_set(mock_emb):
    """★ 1b-ii: entity_type 가 v3 10종 closed set 안인지."""
    mock_emb.return_value = None
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}
    result = resolve("아무 이상한 surface", "ko", "ks-1", client=client)
    v3_closed = {
        "person", "organization", "group",
        "knowledge", "resource", "task", "concept", "event", "metric",
        "location",
    }
    assert result.entity_type in v3_closed


@patch("api.structure.claude_client.call_claude_structured")
@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_ii_default_to_concept_safe_fallback(mock_emb, mock_claude):
    """★ 1b-ii final (★ PO 2026-06-30): unknown surface + Claude 호출 실패 →
    heuristic fallback → 패턴 미스 → concept (★ closed-set safe fallback).

    Pre-1b-ii-final: heuristic stub 만 호출. unknown surface 가 패턴
    매칭 안 되면 concept 으로 떨어짐. 1b-ii final 에서 Claude 호출이
    추가되었으므로, fallback path 검증은 Claude 호출을 실패시킨다.
    """
    mock_emb.return_value = None
    mock_claude.side_effect = RuntimeError("forced fallback to heuristic")
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}
    result = resolve("xyzabc123nopattern", "en", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.entity_type == "concept"


@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_ii_legacy_class_coerced_to_v3(mock_emb):
    """★ 1b-ii: legacy class 값 ('place', 'PROCEDURE') → v3 closed set 강제."""
    mock_emb.return_value = None
    client = MagicMock()
    # exact hit but entity_type = legacy "PROCEDURE" (★ v3 에서 제거됨)
    client.search.return_value = {"hits": {"hits": [{
        "_id": "legacy-1",
        "_source": {
            "object_uid": "legacy-1",
            "name": "legacy entity",
            "entity_type": "PROCEDURE",  # ★ v3 에서 제거
        },
    }]}}
    result = resolve("legacy entity", "en", "ks-1", client=client)
    assert result.source == "exact"
    assert result.entity_type == "concept"  # ★ coerced (★ out-of-set → safe fallback)


# ---------------------------------------------------------------------------
# ★ 1b-v: action_object_resolver STOP guard + 5 resolver 0 호출
# ---------------------------------------------------------------------------

_GATEWAY_PATH = Path(__file__).resolve().parents[2] / "api" / "structure" / "resolution_gateway.py"


def test_1b_v_gateway_imports_no_5_resolvers():
    """★ 1b-v: gateway 의 ★ import 에 5 resolver 0 (★ 호출 X, 로직만 흡수).

    ★ AST 파싱으로 import 만 검사 (★ 주석/docstring 의 단순 언급은 허용).
    """
    src = _GATEWAY_PATH.read_text(encoding="utf-8")
    tree = ast.parse(src)
    forbidden = {
        "entity_resolver",
        "brand_resolver",
        "subject_recovery",
        "object_matcher",
        "action_object_resolver",
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            # ★ "from api.structure.entity_resolver import ..." 검사
            mod = node.module or ""
            tail = mod.rsplit(".", 1)[-1]
            assert tail not in forbidden, (
                f"★ 1b-v 위반: gateway 가 {mod} 를 import 함 (★ 5 resolver 호출 금지)"
            )
        elif isinstance(node, ast.Import):
            for alias in node.names:
                tail = alias.name.rsplit(".", 1)[-1]
                assert tail not in forbidden, (
                    f"★ 1b-v 위반: gateway 가 {alias.name} 를 import 함"
                )


def test_1b_v_gateway_calls_no_5_resolvers():
    """★ 1b-v: gateway 의 함수 호출에 5 resolver 함수명 0.

    ★ AST 의 Call name 검사 (★ 주석/docstring 의 단순 언급은 허용).
    """
    src = _GATEWAY_PATH.read_text(encoding="utf-8")
    tree = ast.parse(src)
    forbidden_funcs = {
        # entity_resolver public surface
        "resolve_entity",
        "_lookup_by_field",
        "_create_entity",
        # brand_resolver public surface
        "resolve_korean_brand",
        # subject_recovery public surface
        "recover_korean_subject_from_claim",
        # object_matcher public surface
        "match_or_create_object",
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if name and name in forbidden_funcs:
                raise AssertionError(
                    f"★ 1b-v 위반: gateway 가 {name}() 를 호출함 (★ 로직 재구현만 허용)"
                )


# ---------------------------------------------------------------------------
# ★ PO acceptance: "gateway 가 단독 entity 해석 가능"
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_1b_acceptance_gateway_resolves_entity_standalone(mock_emb):
    """★ 1b acceptance: gateway 단독 → ResolvedEntity 반환 (★ 5 resolver 없이)."""
    mock_emb.return_value = tuple([0.1] * 1536)
    client = MagicMock()
    # ★ 시나리오: KS 의 모든 lookup miss → LLM type 분류 → candidate
    client.search.return_value = {"hits": {"hits": []}}
    result = resolve("새로운 entity surface", "ko", "ks-1", client=client)
    assert isinstance(result, ResolvedEntity)
    assert result.source in ("embedding", "exact", "candidate")
    assert result.entity_type in {
        "person", "organization", "group",
        "knowledge", "resource", "task", "concept", "event", "metric",
        "location",
    }
