"""Canonical 자동 적용 — 새 캡처 후 trigger.

PO 결정 (2026-06-29): 새 데이터 entity dup 자동 정리.

★ 비용 가드:
- deterministic verdict 만 자동 apply (LLM gate uncertain/no → skip)
- LLM gate 호출은 deterministic 후보 만 (정확도 우선)

★ 안전 가드:
- dry-run 먼저 → LLM gate → yes 만 apply
- 보수적 (false-positive 차단 우선)
"""

import asyncio
from typing import Any
from api.ops.canonical_merge import discover_merge_proposals, apply_merge
from api.services.canonical_mapping import llm_canonical_match
from api.storage.elasticsearch.client import get_client, LUCID_OBJECTS

async def auto_apply_after_capture(ks_id: str) -> dict:
    """Trigger: 새 캡처 후. Discovery + LLM gate + apply.

    Returns: {applied: int, blocked: int, uncertain: int, errors: int}
    """
    client = get_client()
    try:
        proposals = discover_merge_proposals(client, ks_id)
    except Exception as e:
        return {"error": str(e), "stage": "discover"}

    if not proposals:
        return {"applied": 0, "blocked": 0, "uncertain": 0, "skipped": "no_proposals"}

    applied = 0
    blocked = 0
    uncertain = 0
    errors = 0

    for p in proposals:
        try:
            rep_uid = p.target_canonical_uid
            members = [u for u in p.members if u != rep_uid]
            if not members:
                continue

            rep_doc = client.get(index=LUCID_OBJECTS, id=rep_uid)["_source"]
            mem_doc = client.get(index=LUCID_OBJECTS, id=members[0])["_source"]

            # LLM gate (보수적)
            verdict, _ = await llm_canonical_match(rep_doc, mem_doc, [], [])

            if verdict == "yes":
                apply_merge(client, p, dry_run=False)
                applied += 1
            elif verdict == "no":
                blocked += 1
            else:
                uncertain += 1
        except Exception:
            errors += 1

    return {"applied": applied, "blocked": blocked, "uncertain": uncertain, "errors": errors}
