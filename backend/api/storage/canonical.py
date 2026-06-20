"""B-62 data bedrock — canonical S-P-O key + literal normalization.

The canonical key collapses two captures of the same proposition with
slightly different surface forms (whitespace, case, inner spaces) into
a single dedup key. The downstream B-48a `find_fact_by_spo` lookup uses
this key as the primary equality test before writing a new fact.

Scope of normalization (intentional non-goals):
  * Literal normalization is whitespace + case only. Korean/English
    semantic equivalence (e.g. "857억 달러" vs "$85.7B") is handled at
    the canonical-entity layer, not here.
  * Predicate codes are exact-match controlled-vocabulary strings.
    No alias resolution here — the caller passes the OPL code.
  * Entity references are exact-match by subject_uid. Cross-lingual
    canonical-entity collapse runs upstream of this util.
"""
from __future__ import annotations

import re
from typing import Literal, TypedDict

_WHITESPACE_RUN = re.compile(r"\s+", re.UNICODE)


class CanonicalEntityRef(TypedDict):
    """Object of an S-P-O triple when the object is a canonical entity."""

    kind: Literal["entity"]
    uid: str


class CanonicalLiteralRef(TypedDict):
    """Object of an S-P-O triple when the object is a literal value."""

    kind: Literal["literal"]
    value: str


CanonicalObject = CanonicalEntityRef | CanonicalLiteralRef


def normalize_literal(value: str) -> str:
    """Collapse whitespace runs and lowercase the literal.

    * Strips leading / trailing whitespace.
    * Replaces every internal whitespace run (spaces, tabs, NBSP, etc.)
      with a single ASCII space.
    * Lowercases via ``str.lower()`` (Unicode-aware).

    Two literals that differ only in whitespace or case map to the same
    canonical key. Semantic / cross-lingual equivalence is OUT OF SCOPE
    and lives at the canonical-entity layer.
    """
    if value is None:  # type: ignore[unreachable]
        return ""
    return _WHITESPACE_RUN.sub(" ", value.strip()).lower()


def object_canonical(obj: CanonicalObject) -> str:
    """Return the canonical string form of an S-P-O object.

    Entity objects render as ``entity:<uid>``; literal objects render
    as ``literal:<normalized value>``. The ``kind`` prefix guarantees
    an entity reference and a literal value that happen to share the
    same string never collide.
    """
    if obj["kind"] == "entity":
        return f"entity:{obj['uid']}"
    return f"literal:{normalize_literal(obj['value'])}"


def canonical_key(
    subject_uid: str,
    predicate_code: str,
    obj: CanonicalObject,
) -> str:
    """Build the canonical S-P-O dedup key.

    Format: ``<subject_uid>|<predicate_code>|<object_canonical>``

    The pipe separator is safe because subject_uid is a system-issued
    opaque token, predicate_code is a controlled-vocabulary code from
    the ``predicates`` table, and the object segment is either an
    ``entity:<uid>`` or a whitespace-collapsed lowercased literal.
    """
    return f"{subject_uid}|{predicate_code}|{object_canonical(obj)}"


__all__ = [
    "CanonicalEntityRef",
    "CanonicalLiteralRef",
    "CanonicalObject",
    "normalize_literal",
    "object_canonical",
    "canonical_key",
]
