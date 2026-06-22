"""Anthropic Claude client for the Structure stage (Sprint 3 PR-3-1).

Wraps `anthropic.Anthropic().messages.create` with:
  - Default model: claude-sonnet-4-5 (PO directive 2026-05-21 [변경 5])
  - Prompt caching: the system prompt + few-shots block is marked
    `cache_control: {"type": "ephemeral"}` so repeat calls within the
    5-minute window pay the cached input token rate (10x cheaper).
  - Safe JSON parsing: any non-parseable output → empty result with
    failure_reason="malformed_llm_output".
  - Timing + token bookkeeping: latency_ms + input/output token
    estimates land on the StructureResult.

Tests mock `decompose_via_claude` so no real API spend during CI.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

from api.structure.models import StructureResult
from api.structure.prompts import (
    FEW_SHOT_EXAMPLES,
    SYSTEM_PROMPT,
    build_user_message,
)

logger = logging.getLogger("lucid.structure.claude")

DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_MAX_TOKENS = 8192
APPROX_CHARS_PER_TOKEN = 4  # rough Korean+English heuristic


def _model_name() -> str:
    return os.getenv("CLAUDE_MODEL", DEFAULT_MODEL)


def _api_key_present() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def _approx_token_count(text: str) -> int:
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def _build_cached_system_block() -> list[dict[str, Any]]:
    """Build the cached system prompt block + few-shot turns.

    Anthropic accepts `system` as either a string or a list of text
    blocks; the list form is the only one that supports
    cache_control. We put the long system text + the few-shot
    examples in a single cached block so they share one cache key.
    """
    few_shot_text_parts: list[str] = []
    for idx, ex in enumerate(FEW_SHOT_EXAMPLES, start=1):
        few_shot_text_parts.append(
            f"# Example {idx} input\n{ex['input']}\n\n"
            f"# Example {idx} output\n{json.dumps(ex['output'], ensure_ascii=False)}\n"
        )
    body = SYSTEM_PROMPT + "\n\n# Few-shot examples\n\n" + "\n".join(few_shot_text_parts)
    return [
        {
            "type": "text",
            "text": body,
            "cache_control": {"type": "ephemeral"},
        }
    ]


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _strip_json_fences(text: str) -> str:
    """Best-effort: strip ```json ...``` fences if the model added them."""
    return _JSON_FENCE_RE.sub("", text).strip()


def _parse_json_safely(text: str) -> dict[str, Any] | None:
    """Parse a JSON string into a dict. Returns None on any failure."""
    if not text:
        return None
    body = _strip_json_fences(text)
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        # Common LLM quirk: trailing commas. Try one targeted scrub.
        scrubbed = re.sub(r",(\s*[}\]])", r"\1", body)
        try:
            parsed = json.loads(scrubbed)
        except json.JSONDecodeError:
            return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _empty_failure(reason: str) -> dict[str, Any]:
    """The canonical empty-result envelope when the LLM output is unusable."""
    return {
        "objects": [],
        "facts": [],
        "fact_object_links": [],
        "fact_fact_links": [],
        "disambiguation_candidates": [],
        "extraction_status": "no_facts_found",
        "failure_reason": reason,
    }


def decompose_via_claude(
    merged_text: str,
    metadata: dict[str, Any] | None = None,
    *,
    model: str | None = None,
    max_tokens: int | None = None,
) -> StructureResult:
    """Call Claude to decompose `merged_text`. Always returns a StructureResult.

    On any failure (missing API key, network error, bad JSON, etc.) the
    return is a StructureResult with extraction_status='no_facts_found'
    and an appropriate failure_reason — the caller treats this the
    same as a real "no facts" response and writes the metric.
    """
    if not merged_text or not merged_text.strip():
        return _build_result(_empty_failure("empty_input"), merged_text, "", model or _model_name(), 0)

    if not _api_key_present():
        logger.warning("ANTHROPIC_API_KEY missing; returning empty StructureResult")
        return _build_result(
            _empty_failure("malformed_llm_output"),
            merged_text,
            "",
            model or _model_name(),
            0,
        )

    try:
        from anthropic import Anthropic
    except ImportError:
        logger.warning("anthropic package not installed; returning empty StructureResult")
        return _build_result(
            _empty_failure("malformed_llm_output"),
            merged_text,
            "",
            model or _model_name(),
            0,
        )

    client = Anthropic()
    user_msg = build_user_message(merged_text, metadata)
    chosen_model = model or _model_name()
    chosen_max = max_tokens or DEFAULT_MAX_TOKENS

    start = time.monotonic()
    try:
        response = client.messages.create(
            model=chosen_model,
            max_tokens=chosen_max,
            system=_build_cached_system_block(),  # type: ignore[arg-type]
            messages=[
                {"role": "user", "content": user_msg},
            ],
        )
    except Exception as exc:  # noqa: BLE001 - Anthropic SDK raises various types
        logger.warning("Claude decompose call failed: %s", exc)
        latency_ms = int((time.monotonic() - start) * 1000)
        result = _build_result(
            _empty_failure("malformed_llm_output"),
            merged_text,
            "",
            chosen_model,
            latency_ms,
        )
        return result

    latency_ms = int((time.monotonic() - start) * 1000)

    # Concatenate text content blocks
    text_blocks: list[str] = []
    for block in response.content:
        if getattr(block, "type", "") == "text":
            text_blocks.append(getattr(block, "text", "") or "")
    raw_output = "\n".join(text_blocks).strip()

    parsed = _parse_json_safely(raw_output)
    if parsed is None:
        logger.warning("Claude returned non-JSON output (first 200 chars): %s", raw_output[:200])
        return _build_result(
            _empty_failure("malformed_llm_output"),
            merged_text,
            raw_output,
            chosen_model,
            latency_ms,
        )

    return _build_result(parsed, merged_text, raw_output, chosen_model, latency_ms)


def _build_result(
    parsed: dict[str, Any],
    merged_text: str,
    raw_output: str,
    model_name: str,
    latency_ms: int,
) -> StructureResult:
    """Hydrate StructureResult from the parsed JSON; add bookkeeping fields."""
    try:
        result = StructureResult.model_validate(parsed)
    except Exception as exc:  # noqa: BLE001 - schema mismatch -> empty failure
        # Faithful-decomp PR (PO 2026-06-23): on validation failure
        # log e.errors() so the field-level cause is visible in prod
        # logs. Without this, the prior "%s" formatting truncated the
        # ValidationError repr and we lost which field rejected the
        # response. Also stamp a 200-char preview of the parsed dict.
        error_details = getattr(exc, "errors", None)
        details_repr = error_details() if callable(error_details) else None
        logger.warning(
            "StructureResult schema validation failed: %s "
            "(errors=%r, parsed_preview=%r)",
            exc, details_repr, str(parsed)[:200],
        )
        envelope = _empty_failure("malformed_llm_output")
        result = StructureResult.model_validate(envelope)
    result.input_char_count = len(merged_text)
    result.input_token_estimate = _approx_token_count(merged_text)
    result.output_token_estimate = _approx_token_count(raw_output)
    result.latency_ms = latency_ms
    result.model_used = model_name
    return result

def call_claude_structured(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 600,
    model: str | None = None,
) -> dict[str, Any]:
    """Thin wrapper for a single Claude call that expects JSON output.

    Returns the parsed JSON dict. Raises RuntimeError on any failure
    (missing key, bad JSON, API error) so the caller can handle
    degradation uniformly.
    """
    if not _api_key_present():
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    try:
        from anthropic import Anthropic
    except ImportError as exc:
        raise RuntimeError("anthropic package not installed") from exc

    chosen_model = model or "claude-sonnet-4-6"
    client = Anthropic()
    try:
        response = client.messages.create(
            model=chosen_model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Claude API call failed: {exc}") from exc

    text_blocks: list[str] = []
    for block in response.content:
        if getattr(block, "type", "") == "text":
            text_blocks.append(getattr(block, "text", "") or "")
    raw = "\n".join(text_blocks).strip()

    parsed = _parse_json_safely(raw)
    if parsed is None:
        raise RuntimeError(f"Claude returned non-JSON: {raw[:200]}")
    return parsed
