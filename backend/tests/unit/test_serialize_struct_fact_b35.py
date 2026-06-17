"""Unit tests for B-35 entity-uid remap in _serialize_struct_fact.

The remap is the closing keystone for the cross-fact / cross-job
entity graph: match_or_create_object already returns a canonical
Object UID for any entity name+class within a knowledge_space, but
until B-35 the fact's `subject_uid` and `object_value` kept the LLM's
per-decompose placeholder ("obj-1") instead of the canonical UID.
After the remap, two facts that mention the same entity — whether
in the same article or in a later one — point at the same node.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact


def _f(*, uid: str, subject_uid: str, predicate: str, object_value: str) -> StructureFact:
    return StructureFact.model_validate(
        {
            "uid": uid,
            "type": "proposition",
            "claim": "x",
            "subject_uid": subject_uid,
            "predicate": predicate,
            "object_value": object_value,
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": [],
        },
    )


def test_no_uid_map_passes_through_unchanged():
    """When no uid_map is supplied the function is the pre-B-35
    behaviour: placeholder uids stay intact and the only projection
    is `uid` -> `fact_uid`."""
    f = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="obj-2")
    d = _serialize_struct_fact(f)
    assert d["subject_uid"] == "obj-1"
    assert d["object_value"] == "obj-2"
    # uid alias is still emitted.
    assert d["fact_uid"] == "fn-1"


def test_subject_uid_remapped_through_uid_map():
    """The canonical uid replaces the LLM placeholder on subject."""
    f = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="literal")
    d = _serialize_struct_fact(f, uid_map={"obj-1": "obj-canonical-spacex"})
    assert d["subject_uid"] == "obj-canonical-spacex"
    # Literal object_value untouched.
    assert d["object_value"] == "literal"


def test_object_value_with_obj_ref_is_remapped():
    """When object_value is an obj-N ref (cross-entity link in the
    triple) it gets the same canonical-uid treatment."""
    f = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="obj-2")
    uid_map = {
        "obj-1": "obj-canonical-spacex",
        "obj-2": "obj-canonical-ipo",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == "obj-canonical-spacex"
    assert d["object_value"] == "obj-canonical-ipo"


def test_object_value_literal_is_not_remapped():
    """A literal value that happens to be present in uid_map keys
    must NOT be remapped — only obj-N shaped strings qualify."""
    f = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="85.7 billion USD")
    uid_map = {
        "obj-1": "obj-canonical-spacex",
        # Even if a literal had a canonical mapping registered, the
        # shape check rejects it.
        "85.7 billion USD": "obj-canonical-fake",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == "obj-canonical-spacex"
    assert d["object_value"] == "85.7 billion USD"


def test_missing_placeholder_is_passed_through():
    """If the LLM emits a subject_uid the matcher never produced a
    mapping for (e.g. disambiguation pending) — that uid is preserved
    so the Decide overlay can resolve it via the objects array."""
    f = _f(uid="fn-1", subject_uid="obj-99", predicate="p", object_value="literal")
    d = _serialize_struct_fact(f, uid_map={"obj-1": "obj-canonical-a"})
    assert d["subject_uid"] == "obj-99"


def test_same_canonical_uid_across_facts_yields_shared_subject_uid():
    """The cross-fact graph join: two different facts whose subject
    placeholder maps to the same canonical uid must produce the same
    subject_uid on serialisation. That's what lets graph queries fuse
    facts that talk about the same entity."""
    f1 = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="x")
    f2 = _f(uid="fn-2", subject_uid="obj-7", predicate="q", object_value="y")
    # Both placeholders resolve to the same canonical SpaceX uid:
    uid_map = {"obj-1": "obj-canonical-spacex", "obj-7": "obj-canonical-spacex"}
    d1 = _serialize_struct_fact(f1, uid_map=uid_map)
    d2 = _serialize_struct_fact(f2, uid_map=uid_map)
    assert d1["subject_uid"] == d2["subject_uid"] == "obj-canonical-spacex"


def test_object_to_subject_join_across_facts():
    """The fn-3.object(SpaceX) -> fn-2.subject(SpaceX) graph join
    (the PO's reproduction target) — once both go through the same
    canonical mapping, the join key matches."""
    fn3 = _f(
        uid="fn-3",
        subject_uid="obj-2",  # Goldman Sachs in the LLM placeholder space
        predicate="is_underwriter_for",
        object_value="obj-1",  # SpaceX (object side, ref)
    )
    fn2 = _f(
        uid="fn-2",
        subject_uid="obj-1",  # SpaceX as subject in fn-2
        predicate="total_funding_raised",
        object_value="85.7 billion USD",
    )
    uid_map = {
        "obj-1": "obj-canonical-spacex",
        "obj-2": "obj-canonical-goldman",
    }
    d3 = _serialize_struct_fact(fn3, uid_map=uid_map)
    d2 = _serialize_struct_fact(fn2, uid_map=uid_map)
    assert d3["object_value"] == d2["subject_uid"] == "obj-canonical-spacex"


def test_obj_n_match_is_case_insensitive():
    """LLM has occasionally been observed emitting OBJ-1; the
    placeholder regex is case-insensitive so the remap still fires."""
    f = _f(uid="fn-1", subject_uid="OBJ-1", predicate="p", object_value="OBJ-2")
    uid_map = {
        "OBJ-1": "obj-canonical-spacex",
        "OBJ-2": "obj-canonical-ipo",
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == "obj-canonical-spacex"
    assert d["object_value"] == "obj-canonical-ipo"
