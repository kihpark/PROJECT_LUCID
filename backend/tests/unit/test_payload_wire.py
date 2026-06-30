"""feat/spo-decide-payload-wire — unit tests.

PO directive (2026-06-23): the Decide UI was showing the LLM's raw
English subject ("Korean Red Cross", "John Linton") even though
`_match_object`'s claim_recovery had corrected `lucid_objects.primary_label`
to Korean. Root cause: `_serialize_struct_fact` and `_serialize_struct_object`
both used the LLM's raw `StructureObject.name` / `subject_surface`,
ignoring `match_per_object[uid].primary_label`.

This module pins the new contract:

  1. _serialize_struct_fact uses corrected subject surface when
     match_per_object has the corrected primary_label.
  2. Falls back to LLM raw name when match_per_object is empty / missing.
  3. Object entity (when object_value is obj-N ref) also uses corrected.
  4. predicate_violation flag fires on English snake_case predicate +
     Korean claim.
  5. predicate_violation flag is False on English predicate + English
     claim.
  6. predicate_violation flag is False on Korean predicate + Korean
     claim.
"""
from __future__ import annotations

from api.models.objects import ObjectClass
from api.structure.models import StructureFact, StructureObject
from api.structure.object_matcher import MatchResult
from api.structure.processor import _serialize_struct_fact


def _fact(
    *,
    subject_uid: str = "obj-1",
    predicate: str = "p",
    object_value: str = "literal",
    claim: str = "x",
    subject_surface: str | None = None,
    object_surface: str | None = None,
    fact_type: str = "claim",
) -> StructureFact:
    # ★ STAGE 1c-vii: ACTION + literal object_value 는 validator 가 raise.
    # 이 fixture 의 검증 대상은 surface/predicate_violation 이므로 fact_type
    # 은 무관 → default 를 ``claim`` 으로 변경해 literal 보존.
    return StructureFact.model_validate(
        {
            "uid": "fn-1",
            "type": "proposition",
            "claim": claim,
            "subject_uid": subject_uid,
            "subject_surface": subject_surface,
            "object_surface": object_surface,
            "predicate": predicate,
            "object_value": object_value,
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
            "fact_type": fact_type,
        },
    )


def _obj(uid: str, name: str) -> StructureObject:
    return StructureObject(
        uid=uid,
        **{"class": ObjectClass.ORGANIZATION.value},
        name=name,
    )


# ---------------------------------------------------------------------------
# 1. Corrected subject surface from match_per_object propagates
# ---------------------------------------------------------------------------


def test_corrected_subject_surface_overrides_llm_raw():
    """LLM emitted subject_name='Korean Red Cross'; claim_recovery
    corrected the canonical primary_label to '대한적십자사'. The
    serialized fact must surface the Korean form.
    """
    f = _fact(
        subject_uid="obj-1",
        claim="대한적십자사는 22일 새 회장을 선출했다.",
        subject_surface="Korean Red Cross",
        predicate="선출했다",
        object_value="회장",
    )
    decomp_objects = {"obj-1": _obj("obj-1", "Korean Red Cross")}
    match_per_object = {
        "obj-1": MatchResult(
            matched_object_uid="obj-canon-krc",
            decision_reason="resolve_entity_match",
            primary_label="대한적십자사",
        ),
    }
    d = _serialize_struct_fact(
        f,
        violation_per_object={"obj-1": True},  # LLM emitted English on Korean
        match_per_object=match_per_object,
        decomp_objects=decomp_objects,
    )
    # The corrected Korean surface is now what the Decide UI reads.
    assert d["subject_label"] == "대한적십자사"
    # And subject_surface override fires because the violation flag was
    # set — without it, the LLM's English would have stuck.
    assert d["subject_surface"] == "대한적십자사"


# ---------------------------------------------------------------------------
# 2. Fallback to LLM raw when no match
# ---------------------------------------------------------------------------


