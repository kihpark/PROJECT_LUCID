"""REQ-004 STAGE 1c — ★ acceptance: literal=0 in ACTION fact storage path.

★ PO acceptance (verbatim):
    "1c acceptance = ★ literal 0 (★ 저장 경로 전환 → literal 사라져야)"

Tests:
  1. ACTION fact 추출 → ES 저장 → object_value literal 0 검증.
  2. CLAIM fact → speaker_uid = entity_id 검증.
  3. 옛 placeholder (obj-N) leak 0.
  4. predicate_mapper 호출 0 (★ AST 검증 — 모든 backend/api/**.py).
  5. action_object_resolver 호출 0 (★ AST 검증).

★ Tests run static AST + processor `_serialize_struct_fact` driver tests
without ES; integration ES path is exercised through MagicMock so the
docker network is not required.
"""
from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from api.structure.models import StructureFact, StructureObject
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Path discovery: walk the entire backend/api tree for static AST checks.
# ---------------------------------------------------------------------------

_BACKEND_API = Path(__file__).resolve().parents[2] / "api"


def _iter_py_files(root: Path):
    for p in root.rglob("*.py"):
        if "__pycache__" in p.parts:
            continue
        yield p


# ---------------------------------------------------------------------------
# Helpers — build StructureFact / StructureObject for serialize tests.
# ---------------------------------------------------------------------------

def _fact(
    *,
    fact_type: str = "action",
    subject_uid: str = "obj-1",
    object_value: str = "obj-2",
    predicate: str = "설립했다",
    claim: str = "샘플 사실",
    speaker_uid: str | None = None,
    subject_surface: str | None = None,
    object_surface: str | None = None,
    uid: str = "fn-1",
) -> StructureFact:
    return StructureFact.model_validate(
        {
            "uid": uid,
            "type": "proposition",
            "claim": claim,
            "subject_uid": subject_uid,
            "subject_surface": subject_surface,
            "object_surface": object_surface,
            "predicate": predicate,
            "object_value": object_value,
            "negation_flag": False,
            "fact_type": fact_type,
            "speaker_uid": speaker_uid,
        }
    )


def _obj(uid: str = "obj-1", name: str = "샘플 엔티티") -> StructureObject:
    return StructureObject.model_validate(
        {"uid": uid, "class": "concept", "name": name}
    )


# ---------------------------------------------------------------------------
# 1. ★ ACTION fact → ES 저장 직전 직렬화 → literal object_value 0
# ---------------------------------------------------------------------------

def test_action_fact_literal_object_is_stripped() -> None:
    """★ 1c-iii acceptance: literal=0.

    LLM 이 흘린 literal ("강재호") 가 uid_map 으로 매핑 안 되면 ★ ES 저장
    직전 ★ "" 로 strip 되고 needs_review=True 가 자동 부여된다. v3 §2:
    "모든 entity 참조 = entity_id. ★ 문자열 저장 경로 제거."
    """
    fact = _fact(
        fact_type="action",
        subject_uid="obj-1",
        object_value="강재호",  # ★ literal — uid_map 에 없음
        predicate="언급했다",
        claim="이재명이 강재호를 언급했다.",
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["fact_type"] == "action"
    assert out["object_value"] == "", (
        f"★ 1c-iii literal 잔재: object_value={out['object_value']!r}"
    )
    assert out["needs_review"] is True


def test_action_fact_resolved_entity_id_passes_through() -> None:
    """★ 1c-iii: ACTION fact 의 object_value 가 ★ 진짜 entity_id (UUID4) 면
    그대로 유지된다."""
    real_uid = "22222222-2222-2222-2222-222222222222"
    fact = _fact(
        fact_type="action",
        subject_uid="obj-1",
        object_value="obj-2",
        predicate="설립했다",
        claim="A 가 B 를 설립했다.",
    )
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": real_uid,
    }
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["object_value"] == real_uid


