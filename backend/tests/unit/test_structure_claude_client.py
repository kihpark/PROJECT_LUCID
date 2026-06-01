"""Unit: structure/claude_client.py JSON parsing + fallback paths."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from api.structure.claude_client import (
    _parse_json_safely,
    _strip_json_fences,
    decompose_via_claude,
)


def test_strip_json_fences_handles_markdown_wrapping():
    raw = "```json\n{\"a\": 1}\n```"
    assert _strip_json_fences(raw) == '{"a": 1}'


def test_strip_json_fences_no_op_for_plain_json():
    assert _strip_json_fences('{"a": 1}') == '{"a": 1}'


def test_parse_json_safely_returns_none_on_garbage():
    assert _parse_json_safely("not json") is None
    assert _parse_json_safely("") is None


def test_parse_json_safely_recovers_from_trailing_comma():
    """One common LLM quirk."""
    bad = '{"a": [1, 2, 3,],}'
    parsed = _parse_json_safely(bad)
    assert parsed == {"a": [1, 2, 3]}


def test_parse_json_safely_rejects_non_dict():
    assert _parse_json_safely("[1, 2, 3]") is None


def test_decompose_empty_input_returns_empty_input_failure():
    from api.structure.claude_client import decompose_via_claude

    result = decompose_via_claude("   ")
    assert result.extraction_status == "no_facts_found"
    assert result.failure_reason == "empty_input"


def test_decompose_missing_api_key_returns_malformed_failure(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    result = decompose_via_claude("some text")
    assert result.extraction_status == "no_facts_found"
    assert result.failure_reason == "malformed_llm_output"


def test_decompose_with_mocked_anthropic_returns_structured_result(monkeypatch):
    """Happy path: Anthropic responds with a valid JSON; we hydrate."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    fake_payload = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "Alice",
             "name_en": "Alice", "properties": {}},
        ],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "Alice founded Acme.",
             "subject_uid": "obj-1", "predicate": "founded",
             "object_value": "Acme", "negation_flag": False,
             "negation_scope": None, "tags_suggested": []},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-1",
             "link_type": "involves", "properties": {}},
        ],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    fake_resp = MagicMock()
    fake_resp.content = [MagicMock(type="text", text=json.dumps(fake_payload))]
    fake_resp.model = "claude-sonnet-4-5"
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_resp

    with patch("anthropic.Anthropic", return_value=fake_client):
        result = decompose_via_claude("Alice founded Acme.", {"source_url": "https://x"})

    assert result.extraction_status == "success"
    assert len(result.facts) == 1
    assert result.facts[0].claim == "Alice founded Acme."
    assert result.input_char_count == len("Alice founded Acme.")
    assert result.latency_ms >= 0
    assert result.model_used == "claude-sonnet-4-5"

    # Verify the system block carries cache_control
    call_kwargs = fake_client.messages.create.call_args.kwargs
    system_blocks = call_kwargs["system"]
    assert isinstance(system_blocks, list)
    assert system_blocks[0]["cache_control"] == {"type": "ephemeral"}
    assert "Step 4" in system_blocks[0]["text"]


def test_decompose_with_malformed_llm_output_returns_failure(monkeypatch):
    """Anthropic returns junk text; we record failure_reason=malformed_llm_output."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    fake_resp = MagicMock()
    fake_resp.content = [MagicMock(type="text", text="totally not json")]
    fake_resp.model = "claude-sonnet-4-5"
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_resp

    with patch("anthropic.Anthropic", return_value=fake_client):
        result = decompose_via_claude("some text")
    assert result.extraction_status == "no_facts_found"
    assert result.failure_reason == "malformed_llm_output"


def test_decompose_anthropic_exception_returns_failure(monkeypatch):
    """Any Anthropic SDK error -> failure, never re-raised."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    fake_client = MagicMock()
    fake_client.messages.create.side_effect = RuntimeError("503 from Anthropic")

    with patch("anthropic.Anthropic", return_value=fake_client):
        result = decompose_via_claude("some text")
    assert result.extraction_status == "no_facts_found"
    assert result.failure_reason == "malformed_llm_output"
