"""Smoke test for the API scaffold - TASK-001 exit criterion.

Runs without Neo4j: the health probe degrades to neo4j="disconnected" when no
server is reachable, and this test accepts either state.
"""
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health_endpoint_returns_ok_status():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["neo4j"] in {"connected", "disconnected"}
    assert body["version"]


def test_all_routers_are_mounted():
    """Every router from AGENTS.md section 6 is included on the app."""
    paths = {route.path for route in app.routes}
    assert "/api/health" in paths
    # Routers are mounted; their concrete endpoints land in later tasks.
    prefixes = {getattr(route, "path", "") for route in app.routes}
    assert any(p.startswith("/api/") for p in prefixes)
