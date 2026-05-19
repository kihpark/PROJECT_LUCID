"""Deterministic fake Claude responses for offline / CI testing.

Activated when LUCID_MOCK_LLM=true. See AGENTS.md section 1 (Mock-first rule):
the full Capture -> Structure -> Validate -> Surface loop must pass tests in
mock mode before any real API calls.

This scaffold provides the shape. Canned responses are filled in as the
Structurer and other LLM-calling modules land. Keep every response
deterministic - the same input must always yield the same output.
"""
from __future__ import annotations

import os

# Canned atomic-fact decompositions, keyed by a substring of the input text.
# Extended as modules land. Each value mimics the Structurer's JSON output:
# a list of {claim, subject, predicate, object, confidence} dicts.
MOCK_DECOMPOSITIONS: dict[str, list[dict]] = {}


def is_mock_enabled() -> bool:
    """True when LUCID_MOCK_LLM=true - route LLM calls through this module."""
    return os.getenv("LUCID_MOCK_LLM", "false").lower() == "true"


def mock_decompose(merged_text: str) -> list[dict]:
    """Return a deterministic decomposition for a known input, else an empty list."""
    for key, facts in MOCK_DECOMPOSITIONS.items():
        if key in merged_text:
            return facts
    return []
