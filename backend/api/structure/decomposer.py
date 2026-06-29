"""Structure-stage entry point (Sprint 3 PR-3-1).

`decompose(text, metadata)` is the single public function for the
Structure stage. PR-3-2 will wire this into the SourceJob lifecycle
(when status='extracted' rows land in the queue); for now the function
is callable in isolation and tests cover its behavior with a mocked
Claude client.
"""
from __future__ import annotations

import logging
from typing import Any

from api.structure.action_object_resolver import resolve_action_object_to_entity
from api.structure.claude_client import decompose_via_claude
from api.structure.coord_splitter import split_coordinated_subjects
from api.structure.models import StructureResult

logger = logging.getLogger("lucid.structure.decomposer")


def decompose(merged_text: str, metadata: dict[str, Any] | None = None) -> StructureResult:
    """Public API: decompose `merged_text` into a StructureResult.

    Currently a thin wrapper around `decompose_via_claude`. The
    indirection exists so PR-3-2 / PR-3-3 can layer in:
      - cache / dedup
      - Object matching against the existing graph
      - failure-mode telemetry hooks
    without forcing callers to change.
    """
    result = decompose_via_claude(merged_text, metadata)
    # B-33: distributive-coordination safety net. The LLM is expected
    # to honour Step 3a in the prompt and split "A와 B가 ~" into one
    # atomic fact per subject. When it doesn't (and only when the
    # heuristic is unambiguous — same class, coord marker present,
    # non-joint predicate) the splitter emits the missing atoms with
    # tags_suggested += ["coord_split"] so the Decide overlay shows
    # them as derived.
    pre_split_count = len(result.facts)
    result = split_coordinated_subjects(result)
    if len(result.facts) != pre_split_count:
        logger.info(
            "decompose: coord_splitter added %d derived fact(s) "
            "(LLM emitted %d, post-split %d)",
            len(result.facts) - pre_split_count,
            pre_split_count,
            len(result.facts),
        )
    # feat/v2-action-entity-edge-class-fix (PO 2026-06-29):
    # 원칙 1 위반 클래스 fix — ACTION fact 의 object_value 가 literal 인
    # 경우 같은 result.objects 배열에서 deterministic 매칭으로 obj-N
    # placeholder 로 치환. LLM Path A (prompt) 가 못 잡은 잔여를
    # safety net 으로 흡수. CLAIM / MEASUREMENT 무변경.
    pre_resolve_action_with_literal = sum(
        1 for f in result.facts
        if f.fact_type == "action"
        and isinstance(f.object_value, str)
        and f.object_value.strip()
        and not f.object_value.strip().lower().startswith("obj-")
    )
    result = resolve_action_object_to_entity(result)
    post_resolve_action_with_literal = sum(
        1 for f in result.facts
        if f.fact_type == "action"
        and isinstance(f.object_value, str)
        and f.object_value.strip()
        and not f.object_value.strip().lower().startswith("obj-")
    )
    if pre_resolve_action_with_literal != post_resolve_action_with_literal:
        logger.info(
            "decompose: action_object_resolver rewrote %d ACTION fact(s) "
            "(literal->entity; pre=%d post=%d)",
            pre_resolve_action_with_literal - post_resolve_action_with_literal,
            pre_resolve_action_with_literal,
            post_resolve_action_with_literal,
        )
    logger.info(
        "decompose: status=%s, facts=%d, objects=%d, latency_ms=%d, failure_reason=%s",
        result.extraction_status,
        len(result.facts),
        len(result.objects),
        result.latency_ms,
        result.failure_reason,
    )
    # B-62-debug (PO 2026-06-22): point 1 instrumentation. Log each fact's
    # subject-side fields verbatim from the LLM (post coord-split) so we
    # can measure whether the LLM is filling subject_surface for
    # Korean-origin entities or quietly omitting it. DEBUG-gated — zero
    # cost in production (default log level is INFO).
    if logger.isEnabledFor(logging.DEBUG):
        obj_by_uid = {o.uid: o for o in result.objects}
        for idx, fact in enumerate(result.facts):
            subj_obj = obj_by_uid.get(fact.subject_uid)
            subj_name = getattr(subj_obj, "name", None) if subj_obj else None
            subj_name_en = getattr(subj_obj, "name_en", None) if subj_obj else None
            logger.debug(
                "B-62-debug LLM_RAW fact=%d uid=%s subject_uid=%s "
                "subject_name=%r subject_surface=%r subject_name_en=%r "
                "object_value=%r object_surface=%r claim=%r",
                idx, fact.uid, fact.subject_uid,
                subj_name, fact.subject_surface, subj_name_en,
                fact.object_value, fact.object_surface, fact.claim,
            )
    return result
