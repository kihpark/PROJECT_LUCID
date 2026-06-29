"""STELLAR v2 wonchik 1 - ACTION fact entity-edge gangje."""
from __future__ import annotations

import pytest

from api.structure.action_object_resolver import (
    resolve_action_object_to_entity,
)
from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)

pytestmark = pytest.mark.integration


def _make_action_fact(uid, subject_uid, object_value, predicate="did"):
    return StructureFact.model_validate({
        "uid": uid,
        "type": "proposition",
        "claim": subject_uid + " " + predicate + " " + object_value,
        "subject_uid": subject_uid,
        "predicate": predicate,
        "object_value": object_value,
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": "action",
    })


def _make_claim_fact(uid, subject_uid, speaker_uid, object_value, claim,
                     speech_act="said"):
    return StructureFact.model_validate({
        "uid": uid,
        "type": "proposition",
        "claim": claim,
        "subject_uid": subject_uid,
        "predicate": speech_act,
        "object_value": object_value,
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": "claim",
        "speaker_uid": speaker_uid,
        "speaker_label": "(speaker)",
        "speech_act": speech_act,
        "content_claim": object_value,
        "stance": "neutral",
    })


def _make_measurement_fact(uid, subject_uid, object_value, metric, value,
                           unit, as_of=None):
    return StructureFact.model_validate({
        "uid": uid,
        "type": "proposition",
        "claim": subject_uid + " " + metric + " is " + str(value) + " " + unit,
        "subject_uid": subject_uid,
        "predicate": "is",
        "object_value": object_value,
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
        "fact_type": "measurement",
        "metric": metric,
        "measurement_value": value,
        "measurement_unit": unit,
        "as_of": as_of,
    })


def _obj(uid, klass, name, name_en=None, aliases=None):
    return StructureObject.model_validate({
        "uid": uid,
        "class": klass,
        "name": name,
        "name_en": name_en,
        "aliases": aliases or [],
        "properties": {},
    })


def _result(objects, facts, links=None):
    return StructureResult(
        objects=objects,
        facts=facts,
        fact_object_links=list(links or []),
        fact_fact_links=[],
        disambiguation_candidates=[],
        extraction_status="success",
        failure_reason=None,
    )


