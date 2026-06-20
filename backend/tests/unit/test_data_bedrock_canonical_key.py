"""Unit tests for B-62 canonical_key + normalize_literal (no DB)."""
from __future__ import annotations

import pytest

from api.storage.canonical import (
    CanonicalEntityRef,
    CanonicalLiteralRef,
    canonical_key,
    normalize_literal,
    object_canonical,
)

# --- normalize_literal -----------------------------------------------------


def test_normalize_literal_strips_outer_whitespace() -> None:
    assert normalize_literal("  hello  ") == "hello"


def test_normalize_literal_collapses_inner_whitespace() -> None:
    assert normalize_literal("857억  달러") == "857억 달러"


def test_normalize_literal_strips_and_collapses_together() -> None:
    # The KO literal "857억 달러" should be equal to the same string
    # with leading/trailing whitespace and a double space inside.
    assert (
        normalize_literal(" 857억  달러 ")
        == normalize_literal("857억 달러")
        == "857억 달러"
    )


def test_normalize_literal_lowercases() -> None:
    assert normalize_literal("OpenAI") == "openai"


def test_normalize_literal_empty_string() -> None:
    assert normalize_literal("") == ""


# --- canonical_key: same triples collapse ---------------------------------


def test_same_subject_predicate_entity_object_gives_same_key() -> None:
    obj: CanonicalEntityRef = {"kind": "entity", "uid": "obj-1"}
    k1 = canonical_key("subj-1", "FOUNDED_BY", obj)
    k2 = canonical_key("subj-1", "FOUNDED_BY", obj)
    assert k1 == k2


def test_literal_object_whitespace_variations_collapse() -> None:
    a: CanonicalLiteralRef = {"kind": "literal", "value": "857억 달러"}
    b: CanonicalLiteralRef = {"kind": "literal", "value": " 857억  달러 "}
    assert canonical_key("s", "HAS_VALUE", a) == canonical_key("s", "HAS_VALUE", b)


def test_literal_object_case_variations_collapse() -> None:
    a: CanonicalLiteralRef = {"kind": "literal", "value": "OpenAI"}
    b: CanonicalLiteralRef = {"kind": "literal", "value": "openai"}
    assert canonical_key("s", "HAS_VALUE", a) == canonical_key("s", "HAS_VALUE", b)


# --- canonical_key: differences propagate to a different key ---------------


def test_different_subjects_give_different_keys() -> None:
    obj: CanonicalEntityRef = {"kind": "entity", "uid": "obj-1"}
    assert canonical_key("subj-A", "FOUNDED_BY", obj) != canonical_key(
        "subj-B", "FOUNDED_BY", obj,
    )


def test_different_predicates_give_different_keys() -> None:
    obj: CanonicalEntityRef = {"kind": "entity", "uid": "obj-1"}
    assert canonical_key("s", "FOUNDED_BY", obj) != canonical_key(
        "s", "LED_BY", obj,
    )


def test_different_literal_values_give_different_keys() -> None:
    a: CanonicalLiteralRef = {"kind": "literal", "value": "857억 달러"}
    b: CanonicalLiteralRef = {"kind": "literal", "value": "100억 달러"}
    assert canonical_key("s", "HAS_VALUE", a) != canonical_key("s", "HAS_VALUE", b)


def test_entity_and_literal_with_same_id_string_differ() -> None:
    # The ``kind`` discriminator must keep an entity reference whose
    # uid is "foo" distinct from a literal whose value is "foo".
    ent: CanonicalEntityRef = {"kind": "entity", "uid": "foo"}
    lit: CanonicalLiteralRef = {"kind": "literal", "value": "foo"}
    assert canonical_key("s", "RELATED_TO", ent) != canonical_key(
        "s", "RELATED_TO", lit,
    )


def test_korean_and_english_literal_of_same_meaning_differ() -> None:
    # Intentional: literal normalization is whitespace + case ONLY.
    # Cross-lingual collapse (e.g. "삼성전자" <-> "Samsung Electronics")
    # is handled at the canonical-entity layer, not in this util.
    ko: CanonicalLiteralRef = {"kind": "literal", "value": "삼성전자"}
    en: CanonicalLiteralRef = {"kind": "literal", "value": "Samsung Electronics"}
    assert canonical_key("s", "IS_A", ko) != canonical_key("s", "IS_A", en)


# --- object_canonical: prefixing prevents collisions ----------------------


def test_object_canonical_entity_prefix() -> None:
    obj: CanonicalEntityRef = {"kind": "entity", "uid": "obj-1"}
    assert object_canonical(obj) == "entity:obj-1"


def test_object_canonical_literal_prefix_and_normalization() -> None:
    obj: CanonicalLiteralRef = {"kind": "literal", "value": "  Hello World  "}
    assert object_canonical(obj) == "literal:hello world"


# Smoke: pytest discovery sanity.
def test_module_exports() -> None:
    from api.storage import canonical as mod
    assert "canonical_key" in mod.__all__
    assert "normalize_literal" in mod.__all__
    # Silence "unused" for the import lint.
    pytest  # noqa: B018
