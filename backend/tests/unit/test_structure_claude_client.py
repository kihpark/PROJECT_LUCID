"""Unit: structure/claude_client.py JSON parsing + fallback paths."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from api.structure.claude_client import (
    _drop_facts_without_subject,
    _parse_json_safely,
    _repair_truncated_json,
    _strip_json_fences,
    _validate_with_partial_recovery,
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
            # ★ STAGE 1c-vii: ACTION + literal "Acme" raises. claim 으로 우회.
            {"uid": "fn-1", "type": "proposition", "claim": "Alice founded Acme.",
             "subject_uid": "obj-1", "predicate": "founded",
             "object_value": "Acme", "negation_flag": False,
             "negation_scope": None, "tags_suggested": [],
             "fact_type": "claim"},
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
            # ★ STAGE 1c-vii: ACTION + literal object_value 는 raise.
            # 발화 내용 literal 검증이므로 fact_type=claim 으로 우회.
            {"uid": "fn-1", "type": "proposition",
             "claim": "코스피가 7월 이후 최고치를 기록했다.",
             "subject_uid": "obj-1", "predicate": "기록했다",
             "object_value": "최고치",
             "fact_type": "claim"},
            # Ellipsis: the LLM emitted subject_uid: null here.
            {"uid": "fn-2", "type": "proposition",
             "claim": "거래대금도 늘어났다.",
             "subject_uid": None, "predicate": "늘어났다",
             "object_value": "거래대금",
             "fact_type": "claim"},
            {"uid": "fn-3", "type": "proposition",
             "claim": "삼성전자가 강세를 보였다.",
             "subject_uid": "obj-2", "predicate": "보였다",
             "object_value": "강세",
             "fact_type": "claim"},
            {"uid": "fn-4", "type": "proposition",
             "claim": "7월 이후 최고치였다.",
             "subject_uid": None, "predicate": "였다",
             "object_value": "최고치",
             "fact_type": "claim"},
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


# ---------------------------------------------------------------------------
# empty-extract-parsing-robust (PO 2026-07-02):
#   Fix A: legacy link_type ('located_in' etc.) normalization
#   Fix B: truncated JSON envelope recovery (braces=95/93 symptom)
#   Fix C: partial recovery — one bad item drops just that item
# ---------------------------------------------------------------------------


def test_legacy_link_type_located_in_normalized_to_describes_state():
    """PO log verbatim: LLM emitted link_type='located_in' which isn't in
    the 5-enum vocabulary. Pre-fix, the whole StructureResult envelope
    was rejected via pydantic literal_error and the capture ended with
    facts=0. Post-fix, we remap the legacy alias to 'describes_state'
    and the envelope validates cleanly."""
    from api.structure.models import StructureFactObjectLink

    link = StructureFactObjectLink.model_validate({
        "fact_uid": "fn-1",
        "object_uid": "obj-1",
        "link_type": "located_in",   # legacy alias — PO 2026-07-02 root cause
        "properties": {},
    })
    assert link.link_type == "describes_state"


def test_legacy_link_type_part_of_normalized_to_involves():
    from api.structure.models import StructureFactObjectLink

    link = StructureFactObjectLink.model_validate({
        "fact_uid": "fn-1",
        "object_uid": "obj-1",
        "link_type": "part_of",
        "properties": {},
    })
    assert link.link_type == "involves"


def test_legacy_ff_link_type_refutes_normalized_to_contradicts():
    from api.structure.models import StructureFactFactLink

    link = StructureFactFactLink.model_validate({
        "from_uid": "fn-1",
        "to_uid": "fn-2",
        "link_type": "refutes",
    })
    assert link.link_type == "contradicts"


def test_unknown_link_type_still_fails():
    """Non-mappable link_type still raises — partial recovery drops
    just that link but keeps the surrounding facts."""
    from pydantic import ValidationError

    from api.structure.models import StructureFactObjectLink

    with pytest.raises(ValidationError):
        StructureFactObjectLink.model_validate({
            "fact_uid": "fn-1",
            "object_uid": "obj-1",
            "link_type": "not_a_real_link_type_xyz",
            "properties": {},
        })


# --- Fix B: truncated JSON recovery ---


def test_repair_truncated_json_recovers_partial_envelope():
    """PO log verbatim: braces=95/93 (unbalanced — LLM ran out of tokens
    mid-response). Pre-fix, `_extract_outer_json` returned None because
    the outer '{' never closed → whole envelope lost. Post-fix, we walk
    to the last complete top-level value and close the envelope."""
    # Simulate LLM truncated after emitting objects + first fact,
    # while writing the second fact's `claim` field.
    truncated = (
        '```json\n'
        '{\n'
        '  "objects": [\n'
        '    {"uid": "obj-1", "class": "person", "name": "Alice"}\n'
        '  ],\n'
        '  "facts": [\n'
        '    {"uid": "fn-1", "type": "proposition", "claim": "c1",\n'
        '     "subject_uid": "obj-1", "predicate": "p",\n'
        '     "object_value": "obj-1", "fact_type": "claim"}\n'
        '  ],\n'
        '  "fact_object_links": [\n'
        '    {"fact_uid": "fn-1", "object_uid": "obj-1", "link_type"'
        # ← truncated here mid-string
    )

    parsed = _parse_json_safely(truncated)
    assert parsed is not None, "truncation repair should salvage the envelope"
    assert isinstance(parsed, dict)
    # objects + facts survive because the snapshot at their closing ']'
    # is the last complete top-level value.
    assert "objects" in parsed
    assert "facts" in parsed
    assert len(parsed["objects"]) == 1
    assert len(parsed["facts"]) == 1


def test_repair_truncated_json_direct_helper():
    """`_repair_truncated_json` invoked directly — verify it snapshots
    at the closing ']' of `facts` and returns a partial dict."""
    truncated = (
        '{"objects": [{"uid": "o1"}], "facts": [{"uid": "f1"}], '
        '"fact_object_links": [{"fact_uid": "f1"'   # truncated mid-list
    )
    parsed = _repair_truncated_json(truncated)
    assert parsed is not None
    assert parsed.get("objects") == [{"uid": "o1"}]
    assert parsed.get("facts") == [{"uid": "f1"}]


def test_repair_truncated_json_returns_none_when_nothing_recoverable():
    """No top-level value ever closed: nothing to recover."""
    # Only the opening brace, no closers reach depth 1.
    unrecoverable = '{"facts": [{"uid": "f1"'
    assert _repair_truncated_json(unrecoverable) is None


def test_repair_truncated_json_handles_leading_code_fence():
    """LLM wrapped the truncated JSON in ```json ... — the repair
    should skip the fence header (it finds first '{')."""
    with_fence = (
        '```json\n'
        '{"objects": [{"uid": "o1"}], "facts": []}'   # complete, no truncation
    )
    # Even though this fence isn't truncated, `_parse_json_safely`
    # should extract via _extract_outer_json first; test that the
    # repair path *also* works in isolation.
    parsed = _repair_truncated_json(with_fence)
    assert parsed is not None
    assert parsed["objects"] == [{"uid": "o1"}]


