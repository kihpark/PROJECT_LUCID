"""Unit tests for m32a-stage4-link-status (PO 2026-06-28 결정 5).

PO 결정 5 verbatim:
    link_status = verified/claimed 2종만
    ★ 추가 가드 — 셋 이상 정의 안 함.

PO 의뢰서 verbatim — provenance 게이트 (P2 가 구조에 박힘):
    내용 속 entity 연결(aweb─6·3선거)은 검증된 사실이 아니라 **claim
    노드를 경유한 "주장된 연결"**. AI/시스템이 미검증 entity 관계를
    실선으로 못 그음. = **점선 related-to.**

★ 추가 가드 — verified/claimed 2종만. 다른 fact_type 값
(measurement/None/unknown/uncertain/draft/...) 은 모두 verified 로
fall-through. claim 만 'claimed'.

STELLAR (M3-2b) 가 link_status 값에 따라 실선(verified) / 점선(claimed)
를 결정한다 — Stage 4 의 단일 책임.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import (
    _determine_link_status,
    _serialize_struct_fact,
)


def _fact(
    *,
    uid: str = "fn-1",
    subject_uid: str = "obj-1",
    object_value: str = "obj-2",
    fact_type: str = "claim",
) -> StructureFact:
    payload: dict = {
        "uid": uid,
        "type": "proposition",
        "claim": "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다.",
        "subject_uid": subject_uid,
        "predicate": "주장했다",
        "object_value": object_value,
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": fact_type,
    }
    return StructureFact.model_validate(payload)


def test_determine_link_status_action_is_verified():
    """ACTION fact (검증된 SPO) → verified. STELLAR 실선."""
    assert _determine_link_status("action") == "verified"


def test_determine_link_status_measurement_is_verified():
    """MEASUREMENT fact (검증된 수치 관계) → verified. STELLAR 실선."""
    assert _determine_link_status("measurement") == "verified"


def test_determine_link_status_claim_is_claimed():
    """CLAIM fact (주장된 연결) → claimed. STELLAR 점선 related-to.

    의뢰서 acceptance verbatim: "aweb 관련 주장" = claim 노드
    (점선 related-to). [모스 탄] ─speaker─> claim ─related-to─>
    [6·3선거][aweb]."""
    assert _determine_link_status("claim") == "claimed"


def test_determine_link_status_none_is_verified_legacy_default():
    """legacy fact (fact_type 누락) → verified. 직렬화 단계의 setdefault
    가 'action' 으로 채워주지만 helper 자체도 None 을 안전 처리해
    이중 가드. 의뢰서 'fact_type 분류 건드리지 마' 원칙 위반 없이
    legacy 가 자연스럽게 실선으로 떨어진다."""
    assert _determine_link_status(None) == "verified"


def test_determine_link_status_third_value_gate_only_two_outputs():
    """★ PO 결정 5 가드 — verified/claimed 2종만 (셋 이상 정의 안 함).

    LLM 이 알 수 없는 fact_type ('uncertain', 'draft', 'pending', '')
    을 emit 해도 helper 는 절대 새 값을 만들지 않는다. claim 만
    'claimed', 나머지는 모두 'verified' 로 통합 — provenance 게이트
    의 binary 의사 결정 (P2 가 구조에 박힘) 을 코드 수준에서 보장."""
    allowed = {"verified", "claimed"}
    for unknown in ("uncertain", "draft", "pending", "", "unknown", "foo"):
        result = _determine_link_status(unknown)
        assert result in allowed, (
            f"third-value 게이트 위반: fact_type={unknown!r} → {result!r} "
            f"(★ verified/claimed 2종만 허용)"
        )
        # 명시적으로 'verified' 임도 확인 — claim 이 아닌 모든 값은 verified.
        assert result == "verified"


def test_serialize_wires_link_status_for_claim_and_action():
    """End-to-end serializer wire — _serialize_struct_fact emits
    `link_status` derived from `fact_type`. CLAIM → claimed, ACTION
    → verified. ★ provenance 게이트의 데이터 표현이 직렬화 단계에
    박혀 STELLAR 가 doc 만 보고 점/실선을 결정할 수 있다."""
    f_claim = _fact(fact_type="claim")
    d_claim = _serialize_struct_fact(f_claim, uid_map={"obj-1": "U1", "obj-2": "U2"})
    assert d_claim["link_status"] == "claimed"
    assert d_claim["fact_type"] == "claim"

    f_action = _fact(fact_type="action")
    d_action = _serialize_struct_fact(f_action, uid_map={"obj-1": "U1", "obj-2": "U2"})
    assert d_action["link_status"] == "verified"
    assert d_action["fact_type"] == "action"
