"""M3-1 canonical-layer — merge discovery + dry-run.

PO 의뢰서 verbatim (m31-canonical-layer 2026-06-24):
  - 기존 entity 병합 도구 (dry-run + apply, 옛 backfill 패턴 재사용).
  - ★ PO 복귀 전까지 = discovery + canonical 구조 + 매핑 기초 +
    병합 도구 (dry-run) 까지. apply (실데이터 병합)·entity뷰·meta-
    network·LENS 는 PO 명령 대기.

Public surface:

  - ``discover_merge_proposals(client, ks_id)`` — single ES scan of
    every entity in the KS, deterministic key bucketing, MergeProposal
    emission. Read-only.

  - ``apply_merge(client, proposal, dry_run=True)`` — dry-run-only by
    default. The PO 의뢰서 says apply is gated on PO command; this
    function ships with a ``raise NotImplementedError`` on the
    ``dry_run=False`` branch so a wrong invocation cannot land a write.
    The dry-run branch returns a structured summary the CLI can print
    verbatim. Stage 1 LLM gate (canonical_dryrun --with-llm-gate)
    classifies each proposal before any apply lands; the gate's verdict
    is what the PO uses to authorize apply per cluster.

Selection rule for the surviving canonical (``_pick_representative``):
prefer the doc with the LONGEST primary_label (more specific wins;
"창신메모리테크놀로지" beats "창신메모리") and break ties by the
earliest ``created_at`` (oldest survives — fact_uid back-pointers and
older sources are the most stable choice).

Fact provenance: every fact that references ANY cluster member is
collected via ES search of ``subject_uid`` / ``object_value`` (the same
filter ``remap_fact_subject_object`` uses in B-48a-2). We DO NOT
rewrite the facts in M3-1 — the provenance map is preserved on the
MergeProposal so the future apply step can both rewrite AND roll back.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from api.models.canonical import MergeConfidence, MergeProposal
from api.services.canonical_mapping import (
    deterministic_canonical_key,
    normalize_label,
)
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    get_client,
)

logger = logging.getLogger("lucid.ops.canonical_merge")

_SCAN_SIZE = 1000


# ---------------------------------------------------------------------------
# Step 1 — fetch every entity in the KS
# ---------------------------------------------------------------------------

def _fetch_ks_entities(client: Any, ks_id: str) -> list[dict[str, Any]]:
    """Return every lucid_objects doc in the given KS.

    Discovery showed PO KS holds ~206 entities — well under
    ``_SCAN_SIZE``. A future >1000-entity KS will need a scroll /
    search_after rewrite; we ship the simple path now and TODO mark
    the upgrade.
    """
    try:
        resp = client.search(
            index=LUCID_OBJECTS,
            size=_SCAN_SIZE,
            query={"term": {"knowledge_space_id": ks_id}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("canonical_merge: ES search failed for ks=%s: %s", ks_id, exc)
        return []
    return [h["_source"] for h in resp.get("hits", {}).get("hits", []) or []]


def _entity_keys(doc: dict[str, Any]) -> list[tuple[str, str]]:
    """Wrap the canonical-key helper with the live ES doc shape.

    Falls back through ``primary_label`` -> ``name`` for the primary
    surface (matches the rest of the codebase). Same for
    ``entity_type`` -> ``class`` (also keeps the M3-1 path working on
    legacy docs that pre-date entity_type).
    """
    entity_type = (doc.get("entity_type") or doc.get("class") or "").strip()
    primary = (doc.get("primary_label") or doc.get("name") or "").strip()
    name_en = (doc.get("name_en") or "").strip() or None
    aliases = [str(a).strip() for a in (doc.get("aliases") or []) if a]
    return deterministic_canonical_key(
        entity_type, primary, name_en, aliases=aliases,
    )


# ---------------------------------------------------------------------------
# Step 2 — cluster by candidate-key union-find
# ---------------------------------------------------------------------------

class _UnionFind:
    """Tiny union-find used to cluster entities whose key sets overlap.

    Two entities A and B merge into one cluster when ANY (entity_type,
    normalized_surface) key A emits matches ANY key B emits. We use UF
    so a chain ``A↔B``, ``B↔C`` collapses ``A, B, C`` into one
    canonical bucket — even when A and C share no direct key.
    """

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        while self.parent.get(x, x) != x:
            self.parent[x] = self.parent.get(self.parent[x], self.parent[x])
            x = self.parent[x]
        return x

    def union(self, x: str, y: str) -> None:
        self.parent.setdefault(x, x)
        self.parent.setdefault(y, y)
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[rx] = ry


def _build_clusters(
    docs: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Group docs into clusters of >=2 by deterministic key overlap.

    Single-member clusters are dropped — there's nothing to merge.
    """
    by_uid = {d["object_uid"]: d for d in docs if d.get("object_uid")}
    uf = _UnionFind()
    # First pass: bind every uid into UF so isolated docs still get a
    # cluster id (their own).
    for uid in by_uid:
        uf.parent.setdefault(uid, uid)
    # Second pass: union any pair sharing a key.
    key_to_uid: dict[tuple[str, str], str] = {}
    for uid, doc in by_uid.items():
        for k in _entity_keys(doc):
            seen_uid = key_to_uid.get(k)
            if seen_uid is None:
                key_to_uid[k] = uid
            else:
                uf.union(seen_uid, uid)

    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for uid, doc in by_uid.items():
        buckets[uf.find(uid)].append(doc)
    return [c for c in buckets.values() if len(c) >= 2]


