"""Lucid API - FastAPI application entry point.

Validation infrastructure for the post-AI internet.
Sprint 1A PR-1A-1: v2 stack (Postgres + Elasticsearch) replaces Neo4j + FAISS.
Route logic lands in later sprints; see AGENTS.md.
"""
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware

from api.routes import (
    admin_applications,
    applications,
    auth,
    capture,
    graph,
    home,
    jobs,
    query,
    recall,
    spaces,
    surface,
    users,
    validate,
    validation_api,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lucid")

API_VERSION = "0.4.0"

@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """B-39 fix 2: ensure the three ES indexes exist on app boot.

    `create_indexes()` is idempotent — it returns "exists" on indexes
    that are already present, so a normal boot is a no-op. When the
    indexes have been wiped (e.g. an integration test session leaked
    `delete_indexes()` against dev ES; B-38 prefix-isolation prevents
    that going forward, but a hand-wiped ES still needs the structure
    back) the hook recreates lucid_facts / lucid_objects /
    lucid_sources with the correct mappings — dense_vector(dims=1536)
    on `embedding`, keyword on knowledge_space_id / validation_method,
    nori-analyser on the Korean text fields.

    If ES is unreachable at boot we log a warning and continue —
    routes that don't need ES (auth, capture, jobs) still work, and
    a subsequent ES restart picks up the indexes via the same path
    on the next boot.
    """
    try:
        from api.storage.elasticsearch import indexes
        from api.storage.elasticsearch.client import reset_client

        reset_client()
        result = indexes.ensure_negation_fields()
        # ensure_negation_fields handles the lucid_facts case
        # specifically; create_indexes covers all three.
        creation = indexes.create_indexes()
        logger.info(
            "B-39 startup: ES indexes %s (negation tip-up: %s)",
            creation,
            result,
        )
    except Exception as exc:  # noqa: BLE001 - boot must never crash here
        logger.warning(
            "B-39 startup: could not ensure ES indexes (%s). Routes that "
            "depend on ES will return empty envelopes until the cluster "
            "is reachable.",
            exc,
        )
    yield


app = FastAPI(title="Lucid API", version=API_VERSION, lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _postgres_status() -> str:
    """Best-effort Postgres connectivity probe. Never raises."""
    url = os.getenv("DATABASE_URL", "postgresql://lucid:lucid@localhost:5432/lucid")
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return "connected"
        finally:
            engine.dispose()
    except Exception as exc:  # noqa: BLE001 - health probe must never raise
        logger.warning("Postgres health probe failed: %s", exc)
        return "disconnected"


def _elasticsearch_status() -> str:
    """Best-effort Elasticsearch connectivity probe. Never raises."""
    url = os.getenv("ELASTICSEARCH_URL", "http://localhost:9200")
    try:
        from elasticsearch import Elasticsearch

        client = Elasticsearch(url, request_timeout=3, verify_certs=False)
        try:
            if client.ping():
                return "connected"
            return "disconnected"
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001 - health probe must never raise
        logger.warning("Elasticsearch health probe failed: %s", exc)
        return "disconnected"


@app.get("/api/health")
async def health(response: Response) -> dict:
    """Liveness plus Postgres and Elasticsearch connectivity.

    Returns 200 when both backends are connected, 503 when either is not.
    The body shape stays uniform either way so clients can branch on the
    individual `postgres` / `elasticsearch` fields.
    """
    postgres = _postgres_status()
    elasticsearch = _elasticsearch_status()
    if postgres != "connected" or elasticsearch != "connected":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "status": "ok" if postgres == "connected" and elasticsearch == "connected" else "degraded",
        "postgres": postgres,
        "elasticsearch": elasticsearch,
        "version": API_VERSION,
    }


# Routers - namespaced under /api/spaces/{sid}/ per AGENTS.md section 6.
for _router in (
    auth.router,
    users.router,
    spaces.router,
    capture.router,
    jobs.router,
    validate.router,
    graph.router,
    surface.router,
    query.router,
    recall.router,
    home.router,
    validation_api.router,
    applications.router,
    admin_applications.router,
):
    app.include_router(_router)
