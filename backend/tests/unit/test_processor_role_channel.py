"""Unit tests for m32a-stage2-role-channel (PO 2026-06-28 decision 4).

The discovery report (docs/m3-2a-discovery.md C.2) measured that 100%
of current `involves` links carry properties={} — multi-participant
facts (e.g. "모스 탄이 6·3선거를 트럼프에게 알렸다", trump=recipient)
lose the auxiliary participant entirely. The role channel plugs that
gap.

PO directive: SEED roles = recipient / instrument / location, but the
channel is intentionally NOT a strict enum. New role keys (witness /
topic / co-actor / ...) must pass through.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _extract_roles, _serialize_struct_fact


def _fact(*, uid: str = "fn-1", subject_uid: str = "obj-1",
          object_value: str = "obj-2",
          roles: dict[str, str] | None = None,
          fact_type: str = "action") -> StructureFact:
    payload: dict = {
        "uid": uid,
        "type": "proposition",
        "claim": "x",
        "subject_uid": subject_uid,
        "predicate": "p",
        "object_value": object_value,
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": fact_type,
    }
    if roles is not None:
        payload["roles"] = roles
    return StructureFact.model_validate(payload)


def test_extract_roles_recipient_via_uid_map():
    """The PO acceptance case — `recipient` placeholder resolves to a
    canonical Object UID through uid_map, same fusion path subject_uid
    uses in _serialize_struct_fact."""
    f = _fact(roles={"recipient": "obj-3"})
    uid_map = {
        "obj-1": "obj-canonical-mose-tan",
        "obj-3": "obj-canonical-trump",
    }
    out = _extract_roles(f, uid_map)
    assert out == {"recipient": "obj-canonical-trump"}


def test_extract_roles_instrument():
    """instrument role — seed role #2."""
    f = _fact(roles={"instrument": "obj-9"})
    uid_map = {"obj-9": "obj-canonical-calcium"}
    out = _extract_roles(f, uid_map)
    assert out == {"instrument": "obj-canonical-calcium"}


def test_extract_roles_location():
    """location role — seed role #3."""
    f = _fact(roles={"location": "obj-7"})
    uid_map = {"obj-7": "obj-canonical-geneva"}
    out = _extract_roles(f, uid_map)
    assert out == {"location": "obj-canonical-geneva"}


def test_extract_roles_enum_경직_금지_새_role_그대로_통과():
    """★ PO directive 4: SEED roles are not an enum. A new role like
    `witness` must pass through untouched so ES dynamic mapping on
    `fact_object_role` auto-indexes it without a migration."""
    f = _fact(roles={"witness": "obj-5", "topic": "obj-6"})
    uid_map = {
        "obj-5": "obj-canonical-witness-a",
        "obj-6": "obj-canonical-topic-x",
    }
    out = _extract_roles(f, uid_map)
    # Both unseed roles preserved verbatim, values resolved through uid_map.
    assert out == {
        "witness": "obj-canonical-witness-a",
        "topic": "obj-canonical-topic-x",
    }


def test_extract_roles_missing_returns_empty():
    """A simple SPO fact (no auxiliary participants) — `roles` absent —
    yields an empty dict so the serializer writes {} not null. The ES
    mapping then sees an object every time, keeping dynamic mapping
    predictable."""
    f = _fact(roles=None)
    out = _extract_roles(f, {"obj-1": "x"})
    assert out == {}


def test_extract_roles_uid_map_applied_literal_passthrough():
    """When a role value is NOT an obj-N placeholder (literal surface),
    it passes through unchanged — same fall-through subject_uid uses
    for unmapped values."""
    f = _fact(roles={"recipient": "트럼프"})  # literal surface
    uid_map = {"obj-3": "obj-canonical-trump"}
    out = _extract_roles(f, uid_map)
    assert out == {"recipient": "트럼프"}


def test_serialize_writes_fact_object_role_field():
    """End-to-end: _serialize_struct_fact emits the `fact_object_role`
    key on the serialized doc, populated by _extract_roles.

    ★ STAGE 1c-vii: ACTION default 의 object_value 는 canonical UUID4 강제
    — uid_map 의 값을 UUID4 shape 으로 변경해 serialize strict reject 통과.
    fact_object_role 값 (recipient) 은 UUID4 가드 대상 아님이므로 sentinel
    그대로 유지.
    """
    f = _fact(roles={"recipient": "obj-3"})
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": "22222222-2222-2222-2222-222222222222",
        "obj-3": "obj-canonical-trump",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["fact_object_role"] == {"recipient": "obj-canonical-trump"}


def test_serialize_simple_spo_writes_empty_role_dict():
    """Plain SPO fact (no roles) — serialized doc still has the field
    as {} so ES mapping never sees null.

    ★ STAGE 1c-vii: ACTION default 의 object_value obj-2 를 UUID4 로
    매핑해 serialize strict reject 통과.
    """
    f = _fact()  # no roles
    uid_map = {
        "obj-1": "11111111-1111-1111-1111-111111111111",
        "obj-2": "22222222-2222-2222-2222-222222222222",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["fact_object_role"] == {}
