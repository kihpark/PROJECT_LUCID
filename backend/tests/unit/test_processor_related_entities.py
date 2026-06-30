"""Unit tests for m32a-stage3-claim-related-entities (PO 2026-06-28 결정 6).

PO 의뢰서 verbatim:
    CLAIM → 독립 노드 + related-to(내용 속 entity, **점선/미검증 플래그**
    = provenance 게이트). 예: [모스 탄] ─speaker─> claim ─related-to─>
    [6·3선거][aweb].

    Acceptance: "aweb 관련 주장" = claim 노드 (점선 related-to)

PO 결정 6: 같은 fact 안 array (related_entity_uids), ★ 별도 doc 아님
(성능 + 단순성).

★ provenance 게이트 (P2 가 구조에 박힘): 이 array 는 검증된 사실이
아니라 claim 노드를 경유한 "주장된 연결" 만 담는다 — AI/시스템이
미검증 entity 관계를 실선으로 못 그음.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import (
    _extract_related_entity_uids,
    _serialize_struct_fact,
)


def _fact(
    *,
    uid: str = "fn-1",
    subject_uid: str = "obj-1",
    object_value: str = "aweb 이 6·3선거와 관련있다",
    fact_type: str = "claim",
    related_entity_uids: list[str] | None = None,
    speaker_uid: str | None = None,
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
    if related_entity_uids is not None:
        payload["related_entity_uids"] = related_entity_uids
    if speaker_uid is not None:
        payload["speaker_uid"] = speaker_uid
    return StructureFact.model_validate(payload)


def test_extract_related_entity_uids_acceptance_case_uid_map_applied():
    """★ PO 의뢰서 acceptance verbatim — "aweb 관련 주장" 의 content_claim
    안 [aweb, 6·3선거] 가 canonical UID 로 매핑된다."""
    f = _fact(
        related_entity_uids=["obj-2", "obj-3"],
        speaker_uid="obj-1",
    )
    uid_map = {
        "obj-1": "obj-canonical-mose-tan",
        "obj-2": "obj-canonical-aweb",
        "obj-3": "obj-canonical-june-3-election",
    }
    out = _extract_related_entity_uids(f, uid_map)
    # speaker 본인 (obj-1) 은 array 에 안 들어옴 — speaker_uid 가 carry.
    assert out == ["obj-canonical-aweb", "obj-canonical-june-3-election"]


def test_extract_related_entity_uids_uid_map_fallthrough():
    """uid_map 에 없는 ref (예: literal surface 또는 새 placeholder) 는
    원본 그대로 통과 — subject_uid 의 fall-through 와 동일."""
    f = _fact(related_entity_uids=["obj-2", "obj-unknown"])
    uid_map = {"obj-2": "obj-canonical-aweb"}
    out = _extract_related_entity_uids(f, uid_map)
    assert out == ["obj-canonical-aweb", "obj-unknown"]


def test_extract_related_entity_uids_non_claim_passthrough():
    """non-CLAIM fact 도 helper 자체는 fact_type 분기 없이 동일하게
    동작한다 (★ 단순성 — 분기 = 미래 버그). LLM 이 보통 emit 하지 않
    아 빈 array 가 자연 결과지만, 만약 LLM 이 emit 하면 그대로 보존.

    ★ STAGE 1c-vii: ACTION + literal object_value 는 validator 가 raise —
    object_value 를 obj-N placeholder 로 변경 (validator 통과).
    """
    f = _fact(
        fact_type="action",
        object_value="obj-2",
        related_entity_uids=["obj-2"],
    )
    out = _extract_related_entity_uids(f, {"obj-2": "obj-canonical-aweb"})
    assert out == ["obj-canonical-aweb"]


def test_extract_related_entity_uids_empty_array():
    """빈 array → 빈 array. ES keyword null/empty 처리와 호환."""
    f = _fact(related_entity_uids=[])
    out = _extract_related_entity_uids(f, {"obj-1": "x"})
    assert out == []


def test_extract_related_entity_uids_missing_field_returns_empty():
    """필드 자체 누락 (LLM 이 omit) → 빈 array. caller 는 평탄하게
    [] 를 ES 에 쓸 수 있어 keyword null 분기 불필요."""
    f = _fact(related_entity_uids=None)
    out = _extract_related_entity_uids(f, {"obj-1": "x"})
    assert out == []


def test_extract_related_entity_uids_malformed_inputs_silently_dropped():
    """malformed payload — non-list / non-string ref / 빈 문자열 /
    whitespace — 안전 처리. LLM 의 envelope 안정성 (extra='ignore'
    프로젝트 정책) 과 동일한 방어 자세."""
    # related_entity_uids 가 list 아닌 dict 형태로 잘못 옴 → []
    f_bad = StructureFact.model_validate({
        "uid": "fn-x",
        "type": "proposition",
        "claim": "x",
        "subject_uid": "obj-1",
        "predicate": "p",
        "object_value": "obj-2",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": "claim",
    })
    # Pydantic 이 list[str]|None 으로 강제했으므로 dict 는 못 들어감
    # — 대신 모델을 우회해 raw 상태에서 helper 가 어떻게 처리하는지
    # 확인하기 위해 setattr 우회.
    object.__setattr__(f_bad, "related_entity_uids", {"not": "a list"})
    assert _extract_related_entity_uids(f_bad, {}) == []

    # 빈 string / whitespace / 정상 mix → 빈 것만 drop.
    f_mixed = _fact(related_entity_uids=["obj-2", "", "   ", "obj-3"])
    uid_map = {"obj-2": "U2", "obj-3": "U3"}
    out = _extract_related_entity_uids(f_mixed, uid_map)
    assert out == ["U2", "U3"]


def test_extract_related_entity_uids_dedup_preserves_order():
    """LLM 이 같은 ref 를 두 번 emit 하면 첫 등장만 보존 (dedup +
    순서 유지). subject_uid 또는 speaker_uid 가 중복 등장하는 사고
    상황도 같이 방어."""
    f = _fact(related_entity_uids=["obj-2", "obj-3", "obj-2"])
    uid_map = {"obj-2": "U-aweb", "obj-3": "U-election"}
    out = _extract_related_entity_uids(f, uid_map)
    assert out == ["U-aweb", "U-election"]


def test_serialize_writes_related_entity_uids_field():
    """End-to-end: _serialize_struct_fact emits the canonical
    `related_entity_uids` array on the serialized doc. 같은 fact 안
    array — ★ 별도 doc 아님 (PO 결정 6 verbatim)."""
    f = _fact(
        related_entity_uids=["obj-2", "obj-3"],
        speaker_uid="obj-1",
    )
    uid_map = {
        "obj-1": "obj-canonical-mose-tan",
        "obj-2": "obj-canonical-aweb",
        "obj-3": "obj-canonical-june-3-election",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["related_entity_uids"] == [
        "obj-canonical-aweb",
        "obj-canonical-june-3-election",
    ]
    # Stage 1 (speaker_uid) regression guard — same fusion path.
    assert d["speaker_uid"] == "obj-canonical-mose-tan"
    # fact_type 보존.
    assert d["fact_type"] == "claim"


def test_serialize_non_claim_fact_emits_empty_array():
    """non-CLAIM fact 의 직렬화는 related_entity_uids=[] 로 평탄 처리.
    분기 = 미래 버그 (PO 결정 6 의 단순성 원칙). ES keyword null 처리
    덕에 facet/count 에 영향 없음.

    ★ STAGE 1c-vii: ACTION → object_value obj-N 사용 + uid_map 의 값을
    canonical UUID4 로 변경해 serialize strict reject 통과.
    """
    f = _fact(
        fact_type="action",
        object_value="obj-2",
        related_entity_uids=None,
    )
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": "22222222-2222-2222-2222-222222222222",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["related_entity_uids"] == []
