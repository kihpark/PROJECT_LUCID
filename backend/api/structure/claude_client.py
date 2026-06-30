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


_OBJ_PLACEHOLDER_RE_CLIENT = re.compile(r"^obj-\d+$", re.IGNORECASE)
_UUID_LIKE_RE_CLIENT = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _is_entity_id_shape_client(value: Any) -> bool:
    """True iff `value` is None / empty / obj-N placeholder / canonical UUID4.

    Mirror of `api.structure.models._is_entity_id_shape` — used in the
    pre-validate literal-recovery pass so we can rewrite literals into
    fresh obj-N placeholders BEFORE the StructureFact model_validator
    runs and raises V3LiteralObjectError.
    """
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    bare = value.strip()
    if not bare:
        return True
    if _OBJ_PLACEHOLDER_RE_CLIENT.match(bare):
        return True
    if _UUID_LIKE_RE_CLIENT.match(bare):
        return True
    return False


def _recover_literal_object_values(parsed: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """REQ-004 STAGE 1b-ii final (★ PO 2026-06-30) — literal recovery.

    The LLM occasionally violates the prompt rule "ACTION fact's
    object_value MUST be obj-N (an entity reference)" and emits a raw
    Korean / English noun phrase as literal ("메가프로젝트", "Samsung",
    "메모리 팹"). The v3 strict-reject model_validator (STAGE 1c-vii)
    then raises V3LiteralObjectError and the whole envelope fails.

    The PO's 2026-06-30 directive (REQ-004 STAGE 1b-ii final):
        "AI 코리아", "청사진" 등을 ★ entity_id 로 해석하게 (지금은
        literal 떨어뜨려 reject). gateway 가 ★ 진짜 entity 만들면
        ★ literal reject 없이 entity-edge 형성.

    This pass walks parsed['facts'] BEFORE Pydantic validation and:
      1. For each ACTION fact with a non-entity-shape object_value
         (literal noun phrase), allocate a synthetic obj-N uid.
      2. Append a matching StructureObject stub to parsed['objects']
         (class=concept; resolution_gateway will Claude-classify the
         real v3 10-type later).
      3. Replace the fact's object_value with that synthetic obj-N.
      4. Append a fact_object_link of link_type='primary_object' so the
         link layer keeps the edge consistent.

    Returns (mutated_dict_or_original, recovered_count). The pass is
    idempotent — facts whose object_value is already entity-shaped are
    passed through untouched. The link layer is not pruned (only
    appended-to) so existing references stay valid.
    """
    facts = parsed.get("facts")
    if not isinstance(facts, list):
        return parsed, 0

    objects = parsed.get("objects")
    if not isinstance(objects, list):
        objects = []
        parsed["objects"] = objects

    # Cache existing literal -> synthetic-uid so multiple facts
    # mentioning the same entity-literal share one obj-N.
    literal_to_uid: dict[str, str] = {}

    # Seed cache with EXISTING objects that share a name — when the
    # LLM already created a StructureObject for "메가프로젝트" but
    # also emitted a fact whose object_value is the same literal, we
    # want both to land on the same obj-N (not allocate a duplicate).
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        nm = obj.get("name")
        uid = obj.get("uid")
        if isinstance(nm, str) and isinstance(uid, str) and nm.strip() and uid.strip():
            literal_to_uid.setdefault(nm.strip(), uid.strip())

    # Find the next free obj-N index.
    next_idx = 1
    seen_uids: set[str] = set()
    for obj in objects:
        if not isinstance(obj, dict):
            continue
        uid = obj.get("uid")
        if isinstance(uid, str):
            seen_uids.add(uid)
            m = _OBJ_PLACEHOLDER_RE_CLIENT.match(uid)
            if m:
                try:
                    n = int(uid.split("-", 1)[1])
                    if n >= next_idx:
                        next_idx = n + 1
                except (ValueError, IndexError):
                    pass

    def _alloc_uid() -> str:
        nonlocal next_idx
        while True:
            candidate = f"obj-{next_idx}"
            next_idx += 1
            if candidate not in seen_uids:
                seen_uids.add(candidate)
                return candidate

    fol = parsed.get("fact_object_links")
    if not isinstance(fol, list):
        fol = []
        parsed["fact_object_links"] = fol

    recovered = 0
    out_facts: list[Any] = []
    for fact in facts:
        if not isinstance(fact, dict):
            out_facts.append(fact)
            continue
        # CLAIM 의 object_value 는 의도적으로 literal (발화 내용),
        # MEASUREMENT 의 object_value 는 수치 표현 literal — 둘 다 건너뜀.
        if fact.get("fact_type") != "action":
            out_facts.append(fact)
            continue
        ov = fact.get("object_value")
        if _is_entity_id_shape_client(ov):
            out_facts.append(fact)
            continue
        if not isinstance(ov, str):
            out_facts.append(fact)
            continue
        literal = ov.strip()
        if not literal:
            out_facts.append(fact)
            continue
        # Allocate (or reuse) a synthetic obj-N for this literal.
        synth_uid = literal_to_uid.get(literal)
        if synth_uid is None:
            synth_uid = _alloc_uid()
            literal_to_uid[literal] = synth_uid
            # Append a StructureObject stub. class=concept is a safe
            # default; resolution_gateway._classify_type_with_llm
            # (Claude structured output) will pick the real v3 type
            # downstream and ResolvedEntity.entity_type lands on the
            # fact's object resolution.
            #
            # object_surface (used by processor._build_surface_map)
            # gets the literal too via the fact's own object_surface
            # falling back to the StructureObject.name.
            objects.append({
                "uid": synth_uid,
                "class": "concept",
                "name": literal,
                "aliases": [],
                "properties": {
                    "synthetic": True,
                    "recovered_from_literal": True,
                    "stage": "1b-ii-final",
                },
            })
        # Rewrite the fact.
        fact = dict(fact)
        fact["object_value"] = synth_uid
        # Preserve the LLM's original literal in object_surface for
        # downstream surface_map / corrected_label fallback.
        if not fact.get("object_surface"):
            fact["object_surface"] = literal
        out_facts.append(fact)
        # Append a primary_object link so the link layer stays consistent.
        fact_uid = fact.get("uid")
        if isinstance(fact_uid, str) and fact_uid:
            # ★ link_type = 'involves' (FactObjectLink enum: asserts_property,
            # describes_state, addresses, uses, involves). 'involves' is the
            # most generic "fact references this entity as a participant" —
            # matches the prompt's convention for object/subject entity refs.
            fol.append({
                "fact_uid": fact_uid,
                "object_uid": synth_uid,
                "link_type": "involves",
                "properties": {"recovered_from_literal": True},
            })
        recovered += 1

    if recovered == 0:
        return parsed, 0

    parsed["facts"] = out_facts
    return parsed, recovered


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
    # REQ-004 STAGE 1b-ii final (★ PO 2026-06-30): literal recovery.
    # When the LLM emits ACTION fact whose object_value is a raw noun
    # phrase ("메가프로젝트", "Samsung", "AI 코리아"), rewrite it into a
    # fresh obj-N placeholder + a synthetic StructureObject stub BEFORE
    # the StructureFact._v3_action_object_must_be_entity_id validator
    # runs. Downstream `resolution_gateway.resolve()` Claude-classifies
    # the v3 type and persists the candidate entity (★ 1c-ii path).
    # Without this pass the whole envelope explodes on first literal.
    parsed, recovered_literals = _recover_literal_object_values(parsed)
    if recovered_literals:
        logger.info(
            "REQ-004-1b-ii-final: recovered %d literal object_value(s) "
            "into synthetic obj-N placeholders (gateway will Claude-"
            "classify the v3 type downstream).",
            recovered_literals,
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
