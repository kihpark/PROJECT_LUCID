"""M3-1 canonical-layer — surface-form -> canonical mapping rules.

PO 의뢰서 verbatim (m31-canonical-layer 2026-06-24):
  - 표면형 -> canonical 매핑 (결정적 규칙 + LLM classifier 보조,
    느슨한 ontology — 경직 강제 금지).

Three layered rules:

  1. ``normalize_label(label)`` — deterministic surface normalization
     used by the canonical key + alias dedup. NFKC fold, lowercase,
     whitespace collapse. No language-specific magic — just
     unicode-correct equality.

  2. ``deterministic_canonical_key(entity_type, name, name_en)`` —
     the cheap deterministic test. Returns a tuple ``(entity_type,
     normalized_surface)`` for every non-empty surface form, so two
     entities sharing ANY normalized variant under the same
     ``entity_type`` collide. This collapses the 7 PO-KS clusters we
     measured in discovery: shared ``name_en`` keyword across two
     ``lucid_objects`` docs already proves they are the same entity.

  3. ``llm_canonical_match(a, b, sample_facts_a, sample_facts_b)`` —
     STAGE 1 LLM gate. Claude judges whether two deterministic-key
     candidates truly point at the same real-world referent. Returns
     ``(verdict, reason)`` where verdict in {'yes', 'no', 'uncertain'}.
     This catches the 남한/국내 false-positive class — both share
     ``name_en='South Korea'`` but '국내' (domestic) is a broader
     concept. PO 의뢰서: "비용 가드: 결정적 우선" — callers run the
     deterministic key first, then ask the LLM only on candidate pairs
     that survived the key collision.

The module is import-time pure — no ES or LLM call lands until a
caller invokes the relevant function. That keeps M3-1 cheap to
import from CLI / test contexts.
"""
from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from typing import Any, Literal

logger = logging.getLogger("lucid.services.canonical_mapping")

# Verdict for the Stage 1 LLM gate. 'yes' means same real-world
# referent (auto-merge candidate); 'no' means distinct referent
# (false-positive — drop the proposal); 'uncertain' means Claude
# couldn't decide OR the call/parse failed (conservative — do NOT
# auto-merge, route to PO review). The 3-way return is deliberate:
# a bool would collapse uncertain -> false and lose the "needs review"
# signal that the dry-run CLI uses to bucket proposals.
CanonicalLLMVerdict = Literal["yes", "no", "uncertain"]

# ---------------------------------------------------------------------------
# Rule 1 — normalize_label
# ---------------------------------------------------------------------------

# Collapses ALL Unicode whitespace classes (spaces, tabs, ideographic
# spaces, etc.) into the empty string. Chosen over single-space
# collapse because Korean entity surfaces routinely vary on
# whitespace presence ("MP 머티리얼즈" vs "MP머티리얼스") — those
# pairs MUST hash to the same key. English multi-word phrases also
# collapse, which is fine for entity dedup: "Bank of Korea" and
# "BankofKorea" should not be treated as distinct entities.
_WHITESPACE_RE = re.compile(r"\s+", re.UNICODE)


def normalize_label(label: str | None) -> str:
    """Return a deterministic normalized form of ``label``.

    Steps (in order):
      1. NFKC unicode fold — collapses fullwidth / halfwidth / circled
         variants onto their canonical codepoints so "ＭＰ" and "MP"
         agree.
      2. Strip surrounding whitespace.
      3. Lowercase (Unicode-aware ``str.casefold`` would also fold
         German sharp-s -> ss; ``lower`` is enough for ko/en).
      4. Collapse all whitespace to the empty string.

    Empty / None inputs return ``""``. This is the SAME function used
    by the canonical_key, alias dedup, and the cluster discovery
    pass — the three paths share one source of truth.
    """
    if not label:
        return ""
    s = unicodedata.normalize("NFKC", str(label)).strip().lower()
    return _WHITESPACE_RE.sub("", s)


# ---------------------------------------------------------------------------
# Rule 2 — deterministic canonical key
# ---------------------------------------------------------------------------

