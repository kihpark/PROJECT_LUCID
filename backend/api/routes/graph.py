"""Knowledge graph routes - /api/spaces/{sid}/facts|graph|stats.

Scaffold stub (TASK-001). Graph read endpoints land in a later task.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/spaces/{sid}", tags=["graph"])
