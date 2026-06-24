"""Unit: structure/claude_client.py JSON parsing + fallback paths."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from api.structure.claude_client import (
    _drop_facts_without_subject,
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


# ---------------------------------------------------------------------------
# capture-naver-fix (PO 2026-06-24): null-subject_uid facts get dropped
# ---------------------------------------------------------------------------

def test_drop_facts_without_subject_filters_null_subject_uid():
    """Bare envelope: facts with subject_uid=null are removed; the rest
    survive and the dropped count is reported."""
    envelope = {
        "objects": [{"uid": "obj-1", "class": "organization", "name": "코스피"}],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "코스피가 상승했다.",
             "subject_uid": "obj-1", "predicate": "rose", "object_value": "상승"},
            # PO's reproduction: Korean ellipsis subject — the LLM
            # left subject_uid null on inherited-subject claims.
            {"uid": "fn-2", "type": "proposition", "claim": "7월 이후 최고치였다.",
             "subject_uid": None, "predicate": "was_highest", "object_value": "최고치"},
            {"uid": "fn-3", "type": "proposition", "claim": "거래대금도 늘었다.",
             "subject_uid": "", "predicate": "increased", "object_value": "거래대금"},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-1", "link_type": "involves"},
            # Should be filtered because fn-2 was dropped.
            {"fact_uid": "fn-2", "object_uid": "obj-1", "link_type": "involves"},
        ],
        "fact_fact_links": [
            # Should be filtered because fn-3 was dropped.
            {"from_uid": "fn-1", "to_uid": "fn-3", "link_type": "supports"},
        ],
        "extraction_status": "success",
        "failure_reason": None,
    }
    out, dropped = _drop_facts_without_subject(envelope)
    assert dropped == 2
    assert len(out["facts"]) == 1
    assert out["facts"][0]["uid"] == "fn-1"
    # Cross-references to dropped facts are filtered out.
    assert len(out["fact_object_links"]) == 1
    assert out["fact_object_links"][0]["fact_uid"] == "fn-1"
    assert out["fact_fact_links"] == []


def test_drop_facts_without_subject_no_op_when_all_have_subject():
    """When every fact has a non-empty subject_uid, the function is a
    no-op (returns the same dict reference and 0 dropped)."""
    envelope = {
        "objects": [],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "c",
             "subject_uid": "obj-1", "predicate": "p", "object_value": "o"},
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    out, dropped = _drop_facts_without_subject(envelope)
    assert dropped == 0
    assert out is envelope  # cheap path — same reference


def test_decompose_naver_mnews_payload_with_null_subjects_recovers_facts(monkeypatch):
    """The PO's failing n.news.naver.com mnews capture: LLM returned 4
    facts with subject_uid=null among ~17 valid facts. Before this fix
    the entire envelope was rejected and facts=0 — the "추출된 사실
    없음" toast. After the fix the valid facts survive."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    fake_payload = {
        "objects": [
            {"uid": "obj-1", "class": "organization", "name": "코스피"},
            {"uid": "obj-2", "class": "organization", "name": "삼성전자"},
        ],
        "facts": [
            {"uid": "fn-1", "type": "proposition",
             "claim": "코스피가 7월 이후 최고치를 기록했다.",
             "subject_uid": "obj-1", "predicate": "기록했다",
             "object_value": "최고치"},
            # Ellipsis: the LLM emitted subject_uid: null here.
            {"uid": "fn-2", "type": "proposition",
             "claim": "거래대금도 늘어났다.",
             "subject_uid": None, "predicate": "늘어났다",
             "object_value": "거래대금"},
            {"uid": "fn-3", "type": "proposition",
             "claim": "삼성전자가 강세를 보였다.",
             "subject_uid": "obj-2", "predicate": "보였다",
             "object_value": "강세"},
            {"uid": "fn-4", "type": "proposition",
             "claim": "7월 이후 최고치였다.",
             "subject_uid": None, "predicate": "였다",
             "object_value": "최고치"},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-1", "link_type": "involves"},
            {"fact_uid": "fn-3", "object_uid": "obj-2", "link_type": "involves"},
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
        result = decompose_via_claude(
            "코스피가 7월 이후 최고치를 기록했다. ...",
            {"source_url": "https://n.news.naver.com/mnews/article/001/0015421921"},
        )

    # Pre-fix this was extraction_status='no_facts_found' (envelope
    # rejected entirely). Post-fix: 2 valid facts survive.
    assert result.extraction_status == "success"
    assert len(result.facts) == 2
    surviving_uids = {f.uid for f in result.facts}
    assert surviving_uids == {"fn-1", "fn-3"}
