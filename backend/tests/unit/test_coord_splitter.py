"""Unit tests for the B-33 coordination-split safety net.

The splitter fires AFTER the LLM responds, so the inputs here are
hand-crafted StructureResult objects representing exactly what the LLM
might emit. The contract is:

  * Distributive coordination of subjects of the SAME class joined by a
    coord marker -> one extra fact per coord subject.
  * Joint / reciprocal predicates -> never split.
  * Same-class noun mention WITHOUT a coord marker -> never split
    (avoids splitting sentences where two organisations are co-mentioned
    but not grammatically coordinated).
  * The original fact is preserved unchanged at its original list
    position; derived facts are appended right after.
  * Every derived fact carries `tags_suggested += "coord_split"` so
    the Decide overlay can flag them as derivations the PO may want
    to audit.
"""
from __future__ import annotations

import pytest

from api.models.objects import ObjectClass
from api.structure.coord_splitter import (
    JOINT_PREDICATE_MARKERS,
    _is_joint_predicate,
    _next_uid_suffix,
    split_coordinated_subjects,
)
from api.structure.models import (
    StructureFact,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)


def _org(uid: str, name: str, name_en: str | None = None) -> StructureObject:
    return StructureObject.model_validate(
        {
            "uid": uid,
            "class": ObjectClass.ORGANIZATION,
            "name": name,
            "name_en": name_en,
            "properties": {},
        },
    )


def _event(uid: str, name: str) -> StructureObject:
    return StructureObject.model_validate(
        {
            "uid": uid,
            "class": ObjectClass.EVENT,
            "name": name,
            "name_en": name,
            "properties": {},
        },
    )


def _fact(
    *,
    uid: str,
    claim: str,
    subject_uid: str,
    predicate: str,
    object_value: str,
    tags: list[str] | None = None,
    fact_type: str = "claim",
) -> StructureFact:
    # ★ STAGE 1c-vii (★ PO 2026-06-30): ACTION + literal object_value 는
    # validator 가 raise — coord_splitter fixture 는 발화 내용 literal
    # ("SpaceX IPO" 등) 을 가짐. CLAIM 으로 우회. splitter 로직은 fact_type
    # 에 무관하므로 회귀 위험 X.
    return StructureFact.model_validate(
        {
            "uid": uid,
            "type": "proposition",
            "claim": claim,
            "subject_uid": subject_uid,
            "predicate": predicate,
            "object_value": object_value,
            "negation_flag": False,
            "negation_scope": None,
            "tags_suggested": tags or [],
            "fact_type": fact_type,
        },
    )


