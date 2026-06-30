"""Unit tests for B-35 entity-uid remap in _serialize_struct_fact.

The remap is the closing keystone for the cross-fact / cross-job
entity graph: match_or_create_object already returns a canonical
Object UID for any entity name+class within a knowledge_space, but
until B-35 the fact's `subject_uid` and `object_value` kept the LLM's
per-decompose placeholder ("obj-1") instead of the canonical UID.
After the remap, two facts that mention the same entity — whether
in the same article or in a later one — point at the same node.

★ REQ-004 STAGE 1c-iii update:
The original B-35 invariant assumed `object_value` literals (e.g.
"obj-canonical-spacex", "85.7 billion USD") would pass through the
serializer untouched. v3 changes this for ACTION facts — literal
object_value is ★ stripped to "" because v3 requires entity_id only.
CLAIM and MEASUREMENT fact_types preserve their literal object_value
(intentional — content / numeric expression). Tests below now use
canonical UUIDs in uid_map values (the real shape produced by
new_uid() / match-or-create) and switch tests that asserted literal
preservation to fact_type="claim".
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

# Real-shaped canonical UUIDs (★ what new_uid() actually produces in prod).
_UID_SPACEX = "11111111-1111-1111-1111-111111111111"
_UID_IPO = "22222222-2222-2222-2222-222222222222"
_UID_GOLDMAN = "33333333-3333-3333-3333-333333333333"
_UID_FAKE = "44444444-4444-4444-4444-444444444444"
_UID_A = "55555555-5555-5555-5555-555555555555"


def _f(
    *, uid: str, subject_uid: str, predicate: str, object_value: str,
    fact_type: str = "action",
) -> StructureFact:
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
            "fact_type": fact_type,
        },
    )


def test_no_uid_map_passes_through_unchanged():
    """When no uid_map is supplied the function is the pre-B-35
    behaviour: placeholder uids stay intact and the only projection
    is `uid` -> `fact_uid`.

    ★ STAGE 1c-iii: ACTION fact + unmapped obj-N → literal-strip
    zeros object_value. Use fact_type="claim" so the literal stays
    (CLAIM 의도 = 발화 내용 literal)."""
    f = _f(
        uid="fn-1", subject_uid="obj-1", predicate="p", object_value="obj-2",
        fact_type="claim",
    )
    d = _serialize_struct_fact(f)
    assert d["subject_uid"] == "obj-1"
    assert d["object_value"] == "obj-2"
    # uid alias is still emitted.
    assert d["fact_uid"] == "fn-1"


def test_subject_uid_remapped_through_uid_map():
    """The canonical uid replaces the LLM placeholder on subject.

    ★ STAGE 1c-iii: CLAIM fact_type preserves the literal object_value;
    ACTION fact_type would strip it. The original test asserted literal
    preservation, so we use CLAIM here."""
    f = _f(
        uid="fn-1", subject_uid="obj-1", predicate="p", object_value="literal",
        fact_type="claim",
    )
    d = _serialize_struct_fact(f, uid_map={"obj-1": _UID_SPACEX})
    assert d["subject_uid"] == _UID_SPACEX
    # Literal object_value untouched on CLAIM.
    assert d["object_value"] == "literal"


def test_object_value_with_obj_ref_is_remapped():
    """When object_value is an obj-N ref (cross-entity link in the
    triple) it gets the same canonical-uid treatment.

    ★ STAGE 1c-iii: uid_map values must be canonical UUIDs (real shape)
    for ACTION facts so the post-remap literal-strip does not fire."""
    f = _f(uid="fn-1", subject_uid="obj-1", predicate="p", object_value="obj-2")
    uid_map = {
        "obj-1": _UID_SPACEX,
        "obj-2": _UID_IPO,
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == _UID_SPACEX
    assert d["object_value"] == _UID_IPO


def test_object_value_literal_is_not_remapped():
    """A literal value that happens to be present in uid_map keys
    must NOT be remapped — only obj-N shaped strings qualify.

    ★ STAGE 1c-iii: ACTION fact_type would strip the literal anyway;
    use CLAIM so the literal preservation invariant survives."""
    f = _f(
        uid="fn-1", subject_uid="obj-1", predicate="p",
        object_value="85.7 billion USD", fact_type="claim",
    )
    uid_map = {
        "obj-1": _UID_SPACEX,
        # Even if a literal had a canonical mapping registered, the
        # shape check rejects it.
        "85.7 billion USD": _UID_FAKE,
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == _UID_SPACEX
    assert d["object_value"] == "85.7 billion USD"


def test_missing_placeholder_is_passed_through():
    """If the LLM emits a subject_uid the matcher never produced a
    mapping for (e.g. disambiguation pending) — that uid is preserved
    so the Decide overlay can resolve it via the objects array.

    ★ STAGE 1c-iii: ACTION + literal "literal" would strip; use CLAIM."""
    f = _f(
        uid="fn-1", subject_uid="obj-99", predicate="p",
        object_value="literal", fact_type="claim",
    )
    d = _serialize_struct_fact(f, uid_map={"obj-1": _UID_A})
    assert d["subject_uid"] == "obj-99"


def test_same_canonical_uid_across_facts_yields_shared_subject_uid():
    """The cross-fact graph join: two different facts whose subject
    placeholder maps to the same canonical uid must produce the same
    subject_uid on serialisation. That's what lets graph queries fuse
    facts that talk about the same entity.

    ★ STAGE 1c-iii: object_value literals stripped for ACTION; use
    CLAIM fact_type to keep the literal so the assertion focus stays
    on subject_uid joining."""
    f1 = _f(
        uid="fn-1", subject_uid="obj-1", predicate="p",
        object_value="x", fact_type="claim",
    )
    f2 = _f(
        uid="fn-2", subject_uid="obj-7", predicate="q",
        object_value="y", fact_type="claim",
    )
    # Both placeholders resolve to the same canonical SpaceX uid:
    uid_map = {"obj-1": _UID_SPACEX, "obj-7": _UID_SPACEX}
    d1 = _serialize_struct_fact(f1, uid_map=uid_map)
    d2 = _serialize_struct_fact(f2, uid_map=uid_map)
    assert d1["subject_uid"] == d2["subject_uid"] == _UID_SPACEX


def test_object_to_subject_join_across_facts():
    """The fn-3.object(SpaceX) -> fn-2.subject(SpaceX) graph join
    (the PO's reproduction target) — once both go through the same
    canonical mapping, the join key matches.

    ★ STAGE 1c-iii: fn-2 uses CLAIM fact_type so the "85.7 billion USD"
    literal survives the literal-strip; fn-3 is ACTION (entity-to-entity
    is the v3 ACTION shape), and its object_value remaps to canonical
    SpaceX UUID."""
    fn3 = _f(
        uid="fn-3",
        subject_uid="obj-2",  # Goldman Sachs in the LLM placeholder space
        predicate="is_underwriter_for",
        object_value="obj-1",  # SpaceX (object side, ref) — entity_id
        fact_type="action",
    )
    fn2 = _f(
        uid="fn-2",
        subject_uid="obj-1",  # SpaceX as subject in fn-2
        predicate="total_funding_raised",
        object_value="85.7 billion USD",
        fact_type="claim",  # ★ literal numeric statement — CLAIM
    )
    uid_map = {
        "obj-1": _UID_SPACEX,
        "obj-2": _UID_GOLDMAN,
    }
    d3 = _serialize_struct_fact(fn3, uid_map=uid_map)
    d2 = _serialize_struct_fact(fn2, uid_map=uid_map)
    assert d3["object_value"] == d2["subject_uid"] == _UID_SPACEX


def test_obj_n_match_is_case_insensitive():
    """LLM has occasionally been observed emitting OBJ-1; the
    placeholder regex is case-insensitive so the remap still fires.

    ★ STAGE 1c-iii: uid_map values must be canonical UUIDs so the
    post-remap ACTION literal-strip does not fire."""
    f = _f(uid="fn-1", subject_uid="OBJ-1", predicate="p", object_value="OBJ-2")
    uid_map = {
        "OBJ-1": _UID_SPACEX,
        "OBJ-2": _UID_IPO,
    }
    d = _serialize_struct_fact(f, uid_map=uid_map)
    assert d["subject_uid"] == _UID_SPACEX
    assert d["object_value"] == _UID_IPO
