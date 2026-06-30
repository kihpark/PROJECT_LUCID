"""REQ-004 STAGE 1b-ii final — Claude LLM type 분류 통합 검증.

★ PO 2026-06-30: heuristic stub → ★ Claude structured output 진짜 통합.
★ "AI 코리아", "청사진" 등을 ★ entity_id 로 해석하게 (지금은 literal 떨어뜨려 reject).

Coverage:
  - mock Claude → 정상 응답 → entity_type / confidence 반환
  - API key 미설정 / 호출 실패 → heuristic fallback (0.3 confidence)
  - LLM JSON 깨짐 → heuristic fallback
  - v3 10종 외 type → concept + confidence cap 0.3
  - literal recovery: ACTION fact 의 literal object_value → obj-N + synthetic obj
  - confidence < 0.5 → needs_review on candidate ES insert
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.structure.resolution_gateway import (
    _classify_type_heuristic,
    _classify_type_with_llm,
)


# ---------------------------------------------------------------------------
# A. _classify_type_with_llm — Claude structured output 통합
# ---------------------------------------------------------------------------

@patch("api.structure.claude_client.call_claude_structured")
def test_classify_with_claude_returns_type_and_confidence(mock_call):
    """★ Claude 정상 응답 → (entity_type, confidence) 반환."""
    mock_call.return_value = {"type": "task", "confidence": 0.85}
    t, conf = _classify_type_with_llm("메가프로젝트", "ko")
    assert t == "task"
    assert conf == pytest.approx(0.85)
    # Claude 호출이 실제로 발생했는지 확인 (★ heuristic 우회 = 진짜 통합 증거)
    assert mock_call.called
    kwargs = mock_call.call_args.kwargs
    assert "system_prompt" in kwargs
    assert "user_prompt" in kwargs
    assert "메가프로젝트" in kwargs["user_prompt"]


@patch("api.structure.claude_client.call_claude_structured")
def test_classify_claude_call_failure_falls_back_to_heuristic(mock_call):
    """★ Claude 호출 실패 → heuristic fallback (★ 0.3 confidence)."""
    mock_call.side_effect = RuntimeError("ANTHROPIC_API_KEY not set")
    # "주식회사" 패턴 매칭이 heuristic 안에 있으므로 organization 으로 떨어진다
    t, conf = _classify_type_with_llm("삼성 주식회사", "ko")
    assert t == "organization"
    assert conf == pytest.approx(0.3)


@patch("api.structure.claude_client.call_claude_structured")
def test_classify_claude_malformed_response_falls_back(mock_call):
    """★ Claude 응답에 type 누락 → heuristic fallback."""
    mock_call.return_value = {"foo": "bar"}  # missing 'type'
    t, conf = _classify_type_with_llm("회의록", "ko")
    # heuristic: "회의" 매칭 → event
    assert t == "event"
    assert conf == pytest.approx(0.3)


@patch("api.structure.claude_client.call_claude_structured")
def test_classify_out_of_set_type_coerced_to_concept(mock_call):
    """★ Claude 가 v3 10종 외 type 반환 → concept fallback, confidence cap 0.3."""
    mock_call.return_value = {"type": "PROCEDURE", "confidence": 0.9}
    t, conf = _classify_type_with_llm("임의명사구", "ko")
    assert t == "concept"
    assert conf == pytest.approx(0.3)


@patch("api.structure.claude_client.call_claude_structured")
def test_classify_confidence_clamped_to_unit_range(mock_call):
    """★ confidence > 1.0 / < 0.0 → [0.0, 1.0] clamp."""
    mock_call.return_value = {"type": "person", "confidence": 1.5}
    _t, conf = _classify_type_with_llm("홍길동", "ko")
    assert conf == 1.0


@patch("api.structure.claude_client.call_claude_structured")
def test_classify_non_numeric_confidence_defaults_to_half(mock_call):
    """★ confidence 비숫자 → 0.5 default (★ never crashes)."""
    mock_call.return_value = {"type": "person", "confidence": "high"}
    t, conf = _classify_type_with_llm("홍길동", "ko")
    assert t == "person"
    assert conf == pytest.approx(0.5)


def test_classify_empty_surface_returns_zero():
    """★ empty surface → ("concept", 0.0)."""
    t, conf = _classify_type_with_llm("", "ko")
    assert t == "concept"
    assert conf == 0.0


def test_classify_whitespace_surface_returns_zero():
    t, conf = _classify_type_with_llm("   ", "ko")
    assert t == "concept"
    assert conf == 0.0


# ---------------------------------------------------------------------------
# B. _classify_type_heuristic — fallback path 보존
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "surface,expected",
    [
        # 가장 명확한 keyword 만 — heuristic 은 single-char Korean particle ("구",
        # "시", "도") 도 location 으로 떨어뜨리는 greedy 패턴이라 long-tail Korean
        # 명사구가 거의 다 location 으로 오인됨. 이게 ★ Claude 호출이 필요한 이유.
        ("Samsung Inc", "organization"),
        ("Mr. Park", "person"),
        ("annual conference", "event"),
        ("KPI rate", "metric"),
        ("technical report", "resource"),
        ("alpha-beta-noun", "concept"),  # 영어 default → concept
    ],
)
def test_heuristic_patterns(surface, expected):
    """★ heuristic stub 패턴 매칭은 보존 (Claude 호출 실패 시 fallback path).

    ★ stub 은 의도적으로 약하다 — Korean single-char particle ("시", "도",
    "구") 가 location 패턴이라 "보고서" / "임의명사구" 가 모두 location 으로
    오인된다. 이 약함이 1b-ii final 의 Claude 통합을 강제한 이유.
    """
    assert _classify_type_heuristic(surface, "ko") == expected


# ---------------------------------------------------------------------------
# C. literal recovery (★ claude_client._recover_literal_object_values)
# ---------------------------------------------------------------------------

def test_recover_literal_object_values_rewrites_action_literal():
    """★ ACTION fact 의 literal object_value → 새 obj-N + synthetic StructureObject."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "정부"},
        ],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "정부는 메가프로젝트를 추진했다",
                "type": "spo",
                "fact_type": "action",
                "subject_uid": "obj-1",
                "predicate": "추진했다",
                "object_value": "메가프로젝트",  # ★ literal — should be rewritten
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 1
    # 새 synthetic obj-N 가 objects 에 추가
    object_names = [o["name"] for o in out["objects"]]
    assert "메가프로젝트" in object_names
    # synthetic 표시
    synth = [o for o in out["objects"] if o["name"] == "메가프로젝트"][0]
    assert synth["uid"].startswith("obj-")
    assert synth["properties"]["recovered_from_literal"] is True
    # fact 의 object_value 가 obj-N 으로 교체
    assert out["facts"][0]["object_value"] == synth["uid"]
    # object_surface 에 원본 literal 보존
    assert out["facts"][0]["object_surface"] == "메가프로젝트"
    # involves link 가 추가됨 (★ FactObjectLink enum: involves =
    # "fact references this entity as a participant"). primary_object 는
    # enum 외 값이라 사용 불가.
    fol = out["fact_object_links"]
    assert any(
        link["fact_uid"] == "fn-1"
        and link["object_uid"] == synth["uid"]
        and link["link_type"] == "involves"
        and link["properties"].get("recovered_from_literal") is True
        for link in fol
    )


