"""Lucid API — FastAPI application entry point.

Validation infrastructure for the post-AI internet.
Scaffold (TASK-001). Route logic lands in later tasks; see AGENTS.md.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import (
    capture,
    graph,
    query,
    spaces,
    surface,
    validate,
    validation_api,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lucid")

API_VERSION = "0.3.0"

app = FastAPI(title="Lucid API", version=API_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _neo4j_status() -> str:
    """Best-effort Neo4j connectivity probe. Never raises."""
    try:
        from neo4j import GraphDatabase

        uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
        user = os.getenv("NEO4J_USER", "neo4j")
        password = os.getenv("NEO4J_PASSWORD", "")
        driver = GraphDatabase.driver(
            uri, auth=(user, password), connection_timeout=3
        )
        try:
            driver.verify_connectivity()
            return "connected"
        finally:
            driver.close()
    except Exception as exc:  # noqa: BLE001 - health probe must never raise
        logger.warning("Neo4j health probe failed: %s", exc)
        return "disconnected"


@app.get("/api/health")
async def health() -> dict:
    """Liveness plus Neo4j connectivity. TASK-001 exit criterion."""
    return {"status": "ok", "neo4j": _neo4j_status(), "version": API_VERSION}


# Routers - namespaced under /api/spaces/{sid}/ per AGENTS.md section 6.
for _router in (
    spaces.router,
    capture.router,
    validate.router,
    graph.router,
    surface.router,
    query.router,
    validation_api.router,
):
    app.include_router(_router)
