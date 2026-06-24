"""Unit: `_extract_outer_json` + `_parse_json_safely` brace-balanced extractor.

feat/llm-parse-resilient (2026-06-24): the previous regex fence-strip
silently failed when the LLM added trailing prose after the closing
``` fence — the closing-anchor `\\s*```$` doesn't match unless the
fence is the actual end of the string. The new brace-balanced
extractor walks the text and pulls the first balanced JSON value, so
fences and prose on either side are tolerated.

These are pure unit tests for the extractor + parser; no API calls,
no I/O.
"""
from __future__ import annotations

import json

from api.structure.claude_client import (
    _extract_outer_json,
    _parse_json_safely,
)

# -----------------------------------------------------------------
# _extract_outer_json — pure extraction (returns substring or None)
# -----------------------------------------------------------------


def test_extract_plain_object() -> None:
    assert _extract_outer_json('{"a": 1}') == '{"a": 1}'


def test_extract_plain_array() -> None:
    """Arrays are extracted by the scanner. `_parse_json_safely` is
    what rejects non-dict top-levels, not the extractor."""
    assert _extract_outer_json("[1, 2, 3]") == "[1, 2, 3]"


def test_extract_fenced_json() -> None:
    raw = '```json\n{"a": 1}\n```'
    assert _extract_outer_json(raw) == '{"a": 1}'


def test_extract_fenced_with_leading_prose() -> None:
    raw = 'Here\'s the JSON:\n```json\n{"a": 1}\n```'
    assert _extract_outer_json(raw) == '{"a": 1}'


def test_extract_fenced_with_trailing_prose() -> None:
    """The real failure mode that blocked PO dogfood."""
    raw = '```json\n{"a": 1}\n```\n\nNote: this is the analysis output.'
    assert _extract_outer_json(raw) == '{"a": 1}'


def test_extract_with_only_trailing_prose() -> None:
    """No fence, just prose after the JSON."""
    raw = '{"a": 1}\n\nHope this helps!'
    assert _extract_outer_json(raw) == '{"a": 1}'


def test_extract_nested_objects() -> None:
    raw = '{"a": {"b": {"c": 1}}, "d": [1, 2, {"e": 3}]}'
    assert _extract_outer_json(raw) == raw


def test_extract_with_braces_inside_strings() -> None:
    """Braces inside JSON strings must not affect depth counting."""
    raw = '{"x": "this } is { inside a string", "y": 1}'
    assert _extract_outer_json(raw) == raw


def test_extract_with_escaped_quotes_in_strings() -> None:
    """Backslash-escaped quotes don't terminate the string."""
    # JSON source: {"x": "\"quoted\""}
    raw = '{"x": "\\"quoted\\""}'
    extracted = _extract_outer_json(raw)
    assert extracted == raw
    # Sanity: it actually parses with json.loads
    assert json.loads(extracted) == {"x": '"quoted"'}


def test_extract_truncated_returns_none() -> None:
    """No closing brace -> unbalanced -> None (don't try to fix-up)."""
    raw = '```json\n{"objects": [\n  {"uid": "obj-1"'
    assert _extract_outer_json(raw) is None


def test_extract_no_braces_returns_none() -> None:
    assert _extract_outer_json("totally not json") is None


def test_extract_empty_returns_none() -> None:
    assert _extract_outer_json("") is None
    assert _extract_outer_json(None) is None  # type: ignore[arg-type]


def test_extract_multiple_blocks_returns_first() -> None:
    """Document the deterministic-first-block behavior."""
    raw = '{"a": 1}\n\n{"b": 2}'
    assert _extract_outer_json(raw) == '{"a": 1}'


# -----------------------------------------------------------------
# _parse_json_safely — integration of extractor + json.loads
# -----------------------------------------------------------------


def test_parse_plain_json_dict() -> None:
    assert _parse_json_safely('{"a": 1}') == {"a": 1}


def test_parse_fenced_json_dict() -> None:
    raw = '```json\n{"a": 1, "b": [1, 2]}\n```'
    assert _parse_json_safely(raw) == {"a": 1, "b": [1, 2]}


def test_parse_fenced_with_trailing_prose() -> None:
    """The exact failure that blocked PO dogfood (2026-06-24)."""
    raw = (
        '```json\n'
        '{"objects": [], "facts": [], "extraction_status": "success"}\n'
        '```\n\nNote: this is the analysis output.'
    )
    parsed = _parse_json_safely(raw)
    assert parsed is not None
    assert parsed["extraction_status"] == "success"


def test_parse_with_leading_prose() -> None:
    raw = 'Here\'s the JSON you requested:\n{"x": 42}'
    assert _parse_json_safely(raw) == {"x": 42}


def test_parse_truncated_returns_none() -> None:
    """Half a JSON — don't try to fix-up; graceful None."""
    raw = '```json\n{"objects": [\n  {"uid": "obj-1"'
    assert _parse_json_safely(raw) is None


def test_parse_garbage_returns_none() -> None:
    assert _parse_json_safely("totally not json") is None


def test_parse_empty_returns_none() -> None:
    assert _parse_json_safely("") is None


def test_parse_rejects_top_level_array() -> None:
    """Top-level arrays are not valid Structure envelopes."""
    assert _parse_json_safely("[1, 2, 3]") is None


def test_parse_preserves_trailing_comma_scrub() -> None:
    """The legacy trailing-comma scrub still works on the extracted body."""
    raw = '```json\n{"a": [1, 2, 3,],}\n```'
    assert _parse_json_safely(raw) == {"a": [1, 2, 3]}


def test_parse_lucid_envelope_round_trip() -> None:
    """A realistic Structure envelope wrapped in fence + trailing prose."""
    envelope = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "Alice"},
        ],
        "facts": [
            {"uid": "fn-1", "claim": "Alice founded Acme."},
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    body = json.dumps(envelope, ensure_ascii=False)
    raw = f"```json\n{body}\n```\n\nNote: extracted 1 fact."
    parsed = _parse_json_safely(raw)
    assert parsed == envelope