# --- Fix C: partial recovery ---


def test_partial_recovery_bad_link_type_drops_only_the_link():
    """★ THE CENTRAL FIX ★ — PO log root cause 1 in miniature:
    envelope has 3 valid facts + 1 link with invalid `link_type`.
    Pre-fix: whole envelope rejected → 0 facts.
    Post-fix: bad link dropped, 3 facts survive."""
    envelope = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "Alice"},
        ],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "c1",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
            {"uid": "fn-2", "type": "proposition", "claim": "c2",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
            {"uid": "fn-3", "type": "proposition", "claim": "c3",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-1",
             "link_type": "involves", "properties": {}},
            # This link's type is a legitimate-looking word the LLM invented
            # that doesn't map to any legacy alias — should be DROPPED,
            # not fail the envelope.
            {"fact_uid": "fn-2", "object_uid": "obj-1",
             "link_type": "totally_bogus_link_type_xyz", "properties": {}},
            {"fact_uid": "fn-3", "object_uid": "obj-1",
             "link_type": "involves", "properties": {}},
        ],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    result = _validate_with_partial_recovery(envelope)
    assert result.extraction_status == "success"
    assert len(result.facts) == 3
    # Only the good links survive; the bogus one is dropped.
    assert len(result.fact_object_links) == 2


def test_partial_recovery_bad_fact_shape_drops_only_the_fact():
    """A single malformed fact (missing required 'claim') dropped;
    the other facts survive."""
    envelope = {
        "objects": [{"uid": "obj-1", "class": "person", "name": "Alice"}],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "c1",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
            # Missing 'claim' — required.
            {"uid": "fn-bad", "type": "proposition",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
            {"uid": "fn-2", "type": "proposition", "claim": "c2",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    result = _validate_with_partial_recovery(envelope)
    assert result.extraction_status == "success"
    assert len(result.facts) == 2
    surviving = {f.uid for f in result.facts}
    assert surviving == {"fn-1", "fn-2"}


def test_partial_recovery_normalized_legacy_link_type_end_to_end():
    """Fix A + Fix C together: envelope with `located_in` link now
    validates (Fix A remaps it) and appears in the result."""
    envelope = {
        "objects": [{"uid": "obj-1", "class": "location", "name": "Seoul"}],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "c1",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-1",
             "link_type": "located_in", "properties": {}},
        ],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    result = _validate_with_partial_recovery(envelope)
    assert result.extraction_status == "success"
    assert len(result.facts) == 1
    assert len(result.fact_object_links) == 1
    # Remapped to 'describes_state'.
    assert result.fact_object_links[0].link_type == "describes_state"


def test_partial_recovery_missing_extraction_status_infers_success_when_facts_present():
    """LLM omits `extraction_status` but emits facts — we infer success."""
    envelope = {
        "objects": [{"uid": "obj-1", "class": "person", "name": "Alice"}],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "c1",
             "subject_uid": "obj-1", "predicate": "p",
             "object_value": "obj-1", "fact_type": "claim"},
        ],
        "fact_object_links": [],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        # extraction_status omitted!
    }
    result = _validate_with_partial_recovery(envelope)
    assert result.extraction_status == "success"
    assert len(result.facts) == 1


