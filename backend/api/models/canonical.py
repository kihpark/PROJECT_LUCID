"""M3-1 canonical-layer — canonical entity record + MergeProposal.

PO directive (m31-canonical-layer 2026-06-24, verbatim):
  - 같은 entity 를 정확히 식별·병합 (교차소스 dedup).
  - 모순감지·LENS·entity뷰의 토대.
  - 스코프 (기초까지만): canonical entity 레코드 구조 + 표면형 → canonical
    매핑 + 병합 도구 (dry-run + apply, 옛 backfill 패턴 재사용).

This module ONLY defines the in-memory shape used by the discovery /
mapping / merge-proposal pipeline. We do NOT add a new ES index in this
PR — the live `lucid_objects` doc shape already carries the seed fields
(`primary_label`, `primary_lang`, `aliases`, `entity_type`,
`fact_uids`, `connected_objects`). A canonical merge collapses the
member docs onto a single representative `object_uid` rather than
spawning a parallel index. ★ This file ships the STRUCTURE only —
apply / entity뷰 / meta-network / LENS wait on PO command (의뢰서
verbatim).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now


class CanonicalEntity(LucidBaseModel):
    """In-memory canonical entity record.

    Discovery showed 7 merge-candidate clusters in the PO KS where two
    Korean surface forms ("MP 머티리얼즈" vs "MP머티리얼스",
    "선거관리위원회" vs "선관위", etc.) share a normalized name_en
    keyword and an entity_type but live in two separate `lucid_objects`
    docs. The canonical layer's job is to identify those clusters and
    pick a single representative.

    Fields:
      - canonical_uid: the surviving representative `object_uid` for
        the cluster (the chosen "winner" — selection rule lives in
        `canonical_merge.py`, not on this dataclass).
      - primary_label: the canonical natural-language label, in the
        chosen primary language (defaults to Korean per the PO's
        natural-spo-display + b62-fix subject-natlang rules — see
        `entity_resolver.pick_natural_primary`).
      - primary_label_en: the English alias when one exists.
      - aliases: every surface variant that the merge collapsed onto
        this canonical (Korean spellings with/without spaces, English
        alias forms, abbreviations).
      - entity_type: the controlled-vocab class (`person` /
        `organization` / `place` / etc.) — kept loose, NOT enforced as
        an enum here because the PO directive explicitly says
        "ontology — 경직 강제 금지".
      - properties: free-shape slot for downstream attributes
        (founder, founded_at, headquarters, ...) — out of scope for
        M3-1 but reserved so the field survives merges.
      - member_object_uids: every `object_uid` that this canonical
        represents. Always includes `canonical_uid` itself. Used by
        the apply path to find every doc that needs to be merged /
        retired.
      - created_at / updated_at: lifecycle bookkeeping.

    Pydantic v2 LucidBaseModel inherits `extra="forbid"` and
    `validate_assignment=True` — typo and stale-field protection (the
    same defensive default the rest of the codebase uses).
    """

    canonical_uid: UID
    primary_label: str
    primary_label_en: str | None = None
    aliases: list[str] = Field(default_factory=list)
    entity_type: str
    properties: dict[str, Any] = Field(default_factory=dict)
    member_object_uids: list[UID] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# Confidence levels for a merge proposal. Drives how the apply path
# (PO 명령 대기 — not implemented yet) treats the cluster:
#   - deterministic: normalized-key collision; safe to merge without
#     human review.
#   - llm: the deterministic rule said "maybe", and Claude was asked
#     "same entity?" and returned yes. Needs human-review gate when
#     applied.
#   - fuzzy: low-confidence shape match (substring / Levenshtein). PO
#     command-gated — NEVER applied automatically.
MergeConfidence = Literal["deterministic", "llm", "fuzzy"]


class MergeProposal(LucidBaseModel):
    """A discovered cluster of `lucid_objects` docs that look like the
    same canonical entity.

    The discovery path (`canonical_merge.discover_merge_proposals`)
    emits these; the dry-run path (`canonical_merge.apply_merge` with
    `dry_run=True`) reports what WOULD happen without writing. The
    apply path is intentionally NOT wired up in M3-1 — the PO 의뢰서
    explicitly says: "apply (실데이터 병합)·entity뷰·meta-network·LENS
    는 PO 명령 대기."

    Fields:
      - target_canonical_uid: the surviving representative `object_uid`.
        Selection rule (see `canonical_merge._pick_representative`):
        prefer the doc with the longest primary_label (more specific
        wins) and break ties by `created_at` (oldest survives — least
        disruptive for stable fact_uid back-pointers).
      - members: every `object_uid` in the cluster, INCLUDING the
        target. Length >= 2 by construction (a 1-member cluster has
        nothing to merge).
      - primary_label: the chosen canonical primary label (today: the
        representative doc's `primary_label`; future tickets may pick
        the "more natural" surface). Always Korean when a Korean form
        exists — the PO directive defends Korean primaries from
        English translations.
      - aliases: union of every member's aliases + every member's
        primary_label that is NOT the chosen `primary_label`. The
        apply path will write this union back to the surviving doc so
        downstream lookups see every variant.
      - entity_type: the cluster's class. Required to be uniform
        across members in M3-1 (deterministic key includes it). A
        future ticket can add a "class disagreement" reconciliation
        pass; this PR stays narrow.
      - confidence: see `MergeConfidence` above.
      - fact_provenance: maps every `fact_uid` referencing ANY member
        → the original `object_uid` that the fact's `subject_uid` /
        `object_value` pointed at. Used by the apply path (PO 명령 대기)
        to rewrite the facts AND to roll the change back if needed.
        Computed by `canonical_merge._collect_fact_provenance`.
      - reason: a short human-readable note explaining WHY this
        cluster was proposed (e.g. "shared normalized name_en
        'mpmaterials'"). Shows up in the dry-run report for PO review.
    """

    target_canonical_uid: UID
    members: list[UID]
    primary_label: str
    aliases: list[str] = Field(default_factory=list)
    entity_type: str
    confidence: MergeConfidence
    fact_provenance: dict[str, str] = Field(default_factory=dict)
    reason: str = ""
