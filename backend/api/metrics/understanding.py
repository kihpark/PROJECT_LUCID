"""DCR-002 v2 — Understanding Depth metric.

For one FactNode, the understanding-depth is the count of OTHER facts
reachable via 1- and 2-hop Object-mediated links inside the same
KnowledgeSpace:

  fact_uid --(MENTIONS / asserts_property / describes_state / ...)--> Object
  Object   --(fact_uids[])--> { other fact_uids in the same KS }

So we count:
  1-hop: every other fact that shares ≥ 1 Object with the seed fact
  2-hop: every other fact that shares ≥ 1 Object with a 1-hop fact

Beta behaviour: the metric is measured but NOT surfaced to the user.
Phase 1+ surfaces it as Stellar View afterglow + Dashboard.

Direct Fact <-> Fact edges (SUPPORTS / CONTRADICTS / NEGATES / etc.) are
NOT counted here in beta because the beta data model only persists them
inside the SourceJob's extracted_metadata; once Sprint 4 indexes them
into `lucid_facts.connected_facts` (Phase 1+), this module gains a
second traversal axis.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

logger = logging.getLogger("lucid.metrics.understanding")


def _get_objects_for_fact(
    fact_uid: str, knowledge_space_id: str | uuid.UUID,
) -> set[str]:
    """All Object UIDs that mention `fact_uid` inside the KS."""
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    except ImportError:
        return set()
    body = {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": str(knowledge_space_id)}},
                    {"term": {"fact_uids": fact_uid}},
                ]
            }
        },
        "_source": ["object_uid"],
        "size": 1000,
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_OBJECTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("understanding lookup failed: %s", exc)
        return set()
    return {h["_source"]["object_uid"] for h in resp["hits"]["hits"]}


def _get_facts_for_objects(
    object_uids: set[str], knowledge_space_id: str | uuid.UUID,
) -> set[str]:
    """All fact UIDs mentioned by any object in `object_uids` inside the KS."""
    if not object_uids:
        return set()
    try:
        from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client
    except ImportError:
        return set()
    body = {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": str(knowledge_space_id)}},
                    {"terms": {"object_uid": list(object_uids)}},
                ]
            }
        },
        "_source": ["fact_uids"],
        "size": 1000,
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_OBJECTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("understanding fact lookup failed: %s", exc)
        return set()
    out: set[str] = set()
    for h in resp["hits"]["hits"]:
        for f in h["_source"].get("fact_uids") or ():
            out.add(f)
    return out


def compute_understanding_depth(
    fact_uid: str,
    knowledge_space_id: str | uuid.UUID,
    max_hop: int = 2,
) -> int:
    """Count distinct OTHER facts reachable from ``fact_uid`` within
    ``max_hop`` Object-mediated steps (default 2). Returns 0 for an
    isolated fact (or one whose Objects ES can't find)."""
    if max_hop < 1:
        return 0
    seed_objs = _get_objects_for_fact(fact_uid, knowledge_space_id)
    if not seed_objs:
        return 0

    # Copy the returned sets — the helpers may return cached / shared
    # sets and we must not mutate the caller's references.
    one_hop_facts: set[str] = set(
        _get_facts_for_objects(seed_objs, knowledge_space_id)
    ) - {fact_uid}

    visited: set[str] = set(one_hop_facts)
    if max_hop >= 2:
        # 2-hop: gather all objects mentioned by 1-hop facts, then their facts.
        frontier_objs: set[str] = set()
        for f in one_hop_facts:
            frontier_objs |= set(
                _get_objects_for_fact(f, knowledge_space_id)
            )
        frontier_objs -= seed_objs
        two_hop_facts: set[str] = set(
            _get_facts_for_objects(frontier_objs, knowledge_space_id)
        ) - {fact_uid}
        visited |= two_hop_facts

    return len(visited)


def compute_user_average_understanding(
    knowledge_space_id: str | uuid.UUID,
) -> float:
    """Average understanding-depth over every fact in the KS.

    Beta-grade: scans every fact_uid in the KS once. Suitable for ad-hoc
    analysis (the PO runs this from a shell, results aren't displayed).
    Phase 1+ replaces with an incremental cron / event-driven recomputation.
    """
    try:
        from api.storage.elasticsearch.client import LUCID_FACTS, get_client
    except ImportError:
        return 0.0
    body: dict[str, Any] = {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": str(knowledge_space_id)}},
                ]
            }
        },
        "_source": ["fact_uid"],
        "size": 1000,
    }
    try:
        client = get_client()
        resp = client.search(index=LUCID_FACTS, body=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning("user average understanding scan failed: %s", exc)
        return 0.0
    fact_uids = [
        h["_source"]["fact_uid"] for h in resp["hits"]["hits"]
        if "fact_uid" in h.get("_source", {})
    ]
    if not fact_uids:
        return 0.0
    total = sum(
        compute_understanding_depth(fu, knowledge_space_id)
        for fu in fact_uids
    )
    return total / len(fact_uids)
