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
    logger.info(
        "decompose: status=%s, facts=%d, objects=%d, latency_ms=%d, failure_reason=%s",
        result.extraction_status,
        len(result.facts),
        len(result.objects),
        result.latency_ms,
        result.failure_reason,
    )
    return result
