"""Unit tests for fact-measurement-layer-v1 (v0.2.0 step 2).

Pins the StructureFact + serializer shape for the new
fact_type='measurement' bucket and its 4 fields (metric /
measurement_value / measurement_unit / as_of).

PO directive 2026-06-23: the LLM is the classifier; the backend
remains agnostic about metric / unit / as_of (all open natural-
language strings + a float value), so no rule-based parsing is
asserted here. Only structural invariants get pinned:

  - StructureFact validates fact_type='measurement' + the 4 fields
  - Non-measurement facts leave the 4 fields None
  - model_dump preserves all fields under by_alias / mode='json'
  - measurement_value tolerates 0, negative, very large floats
  - measurement_unit is OPEN (any string accepted — no enum)
  - as_of is OPEN (year / year-month / quarter / date all accepted)
  - _serialize_struct_fact emits the 4 fields on the JSONB doc
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact


def _struct(**overrides) -> StructureFact:
    # ★ STAGE 1c-vii: default ACTION + literal "literal" 는 validator 가
    # raise. object_value 를 obj-N placeholder shape 으로 변경 — validator
    # 통과 + default action 유지 (test_action_fact_has_no_measurement_fields
    # 검증).
    payload = {
        "uid": "fn-1",
        "type": "proposition",
        "claim": "x",
        "subject_uid": "obj-1",
        "predicate": "p",
        "object_value": "obj-2",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
    }
    payload.update(overrides)
    return StructureFact.model_validate(payload)


# ---------------------------------------------------------------------------
# 1. fact_type='measurement' preserves all 4 new fields
# ---------------------------------------------------------------------------


def test_measurement_fact_preserves_metric_value_unit_as_of():
    """fact_type='measurement' carries metric / value / unit / as_of."""
    f = _struct(
        fact_type="measurement",
        metric="MAU",
        measurement_value=800000000.0,
        measurement_unit="명",
        as_of="2026-03",
    )
    assert f.fact_type == "measurement"
    assert f.metric == "MAU"
    assert f.measurement_value == 800000000.0
    assert f.measurement_unit == "명"
    assert f.as_of == "2026-03"


# ---------------------------------------------------------------------------
# 2. Non-measurement facts leave measurement fields None
# ---------------------------------------------------------------------------


def test_action_fact_has_no_measurement_fields():
    """Default action facts have all 4 measurement fields None."""
    f = _struct(fact_type="action")
    assert f.metric is None
    assert f.measurement_value is None
    assert f.measurement_unit is None
    assert f.as_of is None


def test_claim_fact_has_no_measurement_fields():
    """Claim facts (step 1) also leave measurement fields None when
    no measurement data is supplied — no field bleed across buckets."""
    f = _struct(
        fact_type="claim",
        speaker_uid="obj-1",
        speaker_label="안도걸 의원",
        speech_act="밝혔다",
        content_claim="속도를 낼 것",
        stance="neutral",
    )
    assert f.metric is None
    assert f.measurement_value is None
    assert f.measurement_unit is None
    assert f.as_of is None


# ---------------------------------------------------------------------------
# 3. model_dump (the serializer's primary tool) preserves all fields
# ---------------------------------------------------------------------------


def test_model_dump_by_alias_roundtrips_measurement_fields():
    """`model_dump(by_alias=True, mode='json')` is what the serializer
    uses to seed the JSONB blob. The 4 measurement fields must ride
    along (not silently dropped by alias / mode='json' coercion)."""
    f = _struct(
        fact_type="measurement",
        metric="매출",
        measurement_value=70.0,
        measurement_unit="조 원",
        as_of="2026-Q1",
    )
    d = f.model_dump(by_alias=True, mode="json")
    assert d["fact_type"] == "measurement"
    assert d["metric"] == "매출"
    assert d["measurement_value"] == 70.0
    assert d["measurement_unit"] == "조 원"
    assert d["as_of"] == "2026-Q1"
    # type alias rewrite still works (type_ -> type).
    assert d["type"] == "proposition"


# ---------------------------------------------------------------------------
# 4. measurement_value tolerates edge numerics — 0, negative, large
# ---------------------------------------------------------------------------


def test_measurement_value_accepts_zero():
    f = _struct(
        fact_type="measurement",
        metric="강수량",
        measurement_value=0.0,
        measurement_unit="mm",
        as_of="2026-06-24",
    )
    assert f.measurement_value == 0.0


def test_measurement_value_accepts_negative():
    """Negative values are legitimate (GDP growth, temp anomaly, deficit)."""
    f = _struct(
        fact_type="measurement",
        metric="경상수지",
        measurement_value=-12.5,
        measurement_unit="억 달러",
        as_of="2026-Q2",
    )
    assert f.measurement_value == -12.5


def test_measurement_value_accepts_very_large():
    """MAU at 8e8 must round-trip without precision loss."""
    f = _struct(
        fact_type="measurement",
        metric="MAU",
        measurement_value=800000000.0,
        measurement_unit="명",
        as_of="2026-03",
    )
    assert f.measurement_value == 800000000.0
    # Round-trip via model_dump (the serializer path).
    d = f.model_dump(by_alias=True, mode="json")
    assert d["measurement_value"] == 800000000.0


# ---------------------------------------------------------------------------
# 5. measurement_unit is OPEN — any string accepted (no enum)
# ---------------------------------------------------------------------------


def test_measurement_unit_open_vocabulary():
    """unit accepts arbitrary natural-language: KO, EN, mixed, symbol."""
    for unit in ["명", "조 원", "%", "달러", "billion USD", "kcal/day",
                 "GW", "건수", "tCO2e", "$"]:
        f = _struct(
            fact_type="measurement",
            metric="m",
            measurement_value=1.0,
            measurement_unit=unit,
            as_of="2026",
        )
        assert f.measurement_unit == unit


# ---------------------------------------------------------------------------
# 6. as_of is OPEN — year / year-month / quarter / date all accepted
# ---------------------------------------------------------------------------


def test_as_of_open_format():
    """as_of accepts any granularity the source supports."""
    for as_of in ["2026", "2026-03", "2026-Q1", "2026-03-23",
                  "2026년 3월", "FY2026", "Q2 2026"]:
        f = _struct(
            fact_type="measurement",
            metric="m",
            measurement_value=1.0,
            measurement_unit="u",
            as_of=as_of,
        )
        assert f.as_of == as_of


# ---------------------------------------------------------------------------
# 7. _serialize_struct_fact emits the 4 measurement fields on JSONB doc
# ---------------------------------------------------------------------------


def test_serialize_struct_fact_emits_measurement_fields():
    """The wire-shape doc that lands in ES carries fact_type='measurement'
    and the 4 measurement fields."""
    f = _struct(
        fact_type="measurement",
        metric="실업률",
        measurement_value=3.4,
        measurement_unit="%",
        as_of="2026-06",
    )
    d = _serialize_struct_fact(f)
    assert d["fact_type"] == "measurement"
    assert d["metric"] == "실업률"
    assert d["measurement_value"] == 3.4
    assert d["measurement_unit"] == "%"
    assert d["as_of"] == "2026-06"


def test_serialize_struct_fact_defaults_measurement_fields_none():
    """When the LLM omits measurement fields on a non-measurement fact,
    the serializer back-compat-fills them to None (not missing). ES
    `double` / `keyword` indexing reads None as missing, the recall
    facet doesn't bucket it, and the FactCard branches on
    fact_type=='measurement' before reading them.

    ★ STAGE 1c-vii: ACTION default 의 placeholder obj-2 를 canonical
    UUID 로 매핑해 serialize strict reject 통과.
    """
    f = _struct()  # action default
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": "22222222-2222-2222-2222-222222222222",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["fact_type"] == "action"
    assert d["metric"] is None
    assert d["measurement_value"] is None
    assert d["measurement_unit"] is None
    assert d["as_of"] is None