def test_arbitrary_action_facts_all_resolve_to_entity_object():
    objects = [
        _obj("obj-1", "person", "Person A"),
        _obj("obj-2", "organization", "Org A"),
        _obj("obj-3", "person", "Person B"),
        _obj("obj-4", "organization", "Org B"),
        _obj("obj-5", "person", "Person C"),
        _obj("obj-6", "organization", "Org C"),
        _obj("obj-7", "person", "Person D"),
        _obj("obj-8", "organization", "Org D"),
        _obj("obj-9", "person", "Person E"),
        _obj("obj-10", "organization", "Org E"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "Org A", "joined"),
        _make_action_fact("fn-2", "obj-3", "Org B", "founded"),
        _make_action_fact("fn-3", "obj-5", "Org C", "left"),
        _make_action_fact("fn-4", "obj-7", "Org D", "lead"),
        _make_action_fact("fn-5", "obj-9", "Org E", "advised"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    violations = [
        f for f in out.facts
        if f.fact_type == "action"
        and not (isinstance(f.object_value, str)
                 and f.object_value.startswith("obj-"))
    ]
    assert violations == []
    pairs = {(f.subject_uid, f.object_value) for f in out.facts}
    assert ("obj-1", "obj-2") in pairs
    assert ("obj-3", "obj-4") in pairs
    assert ("obj-5", "obj-6") in pairs
    assert ("obj-7", "obj-8") in pairs
    assert ("obj-9", "obj-10") in pairs


def test_korean_literal_object_with_trailing_particle_matches():
    objects = [
        _obj("obj-1", "person", "강재호"),
        _obj("obj-2", "organization", "이로운몰"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "이로운몰을", "설립했다"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "obj-2"
    addr_links = [
        link for link in out.fact_object_links
        if link.fact_uid == "fn-1" and link.object_uid == "obj-2"
        and link.link_type == "addresses"
    ]
    assert len(addr_links) == 1, addr_links


def test_substring_reverse_direction_matches():
    objects = [
        _obj("obj-1", "person", "Person X"),
        _obj("obj-2", "organization", "대한축구협회",
             name_en="Korea Football Association"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "축구협회", "sued"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "obj-2"


def test_alias_match_picks_canonical_obj():
    objects = [
        _obj("obj-1", "person", "Person X"),
        _obj("obj-2", "organization", "OpenAI", aliases=["오픈AI"]),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "오픈AI", "joined"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "obj-2"


def test_no_match_leaves_object_value_untouched():
    objects = [_obj("obj-1", "person", "Person X")]
    facts = [
        _make_action_fact("fn-1", "obj-1",
                          "absolutely unknown entity", "referenced"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "absolutely unknown entity"
    assert not out.fact_object_links


def test_already_objN_action_unchanged():
    objects = [
        _obj("obj-1", "person", "Person X"),
        _obj("obj-2", "organization", "Org X"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "obj-2", "joined"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "obj-2"
    assert not out.fact_object_links


def test_claim_fact_object_value_unchanged():
    objects = [
        _obj("obj-1", "person", "Trump"),
        _obj("obj-2", "concept", "tariff cut possibility"),
    ]
    facts = [
        _make_claim_fact("fn-1", "obj-1", "obj-1",
                         "tariff cut possibility",
                         "Trump denied tariff cut possibility.",
                         "denied"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "tariff cut possibility"
    assert out.facts[0].fact_type == "claim"


def test_measurement_fact_object_value_unchanged():
    objects = [
        _obj("obj-1", "service", "ChatGPT"),
        _obj("obj-2", "metric", "MAU"),
    ]
    facts = [
        _make_measurement_fact("fn-1", "obj-1", "800000000",
                               "MAU", 800_000_000, "users", "2026-03"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "800000000"
    assert out.facts[0].fact_type == "measurement"


def test_self_edge_avoided():
    objects = [_obj("obj-1", "organization", "Org X")]
    facts = [
        _make_action_fact("fn-1", "obj-1", "Org X", "declared"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    assert out.facts[0].object_value == "Org X"


def test_idempotent_addresses_link_no_duplicate():
    objects = [
        _obj("obj-1", "person", "Person X"),
        _obj("obj-2", "organization", "Org X"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "Org X", "joined"),
    ]
    pre_link = StructureFactObjectLink(
        fact_uid="fn-1", object_uid="obj-2",
        link_type="addresses", properties={},
    )
    out = resolve_action_object_to_entity(
        _result(objects, facts, links=[pre_link])
    )
    addr_count = sum(
        1 for link in out.fact_object_links
        if link.fact_uid == "fn-1" and link.object_uid == "obj-2"
        and link.link_type == "addresses"
    )
    assert addr_count == 1
    assert out.facts[0].object_value == "obj-2"


def test_violation_class_zero_after_full_pass():
    objects = [
        _obj("obj-1", "person", "P1"),
        _obj("obj-2", "organization", "O1"),
        _obj("obj-3", "person", "P2"),
        _obj("obj-4", "organization", "O2"),
        _obj("obj-5", "concept", "C1"),
        _obj("obj-6", "service", "S1"),
        _obj("obj-7", "metric", "M1"),
    ]
    facts = [
        _make_action_fact("fn-1", "obj-1", "O1", "joined"),
        _make_action_fact("fn-2", "obj-3", "O2", "founded"),
        _make_action_fact("fn-3", "obj-1", "C1", "proposed"),
        _make_claim_fact("fn-4", "obj-3", "obj-3",
                         "market is slowing",
                         "P2 said market is slowing."),
        _make_measurement_fact("fn-5", "obj-6", "100000000",
                               "M1", 100_000_000, "users"),
    ]
    out = resolve_action_object_to_entity(_result(objects, facts))
    action_violations = [
        f for f in out.facts
        if f.fact_type == "action"
        and not (isinstance(f.object_value, str)
                 and f.object_value.startswith("obj-"))
    ]
    assert action_violations == [], action_violations
    claim_fact = next(f for f in out.facts if f.uid == "fn-4")
    assert claim_fact.object_value == "market is slowing"
    meas_fact = next(f for f in out.facts if f.uid == "fn-5")
    assert meas_fact.object_value == "100000000"


def test_returns_same_result_object_for_chaining():
    res = _result(
        [_obj("obj-1", "person", "X")],
        [_make_action_fact("fn-1", "obj-1", "literal", "did")],
    )
    out = resolve_action_object_to_entity(res)
    assert out is res