"""Capture routes - /api/spaces/{sid}/capture/*.

Scaffold stub (TASK-001). The capture pipeline lands in a later task.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/spaces/{sid}/capture", tags=["capture"])