def _result(
    *,
    facts: list[StructureFact],
    objects: list[StructureObject],
) -> StructureResult:
    return StructureResult(
        objects=objects,
        facts=facts,
        fact_object_links=[],
        fact_fact_links=[],
        disambiguation_candidates=[],
        extraction_status="success",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_next_uid_suffix_basic_alpha():
    assert _next_uid_suffix(0) == "a"
    assert _next_uid_suffix(1) == "b"
    assert _next_uid_suffix(25) == "z"


def test_next_uid_suffix_double_letter():
    # The two-letter rollover follows base-26 with a leading offset so
    # 26 -> aa, 27 -> ab, ... (matches xlsx column naming for clarity).
    assert _next_uid_suffix(26) == "aa"
    assert _next_uid_suffix(27) == "ab"


@pytest.mark.parametrize("p", list(JOINT_PREDICATE_MARKERS))
def test_is_joint_predicate_recognises_all_markers(p):
    assert _is_joint_predicate(p) is True
    assert _is_joint_predicate(f"prefix_{p}_suffix") is True


@pytest.mark.parametrize(
    "p",
    ["is_underwriter_for", "total_funds_raised", "exercised", "set_ipo_price"],
)
def test_is_joint_predicate_passes_through_non_joint(p):
    assert _is_joint_predicate(p) is False


# ---------------------------------------------------------------------------
# Distributive coordination -> SPLIT
# ---------------------------------------------------------------------------

def test_korean_와_coordination_splits_subjects():
    """The SpaceX fn-3 case: "Goldman Sachs와 Morgan Stanley가 ~".

    LLM picked Goldman Sachs as the subject; Morgan Stanley was
    recognised as a same-class Object but no fact attached to it. The
    splitter must emit a second fact with Morgan Stanley as subject.
    """
    objs = [
        _org("obj-1", "SpaceX"),
        _org("obj-2", "Goldman Sachs"),
        _org("obj-3", "Morgan Stanley"),
        _event("obj-12", "SpaceX IPO"),
    ]
    facts = [
        _fact(
            uid="fn-3",
            claim="Goldman Sachs와 Morgan Stanley가 SpaceX의 주관사단에 포함되어 있다.",
            subject_uid="obj-2",
            predicate="is_underwriter_for",
            object_value="SpaceX IPO",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 2
    assert out.facts[0].uid == "fn-3"
    assert out.facts[0].subject_uid == "obj-2"
    derived = out.facts[1]
    assert derived.uid == "fn-3-a"
    assert derived.subject_uid == "obj-3"
    assert derived.predicate == "is_underwriter_for"
    assert derived.object_value == "SpaceX IPO"
    assert "coord_split" in derived.tags_suggested
    # An involves link for the new subject was appended.
    assert any(
        link.fact_uid == "fn-3-a" and link.object_uid == "obj-3"
        for link in out.fact_object_links
    )


def test_english_and_coordination_splits_subjects():
    objs = [
        _org("obj-1", "SpaceX"),
        _org("obj-2", "Goldman Sachs", name_en="Goldman Sachs"),
        _org("obj-3", "Morgan Stanley", name_en="Morgan Stanley"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Goldman Sachs and Morgan Stanley underwrote the SpaceX IPO.",
            subject_uid="obj-2",
            predicate="is_underwriter_for",
            object_value="SpaceX IPO",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 2
    assert out.facts[1].subject_uid == "obj-3"


def test_three_way_coordination_emits_two_derived_facts():
    """A, B, and C -> three atomic facts: the original (A) + one each
    for B and C."""
    objs = [
        _org("obj-1", "Alpha"),
        _org("obj-2", "Bravo"),
        _org("obj-3", "Charlie"),
        _event("obj-9", "Round X"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Alpha, Bravo, and Charlie participated in Round X.",
            subject_uid="obj-1",
            predicate="participated_in",
            object_value="Round X",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    derived_subjects = sorted(f.subject_uid for f in out.facts)
    assert derived_subjects == ["obj-1", "obj-2", "obj-3"]
    assert {f.uid for f in out.facts} == {"fn-1", "fn-1-a", "fn-1-b"}


# ---------------------------------------------------------------------------
# Joint / reciprocal relation -> KEEP
# ---------------------------------------------------------------------------

def test_merger_is_not_split():
    objs = [
        _org("obj-1", "Disney"),
        _org("obj-2", "Fox"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Disney와 Fox는 2019년에 합병했다.",
            subject_uid="obj-1",
            predicate="merged_with",
            object_value="Fox",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 1
    assert out.facts[0].uid == "fn-1"


def test_partnership_is_not_split():
    objs = [
        _org("obj-1", "Acme"),
        _org("obj-2", "Globex"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Acme와 Globex가 제휴를 맺었다.",
            subject_uid="obj-1",
            predicate="partnered_with",
            object_value="Globex",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 1


# ---------------------------------------------------------------------------
# Negative cases — do NOT split
# ---------------------------------------------------------------------------

def test_cross_class_pair_not_split():
    """Subject is an organization; the other mention is an event of
    different class — even with `와` in between, splitting an
    organisation/event coordination would be nonsense."""
    objs = [
        _org("obj-1", "SpaceX"),
        _event("obj-2", "SpaceX IPO"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="SpaceX와 SpaceX IPO는 같은 회사 사건이다.",
            subject_uid="obj-1",
            predicate="hosted",
            object_value="SpaceX IPO",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 1


def test_no_coord_marker_no_split():
    """Two same-class names co-mentioned but without a `와`/and marker
    between them — the splitter must not fire."""
    objs = [
        _org("obj-1", "Apple"),
        _org("obj-2", "Google"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Apple은 Google의 검색 결과에 대해 입장을 밝혔다.",
            subject_uid="obj-1",
            predicate="commented_on",
            object_value="Google search results",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 1


def test_unknown_subject_uid_does_not_split():
    """If the LLM's subject_uid isn't in the objects list (data error),
    the splitter must not crash and must not invent a split."""
    objs = [_org("obj-1", "Alpha"), _org("obj-2", "Bravo")]
    facts = [
        _fact(
            uid="fn-1",
            claim="Alpha와 Bravo가 행동했다.",
            subject_uid="obj-missing",
            predicate="acted",
            object_value="something",
        ),
    ]
    out = split_coordinated_subjects(_result(facts=facts, objects=objs))
    assert len(out.facts) == 1


def test_empty_inputs_pass_through():
    out = split_coordinated_subjects(
        _result(facts=[], objects=[]),
    )
    assert out.facts == []
    assert out.objects == []


# ---------------------------------------------------------------------------
# Regression: links of original fact preserved untouched
# ---------------------------------------------------------------------------

def test_original_fact_object_links_preserved():
    objs = [
        _org("obj-1", "SpaceX"),
        _org("obj-2", "Goldman Sachs"),
        _org("obj-3", "Morgan Stanley"),
    ]
    facts = [
        _fact(
            uid="fn-1",
            claim="Goldman Sachs와 Morgan Stanley가 SpaceX의 주관사단에 포함되어 있다.",
            subject_uid="obj-2",
            predicate="is_underwriter_for",
            object_value="SpaceX IPO",
        ),
    ]
    seed_link = StructureFactObjectLink(
        fact_uid="fn-1",
        object_uid="obj-1",
        link_type="involves",
        properties={},
    )
    inp = StructureResult(
        objects=objs,
        facts=facts,
        fact_object_links=[seed_link],
        fact_fact_links=[],
        disambiguation_candidates=[],
        extraction_status="success",
    )
    out = split_coordinated_subjects(inp)
    # Seed link still first.
    assert out.fact_object_links[0] == seed_link
    # New `involves` link for fn-1-a appended.
    assert any(
        link.fact_uid == "fn-1-a" and link.object_uid == "obj-3"
        and link.link_type == "involves"
        for link in out.fact_object_links
    )
