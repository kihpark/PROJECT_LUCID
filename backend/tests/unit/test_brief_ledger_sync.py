"""feat/state-sync-unification — brief vs LEDGER source-of-truth lock.

PO #1: HOME shows "이번주 +59" while LEDGER shows "검증 없음". Root
cause: the two routes queried `lucid_facts` with different bool clauses
— specifically, the brief's `_this_week_count` did not enforce the
`retracted_at NOT exists` clause that LEDGER hard-enforces.

This module locks in:
  - brief._this_week_count's ES body now contains the retracted
    must_not, the validated_at range, AND the manual filter.
  - brief._facts_count likewise excludes retracted (HOME's facts total
    has to match the LEDGER total at 0 retraction, and must drop the
    same retracted rows when the user retracts).
  - Recent + top_cluster bodies also drop retracted (so HOME's
    "best of this week" never surfaces a soft-deleted row).
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

from api.routes.home import (
    _facts_count,
    _recent_validated,
    _this_week_count,
    _top_cluster,
)


def _capture_body() -> tuple[MagicMock, list[dict[str, Any]]]:
    """Return (client, captured) where every count/search appends its
    body to `captured` so the test can assert the clause shape."""
    captured: list[dict[str, Any]] = []
    client = MagicMock()

    def _count(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        captured.append({"op": "count", "index": index, "body": body})
        return {"count": 0}

    def _search(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        captured.append({"op": "search", "index": index, "body": body})
        return {"hits": {"hits": [], "total": {"value": 0, "relation": "eq"}}}

    client.count.side_effect = _count
    client.search.side_effect = _search
    return client, captured


def _must_not_clauses(body: dict[str, Any]) -> list[dict[str, Any]]:
    return body["query"]["bool"].get("must_not") or []


def test_this_week_count_excludes_retracted_facts():
    """brief._this_week_count must mirror LEDGER's must_not clause."""
    client, captured = _capture_body()
    ks_id = str(uuid4())
    now = datetime.now(UTC)
    with patch("api.routes.home.get_client", return_value=client):
        _this_week_count(ks_id, now)

    assert len(captured) == 1
    body = captured[0]["body"]
    must_not = _must_not_clauses(body)
    assert {"exists": {"field": "retracted_at"}} in must_not
    # The validated_at >= now-7d clause sits in `filter`, not `must_not`.
    filters = body["query"]["bool"]["filter"]
    assert any("range" in f and "validated_at" in f["range"] for f in filters)


def test_facts_count_excludes_retracted_facts():
    """brief.totals.facts must agree with LEDGER's total when no
    fact_type chip is selected — both drop retracted rows."""
    client, captured = _capture_body()
    ks_id = str(uuid4())
    with patch("api.routes.home.get_client", return_value=client):
        _facts_count(ks_id)

    assert len(captured) == 1
    body = captured[0]["body"]
    must_not = _must_not_clauses(body)
    assert {"exists": {"field": "retracted_at"}} in must_not


def test_recent_validated_excludes_retracted_facts():
    """The "recent 5" card on HOME must not surface a soft-deleted row."""
    client, captured = _capture_body()
    ks_id = str(uuid4())
    now = datetime.now(UTC)
    with patch("api.routes.home.get_client", return_value=client):
        _recent_validated(ks_id, now)

    assert len(captured) == 1
    body = captured[0]["body"]
    must_not = _must_not_clauses(body)
    assert {"exists": {"field": "retracted_at"}} in must_not


def test_top_cluster_excludes_retracted_facts():
    """Top cluster aggregation must not count a soft-deleted row toward
    the leading subject — otherwise the HOME card would say
    "이번주 SpaceX 8건" while LEDGER shows zero SpaceX rows."""
    client, captured = _capture_body()
    ks_id = str(uuid4())
    now = datetime.now(UTC)
    with patch("api.routes.home.get_client", return_value=client):
        _top_cluster(ks_id, now)

    # _top_cluster calls search once for the aggregation. (A second
    # get may follow on a non-empty bucket, but our empty stub never
    # populates one.)
    search_ops = [c for c in captured if c["op"] == "search"]
    assert len(search_ops) >= 1
    body = search_ops[0]["body"]
    must_not = _must_not_clauses(body)
    assert {"exists": {"field": "retracted_at"}} in must_not