def test_partial_recovery_end_to_end_via_decompose(monkeypatch):
    """The full PO reproduction: LLM response wrapped in ```json fence,
    contains one link with `located_in`, and one fact missing `claim`.
    Pre-fix: facts=0. Post-fix: valid facts + valid links survive."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    fake_payload = {
        "objects": [
            {"uid": "obj-1", "class": "person", "name": "Alice"},
            {"uid": "obj-2", "class": "location", "name": "Seoul"},
        ],
        "facts": [
            {"uid": "fn-1", "type": "proposition", "claim": "Alice is in Seoul.",
             "subject_uid": "obj-1", "predicate": "is_in",
             "object_value": "obj-2", "fact_type": "claim"},
            # Malformed — missing claim.
            {"uid": "fn-bad", "type": "proposition",
             "subject_uid": "obj-1", "predicate": "x",
             "object_value": "obj-2", "fact_type": "claim"},
            {"uid": "fn-2", "type": "proposition", "claim": "Alice founded Acme.",
             "subject_uid": "obj-1", "predicate": "founded",
             "object_value": "obj-2", "fact_type": "claim"},
        ],
        "fact_object_links": [
            {"fact_uid": "fn-1", "object_uid": "obj-2",
             # PO's log verbatim: LLM emitted 'located_in'.
             "link_type": "located_in", "properties": {}},
            {"fact_uid": "fn-2", "object_uid": "obj-2",
             "link_type": "involves", "properties": {}},
        ],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "success",
        "failure_reason": None,
    }
    # Wrap in a ```json fence as the LLM did.
    fenced = f"```json\n{json.dumps(fake_payload, ensure_ascii=False)}\n```"

    fake_resp = MagicMock()
    fake_resp.content = [MagicMock(type="text", text=fenced)]
    fake_resp.model = "claude-sonnet-4-5"
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_resp

    with patch("anthropic.Anthropic", return_value=fake_client):
        result = decompose_via_claude("Alice is in Seoul. Alice founded Acme.")

    assert result.extraction_status == "success"
    # 2 valid facts survive (fn-bad dropped).
    assert len(result.facts) == 2
    surviving = {f.uid for f in result.facts}
    assert surviving == {"fn-1", "fn-2"}
    # Both links survive: located_in was remapped, involves is native.
    assert len(result.fact_object_links) == 2
    link_types = {l.link_type for l in result.fact_object_links}
    assert link_types == {"describes_state", "involves"}


def test_partial_recovery_truncated_response_end_to_end(monkeypatch):
    """LLM ran out of tokens mid-response. Pre-fix: `braces=95/93`
    logged, malformed_llm_output returned, facts=0. Post-fix: repair
    walks to last complete top-level value and salvages facts."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake")

    # Truncated payload: fence + valid objects + valid facts, then
    # cut off mid-fact_object_links.
    truncated = (
        '```json\n'
        '{\n'
        '  "objects": [\n'
        '    {"uid": "obj-1", "class": "person", "name": "Alice"}\n'
        '  ],\n'
        '  "facts": [\n'
        '    {"uid": "fn-1", "type": "proposition", "claim": "c1",\n'
        '     "subject_uid": "obj-1", "predicate": "p",\n'
        '     "object_value": "obj-1", "fact_type": "claim"}\n'
        '  ],\n'
        '  "fact_object_links": [\n'
        '    {"fact_uid": "fn-1", "object_uid": "obj-1", "link_type'
        # ← truncated
    )

    fake_resp = MagicMock()
    fake_resp.content = [MagicMock(type="text", text=truncated)]
    fake_resp.model = "claude-sonnet-4-5"
    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_resp

    with patch("anthropic.Anthropic", return_value=fake_client):
        result = decompose_via_claude("some text")

    # Post-fix: facts survive even though the tail was truncated.
    assert result.extraction_status == "success"
    assert len(result.facts) == 1
    assert result.facts[0].uid == "fn-1"