def test_recover_literal_object_values_passes_through_obj_n():
    """★ object_value 가 이미 obj-N 인 경우 → no-op."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "정부"},
            {"uid": "obj-2", "class": "concept", "name": "메가프로젝트"},
        ],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "정부는 메가프로젝트를 추진했다",
                "type": "spo",
                "fact_type": "action",
                "subject_uid": "obj-1",
                "predicate": "추진했다",
                "object_value": "obj-2",
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 0
    assert out["facts"][0]["object_value"] == "obj-2"


def test_recover_literal_object_values_skips_claim_fact_type():
    """★ CLAIM 의 object_value 는 의도적 literal (발화 내용) → skip."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "기자가 회담은 성공이라 말했다",
                "type": "spo",
                "fact_type": "claim",
                "subject_uid": "obj-1",
                "predicate": "말했다",
                "object_value": "회담은 성공이라",
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 0
    # CLAIM 은 그대로 literal 유지
    assert out["facts"][0]["object_value"] == "회담은 성공이라"


def test_recover_literal_object_values_skips_measurement_fact_type():
    """★ MEASUREMENT 의 object_value 는 수치 표현 literal → skip."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "GDP 는 1.5조 달러였다",
                "type": "spo",
                "fact_type": "measurement",
                "subject_uid": "obj-1",
                "predicate": "였다",
                "object_value": "1.5조 달러",
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 0
    assert out["facts"][0]["object_value"] == "1.5조 달러"


def test_recover_literal_object_values_dedups_same_literal():
    """★ 동일한 literal 이 두 fact 에 등장하면 ★ 같은 obj-N 사용 (★ 중복 entity 방지)."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "정부"},
            {"uid": "obj-2", "class": "person", "name": "장관"},
        ],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "정부는 청사진을 발표했다",
                "type": "spo",
                "fact_type": "action",
                "subject_uid": "obj-1",
                "predicate": "발표했다",
                "object_value": "청사진",
            },
            {
                "uid": "fn-2",
                "claim": "장관도 청사진을 지지했다",
                "type": "spo",
                "fact_type": "action",
                "subject_uid": "obj-2",
                "predicate": "지지했다",
                "object_value": "청사진",
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 2  # 두 fact 모두 recover
    # 두 fact 의 object_value 가 동일한 obj-N 으로
    ov1 = out["facts"][0]["object_value"]
    ov2 = out["facts"][1]["object_value"]
    assert ov1 == ov2
    assert ov1.startswith("obj-")
    # objects 에 "청사진" 1개만 추가
    chs = [o for o in out["objects"] if o["name"] == "청사진"]
    assert len(chs) == 1


def test_recover_literal_object_values_reuses_existing_object_by_name():
    """★ 이미 같은 name 의 StructureObject 가 있으면 ★ 그 uid 재사용 (★ dup 방지)."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "정부"},
            {"uid": "obj-7", "class": "concept", "name": "메가프로젝트"},  # 이미 있음
        ],
        "facts": [
            {
                "uid": "fn-1",
                "claim": "정부는 메가프로젝트를 추진했다",
                "type": "spo",
                "fact_type": "action",
                "subject_uid": "obj-1",
                "predicate": "추진했다",
                "object_value": "메가프로젝트",  # literal — 같은 이름의 obj-7 재사용
            },
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
    }
    out, count = _recover_literal_object_values(parsed)
    assert count == 1
    # 새 객체 추가 X — obj-7 재사용
    assert len(out["objects"]) == 2
    assert out["facts"][0]["object_value"] == "obj-7"


def test_recover_no_facts_field_passthrough():
    """★ facts 가 dict/list 아니면 no-op."""
    from api.structure.claude_client import _recover_literal_object_values

    parsed = {"objects": []}
    out, count = _recover_literal_object_values(parsed)
    assert count == 0
    assert out == parsed


# ---------------------------------------------------------------------------
# D. confidence < 0.5 → needs_review on candidate ES insert
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
@patch("api.structure.resolution_gateway._classify_type_with_llm")
def test_low_confidence_marks_needs_review(mock_classify, mock_emb):
    """★ confidence < 0.5 → ES doc 에 needs_review=True 저장."""
    from api.structure.resolution_gateway import resolve

    mock_emb.return_value = None  # ★ kNN path skip
    mock_classify.return_value = ("concept", 0.4)  # < 0.5
    client = MagicMock()
    # ★ exact match miss → candidate insert path
    client.search.return_value = {"hits": {"hits": []}}

    result = resolve("애매한 명사구", "ko", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.confidence == pytest.approx(0.4)
    # ES index 호출의 document.properties 에 needs_review=True (★ strict_dynamic_mapping
    # safe path — top-level 새 필드는 reject 라 properties dynamic_object 로 들어감).
    assert client.index.called
    body = client.index.call_args.kwargs.get("document") or {}
    props = body.get("properties") or {}
    assert props.get("needs_review") is True
    assert props.get("type_confidence") == pytest.approx(0.4)


@patch("api.structure.resolution_gateway.get_embedding")
@patch("api.structure.resolution_gateway._classify_type_with_llm")
def test_high_confidence_does_not_mark_needs_review(mock_classify, mock_emb):
    """★ confidence >= 0.5 → needs_review=False."""
    from api.structure.resolution_gateway import resolve

    mock_emb.return_value = None
    mock_classify.return_value = ("organization", 0.9)
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    result = resolve("Samsung", "en", "ks-1", client=client)
    assert result.source == "candidate"
    assert result.confidence == pytest.approx(0.9)
    body = client.index.call_args.kwargs.get("document") or {}
    props = body.get("properties") or {}
    assert props.get("needs_review") is False
    assert props.get("type_confidence") == pytest.approx(0.9)
