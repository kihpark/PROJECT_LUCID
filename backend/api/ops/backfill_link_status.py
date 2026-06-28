"""Backfill link_status for legacy facts (M3-2a stage 4 + backfill).

PO decision 5 (2026-06-28): verified/claimed 2 kinds.
- CLAIM (fact_type=='claim') -> claimed
- ACTION / MEASUREMENT / None / anything-else -> verified

Idempotent: facts that already have a link_status are skipped (the
must_not exists clause). Default is dry_run; pass --apply to mutate.

Usage:
    python -m api.ops.backfill_link_status                              # global dry-run
    python -m api.ops.backfill_link_status --ks <ks_id>                 # KS-scoped dry-run
    python -m api.ops.backfill_link_status --ks <ks_id> --apply         # KS-scoped apply
"""
from __future__ import annotations

from typing import Any

from api.storage.elasticsearch.client import LUCID_FACTS, get_client


def _claim_query(ks_id: str | None) -> dict[str, Any]:
    q: dict[str, Any] = {
        "bool": {
            "filter": [{"term": {"fact_type": "claim"}}],
            "must_not": [{"exists": {"field": "link_status"}}],
        }
    }
    if ks_id:
        q["bool"]["filter"].append({"term": {"knowledge_space_id": ks_id}})
    return q


def _non_claim_query(ks_id: str | None) -> dict[str, Any]:
    q: dict[str, Any] = {
        "bool": {
            "must_not": [
                {"term": {"fact_type": "claim"}},
                {"exists": {"field": "link_status"}},
            ],
            "filter": [],
        }
    }
    if ks_id:
        q["bool"]["filter"].append({"term": {"knowledge_space_id": ks_id}})
    return q


def backfill_link_status(
    ks_id: str | None = None, dry_run: bool = True
) -> dict[str, Any]:
    """Two-pass update_by_query: CLAIM->claimed, rest->verified."""
    client = get_client()

    claim_q = _claim_query(ks_id)
    if dry_run:
        claim_count = client.count(index=LUCID_FACTS, query=claim_q)["count"]
    else:
        result = client.update_by_query(
            index=LUCID_FACTS,
            query=claim_q,
            script={
                "source": "ctx._source.link_status = 'claimed'",
                "lang": "painless",
            },
            refresh=True,
            conflicts="proceed",
        )
        claim_count = int(result.get("updated", 0))

    verified_q = _non_claim_query(ks_id)
    if dry_run:
        verified_count = client.count(index=LUCID_FACTS, query=verified_q)["count"]
    else:
        result = client.update_by_query(
            index=LUCID_FACTS,
            query=verified_q,
            script={
                "source": "ctx._source.link_status = 'verified'",
                "lang": "painless",
            },
            refresh=True,
            conflicts="proceed",
        )
        verified_count = int(result.get("updated", 0))

    return {
        "ks_id": ks_id,
        "dry_run": dry_run,
        "claim_to_claimed": int(claim_count),
        "non_claim_to_verified": int(verified_count),
    }


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description=(
            "Backfill link_status on legacy lucid_facts. "
            "Default dry-run; pass --apply to mutate."
        )
    )
    parser.add_argument("--ks", default=None, help="knowledge_space_id")
    parser.add_argument("--apply", action="store_true", help="mutate ES")
    args = parser.parse_args()
    result = backfill_link_status(args.ks, dry_run=not args.apply)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