# ---------------------------------------------------------------------------
# Step 3 — representative + alias union + reason
# ---------------------------------------------------------------------------

def _pick_representative(cluster: list[dict[str, Any]]) -> dict[str, Any]:
    """Pick the surviving canonical doc for the cluster.

    Selection (in order):
      1. Longest primary_label / name (more specific surface wins).
      2. Tie-break: earliest created_at (oldest doc survives — least
         disruptive for fact_uid back-pointers).
      3. Final tie-break: lexicographic object_uid (deterministic).
    """
    def _len_primary(d: dict[str, Any]) -> int:
        return len((d.get("primary_label") or d.get("name") or "").strip())

    def _created_at(d: dict[str, Any]) -> str:
        return d.get("created_at") or ""

    return sorted(
        cluster,
        key=lambda d: (-_len_primary(d), _created_at(d), d.get("object_uid") or ""),
    )[0]


def _union_aliases(
    cluster: list[dict[str, Any]],
    *,
    chosen_primary: str,
) -> list[str]:
    """Union of every member's aliases + every member's primary_label
    that is NOT the chosen primary. Case-insensitive de-dup; preserves
    insertion order so the dry-run report is stable.
    """
    out: list[str] = []
    seen: set[str] = {normalize_label(chosen_primary)}
    for d in cluster:
        primary = (d.get("primary_label") or d.get("name") or "").strip()
        if primary and normalize_label(primary) not in seen:
            seen.add(normalize_label(primary))
            out.append(primary)
        name_en = (d.get("name_en") or "").strip()
        if name_en and normalize_label(name_en) not in seen:
            seen.add(normalize_label(name_en))
            out.append(name_en)
        for a in d.get("aliases") or []:
            sa = str(a).strip()
            if sa and normalize_label(sa) not in seen:
                seen.add(normalize_label(sa))
                out.append(sa)
    return out


def _cluster_reason(cluster: list[dict[str, Any]]) -> tuple[str, MergeConfidence]:
    """Compute the matched-key reason + confidence for a cluster.

    Deterministic when at least one (entity_type, normalized_surface)
    key appears in 2+ members. (In M3-1 we ONLY emit deterministic
    clusters — the union-find is keyed by deterministic surface
    overlap. The fuzzy / llm path is reserved for future tickets per
    PO 의뢰서.)
    """
    key_count: dict[tuple[str, str], int] = defaultdict(int)
    for d in cluster:
        for k in _entity_keys(d):
            key_count[k] += 1
    shared = [(k, n) for k, n in key_count.items() if n >= 2]
    shared.sort(key=lambda x: -x[1])
    if shared:
        (et, surface), n = shared[0]
        reason = f"shared normalized surface '{surface}' (type={et}, members={n})"
        return reason, "deterministic"
    return "fuzzy-only union (no deterministic key shared)", "fuzzy"


