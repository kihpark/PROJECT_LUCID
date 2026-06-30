"""Lucid Structure stage (Sprint 3) — Claude decomposition of merged_text.

REQ-004 STAGE 1c — public surface trimmed:
  - ★ `MatchResult` / `match_or_create_object` (object_matcher) 재노출 제거.
    callers 는 resolution_gateway.resolve() 단일 경로를 사용한다.
  - object_matcher.py 는 의도적으로 ★ 미삭제 (★ 1c PO directive — 5
    resolver 자체는 DELETE 만 OK / 코드 수정 X). 미사용 모듈로 남는다.
"""
from api.structure.claude_client import decompose_via_claude
from api.structure.decomposer import decompose
from api.structure.link_creator import LinkCreationResult, create_links
from api.structure.models import (
    FailureReason,
    StructureDisambiguation,
    StructureFact,
    StructureFactFactLink,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)
from api.structure.processor import process_extracted_job
from api.structure.resolution_gateway import ENTITY_TYPE_V3, ResolvedEntity, resolve

__all__ = [
    "ENTITY_TYPE_V3",
    "FailureReason",
    "LinkCreationResult",
    "ResolvedEntity",
    "StructureDisambiguation",
    "StructureFact",
    "StructureFactFactLink",
    "StructureFactObjectLink",
    "StructureObject",
    "StructureResult",
    "create_links",
    "decompose",
    "decompose_via_claude",
    "process_extracted_job",
    "resolve",
]
