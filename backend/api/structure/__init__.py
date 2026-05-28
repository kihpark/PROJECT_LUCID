"""Lucid Structure stage (Sprint 3) — Claude decomposition of merged_text."""
from api.structure.claude_client import decompose_via_claude
from api.structure.decomposer import decompose
from api.structure.models import (
    FailureReason,
    StructureDisambiguation,
    StructureFact,
    StructureFactFactLink,
    StructureFactObjectLink,
    StructureObject,
    StructureResult,
)

__all__ = [
    "decompose",
    "decompose_via_claude",
    "StructureResult",
    "StructureObject",
    "StructureFact",
    "StructureFactObjectLink",
    "StructureFactFactLink",
    "StructureDisambiguation",
    "FailureReason",
]