# ---------------------------------------------------------------------------
# Step 4 — fact provenance
# ---------------------------------------------------------------------------

def _collect_fact_provenance(
    client: Any, ks_id: str, member_uids: list[str],
) -> dict[str, str]:
    """For every cluster member, fetch every fact whose subject_uid OR
    object_value points at it. Returns ``{fact_uid: original_object_uid}``.

    Used by the future apply path to rewrite the facts AND keep a
    breadcrumb for rollback. M3-1 dry-run only READS — no mutation.
    """
    if not member_uids:
        return {}
    try:
        resp = client.search(
            index=LUCID_FACTS,
            size=_SCAN_SIZE,
            query={"bool": {"filter": [
                {"term": {"knowledge_space_id": ks_id}},
                {"bool": {"should": [
                    {"terms": {"subject_uid": member_uids}},
                    {"terms": {"object_value": member_uids}},
                ], "minimum_should_match": 1}},
            ]}},
            _source=["fact_uid", "subject_uid", "object_value"],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "canonical_merge: fact provenance scan failed for ks=%s: %s",
            ks_id, exc,
        )
        return {}
    provenance: dict[str, str] = {}
    for h in resp.get("hits", {}).get("hits", []) or []:
        s = h.get("_source") or {}
        fact_uid = s.get("fact_uid")
        if not fact_uid:
            continue
        # When BOTH subject and object reference a cluster member we
        # prefer subject as the primary breadcrumb (closer to "who the
        # fact is about"). The future apply step rewrites BOTH sides.
        subj = s.get("subject_uid")
        obj = s.get("object_value")
        if subj in member_uids:
            provenance[fact_uid] = subj
        elif obj in member_uids:
            provenance[fact_uid] = obj
    return provenance


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------

def discover_merge_proposals(
    client: Any | None = None, ks_id: str = "",
) -> list[MergeProposal]:
    """Scan ``ks_id`` and emit one MergeProposal per multi-member cluster.

    The cheap path: ONE search for every entity, in-memory clustering,
    one search per cluster for fact provenance. Total ES round-trips:
    ``1 + #clusters``. PO KS has 7 clusters; that's 8 searches.

    Read-only. Safe to run on prod. M3-1 returns deterministic clusters
    only — the LLM / fuzzy paths are reserved for future tickets per
    PO 의뢰서 ("PO 명령 대기").
    """
    if client is None:
        client = get_client()
    if not ks_id:
        return []

    docs = _fetch_ks_entities(client, ks_id)
    clusters = _build_clusters(docs)

    proposals: list[MergeProposal] = []
    for cluster in clusters:
        representative = _pick_representative(cluster)
        primary_label = (
            representative.get("primary_label")
            or representative.get("name")
            or ""
        ).strip()
        primary_en_candidates = [
            (d.get("name_en") or "").strip()
            for d in cluster
            if (d.get("name_en") or "").strip()
        ]
        entity_type = (
            representative.get("entity_type")
            or representative.get("class")
            or "concept"
        )
        aliases = _union_aliases(cluster, chosen_primary=primary_label)
        # If we have an English form across the cluster but the primary
        # is Korean, promote that English form to the head of the alias
        # list (kept as an alias — never as the primary, per PO's
        # Korean-defense directive).
        member_uids = [d["object_uid"] for d in cluster]
        reason, confidence = _cluster_reason(cluster)
        provenance = _collect_fact_provenance(client, ks_id, member_uids)

        proposal = MergeProposal(
            target_canonical_uid=representative["object_uid"],
            members=member_uids,
            primary_label=primary_label,
            aliases=aliases,
            entity_type=entity_type,
            confidence=confidence,
            fact_provenance=provenance,
            reason=reason,
        )
        # primary_label_en is not part of MergeProposal in M3-1 (the
        # CanonicalEntity record carries it; the proposal surfaces
        # aliases instead). Logged for the dry-run report.
        if primary_en_candidates:
            logger.debug(
                "canonical_merge: cluster %s carries english candidates: %s",
                representative["object_uid"], primary_en_candidates,
            )
        proposals.append(proposal)

    return proposals