def deterministic_canonical_key(
    entity_type: str | None,
    name: str | None,
    name_en: str | None = None,
    *,
    aliases: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return every (entity_type, normalized_surface) candidate key.

    The CALLER decides equivalence: two entities are deterministically
    "the same" when their candidate key sets intersect. We return a
    list rather than a single string because a single doc legitimately
    carries multiple surfaces (Korean primary + English alias + raw
    aliases list) — any one of which can hash-collide with the same
    surface on another doc.

    Why a list and not a frozenset? Order is preserved so the discovery
    report can show "matched on alias #2" deterministically. Callers
    that need a set can wrap with ``set(...)``.

    ``entity_type`` is required: the canonical key NEVER crosses class
    boundaries (the PO 의뢰서 says "ontology — 경직 강제 금지" but the
    SAME PO directive ships the 13 ObjectClasses as a controlled vocab.
    We respect both by KEEPING the class as part of the key — so a
    "민주당 / Democratic Party" organization and a hypothetical "민주당"
    PRODUCT NAME cannot accidentally merge — without REJECTING a
    capture whose class is unfamiliar). Empty / None ``entity_type``
    short-circuits to an empty list (no key, caller must skip).
    """
    if not entity_type:
        return []
    et = str(entity_type).strip().lower()
    if not et:
        return []
    surfaces: list[str] = []
    for raw in (name, name_en, *(aliases or [])):
        n = normalize_label(raw)
        if n and n not in surfaces:
            surfaces.append(n)
    return [(et, s) for s in surfaces]


# ---------------------------------------------------------------------------
# Rule 3 — Stage 1 LLM gate
# ---------------------------------------------------------------------------

# Korean prompt — the entities the gate judges are almost always
# Korean+English bilingual records (PO-KS spec). Asking Claude in
# Korean keeps the model anchored on the Korean primary_label
# semantics (남한 != 국내, 한국은행 = 한은) without leaking English
# bias from a translation step.
_LLM_SYSTEM = (
    "당신은 한국어/영어 명명 엔티티 동일성 판정자입니다. 두 개의 "
    "후보 엔티티 레코드가 주어지면, 그 둘이 동일한 '실세계 지시 "
    "대상(real-world referent)'을 가리키는지 판단합니다.\n\n"
    "판정 규칙:\n"
    "  - 'yes': 같은 지시 대상이다 (예: '한국은행' = '한은', "
    "'애플' = 'Apple Inc.', 'MP 머티리얼즈' = 'MP머티리얼스').\n"
    "  - 'no': 서로 다른 지시 대상이다 (예: '남한' != '국내' — "
    "'국내'는 화자 기준 자국 내를 뜻하는 상대적 개념이며, "
    "'남한'은 특정 국가를 가리키는 고유 지시; 둘이 우연히 "
    "name_en='South Korea'를 공유하더라도 다른 엔티티이다).\n"
    "  - 'uncertain': 주어진 정보만으로는 결정할 수 없다 "
    "(샘플 사실이 비어 있거나, 엔티티 타입이 충돌하거나, "
    "다의어로 인해 판단이 모호한 경우).\n\n"
    "보수적으로 판정하세요: 확신이 없으면 'uncertain'을 반환하고, "
    "동일성에 의심이 들면 'no'를 반환하세요. False-positive 병합을 "
    "차단하는 것이 우선입니다.\n\n"
    "출력 형식: 다음 JSON 한 줄만 출력하고 다른 텍스트는 절대 "
    "포함하지 마세요.\n"
    '{"verdict": "yes"|"no"|"uncertain", '
    '"reason": "<한 문장 한국어 근거>"}'
)

# Small/fast model — classification only, no long-form generation
# needed. Override via CLAUDE_CANONICAL_GATE_MODEL for experiments.
# Default is haiku-latest (the codebase's cheapest classifier-grade
# Claude); a CLAUDE_MODEL override is honored as a secondary fallback
# so callers can pin a single model env-wide.
_DEFAULT_GATE_MODEL = "claude-3-5-haiku-latest"


def _gate_model() -> str:
    return (
        os.getenv("CLAUDE_CANONICAL_GATE_MODEL")
        or os.getenv("CLAUDE_MODEL")
        or _DEFAULT_GATE_MODEL
    )


def _candidate_summary(rec: dict[str, Any]) -> str:
    """Compact one-line summary used to keep the LLM prompt cheap.

    Picks the bilingual surface fields the canonical key already cares
    about (primary_label / name / name_en / entity_type / class /
    aliases) — anything else on the doc (fact_uids, embeddings,
    created_at) is noise for the same-referent decision.
    """
    fields = []
    for k in ("primary_label", "name", "name_en", "entity_type", "class"):
        v = rec.get(k)
        if v:
            fields.append(f"{k}={v!r}")
    aliases = rec.get("aliases") or []
    if aliases:
        # Cap alias dump to keep tokens bounded on noisy docs.
        fields.append(f"aliases={list(aliases)[:8]!r}")
    return "; ".join(fields)


def _fact_lines(facts: list[str], *, max_lines: int = 3) -> str:
    """Render up to ``max_lines`` sample facts as a bulleted block.

    Empty list -> '(없음)'. Each fact is truncated at 240 chars so a
    runaway claim cannot blow the prompt budget.
    """
    if not facts:
        return "(없음)"
    out = []
    for f in facts[:max_lines]:
        s = str(f).strip()
        if not s:
            continue
        if len(s) > 240:
            s = s[:237] + "..."
        out.append(f"  - {s}")
    return "\n".join(out) if out else "(없음)"


def _build_user_message(
    candidate_a: dict[str, Any],
    candidate_b: dict[str, Any],
    sample_facts_a: list[str],
    sample_facts_b: list[str],
) -> str:
    return (
        "다음 두 후보가 같은 실세계 엔티티를 가리키는지 판정하세요.\n\n"
        f"[후보 A]\n  {_candidate_summary(candidate_a)}\n"
        f"  샘플 사실:\n{_fact_lines(sample_facts_a)}\n\n"
        f"[후보 B]\n  {_candidate_summary(candidate_b)}\n"
        f"  샘플 사실:\n{_fact_lines(sample_facts_b)}\n\n"
        "JSON 한 줄로만 답하세요: "
        '{"verdict": "yes"|"no"|"uncertain", "reason": "..."}'
    )


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _extract_json_object(text: str) -> str | None:
    """Find the outermost balanced JSON object in ``text``.

    Reused logic from structure/claude_client._extract_outer_json but
    inlined to keep the canonical_mapping module self-contained (the
    structure stage has its own dependency surface we don't want to
    pull into the services layer).
    """
    if not text:
        return None
    start = text.find("{")
    if start == -1:
        return None
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
        if c == '"':
            in_string = True
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _parse_verdict(text: str) -> tuple[CanonicalLLMVerdict, str] | None:
    """Try to parse Claude's response into (verdict, reason).

    Returns None when the output cannot be coerced into the expected
    envelope — caller folds None into the conservative
    ('uncertain', '...') default.
    """
    if not text:
        return None
    # Strip fences first (cheap; works for the common ```json wrap).
    stripped = _JSON_FENCE_RE.sub("", text).strip()
    candidate = _extract_json_object(stripped) or stripped
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    verdict_raw = payload.get("verdict")
    if not isinstance(verdict_raw, str):
        return None
    v = verdict_raw.strip().lower()
    if v not in ("yes", "no", "uncertain"):
        return None
    reason = payload.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        reason = "(no reason supplied)"
    return v, reason.strip()  # type: ignore[return-value]


async def llm_canonical_match(
    candidate_a: dict[str, Any],
    candidate_b: dict[str, Any],
    sample_facts_a: list[str] | None = None,
    sample_facts_b: list[str] | None = None,
) -> tuple[CanonicalLLMVerdict, str]:
    """Claude classifier — same-referent judgment. Conservative.

    Stage 1 LLM gate: given two MergeProposal candidates that already
    survived the deterministic key collision, ask Claude whether they
    refer to the same real-world entity. The 3-way verdict drives the
    dry-run bucketing in ``canonical_dryrun --with-llm-gate``:

      - 'yes'       -> 병합 권장
      - 'uncertain' -> PO 검토 필요 (cost guard; safer than auto-merge)
      - 'no'        -> 병합 거부 (false-positive 차단 — 남한/국내 류)

    Conservative defaults:
      - ANTHROPIC_API_KEY missing -> ('uncertain', '...') — never block
        the dry-run on a missing secret, but also never silently merge.
      - anthropic SDK missing    -> ('uncertain', '...').
      - API call exception       -> ('uncertain', '...') with the
        exception in the reason for debuggability.
      - Malformed LLM output     -> ('uncertain', '...') (safe default).

    The async signature is deliberate: future callers (a server-side
    apply path or a streaming dry-run UI) will want concurrency. The
    underlying SDK call is sync (``anthropic.Anthropic``) — we run it
    on the default thread executor so the coroutine plays nicely with
    asyncio.gather. CLI callers wrap with ``asyncio.run``.
    """
    sample_facts_a = sample_facts_a or []
    sample_facts_b = sample_facts_b or []

    if not os.getenv("ANTHROPIC_API_KEY"):
        logger.debug("llm_canonical_match: no API key — uncertain default")
        return ("uncertain", "no api key — conservative default")

    try:
        # Lazy import — keeps the no-key / no-SDK path zero-cost.
        import anthropic  # noqa: PLC0415
    except ImportError:
        logger.warning(
            "llm_canonical_match: anthropic SDK missing — uncertain default"
        )
        return ("uncertain", "anthropic SDK missing — conservative default")

    user_msg = _build_user_message(
        candidate_a, candidate_b, sample_facts_a, sample_facts_b,
    )
    model = _gate_model()

    import asyncio  # noqa: PLC0415 — only needed on the live-call path

    def _call() -> Any:
        client = anthropic.Anthropic()
        return client.messages.create(
            model=model,
            max_tokens=256,
            system=_LLM_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )

    try:
        resp = await asyncio.to_thread(_call)
    except Exception as exc:  # noqa: BLE001 — SDK raises many types
        logger.warning("llm_canonical_match: API call failed: %s", exc)
        return ("uncertain", f"API call failed: {exc}")

    try:
        text_blocks: list[str] = []
        for block in resp.content:
            t = getattr(block, "text", None)
            if t:
                text_blocks.append(t)
        raw = "\n".join(text_blocks).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm_canonical_match: response shape unexpected: %s", exc)
        return ("uncertain", f"unexpected response shape: {exc}")

    parsed = _parse_verdict(raw)
    if parsed is None:
        preview = raw[:200] if raw else "(empty)"
        logger.warning(
            "llm_canonical_match: malformed LLM output (preview=%r)", preview,
        )
        return ("uncertain", f"malformed LLM output: {preview!r}")
    return parsed


__all__ = [
    "CanonicalLLMVerdict",
    "normalize_label",
    "deterministic_canonical_key",
    "llm_canonical_match",
]
