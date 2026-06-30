"""B-37 defect 2 backend regression: _serialize_struct_object now
remaps the object's uid through the same uid_map that
_serialize_struct_fact uses. Without this, the canonical UUIDs on
fact.subject_uid never line up with the obj.uid in the Decide
overlay's objects array, and FactCard ends up displaying raw UUIDs.
"""
from __future__ import annotations

from api.models.objects import ObjectClass
from api.structure.models import StructureObject
from api.structure.processor import _serialize_struct_object


def _obj(uid: str, name: str) -> StructureObject:
    return StructureObject.model_validate(
        {
            "uid": uid,
            "class": ObjectClass.ORGANIZATION,
            "name": name,
            "name_en": name,
            "properties": {},
        },
    )


def test_no_uid_map_passes_through_unchanged():
    """The pre-B-37 behaviour: no uid_map -> uid stays as the LLM
    emitted it. Other callers without a remap context still work."""
    o = _obj("obj-1", "SpaceX")
    d = _serialize_struct_object(o)
    assert d["uid"] == "obj-1"


def test_object_uid_remapped_through_uid_map():
    """The B-37 fix: the canonical uid replaces the LLM placeholder
    on the serialised object, matching the same remap that already
    runs on facts.subject_uid (B-35)."""
    o = _obj("obj-1", "SpaceX")
    uid_map = {"obj-1": "canonical-spacex"}
    d = _serialize_struct_object(o, uid_map=uid_map)
    assert d["uid"] == "canonical-spacex"
    # Other fields untouched.
    assert d["name"] == "SpaceX"
    assert d["class"] == "organization"


def test_object_uid_missing_from_map_preserved():
    """If the matcher didn't issue a canonical uid for this object
    (e.g. disambiguation still pending) the uid stays as the
    placeholder so the Decide overlay can still find a name."""
    o = _obj("obj-99", "Unknown Org")
    uid_map = {"obj-1": "canonical-other"}
    d = _serialize_struct_object(o, uid_map=uid_map)
    assert d["uid"] == "obj-99"


def test_properties_dict_still_coerced_to_plain_dict():
    """Regression on the original chore-5 contract: properties is
    coerced to a plain dict regardless of whether uid_map is supplied."""
    o = StructureObject.model_validate(
        {
            "uid": "obj-1",
            "class": ObjectClass.METRIC,
            "name": "value",
            "name_en": "value",
            "properties": {"unit": "USD", "value": 100},
        },
    )
    d = _serialize_struct_object(o, uid_map={"obj-1": "canon-a"})
    assert d["uid"] == "canon-a"
    assert d["properties"] == {"unit": "USD", "value": 100}
    assert isinstance(d["properties"], dict)


def test_b37_end_to_end_matches_fact_subject_uid():
    """The point of the fix: after both serialisers run with the
    same uid_map, fact.subject_uid and obj.uid carry identical
    canonical strings — that's the join key FactCard needs.

    ★ STAGE 1c-vii: ACTION + literal "85.7 billion USD" 는 validator 가
    raise. fact_type=claim 으로 우회 (수치 literal 의도 = CLAIM/MEASUREMENT
    영역; 여기서는 surface join 만 검증).
    """
    from api.structure.models import StructureFact
    from api.structure.processor import _serialize_struct_fact

    obj = _obj("obj-1", "SpaceX")
    fact = StructureFact.model_validate(
        {
            "uid": "fn-1",
            "type": "proposition",
            "claim": "x",
            "subject_uid": "obj-1",
            "predicate": "p",
            "object_value": "85.7 billion USD",
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
            "fact_type": "claim",
        },
    )
    uid_map = {"obj-1": "canonical-spacex"}

    obj_dict = _serialize_struct_object(obj, uid_map=uid_map)
    fact_dict = _serialize_struct_fact(fact, uid_map=uid_map)

    assert obj_dict["uid"] == fact_dict["subject_uid"] == "canonical-spacex"
