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

# REQ-004 STAGE 1c-v — action_object_resolver 폐기:
# ★ STOP guard 제거. ACTION fact 의 literal-object 잔재는 STAGE 1c-iii 의
# processor `_serialize_struct_fact` literal-strip 가드가 entity_id 가
# 아닌 모든 값을 ★ 통째로 비우는 방식으로 차단한다. action_object_resolver
# 의 deterministic name-fuzzy 매칭은 v3 의 ★ 전역 entity resolution 관문
# (resolution_gateway) 로 대체된다 — 매칭이 안 되면 candidate entity 가
# 새로 생기거나 (★ 1c-ii) object_value 가 비어 needs_review=True 가
# 된다 (★ 1c-iii). 더 이상 decomposer 가 후처리로 literal→placeholder
# 재작성을 시도하지 않는다.
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
    # REQ-004 STAGE 1c-v — action_object_resolver 호출 site 제거.
    # ★ literal 잔재는 processor `_serialize_struct_fact` 의 1c-iii
    # literal-strip 가드가 차단. decomposer 는 더 이상 후처리로 literal
    # 을 entity 로 재작성하지 않는다 (★ 단일 entity resolution 경로 =
    # resolution_gateway). 측정용 로그만 남긴다.
    action_literal_residual = sum(
        1 for f in result.facts
        if f.fact_type == "action"
        and isinstance(f.object_value, str)
        and f.object_value.strip()
        and not f.object_value.strip().lower().startswith("obj-")
    )
    if action_literal_residual:
        logger.info(
            "decompose: %d ACTION fact(s) carry literal object_value at "
            "LLM-output time; ★ STAGE 1c-iii literal-strip will null them.",
            action_literal_residual,
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
