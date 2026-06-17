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
    logger.info(
        "decompose: status=%s, facts=%d, objects=%d, latency_ms=%d, failure_reason=%s",
        result.extraction_status,
        len(result.facts),
        len(result.objects),
        result.latency_ms,
        result.failure_reason,
    )
    return result
