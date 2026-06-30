"""REQ-004 STAGE 1c-vii — ★ STRICT REJECT (★ PO 2026-06-30).

PO 결정 verbatim:
    "A. **strict reject 강화** = ★ raise on literal. strip 약함 —
     근본 차단 아님. gateway 우회 경로가 살아있어도 에러 안 나서 못 잡음.
     reject = literal 들어오면 예외 → 호출부 gateway 강제 = ★ V3 진짜 차단.
     '회귀 방지' 변명 ★ 기각 — 회귀는 호출부 제대로 고쳐 막는 것."

Tests:
  1. StructureFact pydantic validator: ACTION + literal object_value → raise
  2. StructureFact validator: ACTION + UUID4 object_value → OK
  3. StructureFact validator: ACTION + obj-N placeholder → OK (gateway 미통과는
     서리얼라이즈 시점에서 잡힘)
  4. CLAIM + literal object_value → OK (literal 의도)
  5. MEASUREMENT + literal object_value → OK (수치 표현 literal 의도)
  6. _serialize_struct_fact: ACTION + literal → raise
  7. _serialize_struct_fact: ACTION + obj-N (uid_map 없음) → raise
  8. _serialize_struct_fact: ACTION + UUID4 → OK
  9. wipe_data.apply() without force_po_approval=True → raise NotImplementedError
 10. wipe_data.apply(force_po_approval=True) → guard 통과 (mock 으로 검증)
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from api.structure.models import StructureFact, V3LiteralObjectError
from api.structure.processor import _serialize_struct_fact


def _assert_v3_in_validation_error(exc: BaseException) -> None:
    """Walk a pydantic ValidationError and confirm V3LiteralObjectError is wrapped."""
    found = False
    for err in exc.errors():
        ctx = err.get("ctx") or {}
        inner = ctx.get("error")
        if isinstance(inner, V3LiteralObjectError):
            found = True
            break
        # Fallback: message contains the V3 marker
        if "V3 위반" in (err.get("msg") or ""):
            found = True
            break
    assert found, f"V3LiteralObjectError not found in ValidationError: {exc.errors()}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_fact(**overrides) -> StructureFact:
    payload = {
        "uid": "fn-1",
        "type": "proposition",
        "claim": "샘플 사실",
        "subject_uid": "obj-1",
        "predicate": "설립했다",
        "object_value": "obj-2",
        "negation_flag": False,
        "fact_type": "action",
    }
    payload.update(overrides)
    return StructureFact.model_validate(payload)


# ---------------------------------------------------------------------------
# 1-5. StructureFact pydantic validator
# ---------------------------------------------------------------------------


def test_action_literal_object_value_raises() -> None:
    """★ ACTION + literal object_value → V3LiteralObjectError (wrapped in ValidationError).

    pydantic wraps validator ValueErrors in ValidationError; the
    V3LiteralObjectError is reachable via err['ctx']['error']. The
    claude_client `_build_result` unwraps this and re-raises so the
    capture job is marked STRUCTURE_FAILED.
    """
    with pytest.raises(ValidationError) as exc_info:
        _build_fact(
            fact_type="action",
            object_value="대한축구협회",  # ★ literal
        )
    _assert_v3_in_validation_error(exc_info.value)


def test_action_uuid_object_value_passes() -> None:
    """★ ACTION + UUID4 → OK."""
    uuid = "c0d08a24-1234-4abc-89de-1234567890ab"
    fact = _build_fact(fact_type="action", object_value=uuid)
    assert fact.object_value == uuid


def test_action_placeholder_object_value_passes_at_validator() -> None:
    """★ ACTION + obj-N placeholder → validator 통과.

    placeholder 는 LLM 단계 정상 산출물 — uid_map 변환 실패는 서리얼라이즈
    시점에서 잡힌다.
    """
    fact = _build_fact(fact_type="action", object_value="obj-7")
    assert fact.object_value == "obj-7"


def test_action_empty_object_value_passes() -> None:
    """★ ACTION + 빈 문자열 object_value → OK (entity 미지정 fact)."""
    fact = _build_fact(fact_type="action", object_value="")
    assert fact.object_value == ""


def test_claim_literal_object_value_passes() -> None:
    """★ CLAIM 의 object_value 는 의도적으로 발화 내용 literal — 가드 무관."""
    fact = _build_fact(
        fact_type="claim",
        predicate="주장했다",
        object_value="이재명은 좋은 사람이다.",
    )
    assert fact.object_value == "이재명은 좋은 사람이다."


def test_measurement_literal_object_value_passes() -> None:
    """★ MEASUREMENT 의 object_value 는 수치 표현 literal — 가드 무관."""
    fact = _build_fact(
        fact_type="measurement",
        predicate="기록했다",
        object_value="3.4%",
    )
    assert fact.object_value == "3.4%"


# ---------------------------------------------------------------------------
# 6-8. _serialize_struct_fact
# ---------------------------------------------------------------------------


def test_serialize_raises_on_placeholder_leak() -> None:
    """★ obj-N placeholder 가 uid_map 에 누락 → serialize 시점 raise."""
    fact = _build_fact(fact_type="action", object_value="obj-999")
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    with pytest.raises(V3LiteralObjectError, match="placeholder-leak"):
        _serialize_struct_fact(fact, uid_map=uid_map)


def test_serialize_raises_on_unresolved_literal_via_dict_bypass() -> None:
    """★ validator 우회 (model_construct) 로 literal 을 강제 주입한 fact 도
    serialize 시점에서 raise. 이중 가드 검증.
    """
    # ★ model_construct 는 validator 건너뛰는 백도어 — gateway 우회 시뮬레이션
    fact = StructureFact.model_construct(
        uid="fn-1",
        type_="proposition",
        claim="X",
        subject_uid="obj-1",
        subject_surface=None,
        object_surface=None,
        predicate="언급했다",
        object_value="literal string",
        negation_flag=False,
        negation_scope=None,
        tags_suggested=[],
        fact_type="action",
        speaker_uid=None,
        speaker_label=None,
        speech_act=None,
        content_claim=None,
        stance=None,
        metric=None,
        measurement_value=None,
        measurement_unit=None,
        as_of=None,
        roles=None,
        related_entity_uids=None,
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    with pytest.raises(V3LiteralObjectError, match="V3 위반"):
        _serialize_struct_fact(fact, uid_map=uid_map)


def test_serialize_passes_on_canonical_uuid() -> None:
    """★ ACTION + canonical UUID4 → serialize OK."""
    real_uid = "22222222-2222-2222-2222-222222222222"
    fact = _build_fact(fact_type="action", object_value="obj-2")
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": real_uid,
    }
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["object_value"] == real_uid


def test_serialize_claim_literal_passes() -> None:
    """★ CLAIM literal object_value 는 serialize 무변경 (가드 ACTION 전용)."""
    fact = _build_fact(
        fact_type="claim",
        predicate="주장했다",
        object_value="이재명은 좋은 사람이다.",
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["object_value"] == "이재명은 좋은 사람이다."


# ---------------------------------------------------------------------------
# 9-10. wipe_data.apply() 가드 재설치
# ---------------------------------------------------------------------------


def test_wipe_apply_without_po_approval_raises() -> None:
    """★ wipe.apply() 가드 재설치 (★ PO 2026-06-30).

    force_po_approval=False (default) → NotImplementedError.
    """
    from api.ops import wipe_data

    with pytest.raises(NotImplementedError, match="PO"):
        wipe_data.apply()

    with pytest.raises(NotImplementedError, match="PO"):
        wipe_data.apply(force_po_approval=False)


def test_wipe_apply_with_po_approval_bypasses_guard() -> None:
    """★ force_po_approval=True 면 가드를 통과해 실제 wipe 코드로 들어간다.

    실제 DB/ES 호출은 mock — 가드 통과만 검증.
    """
    from api.ops import wipe_data

    with patch.object(wipe_data, "make_sessionmaker") as msm, \
         patch.object(wipe_data, "get_client") as gc:
        # SessionLocal() context manager mock
        sess = msm.return_value.return_value.__enter__.return_value
        sess.execute.return_value.rowcount = 0
        # ES client
        gc.return_value.delete_by_query.return_value = {"deleted": 0}

        # ★ NotImplementedError 가 raise 되지 않으면 가드 통과
        result = wipe_data.apply(force_po_approval=True)
        assert "pg" in result
        assert "es" in result
