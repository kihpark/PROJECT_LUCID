"""Lucid Structure stage (Sprint 3) — Claude decomposition of merged_text."""
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
from api.structure.object_matcher import MatchResult, match_or_create_object
from api.structure.processor import process_extracted_job

__all__ = [
    "FailureReason",
    "LinkCreationResult",
    "MatchResult",
    "StructureDisambiguation",
    "StructureFact",
    "StructureFactFactLink",
    "StructureFactObjectLink",
    "StructureObject",
    "StructureResult",
    "create_links",
    "decompose",
    "decompose_via_claude",
    "match_or_create_object",
    "process_extracted_job",
]
