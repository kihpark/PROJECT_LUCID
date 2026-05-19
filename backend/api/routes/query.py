"""Validated-facts-only query route - /api/spaces/{sid}/query.

Scaffold stub (TASK-001). The query engine lands in a later task. Answers must
use only validated FactNodes, never LLM general knowledge (AGENTS.md rule 1).
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/spaces/{sid}", tags=["query"])
