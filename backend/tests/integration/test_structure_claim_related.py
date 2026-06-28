"""Integration tests for m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6).

Locks the PO acceptance case verbatim:

    "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다."
        → fact_type='claim'
          speaker_uid='obj-1' (모스 탄)  ← Stage 1
          content_claim='aweb 이 6·3선거와 관련있다'
          related_entity_uids=[<aweb canonical>, <6·3선거 canonical>]
            ★ 같은 fact 안 array, 별도 doc 아님 (PO 결정 6)
            ★ provenance 게이트 — 점선 related-to 의 데이터 표현

비교군 regression: 단순 action fact 는 related_entity_uids=[] —
(claim 아니므로) 분기 없는 평탄 직렬화.
"""
from __future__ import annotations

import pytest

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


def test_aweb_claim_acceptance_case_related_entity_uids_canonicalized() -> None:
    """PO 의뢰서 verbatim acceptance: "aweb 관련 주장" CLAIM fact 의
    content_claim 안 [aweb, 6·3선거] 가 canonical UID 로 매핑되어
    related_entity_uids 배열에 보존된다.

    의뢰서: [모스 탄] ─speaker─> claim ─related-to─> [6·3선거][aweb]

    ★ provenance 게이트: 이 array 는 "aweb 이 6·3선거와 관련있다"는
    검증된 사실이 아니라 모스 탄이 "주장한 연결" 만 담는다. 다운스트림
    Stage 4 (link_status verified/claimed) 가 이 배열 위에 얹혀 점/실선
    을 결정한다.
    """
    f = StructureFact.model_validate({
        "uid": "fn-1",
        "type": "proposition",
        "claim": "모스 탄이 aweb 이 6·3선거와 관련있다고 주장했다.",
        "subject_uid": "obj-1",       # 모스 탄
        "predicate": "주장했다",
        "object_value": "aweb 이 6·3선거와 관련있다",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "claim",
        "speaker_uid": "obj-1",       # ★ Stage 1
        "speaker_label": "모스 탄",
        "speech_act": "주장했다",
        "content_claim": "aweb 이 6·3선거와 관련있다",
        "stance": "neutral",
        # ★ Stage 3 의 새 필드 — content_claim 안 entity 의 obj-N 배열.
        "related_entity_uids": ["obj-2", "obj-3"],
    })
    uid_map = {
        "obj-1": "obj-canonical-mose-tan",
        "obj-2": "obj-canonical-aweb",
        "obj-3": "obj-canonical-june-3-election",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)

    # CLAIM 분기 보존.
    assert d["fact_type"] == "claim"
    # Stage 1 regression guard — speaker_uid uid_map 적용.
    assert d["speaker_uid"] == "obj-canonical-mose-tan"
    # ★ Stage 3 acceptance assertion — content_claim 안 [aweb, 6·3선거]
    # 가 canonical UID 로 매핑된 array.
    assert d["related_entity_uids"] == [
        "obj-canonical-aweb",
        "obj-canonical-june-3-election",
    ]
    # 같은 fact 안 array — 별도 doc 키 없음 (★ PO 결정 6 verbatim).
    assert "claim_related_entities" not in d  # 만약 별도 doc 이었다면
    # provenance 게이트 의미: array 만 보존하고 fact↔aweb / fact↔6·3선거
    # 의 직접 "실선 entity 간 link" 는 만들지 않는다. (Stage 4 의
    # link_status 가 위에 얹히는 것이 제대로된 경로.)


def test_simple_action_fact_emits_empty_related_entity_uids() -> None:
    """단순 action (claim 아님) → related_entity_uids 평탄 [] 직렬화.
    분기 = 미래 버그 (PO 결정 6 의 단순성 원칙). 비-CLAIM doc 에서
    이 필드가 missing 으로 ES 에 도착해도 keyword null 처리로 recall
    facet 에 영향 없음.
    """
    f = StructureFact.model_validate({
        "uid": "fn-2",
        "type": "proposition",
        "claim": "중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        "subject_uid": "obj-1",
        "predicate": "수출통제 대상에 올렸다",
        "object_value": "obj-2",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "action",
    })
    uid_map = {
        "obj-1": "obj-canonical-china-mofcom",
        "obj-2": "obj-canonical-10-us-companies",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["fact_type"] == "action"
    assert d["related_entity_uids"] == []
