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

from api.structure.models import StructureResult, V3LiteralObjectError
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
    """Best-effort: strip ```json ...``` fences if the model added them.

    Kept for backward-compatibility with callers that imported this
    helper directly. The main parse path (`_parse_json_safely`) now
    uses `_extract_outer_json` instead — that brace-matching extractor
    is robust to fences AND leading/trailing prose, which the regex
    here is not (it misses any closing-fence variant that has prose
    after it). See feat/llm-parse-resilient (2026-06-24).
    """
    return _JSON_FENCE_RE.sub("", text).strip()


def _extract_outer_json(text: str) -> str | None:
    """Find the outermost balanced JSON object or array in text.

    Robust to:
      - Leading/trailing markdown fences (```json, ```)
      - Trailing prose ("Note: ...", "This output ...", "Hope this helps!")
      - Leading prose ("Here's the JSON:")
      - Mixed line endings

    The scanner walks forward from the first '{' or '[' tracking depth
    while respecting JSON strings + their backslash escapes. Returns
    the JSON substring (fences and prose stripped), or None if no
    balanced structure is found (e.g. truncated output).

    If multiple top-level JSON blocks appear, only the FIRST balanced
    one is returned. (Claude doesn't realistically emit multiple, but
    this keeps behavior deterministic.)
    """
    if not text:
        return None

    # Find first '{' or '['
    start = -1
    open_char = ""
    for i, c in enumerate(text):
        if c == "{" or c == "[":
            start = i
            open_char = c
            break
    if start == -1:
        return None

    close_char = "}" if open_char == "{" else "]"
    depth = 0
    in_string = False
    escape_next = False

    for i in range(start, len(text)):
        c = text[i]
        if escape_next:
            escape_next = False
            continue
        if in_string:
            if c == "\\":
                escape_next = True
                continue
            if c == '"':
                in_string = False
            continue
        # not in string
        if c == '"':
            in_string = True
            continue
        if c == open_char:
            depth += 1
        elif c == close_char:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    # Unbalanced (likely truncated)
    return None


