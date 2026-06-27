"""M3-1 canonical-layer — CLI dry-run.

Usage::

    python -m api.ops.canonical_dryrun <ks_id>
    python -m api.ops.canonical_dryrun <ks_id> --with-llm-gate

Prints the discovered MergeProposal list for the KS as a stable text
report. Read-only — never writes to ES.

PO 의뢰서 verbatim: discovery + canonical 구조 + 매핑 기초 + 병합
도구 (dry-run) 까지. apply / entity뷰 / meta-network / LENS 는 PO
명령 대기. The CLI intentionally has NO ``--apply`` flag — the apply
path is gated by ``NotImplementedError`` in ``apply_merge`` and the
follow-up ticket will land it under PO command.

Stage 1 LLM gate (``--with-llm-gate``): for every proposal, calls
``llm_canonical_match`` on (representative, member_i) pairs sampled
from the cluster and bucketing the cluster as a whole:

  - 'yes'       -> 병합 권장
  - 'uncertain' -> PO 검토 필요
  - 'no'        -> 병합 거부 (false-positive 차단)

The gate is purely additive — it never mutates the proposal list,
only annotates each proposal with the verdict + 1-sentence reason so
the PO can scan the report and confirm before the apply ticket lands.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

from api.models.canonical import MergeProposal
from api.ops.canonical_merge import apply_merge, discover_merge_proposals
from api.services.canonical_mapping import (
    CanonicalLLMVerdict,
    llm_canonical_match,
)
from api.storage.elasticsearch.client import LUCID_FACTS, get_client


# ---------------------------------------------------------------------------
# LLM gate plumbing
# ---------------------------------------------------------------------------

_GATE_BUCKETS: dict[CanonicalLLMVerdict, str] = {
    "yes": "병합 권장",
    "uncertain": "PO 검토 필요",
    "no": "병합 거부 (false-positive 차단)",
}

_GATE_BADGES: dict[CanonicalLLMVerdict, str] = {
    "yes": "[YES]",
    "uncertain": "[UNCERTAIN]",
    "no": "[NO]",
}

_SAMPLE_FACTS_PER_MEMBER = 3


def _fetch_member_doc(client: Any, member_uid: str) -> dict[str, Any]:
    """One-shot get for a member's lucid_objects doc.

    The discovery pass already fetched every entity in the KS; we
    re-fetch here so the CLI can read uid -> doc deterministically
    without having to thread the entity scan state through the apply
    chain. The cost is 2 ES gets per proposal (representative + 1
    member), which is negligible against the LLM round-trip.
    """
    from api.storage.elasticsearch.client import LUCID_OBJECTS  # local import
    try:
        resp = client.get(index=LUCID_OBJECTS, id=member_uid)
    except Exception:  # noqa: BLE001
        return {}
    return resp.get("_source") or {}


def _fetch_sample_facts(
    client: Any, member_uid: str, *, ks_id: str,
) -> list[str]:
    """Return up to N short fact claim strings for the member.

    Used to give Claude evidence from the doc's actual fact graph
    ("한국은행 기준금리 동결" vs "한은이 금리를 결정"), which is far
    more discriminative than the bare name pair. We pull from
    ``lucid_facts`` filtered by subject_uid OR object_value match.
    """
    try:
        resp = client.search(
            index=LUCID_FACTS,
            size=_SAMPLE_FACTS_PER_MEMBER,
            query={"bool": {"filter": [
                {"term": {"knowledge_space_id": ks_id}},
                {"bool": {"should": [
                    {"term": {"subject_uid": member_uid}},
                    {"term": {"object_value": member_uid}},
                ], "minimum_should_match": 1}},
            ]}},
            _source=["claim", "surface", "predicate", "object_value"],
        )
    except Exception:  # noqa: BLE001
        return []
    out: list[str] = []
    for h in resp.get("hits", {}).get("hits", []) or []:
        s = h.get("_source") or {}
        # Prefer claim (natural language) over surface; both are
        # acceptable evidence for the same-referent decision.
        claim = (s.get("claim") or s.get("surface") or "").strip()
        if claim:
            out.append(claim)
    return out


async def _run_gate_on_proposal(
    client: Any | None,
    proposal: MergeProposal,
    *,
    ks_id: str,
) -> tuple[CanonicalLLMVerdict, str]:
    """Call llm_canonical_match for a proposal cluster.

    Strategy: judge (representative, first_non_rep_member) — for the
    deterministic clusters M3-1 emits, every member shares a normalized
    key with the representative, so a single A-vs-B call captures the
    cluster's ambiguity. Chains of 3+ are rare (PO-KS has 0); when one
    appears we still ask just the first pair (the goal is the FP-block,
    not a per-edge audit).

    Returns the verdict and the human-readable reason verbatim from
    Claude. Errors fall through llm_canonical_match's own conservative
    defaults ('uncertain', '...').
    """
    members = list(proposal.members)
    rep_uid = proposal.target_canonical_uid
    other_uid = next((u for u in members if u != rep_uid), None)
    if other_uid is None:
        return ("uncertain", "cluster has only one distinct member")

    if client is None:
        # No ES handle -> we can still call the gate with bare names.
        rep_doc = {"primary_label": proposal.primary_label,
                   "entity_type": proposal.entity_type}
        other_doc = {"primary_label": proposal.primary_label,
                     "aliases": list(proposal.aliases),
                     "entity_type": proposal.entity_type}
        sample_a: list[str] = []
        sample_b: list[str] = []
    else:
        rep_doc = _fetch_member_doc(client, rep_uid)
        other_doc = _fetch_member_doc(client, other_uid)
        sample_a = _fetch_sample_facts(client, rep_uid, ks_id=ks_id)
        sample_b = _fetch_sample_facts(client, other_uid, ks_id=ks_id)

    return await llm_canonical_match(rep_doc, other_doc, sample_a, sample_b)


async def _gate_all_proposals(
    client: Any | None,
    proposals: list[MergeProposal],
    *,
    ks_id: str,
) -> list[tuple[CanonicalLLMVerdict, str]]:
    """Run the gate over every proposal sequentially.

    Sequential keeps log output readable AND respects the small/free-
    tier rate limit on the gate model. asyncio.gather is available if
    a future ticket wants concurrency.
    """
    out: list[tuple[CanonicalLLMVerdict, str]] = []
    for p in proposals:
        verdict = await _run_gate_on_proposal(client, p, ks_id=ks_id)
        out.append(verdict)
    return out


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _format_proposal(
    idx: int,
    proposal: MergeProposal,
    *,
    gate_verdict: tuple[CanonicalLLMVerdict, str] | None = None,
) -> str:
    """One-block text rendering. Each block is the dry-run dict pretty-
    printed so PR reviewers can grep on uids / surfaces. When a gate
    verdict is supplied, a header line above the JSON body announces
    the bucket and the LLM's reason.
    """
    payload = apply_merge(None, proposal, dry_run=True)
    if gate_verdict is not None:
        v, reason = gate_verdict
        badge = _GATE_BADGES[v]
        bucket = _GATE_BUCKETS[v]
        payload["llm_gate"] = {"verdict": v, "reason": reason, "bucket": bucket}
        body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        return (
            f"--- proposal {idx + 1}  {badge} {bucket} ---\n"
            f"  LLM reason: {reason}\n"
            f"{body}\n"
        )
    body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return f"--- proposal {idx + 1} ---\n{body}\n"


def _summarize_buckets(
    proposals: list[MergeProposal],
    verdicts: list[tuple[CanonicalLLMVerdict, str]],
) -> str:
    """Aggregate bucket counts for the footer."""
    counts = {"yes": 0, "no": 0, "uncertain": 0}
    for v, _ in verdicts:
        counts[v] = counts.get(v, 0) + 1
    lines = ["--- LLM gate summary ---"]
    for v in ("yes", "uncertain", "no"):
        lines.append(
            f"  {_GATE_BADGES[v]} {_GATE_BUCKETS[v]}: {counts.get(v, 0)}"
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------

def run(ks_id: str, *, with_llm_gate: bool = False) -> int:
    client = get_client()
    proposals = discover_merge_proposals(client, ks_id)
    header = (
        f"ks_id: {ks_id}\n"
        f"proposals: {len(proposals)}\n"
        f"NOTE: dry-run only. apply path is gated on PO command.\n"
    )
    if with_llm_gate:
        header += "LLM gate: ENABLED (claude classifier — same-referent judgment)\n"
    print(header)
    if not proposals:
        print("(no merge candidates — every entity has a unique deterministic key)")
        return 0

    verdicts: list[tuple[CanonicalLLMVerdict, str]] = []
    if with_llm_gate:
        verdicts = asyncio.run(
            _gate_all_proposals(client, proposals, ks_id=ks_id)
        )

    for idx, proposal in enumerate(proposals):
        gate = verdicts[idx] if with_llm_gate else None
        print(_format_proposal(idx, proposal, gate_verdict=gate))

    total_objects = sum(max(0, len(p.members) - 1) for p in proposals)
    total_facts = sum(len(p.fact_provenance) for p in proposals)
    print(
        "--- summary ---\n"
        f"would_merge_n_objects: {total_objects}\n"
        f"would_rewrite_n_facts: {total_facts}\n"
    )
    if with_llm_gate:
        print(_summarize_buckets(proposals, verdicts))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "ks_id",
        help="Target knowledge_space_id to scan for merge candidates.",
    )
    parser.add_argument(
        "--with-llm-gate",
        action="store_true",
        help=(
            "Run the Stage 1 LLM gate (Claude same-referent judgment) on "
            "every proposal. Buckets each proposal into 병합 권장 / PO "
            "검토 필요 / 병합 거부. Requires ANTHROPIC_API_KEY."
        ),
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return run(args.ks_id, with_llm_gate=args.with_llm_gate)


if __name__ == "__main__":
    sys.exit(main())
