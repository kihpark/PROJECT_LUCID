"""Detect contradictions between facts in a knowledge space (v0.2.0 step 3).

Detection-only. Resolution / merging deferred to a separate round.

PO definition (2026-06-23):

  negation = fact 내부 polarity 태그 (이미 데이터로 보존)
  contradiction = 두 fact 사이 관계 (충돌 탐지 결과)

  층위마다 contradiction 정의가 다르다. 단일 SPO 로는 못 가림
  = 3종 분리의 정당화.

Layers handled in this pass:

  - measurement: same (metric, entity_uid, as_of) + different
    measurement_value -> contradiction.
  - action: same (subject_uid, predicate_code, object_canonical OR
    object_value) + opposite negation_flag -> contradiction.

Layers deferred:

  - claim: text-similarity heavyweight; first pass skips it.
  - cross-layer (action vs measurement vs claim): structural mismatch
    needs semantic grounding the LLM judge would have to provide.

Trade-off: keep keys VERBATIM. No Levenshtein, no lowercasing
aggregation, no unit normalisation. PO can broaden later if false
negatives are common in dogfood.

Storage:
  Pairs are written to `fact_relations` with
  ``relation_type='CONTRADICTS'`` (uppercase per the B-54 scaffold
  convention). The scaffold has no `knowledge_space_id` column; cross-KS
  isolation comes from the FACT scan that produced the pair (each scan
  is scoped to a single KS via the ES query). Idempotency: re-running
  detection skips pairs already written (both directions).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("lucid.structure.contradiction_detector")

CONTRADICTS = "CONTRADICTS"
_ES_SCAN_SIZE = 10_000  # ceiling; dogfood KS holds tens, not thousands


@dataclass
class ContradictionCandidate:
    """One pair flagged as a contradiction by the rule-based scan."""

    layer: str  # 'measurement' | 'action'
    from_fact_uid: str
    to_fact_uid: str
    key_summary: str
    evidence: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Natural-key extractors (KEEP VERBATIM — no normalisation).
# ---------------------------------------------------------------------------


def _measurement_key(fact: dict) -> tuple[str, str, str] | None:
    """Return (metric, entity_uid, as_of) tuple or None when the fact
    is missing any of the three.

    Measurement facts may reference an entity via `subject_uid` (the
    typical S-P-O shape) or via `speaker_uid` (a measurement spoken
    by someone — rare but possible). We accept either, taking
    subject_uid first.
    """
    metric = (fact.get("metric") or "").strip()
    entity = fact.get("subject_uid") or fact.get("speaker_uid") or ""
    as_of = (fact.get("as_of") or "").strip()
    if not metric or not entity or not as_of:
        return None
    return (metric, entity, as_of)


def _action_key(fact: dict) -> tuple[str, str, str] | None:
    """Return (subject_uid, predicate_code, object) tuple or None when
    the fact is missing predicate_code (legacy pre-OPL facts) or subject.

    Object prefers the canonical entity uid (object_canonical, set by
    insert_or_dedup_fact when the object resolves to an entity); falls
    back to the surface object_value for literal-objects.
    """
    subject = fact.get("subject_uid") or ""
    predicate_code = fact.get("predicate_code") or ""
    obj = fact.get("object_canonical") or fact.get("object_value") or ""
    if not subject or not predicate_code:
        return None
    return (subject, predicate_code, obj)


# ---------------------------------------------------------------------------
# ES scan + pair generation.
# ---------------------------------------------------------------------------


def _scan_facts_by_type(client, ks_id: str, fact_type: str) -> list[dict]:
    """Pull every non-retracted, manually validated fact of `fact_type`
    in a KS. Returns the list of _source dicts (NOT hits)."""
    from api.storage.elasticsearch.client import LUCID_FACTS

    try:
        res = client.search(
            index=LUCID_FACTS,
            size=_ES_SCAN_SIZE,
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_space_id": ks_id}},
                        {"term": {"fact_type": fact_type}},
                        {"term": {"validation_method": "manual"}},
                    ],
                    "must_not": [{"exists": {"field": "retracted_at"}}],
                }
            },
        )
    except Exception as exc:  # noqa: BLE001 — degrade quietly
        logger.warning(
            "contradiction_detector: ES scan for %s in ks=%s failed: %s",
            fact_type, ks_id, exc,
        )
        return []
    hits = res.get("hits", {}).get("hits", []) or []
    return [h.get("_source") or {} for h in hits]


def _detect_measurement_pairs(facts: list[dict]) -> list[ContradictionCandidate]:
    """Bucket measurement facts by (metric, entity, as_of); for every
    bucket with >= 2 facts, emit a pair for every distinct-value combo.
    """
    by_key: dict[tuple[str, str, str], list[dict]] = {}
    for fact in facts:
        key = _measurement_key(fact)
        if key is None:
            continue
        by_key.setdefault(key, []).append(fact)

    out: list[ContradictionCandidate] = []
    for key, bucket in by_key.items():
        if len(bucket) < 2:
            continue
        for i, fa in enumerate(bucket):
            for fb in bucket[i + 1:]:
                va = fa.get("measurement_value")
                vb = fb.get("measurement_value")
                if va is None or vb is None:
                    continue
                try:
                    same = abs(float(va) - float(vb)) <= 1e-9
                except (TypeError, ValueError):
                    continue
                if same:
                    continue
                ua = fa.get("fact_uid")
                ub = fb.get("fact_uid")
                if not ua or not ub:
                    continue
                metric, entity, as_of = key
                out.append(
                    ContradictionCandidate(
                        layer="measurement",
                        from_fact_uid=ua,
                        to_fact_uid=ub,
                        key_summary=(
                            f"metric={metric!r}, entity={entity[:8]!r}, "
                            f"as_of={as_of!r}"
                        ),
                        evidence={
                            "value_a": va,
                            "value_b": vb,
                            "unit_a": fa.get("measurement_unit"),
                            "unit_b": fb.get("measurement_unit"),
                        },
                    )
                )
    return out


def _detect_action_pairs(facts: list[dict]) -> list[ContradictionCandidate]:
    """Bucket action facts by canonical SPO; emit pairs whose
    negation_flag values disagree (one negated, one not).
    """
    by_key: dict[tuple[str, str, str], list[dict]] = {}
    for fact in facts:
        key = _action_key(fact)
        if key is None:
            continue
        by_key.setdefault(key, []).append(fact)

    out: list[ContradictionCandidate] = []
    for key, bucket in by_key.items():
        if len(bucket) < 2:
            continue
        for i, fa in enumerate(bucket):
            for fb in bucket[i + 1:]:
                pa = bool(fa.get("negation_flag", False))
                pb = bool(fb.get("negation_flag", False))
                if pa == pb:
                    continue
                ua = fa.get("fact_uid")
                ub = fb.get("fact_uid")
                if not ua or not ub:
                    continue
                subj, pred, obj = key
                obj_disp = (obj or "")[:30]
                out.append(
                    ContradictionCandidate(
                        layer="action",
                        from_fact_uid=ua,
                        to_fact_uid=ub,
                        key_summary=(
                            f"SPO=({subj[:8]!r}, {pred!r}, {obj_disp!r}), "
                            f"polarity a={pa} b={pb}"
                        ),
                        evidence={
                            "fact_a_negation": pa,
                            "fact_b_negation": pb,
                        },
                    )
                )
    return out


def detect_contradictions_in_ks(client, ks_id: str) -> list[ContradictionCandidate]:
    """Scan a KS for contradictions across measurement + action layers.

    Returns the FULL candidate list (not yet persisted). Use
    `write_contradiction_relations` to persist and `detect_and_persist`
    for the combined flow.
    """
    if not ks_id:
        return []
    measurement_facts = _scan_facts_by_type(client, ks_id, "measurement")
    action_facts = _scan_facts_by_type(client, ks_id, "action")

    candidates: list[ContradictionCandidate] = []
    candidates.extend(_detect_measurement_pairs(measurement_facts))
    candidates.extend(_detect_action_pairs(action_facts))
    return candidates


# ---------------------------------------------------------------------------
# Postgres persistence — idempotent write to fact_relations.
# ---------------------------------------------------------------------------


def write_contradiction_relations(
    session, candidates: list[ContradictionCandidate],
) -> int:
    """Persist contradiction candidates as fact_relations rows.

    Idempotent: skips a candidate when a row with the same fact_uid
    pair already exists in either direction. Returns the number of NEW
    rows committed (0 when every candidate was already persisted).
    """
    if not candidates:
        return 0

    from sqlalchemy import and_, or_

    from api.storage.postgres.orm import FactRelation

    written = 0
    for cand in candidates:
        # Same-direction check.
        existing = (
            session.query(FactRelation)
            .filter(
                and_(
                    FactRelation.relation_type == CONTRADICTS,
                    or_(
                        and_(
                            FactRelation.from_fact_uid == cand.from_fact_uid,
                            FactRelation.to_fact_uid == cand.to_fact_uid,
                        ),
                        and_(
                            FactRelation.from_fact_uid == cand.to_fact_uid,
                            FactRelation.to_fact_uid == cand.from_fact_uid,
                        ),
                    ),
                )
            )
            .first()
        )
        if existing is not None:
            continue

        session.add(
            FactRelation(
                from_fact_uid=cand.from_fact_uid,
                to_fact_uid=cand.to_fact_uid,
                relation_type=CONTRADICTS,
            )
        )
        written += 1

    if written > 0:
        session.commit()
        logger.info(
            "contradiction_detector: wrote %d new CONTRADICTS relations",
            written,
        )
    return written


def detect_and_persist(client, session, ks_id: str) -> dict[str, Any]:
    """Combined flow: detect + persist + summarize.

    Returns:
      {
        'candidates_found': int,
        'relations_written': int,
        'by_layer': {'measurement': int, 'action': int},
      }
    """
    candidates = detect_contradictions_in_ks(client, ks_id)
    written = write_contradiction_relations(session, candidates)
    return {
        "candidates_found": len(candidates),
        "relations_written": written,
        "by_layer": {
            "measurement": sum(1 for c in candidates if c.layer == "measurement"),
            "action": sum(1 for c in candidates if c.layer == "action"),
        },
    }


# ---------------------------------------------------------------------------
# Recall surfacing — bulk count for a page of facts.
# ---------------------------------------------------------------------------


def count_contradictions_for_facts(
    session, fact_uids: list[str],
) -> dict[str, int]:
    """Bulk-count CONTRADICTS edges for a page of fact_uids.

    Returns ``{fact_uid: count}``. Facts with zero contradictions are
    OMITTED from the dict so the caller can dict-get with default 0.

    One Postgres query regardless of page size (no N+1). KS isolation
    is provided implicitly: fact_uids are globally unique, so two facts
    in different KS will never collide on the SAME from/to pair.
    """
    if not fact_uids:
        return {}

    from sqlalchemy import or_

    from api.storage.postgres.orm import FactRelation

    try:
        rows = (
            session.query(FactRelation.from_fact_uid, FactRelation.to_fact_uid)
            .filter(
                FactRelation.relation_type == CONTRADICTS,
                or_(
                    FactRelation.from_fact_uid.in_(fact_uids),
                    FactRelation.to_fact_uid.in_(fact_uids),
                ),
            )
            .all()
        )
    except Exception as exc:  # noqa: BLE001 — degrade quietly
        logger.warning(
            "contradiction_detector: count query failed: %s", exc,
        )
        return {}

    page_set = set(fact_uids)
    counts: dict[str, int] = {}
    for from_uid, to_uid in rows:
        if from_uid in page_set:
            counts[from_uid] = counts.get(from_uid, 0) + 1
        if to_uid in page_set and to_uid != from_uid:
            counts[to_uid] = counts.get(to_uid, 0) + 1
    return counts
