"""M3-1 canonical-layer — CLI dry-run.

Usage::

    python -m api.ops.canonical_dryrun <ks_id>

Prints the discovered MergeProposal list for the KS as a stable text
report. Read-only — never writes to ES.

PO 의뢰서 verbatim: discovery + canonical 구조 + 매핑 기초 + 병합
도구 (dry-run) 까지. apply / entity뷰 / meta-network / LENS 는 PO
명령 대기. The CLI intentionally has NO ``--apply`` flag — the apply
path is gated by ``NotImplementedError`` in ``apply_merge`` and the
follow-up ticket will land it under PO command.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from api.ops.canonical_merge import apply_merge, discover_merge_proposals
from api.storage.elasticsearch.client import get_client


def _format_proposal(idx: int, proposal: Any) -> str:
    """One-block text rendering. Each block is the dry-run dict pretty-
    printed so PR reviewers can grep on uids / surfaces.
    """
    payload = apply_merge(None, proposal, dry_run=True)
    body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return f"--- proposal {idx + 1} ---\n{body}\n"


def run(ks_id: str) -> int:
    client = get_client()
    proposals = discover_merge_proposals(client, ks_id)
    header = (
        f"ks_id: {ks_id}\n"
        f"proposals: {len(proposals)}\n"
        f"NOTE: dry-run only. apply path is gated on PO command.\n"
    )
    print(header)
    if not proposals:
        print("(no merge candidates — every entity has a unique deterministic key)")
        return 0
    for idx, proposal in enumerate(proposals):
        print(_format_proposal(idx, proposal))
    # Footer summary
    total_objects = sum(max(0, len(p.members) - 1) for p in proposals)
    total_facts = sum(len(p.fact_provenance) for p in proposals)
    print(
        "--- summary ---\n"
        f"would_merge_n_objects: {total_objects}\n"
        f"would_rewrite_n_facts: {total_facts}\n"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "ks_id",
        help="Target knowledge_space_id to scan for merge candidates.",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return run(args.ks_id)


if __name__ == "__main__":
    sys.exit(main())