def test_action_fact_placeholder_leak_is_stripped() -> None:
    """★ 1c-iii: obj-N placeholder 가 uid_map 에 없어 매핑 실패한 경우도
    literal 과 동일하게 ★ "" 로 strip 된다 (★ entity_id only invariant)."""
    fact = _fact(
        fact_type="action",
        subject_uid="obj-1",
        object_value="obj-999",  # ★ uid_map 에 없음 → leak
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["object_value"] == ""
    assert out["needs_review"] is True


def test_claim_fact_literal_object_is_NOT_stripped() -> None:
    """★ CLAIM fact 의 object_value 는 의도적으로 발화 내용 literal —
    1c-iii guard 가 CLAIM 무변경. v3 §2 verbatim."""
    fact = _fact(
        fact_type="claim",
        subject_uid="obj-1",
        object_value="이재명은 좋은 사람이다.",  # ★ 명제 literal
        predicate="주장했다",
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["fact_type"] == "claim"
    assert out["object_value"] == "이재명은 좋은 사람이다."


def test_measurement_fact_literal_object_is_NOT_stripped() -> None:
    """★ MEASUREMENT fact 의 object_value 는 수치 표현 literal —
    1c-iii guard 가 MEASUREMENT 무변경."""
    fact = _fact(
        fact_type="measurement",
        subject_uid="obj-1",
        object_value="3.4%",
        predicate="기록했다",
    )
    uid_map = {"obj-1": "11111111-1111-1111-1111-111111111111"}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["object_value"] == "3.4%"


# ---------------------------------------------------------------------------
# 2. ★ CLAIM fact: speaker_uid = entity_id (★ uid_map 매핑 확인)
# ---------------------------------------------------------------------------

def test_claim_speaker_uid_is_entity_id_after_uid_map() -> None:
    """★ 1c-iii: CLAIM fact 의 speaker_uid 는 ★ entity_id only.

    decomposer 가 placeholder (obj-N) 로 흘려도 ★ uid_map 으로 canonical
    UUID 변환된 결과가 저장된다. m32a-stage1-speaker-uid-hotfix 의
    1c-호환 회귀 테스트.
    """
    speaker_real = "33333333-3333-3333-3333-333333333333"
    fact = _fact(
        fact_type="claim",
        subject_uid="obj-1",
        speaker_uid="obj-3",
        object_value="발언 내용",
        predicate="말했다",
    )
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-3": speaker_real,
    }
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["speaker_uid"] == speaker_real


# ---------------------------------------------------------------------------
# 3. ★ 옛 placeholder (obj-N) ★ ES 저장 0
# ---------------------------------------------------------------------------

def test_no_obj_placeholder_in_serialized_uids_when_uid_map_complete() -> None:
    """★ uid_map 이 완전하면 ★ subject_uid / object_value / speaker_uid 에
    obj-N placeholder 가 남지 않는다."""
    s, o, sp = (
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333",
    )
    fact = _fact(
        fact_type="claim",
        subject_uid="obj-1",
        speaker_uid="obj-3",
        object_value="obj-2",
    )
    uid_map = {"obj-1": s, "obj-2": o, "obj-3": sp}
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    for k in ("subject_uid", "object_value", "speaker_uid"):
        v = out.get(k)
        if isinstance(v, str):
            assert not v.startswith("obj-"), (
                f"★ placeholder 잔재 ({k}): {v!r}"
            )


# ---------------------------------------------------------------------------
# 4. ★ predicate_mapper 호출 0 (★ AST 검증, 전수)
# ---------------------------------------------------------------------------

def test_no_predicate_mapper_imports_in_backend_api() -> None:
    """★ 1c-iv: predicate_mapper.py ★ DELETE 확인 + 모든 backend/api/**.py
    에서 ★ import 0."""
    # ★ 1: 파일 자체가 없어야 한다
    pm_path = _BACKEND_API / "structure" / "predicate_mapper.py"
    assert not pm_path.exists(), (
        f"★ 1c-iv 위반: predicate_mapper.py 가 아직 존재 ({pm_path})"
    )
    # ★ 2: 모든 .py 파일에서 import 0
    offenders: list[tuple[Path, str]] = []
    for p in _iter_py_files(_BACKEND_API):
        try:
            tree = ast.parse(p.read_text(encoding="utf-8-sig"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if mod.endswith("predicate_mapper") or mod.endswith(
                    ".predicate_mapper"
                ):
                    offenders.append((p, f"from {mod}"))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.endswith("predicate_mapper"):
                        offenders.append((p, f"import {alias.name}"))
    assert not offenders, (
        "★ 1c-iv 위반: predicate_mapper 호출 잔재:\n"
        + "\n".join(f"  {p}: {s}" for p, s in offenders)
    )


# ---------------------------------------------------------------------------
# 5. ★ action_object_resolver 호출 0 (★ AST 검증, 전수)
# ---------------------------------------------------------------------------

def test_no_action_object_resolver_imports_in_backend_api() -> None:
    """★ 1c-v: action_object_resolver.py ★ DELETE 확인 + 모든 backend/api/
    **.py 에서 ★ import 0."""
    aor_path = _BACKEND_API / "structure" / "action_object_resolver.py"
    assert not aor_path.exists(), (
        f"★ 1c-v 위반: action_object_resolver.py 가 아직 존재 ({aor_path})"
    )
    offenders: list[tuple[Path, str]] = []
    for p in _iter_py_files(_BACKEND_API):
        try:
            tree = ast.parse(p.read_text(encoding="utf-8-sig"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if mod.endswith("action_object_resolver"):
                    offenders.append((p, f"from {mod}"))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.endswith("action_object_resolver"):
                        offenders.append((p, f"import {alias.name}"))
    assert not offenders, (
        "★ 1c-v 위반: action_object_resolver 호출 잔재:\n"
        + "\n".join(f"  {p}: {s}" for p, s in offenders)
    )


# ---------------------------------------------------------------------------
# 6. ★ caller migration: processor / decomposer 에 ★ 5 resolver import 0
# ---------------------------------------------------------------------------

def test_processor_does_not_import_5_resolvers() -> None:
    """★ 1c-i: processor.py 에 5 resolver (entity_resolver / brand_resolver
    / subject_recovery / object_matcher / predicate_mapper /
    action_object_resolver) import 0."""
    p = _BACKEND_API / "structure" / "processor.py"
    tree = ast.parse(p.read_text(encoding="utf-8-sig"))
    forbidden = {
        "entity_resolver",
        "brand_resolver",
        "subject_recovery",
        "object_matcher",
        "predicate_mapper",
        "action_object_resolver",
    }
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            tail = mod.rsplit(".", 1)[-1]
            if tail in forbidden:
                offenders.append(f"from {mod}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                tail = alias.name.rsplit(".", 1)[-1]
                if tail in forbidden:
                    offenders.append(f"import {alias.name}")
    assert not offenders, (
        "★ 1c-i 위반: processor 가 5 resolver 를 import:\n"
        + "\n".join(f"  {s}" for s in offenders)
    )


def test_decomposer_does_not_import_5_resolvers() -> None:
    """★ 1c-i: decomposer.py 에 5 resolver import 0."""
    p = _BACKEND_API / "structure" / "decomposer.py"
    tree = ast.parse(p.read_text(encoding="utf-8-sig"))
    forbidden = {
        "entity_resolver",
        "brand_resolver",
        "subject_recovery",
        "object_matcher",
        "predicate_mapper",
        "action_object_resolver",
    }
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            tail = mod.rsplit(".", 1)[-1]
            if tail in forbidden:
                offenders.append(f"from {mod}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                tail = alias.name.rsplit(".", 1)[-1]
                if tail in forbidden:
                    offenders.append(f"import {alias.name}")
    assert not offenders, (
        "★ 1c-i 위반: decomposer 가 5 resolver 를 import:\n"
        + "\n".join(f"  {s}" for s in offenders)
    )


# ---------------------------------------------------------------------------
# 7. ★ predicate = 자연어 verbatim (★ v3 §1, OPL 통제어 0)
# ---------------------------------------------------------------------------

def test_predicate_code_is_natural_language_verbatim() -> None:
    """★ 1c-iv: predicate_code = predicate_label = raw predicate (★ 자연어
    verbatim). OPL 매핑 ("FOUNDED_BY", "RELATED_TO" 등) 폐기.

    LLM 이 한국어로 "설립했다" 를 흘리면 ES 에 그대로 "설립했다" 가
    저장된다 — 더 이상 "FOUNDED_BY" 코드로 변환되지 않는다.
    """
    fact = _fact(
        fact_type="action",
        subject_uid="obj-1",
        object_value="obj-2",
        predicate="설립했다",
    )
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": "22222222-2222-2222-2222-222222222222",
    }
    out = _serialize_struct_fact(fact, uid_map=uid_map)
    assert out["predicate_code"] == "설립했다"
    assert out["predicate_label"] == "설립했다"
    assert out["original_surface"] == "설립했다"


# ---------------------------------------------------------------------------
# 8. ★ gateway = single resolution entry-point (★ caller 가 호출하는 함수 1개)
# ---------------------------------------------------------------------------

def test_processor_uses_resolution_gateway_only() -> None:
    """★ 1c-i: processor 가 ★ resolution_gateway.resolve() 만 호출
    (★ 5 resolver 함수 0). AST 의 ★ Call 노드 검사."""
    p = _BACKEND_API / "structure" / "processor.py"
    tree = ast.parse(p.read_text(encoding="utf-8-sig"))
    forbidden_callables = {
        "match_or_create_object",
        "resolve_korean_brand",
        "recover_korean_subject_from_claim",
        "resolve_entity",
        "resolve_action_object_to_entity",
        "map_predicate_to_type_and_label",
        "map_predicate_to_opl",
    }
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if name and name in forbidden_callables:
                offenders.append(f"line {node.lineno}: {name}(...)")
    assert not offenders, (
        "★ 1c-i 위반: processor 가 5 resolver 의 함수 호출:\n"
        + "\n".join(f"  {s}" for s in offenders)
    )
