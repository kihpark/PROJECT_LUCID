"""Unit: structure/fact_dedup (fix/fact-dedup-on-structure-output).

PO 2026-06-27 - the LLM occasionally multi-emits the same canonical
(subject, predicate_code, object) tuple under different fact_uids.
Live evidence (job_id 3bab7b79...): 14 facts, 4 exact duplicates with
predicate_code=RELATED_TO. The structure stage now dedups before
stamping `extracted_metadata.structure.facts` so the Decide overlay
shows each atomic fact exactly once.
"""
from __future__ import annotations

from api.structure.fact_dedup import dedup_facts, filter_links_by_fact_uids


def test_exact_tuple_dup_keeps_first_only():
    """Two identical (subject, predicate, object) tuples -> 1 fact survives."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "fn-b", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert kept[0]["fact_uid"] == "fn-a"
    assert dropped == {"fn-b"}


def test_case_insensitive_dedup():
    """KIST vs kist collapse to the same key."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "KIST",
         "predicate_code": "related_to", "object_value": "ML"},
        {"fact_uid": "fn-b", "subject_label": "kist",
         "predicate_code": "RELATED_TO", "object_value": "ml"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_whitespace_tolerant():
    """Surrounding whitespace does not break the dedup."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": "ML"},
        {"fact_uid": "fn-b", "subject_label": "  KIST  ",
         "predicate_code": "  RELATED_TO\n", "object_value": "ML "},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_object_label_takes_precedence_over_object_value():
    """object_label (entity ref) beats object_value (literal)."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "predicate_code": "LEADS",
         "object_label": "KIST", "object_value": "obj-7"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "predicate_code": "LEADS",
         "object_label": "KIST", "object_value": "obj-9"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_object_value_used_when_object_label_absent():
    """No object_label -> fall back to object_value."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "predicate_code": "PUBLISHED",
         "object_value": "Prospect Theory"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "predicate_code": "PUBLISHED",
         "object_value": "Prospect Theory"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_subject_uid_used_when_subject_label_absent():
    """Fallback chain works for subject too."""
    facts = [
        {"fact_uid": "fn-a", "subject_uid": "obj-1",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "fn-b", "subject_uid": "obj-1",
         "predicate_code": "RELATED_TO", "object_value": None},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_predicate_falls_back_to_natural_predicate():
    """No predicate_code -> fall back to LLM predicate field."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "predicate": "발표했다", "object_value": "Y"},
        {"fact_uid": "fn-b", "subject_label": "X",
         "predicate": "발표했다", "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert dropped == {"fn-b"}


def test_empty_tuple_kept_once():
    """All-empty facts collapse to one survivor."""
    facts = [
        {"fact_uid": "fn-a"},
        {"fact_uid": "fn-b"},
        {"fact_uid": "fn-c"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert kept[0]["fact_uid"] == "fn-a"
    assert dropped == {"fn-b", "fn-c"}


def test_multiple_unique_all_preserved():
    """Distinct tuples - every fact survives."""
    facts = [
        {"fact_uid": "fn-1", "subject_label": "KIST",
         "predicate_code": "LEADS", "object_label": "ProjA"},
        {"fact_uid": "fn-2", "subject_label": "KETI",
         "predicate_code": "LEADS", "object_label": "ProjB"},
        {"fact_uid": "fn-3", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "fn-4", "subject_label": "KETI",
         "predicate_code": "RELATED_TO", "object_value": None},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 4
    assert dropped == set()


def test_po_live_scenario_4_dups_dropped():
    """Reproduce PO job 3bab7b79 evidence: 4 facts -> 2 unique survive."""
    facts = [
        {"fact_uid": "e226de7d", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "c531cb29", "subject_label": "KETI",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "dfcd265a", "subject_label": "KETI",
         "predicate_code": "RELATED_TO", "object_value": None},
        {"fact_uid": "14396d74", "subject_label": "KIST",
         "predicate_code": "RELATED_TO", "object_value": None},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2
    assert [f["fact_uid"] for f in kept] == ["e226de7d", "c531cb29"]
    assert dropped == {"dfcd265a", "14396d74"}


def test_empty_input_returns_empty():
    """Empty list -> empty result + empty dropped set."""
    kept, dropped = dedup_facts([])
    assert kept == []
    assert dropped == set()


def test_uid_field_aliases_collected():
    """Dropped uids collected from both fact_uid and uid keys."""
    facts = [
        {"uid": "fn-a", "fact_uid": "fn-a", "subject_label": "X",
         "predicate_code": "P", "object_value": "Y"},
        {"uid": "fn-b-uid-only", "subject_label": "X",
         "predicate_code": "P", "object_value": "Y"},
        {"fact_uid": "fn-c-fact-uid-only", "subject_label": "X",
         "predicate_code": "P", "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 1
    assert "fn-b-uid-only" in dropped
    assert "fn-c-fact-uid-only" in dropped


def test_filter_links_drops_links_referencing_dropped_facts():
    """fact_object_links_detail cascade - links to dropped facts go."""
    links = [
        {"fact_uid": "fn-a", "object_uid": "obj-1", "link_type": "involves"},
        {"fact_uid": "fn-b-dup", "object_uid": "obj-1", "link_type": "involves"},
        {"fact_uid": "fn-c", "object_uid": "obj-2", "link_type": "uses"},
    ]
    out = filter_links_by_fact_uids(
        links, {"fn-b-dup"}, uid_fields=("fact_uid",),
    )
    assert len(out) == 2
    assert [link["fact_uid"] for link in out] == ["fn-a", "fn-c"]


def test_filter_links_handles_fact_fact_link_either_side():
    """fact_fact_links: drop when EITHER endpoint is dropped."""
    links = [
        {"from_uid": "fn-a", "to_uid": "fn-c", "link_type": "supports"},
        {"from_uid": "fn-b-dup", "to_uid": "fn-c", "link_type": "supports"},
        {"from_uid": "fn-a", "to_uid": "fn-b-dup", "link_type": "supports"},
    ]
    out = filter_links_by_fact_uids(
        links, {"fn-b-dup"}, uid_fields=("from_uid", "to_uid"),
    )
    assert len(out) == 1
    assert out[0] == {"from_uid": "fn-a", "to_uid": "fn-c",
                      "link_type": "supports"}


def test_filter_links_no_dropped_is_identity():
    """Empty dropped set -> links unchanged (copy)."""
    links = [{"fact_uid": "fn-a", "object_uid": "obj-1",
              "link_type": "involves"}]
    out = filter_links_by_fact_uids(links, set(), uid_fields=("fact_uid",))
    assert out == links
    assert out is not links


def test_non_dict_fact_passed_through_defensively():
    """Defense in depth: a stray non-dict survives the pass (no crash)."""
    facts = [
        {"fact_uid": "fn-a", "subject_label": "X",
         "predicate_code": "P", "object_value": "Y"},
        "stray-non-dict",
        {"fact_uid": "fn-b", "subject_label": "X",
         "predicate_code": "P", "object_value": "Y"},
    ]
    kept, dropped = dedup_facts(facts)
    assert len(kept) == 2
    assert dropped == {"fn-b"}
