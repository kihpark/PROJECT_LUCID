"""HITL validation routes - /api/spaces/{sid}/validate/*.

Scaffold stub (TASK-001). Queue and decide endpoints land in a later task.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/spaces/{sid}/validate", tags=["validate"])