def test_falls_back_to_llm_raw_when_no_match():
    """When `match_per_object` has no entry for the subject_uid (e.g.
    disambiguation pending) we fall back to `decomp_objects[uid].name`
    — the LLM's raw subject name. The surface stays whatever LLM
    emitted.
    """
    f = _fact(
        subject_uid="obj-1",
        claim="SpaceX raised $75B.",
        subject_surface="SpaceX",
        predicate="raised_funding",
        object_value="$75B",
    )
    decomp_objects = {"obj-1": _obj("obj-1", "SpaceX")}
    # Empty match_per_object — fallback path.
    d = _serialize_struct_fact(
        f,
        violation_per_object={},
        match_per_object={},
        decomp_objects=decomp_objects,
    )
    assert d["subject_label"] == "SpaceX"
    # subject_surface was LLM-supplied and there is no violation flag,
    # so the original LLM surface is preserved (not overwritten with
    # the fallback name).
    assert d["subject_surface"] == "SpaceX"


# ---------------------------------------------------------------------------
# 3. Object-side entity correction (mirrors subject)
# ---------------------------------------------------------------------------


def test_object_entity_also_uses_corrected_primary_label():
    """When `object_value` is an obj-N entity reference and the matcher
    corrected its primary_label, the serialized fact's object_label
    must use the corrected form too. Mirror of test #1 for the object
    side.
    """
    f = _fact(
        subject_uid="obj-1",
        claim="일본은 한국 정부와 회담했다.",
        subject_surface="Japan",
        predicate="회담했다",
        object_value="obj-2",
        object_surface="Korean government",
    )
    decomp_objects = {
        "obj-1": _obj("obj-1", "Japan"),
        "obj-2": _obj("obj-2", "Korean government"),
    }
    match_per_object = {
        "obj-1": MatchResult(
            matched_object_uid="obj-canon-jp",
            primary_label="일본",
        ),
        "obj-2": MatchResult(
            matched_object_uid="obj-canon-kr-gov",
            primary_label="한국 정부",
        ),
    }
    d = _serialize_struct_fact(
        f,
        violation_per_object={"obj-1": True, "obj-2": True},
        match_per_object=match_per_object,
        decomp_objects=decomp_objects,
    )
    assert d["subject_label"] == "일본"
    assert d["object_label"] == "한국 정부"
    assert d["object_surface"] == "한국 정부"


# ---------------------------------------------------------------------------
# 4. predicate_violation fires on English snake_case + Korean claim
# ---------------------------------------------------------------------------


def test_predicate_violation_fires_on_english_predicate_korean_claim():
    """PO's reproduction case: predicate='elected_president' on a
    Korean claim. The flag must fire and `needs_review` must be True.
    """
    f = _fact(
        subject_uid="obj-1",
        claim="윤석열은 2022년에 대통령으로 선출되었다.",
        subject_surface="윤석열",
        predicate="elected_president",
        object_value="대통령",
    )
    d = _serialize_struct_fact(
        f,
        violation_per_object={},
        match_per_object={},
        decomp_objects={"obj-1": _obj("obj-1", "윤석열")},
    )
    assert d["predicate_violation"] is True
    assert d["needs_review"] is True


# ---------------------------------------------------------------------------
# 5. predicate_violation is False on English predicate + English claim
# ---------------------------------------------------------------------------


def test_predicate_violation_false_on_english_pair():
    """English claim + English predicate → no violation (this is the
    expected path for English captures)."""
    f = _fact(
        subject_uid="obj-1",
        claim="Daniel Kahneman published Prospect Theory in 1979.",
        subject_surface="Daniel Kahneman",
        predicate="published",
        object_value="Prospect Theory",
    )
    d = _serialize_struct_fact(
        f,
        violation_per_object={},
        match_per_object={},
        decomp_objects={"obj-1": _obj("obj-1", "Daniel Kahneman")},
    )
    assert d["predicate_violation"] is False


# ---------------------------------------------------------------------------
# 6. predicate_violation is False on Korean predicate + Korean claim
# ---------------------------------------------------------------------------


def test_predicate_violation_false_on_korean_pair():
    """Korean claim + Korean verb-phrase predicate → no violation.
    This is the expected path post-prompt-strengthening."""
    f = _fact(
        subject_uid="obj-1",
        claim="중국 상무부는 미국 군 관련 기업 10곳을 명단에 올렸다고 발표했다.",
        subject_surface="중국 상무부",
        predicate="발표했다",
        object_value="명단",
    )
    d = _serialize_struct_fact(
        f,
        violation_per_object={},
        match_per_object={},
        decomp_objects={"obj-1": _obj("obj-1", "중국 상무부")},
    )
    assert d["predicate_violation"] is False
    # needs_review can still be True/False from the predicate_mapper;
    # we just assert the violation flag stayed off.