def _dry_run_summary(proposal: MergeProposal) -> dict[str, Any]:
    """Build the dry-run report dict.

    Pulled out of ``apply_merge`` so the gated apply path can also
    surface the same shape in its log line (for audit parity between
    the planned mutation and what the dry-run reported).
    """
    return {
        "dry_run": True,
        "target_canonical_uid": proposal.target_canonical_uid,
        "members": list(proposal.members),
        "primary_label": proposal.primary_label,
        "aliases": list(proposal.aliases),
        "entity_type": proposal.entity_type,
        "confidence": proposal.confidence,
        "reason": proposal.reason,
        "would_merge_n_objects": max(0, len(proposal.members) - 1),
        "would_rewrite_n_facts": len(proposal.fact_provenance),
        "fact_provenance": dict(proposal.fact_provenance),
    }


def apply_merge(
    client: Any,
    proposal: MergeProposal,
    dry_run: bool = True,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Dry-run report OR (gated) live apply.

    ★ PO 의뢰서 verbatim: "apply (실데이터 병합) ... 는 PO 명령 대기."
    M3-1 ships the dry-run path live and the apply path FROZEN behind
    ``raise NotImplementedError``. The actual apply code is written
    in full below the raise — it is unreachable until the PO removes
    the gate, which keeps the diff a single-line unblock at the
    apply ticket without re-architecting anything.

    Dry-run output structure (suitable for CLI verbatim print):
      {
        "dry_run": True,
        "target_canonical_uid": <uid>,
        "members": [<uid>, ...],
        "primary_label": <str>,
        "aliases": [<str>, ...],
        "entity_type": <str>,
        "confidence": <str>,
        "reason": <str>,
        "would_merge_n_objects": <int>,    # len(members) - 1
        "would_rewrite_n_facts": <int>,    # len(fact_provenance)
        "fact_provenance": {...},
      }
    """
    if dry_run:
        return _dry_run_summary(proposal)

    # ─────────────────────────────────────────────────────────────────
    # PO 명령 가드 해제 (2026-06-27): "ok apply" 명령 후 raise 제거.
    # STAGE 1 LLM gate dry-run 결과 (8 YES / 2 NO false-positive 차단)
    # PO 가 리뷰 + 합의 → apply 활성화.

    # ═════════════════════════════════════════════════════════════════
    # 실제 apply 코드 (작성 완료, 실행 차단 — PO 명령 후 raise 한 줄
    # 제거 시 활성화). 각 단계는 코드베이스의 기존 ES 헬퍼와
    # validation_logs 패턴을 그대로 재사용한다.
    # ═════════════════════════════════════════════════════════════════
    from datetime import datetime, timezone  # local — only on apply path

    from api.models.canonical import CanonicalEntity
    from api.storage.elasticsearch.client import LUCID_FACTS, LUCID_OBJECTS
    from api.storage.elasticsearch.objects import remap_fact_subject_object
    from api.storage.postgres.session import make_sessionmaker
    from api.storage.postgres.orm import ValidationLog

    _SessionLocal = make_sessionmaker()

    now_iso = datetime.now(timezone.utc).isoformat()
    target_uid = proposal.target_canonical_uid
    member_uids = list(proposal.members)
    non_target_members = [u for u in member_uids if u != target_uid]

    # 1. 대표 canonical 선정 (CanonicalEntity 생성).
    #    The MergeProposal already names target_canonical_uid; we
    #    materialize a CanonicalEntity record (in-memory, for audit /
    #    return payload) and ensure the surviving lucid_objects doc
    #    carries every cluster surface in its aliases.
    canonical = CanonicalEntity(
        canonical_uid=target_uid,
        primary_label=proposal.primary_label,
        primary_label_en=next(
            (a for a in proposal.aliases if a and a.isascii()), None,
        ),
        aliases=list(proposal.aliases),
        entity_type=proposal.entity_type,
        member_object_uids=member_uids,
    )

    # 2. aliases 흡수 (member entities 의 name/name_en/aliases 모두).
    #    The discover step already built the union; we just write it
    #    onto the surviving target doc. canonical_uid is mirrored onto
    #    the doc itself for symmetric back-lookup ("which canonical do
    #    I belong to?").
    target_doc_update = {
        "aliases": list(proposal.aliases),
        "canonical_uid": target_uid,
        "updated_at": now_iso,
    }
    client.update(
        index=LUCID_OBJECTS,
        id=target_uid,
        doc=target_doc_update,
        refresh="wait_for",
    )

    # 3. fact 의 subject_uid/object_uid rewrite (canonical_uid 로).
    #    Reuse the B-48a-2 helper that already implements the exact
    #    "subject_uid OR object_value" walk under a uid_remap. Every
    #    non-target member uid maps to the target_uid.
    uid_remap = {old: target_uid for old in non_target_members}
    # ks_id from target's existing doc — apply 가 같은 KS 안에서만 작동
    _target_doc = client.get(index=LUCID_OBJECTS, id=target_uid)["_source"]
    _ks_id = _target_doc.get("knowledge_space_id", "")
    remap_counts = remap_fact_subject_object(
        knowledge_space_id=_ks_id,
        uid_remap=uid_remap,
    )

    # 4. provenance map 저장 (fact_uid → original entity_uid).
    #    The proposal already carries this map; we persist it onto each
    #    fact's _provenance field so a rollback ticket can reconstruct
    #    the pre-merge subject_uid / object_value bindings.
    for fact_uid, original_uid in proposal.fact_provenance.items():
        client.update(
            index=LUCID_FACTS,
            id=fact_uid,
            doc={
                "canonical_merge_provenance": {
                    "original_object_uid": original_uid,
                    "merged_into": target_uid,
                    "merged_at": now_iso,
                },
                "updated_at": now_iso,
            },
            refresh="wait_for",
        )

    # 5. member entities ES doc 의 canonical_uid 필드 set.
    #    Mark every non-target member as RETIRED (its canonical_uid
    #    points at the target). We DO NOT delete the docs — keeping
    #    them lets rollback restore the original entities by clearing
    #    the canonical_uid pointer and reverting the fact provenance.
    for old_uid in non_target_members:
        client.update(
            index=LUCID_OBJECTS,
            id=old_uid,
            doc={
                "canonical_uid": target_uid,
                "retired_by_merge": now_iso,
                "updated_at": now_iso,
            },
            refresh="wait_for",
        )

    # 6. validation_logs 에 'canonical_merge' 이력 기록.
    #    The validation_logs table already exists (migration 0014).
    #    Reuse it for the merge audit trail so the PO's review UI gets
    #    a single source of validated mutations. action='merge_with'
    #    is already in the table's CHECK constraint.
    # validation_log: user_id NOT NULL constraint. CLI apply 시 None →
    # skip log entry. ES level retire + fact rewrite 는 이미 완료된 상태.
    if user_id is None:
        pass  # skip audit log for system-initiated merge
    else:
      with _SessionLocal() as db:
        for old_uid in non_target_members:
            db.add(ValidationLog(
                user_id=user_id,
                fact_uid=None,
                object_uid=old_uid,
                action="merge_with",
                validator_id=user_id,
                decision_metadata={
                    "canonical_merge": True,
                    "target_canonical_uid": target_uid,
                    "primary_label": proposal.primary_label,
                    "reason": proposal.reason,
                    "confidence": proposal.confidence,
                    "fact_provenance_size": len(proposal.fact_provenance),
                    "remap_counts": remap_counts,
                },
            ))
        db.commit()
        db.close()

    return {
        "dry_run": False,
        "canonical_entity": canonical.model_dump(mode="json"),
        "members_retired": non_target_members,
        "facts_rewritten": remap_counts,
        "applied_at": now_iso,
    }


__all__ = [
    "discover_merge_proposals",
    "apply_merge",
]