def _parse_json_safely(text: str) -> dict[str, Any] | None:
    """Parse a JSON string into a dict. Returns None on any failure.

    Strategy (feat/llm-parse-resilient):
      1. Extract the outermost balanced JSON via `_extract_outer_json`
         (handles fences, leading prose, trailing prose).
      2. Try `json.loads` on the extracted substring.
      3. On failure, scrub trailing commas (legacy LLM quirk) and retry.
      4. Reject any parsed value that isn't a dict (top-level arrays
         and primitives are not valid Structure-stage envelopes).
    """
    if not text:
        return None

    extracted = _extract_outer_json(text)
    candidate = extracted if extracted is not None else text

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        # Common LLM quirk: trailing commas. Try one targeted scrub.
        scrubbed = re.sub(r",(\s*[}\]])", r"\1", candidate)
        try:
            parsed = json.loads(scrubbed)
        except json.JSONDecodeError:
            return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _has_v3_literal_error(exc: BaseException) -> bool:
    """True iff `exc` or any cause/context chain element is V3LiteralObjectError.

    Pydantic wraps validator errors inside `ValidationError`. The
    original `ValueError` (our `V3LiteralObjectError`) is reachable
    via `__cause__` / `__context__`, and pydantic v2 also exposes it
    inside `exc.errors()[i]['ctx']['error']`. STAGE 1c-vii propagates
    these so the SourceJob fails explicitly rather than silently
    falling back to malformed_llm_output.
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, V3LiteralObjectError):
            return True
        # ValidationError.errors() exposes the wrapped ValueError under
        # ctx.error for each entry. Walk that list too.
        errors_fn = getattr(cur, "errors", None)
        if callable(errors_fn):
            try:
                for err in errors_fn():
                    ctx = (err or {}).get("ctx") if isinstance(err, dict) else None
                    inner = (ctx or {}).get("error") if isinstance(ctx, dict) else None
                    if isinstance(inner, V3LiteralObjectError):
                        return True
            except Exception:  # noqa: BLE001
                pass
        cur = cur.__cause__ or cur.__context__
    return False


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


def _drop_facts_without_subject(parsed: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Filter the parsed envelope to remove facts with no subject_uid.

    capture-naver-fix (PO 2026-06-24): the LLM occasionally emits
    `subject_uid: null` on Korean-ellipsis claims where the subject is
    implicit (e.g. "코스피가 상승했다. 7월 이후 최고치였다." — the second
    fact inherits the first fact's subject without re-binding). The
    schema now accepts None at the inner-model layer (see
    StructureFact.subject_uid), but a fact with no subject is useless
    downstream — the object-matcher / link-creator both index by
    subject. We drop such facts here BEFORE Pydantic validation so:

      - The salvaged facts (the majority) still land in the result.
      - The PO's n.news.naver.com mnews failure (4+ null subject_uid
        facts in a 17-fact response) stops trashing the whole envelope.
      - The dropped count is returned for logging so we can spot a
        regression in LLM behavior.

    Empty-string and whitespace-only subject_uid are treated the same
    as null. The `facts` key is mutated to a filtered list in-place
    on a shallow copy of `parsed`; cross-references in
    `fact_object_links` / `fact_fact_links` that point at the dropped
    facts are also filtered so the link layer doesn't dangle. Returns
    (mutated_dict, drop_count).
    """
    facts = parsed.get("facts")
    if not isinstance(facts, list):
        return parsed, 0

    kept_facts: list[dict[str, Any]] = []
    dropped_fact_uids: set[str] = set()
    for fact in facts:
        if not isinstance(fact, dict):
            kept_facts.append(fact)
            continue
        subj = fact.get("subject_uid")
        if subj is None or (isinstance(subj, str) and not subj.strip()):
            uid = fact.get("uid")
            if isinstance(uid, str):
                dropped_fact_uids.add(uid)
            continue
        kept_facts.append(fact)

    if not dropped_fact_uids and len(kept_facts) == len(facts):
        return parsed, 0

    out = dict(parsed)
    out["facts"] = kept_facts

    # Filter any links that reference a dropped fact so we don't leave
    # dangling fact_uid / from_uid / to_uid pointers.
    fol = out.get("fact_object_links")
    if isinstance(fol, list) and dropped_fact_uids:
        out["fact_object_links"] = [
            link for link in fol
            if not (
                isinstance(link, dict)
                and link.get("fact_uid") in dropped_fact_uids
            )
        ]
    ffl = out.get("fact_fact_links")
    if isinstance(ffl, list) and dropped_fact_uids:
        out["fact_fact_links"] = [
            link for link in ffl
            if not (
                isinstance(link, dict)
                and (
                    link.get("from_uid") in dropped_fact_uids
                    or link.get("to_uid") in dropped_fact_uids
                )
            )
        ]
    return out, len(dropped_fact_uids)


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
        # Hardened logging (feat/llm-parse-resilient): the previous
        # "first 200 chars" view truncated mid-fence so we couldn't
        # tell whether the LLM had wrapped the JSON, added trailing
        # prose, or run out of tokens. We now log length, brace
        # balance, and BOTH ends of the output so the failure mode
        # is identifiable from logs alone.
        open_count = raw_output.count("{")
        close_count = raw_output.count("}")
        tail = raw_output[-300:] if len(raw_output) > 600 else ""
        logger.warning(
            "Claude returned non-JSON output (len=%d, braces=%d/%d). "
            "First 300: %r ... Last 300: %r",
            len(raw_output), open_count, close_count,
            raw_output[:300], tail,
        )
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
    # capture-naver-fix (PO 2026-06-24): drop facts the LLM emitted with
    # `subject_uid: null` BEFORE schema validation. Pre-fix, even though
    # `subject_uid` is now `UID | None` at the schema layer, downstream
    # code can't do anything useful with a subjectless fact, and prior
    # versions of the schema rejected the entire envelope on this case.
    # The dropped count lands in logs so a regression in LLM behavior
    # (n+1 facts going null) is visible.
    parsed, dropped_subjectless = _drop_facts_without_subject(parsed)
    if dropped_subjectless:
        logger.info(
            "Structure: dropped %d facts with null/empty subject_uid "
            "(LLM ellipsis artifact)", dropped_subjectless,
        )
    try:
        result = StructureResult.model_validate(parsed)
    except Exception as exc:  # noqa: BLE001 - schema mismatch -> empty failure
        # REQ-004 STAGE 1c-vii (★ PO 2026-06-30): V3LiteralObjectError
        # 는 ★ propagate. silent fallback 폐기 — capture 작업이 명시적으로
        # STRUCTURE_FAILED 로 표시되어야 호출부 (gateway) 가 강제된다.
        # pydantic 은 validator 의 ValueError 를 ValidationError 로
        # wrap 하므로 errors() 리스트의 ctx.error 또는 __cause__ 체인을
        # 함께 확인한다.
        if _has_v3_literal_error(exc):
            logger.error(
                "REQ-004-1c-vii V3LiteralObjectError propagating from "
                "StructureResult validation (capture job will be "
                "STRUCTURE_FAILED): %s", exc,
            )
            raise
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
