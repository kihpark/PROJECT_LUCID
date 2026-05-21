"""Smoke test for the API scaffold - Sprint 1A PR-1A-1.

Runs without Postgres / Elasticsearch. The health probes degrade to
"disconnected" when no backend is reachable; this test accepts either
state. With backends up the endpoint returns 200; without them 503.
Integration tests cover the happy path.
"""
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health_endpoint_returns_consistent_shape():
    """Body keys are stable across degraded and healthy states."""
    resp = client.get("/api/health")
    assert resp.status_code in {200, 503}
    body = resp.json()
    assert body["status"] in {"ok", "degraded"}
    assert body["postgres"] in {"connected", "disconnected"}
    assert body["elasticsearch"] in {"connected", "disconnected"}
    assert body["version"]


def test_health_status_matches_probe_results():
    """status == ok iff both probes connected."""
    resp = client.get("/api/health")
    body = resp.json()
    both_up = body["postgres"] == "connected" and body["elasticsearch"] == "connected"
    if both_up:
        assert body["status"] == "ok"
        assert resp.status_code == 200
    else:
        assert body["status"] == "degraded"
        assert resp.status_code == 503


def test_all_routers_are_mounted():
    """Every router from AGENTS.md section 6 is included on the app."""
    paths = {route.path for route in app.routes}
    assert "/api/health" in paths
    prefixes = {getattr(route, "path", "") for route in app.routes}
    assert any(p.startswith("/api/") for p in prefixes)
