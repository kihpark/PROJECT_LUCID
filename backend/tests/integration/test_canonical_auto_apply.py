"""M3-2a — canonical auto-apply integration tests.

★ Conservative LLM gate (yes-only apply) covered by 4 cases:

    1. No proposals  -> skipped sentinel
    2. yes verdict   -> apply_merge(dry_run=False) called once, applied=1
    3. no + uncertain -> apply_merge NEVER called with dry_run=False
    4. discover raises -> {error, stage: "discover"}

ES, Claude, and the canonical ops are all mocked. No network / no ES.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from api.models.canonical import MergeProposal
from api.services.canonical_auto_apply import auto_apply_after_capture


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _proposal(target: str, other: str, primary: str = "Acme") -> MergeProposal:
    return MergeProposal(
        target_canonical_uid=target,
        members=[target, other],
        primary_label=primary,
        aliases=[],
        entity_type="organization",
        confidence="deterministic",
        fact_provenance={},
        reason=f"shared normalized surface for {primary}",
    )


def _fake_es_with_docs(uids: list[str]) -> MagicMock:
    """Return an ES client mock whose .get returns a minimal source for each uid."""
    client = MagicMock()

    def _get(*, index: str, id: str) -> dict[str, Any]:
        return {"_source": {"primary_label": id, "entity_type": "organization"}}

    client.get.side_effect = _get
    return client


# ---------------------------------------------------------------------------
# 1. No proposals -> skipped
# ---------------------------------------------------------------------------

def test_no_proposals_returns_skipped(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_client = MagicMock()

    with patch(
        "api.services.canonical_auto_apply.get_client",
        return_value=fake_client,
    ), patch(
        "api.services.canonical_auto_apply.discover_merge_proposals",
        return_value=[],
    ), patch(
        "api.services.canonical_auto_apply.apply_merge",
    ) as mock_apply, patch(
        "api.services.canonical_auto_apply.llm_canonical_match",
        new_callable=AsyncMock,
    ) as mock_gate:
        result = asyncio.run(auto_apply_after_capture("ks-test"))

    assert result == {
        "applied": 0,
        "blocked": 0,
        "uncertain": 0,
        "skipped": "no_proposals",
    }
    mock_apply.assert_not_called()
    mock_gate.assert_not_called()


# ---------------------------------------------------------------------------
# 2. yes verdict -> apply
# ---------------------------------------------------------------------------

def test_yes_verdict_applies_merge(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    p = _proposal("u-a", "u-b", "Acme")
    fake_client = _fake_es_with_docs(["u-a", "u-b"])

    with patch(
        "api.services.canonical_auto_apply.get_client",
        return_value=fake_client,
    ), patch(
        "api.services.canonical_auto_apply.discover_merge_proposals",
        return_value=[p],
    ), patch(
        "api.services.canonical_auto_apply.apply_merge",
    ) as mock_apply, patch(
        "api.services.canonical_auto_apply.llm_canonical_match",
        new_callable=AsyncMock,
        return_value=("yes", "obviously the same entity"),
    ):
        result = asyncio.run(auto_apply_after_capture("ks-test"))

    assert result == {"applied": 1, "blocked": 0, "uncertain": 0, "errors": 0}
    mock_apply.assert_called_once()
    # Apply must be called with dry_run=False (real apply)
    _, kwargs = mock_apply.call_args
    assert kwargs.get("dry_run") is False


# ---------------------------------------------------------------------------
# 3. no + uncertain -> NO apply
# ---------------------------------------------------------------------------

def test_no_and_uncertain_skip_apply(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    p1 = _proposal("u-a", "u-b", "Acme")
    p2 = _proposal("u-c", "u-d", "Beta")
    fake_client = _fake_es_with_docs(["u-a", "u-b", "u-c", "u-d"])

    # First proposal -> "no", second -> "uncertain"
    gate = AsyncMock(side_effect=[
        ("no", "different entities"),
        ("uncertain", "ambiguous evidence"),
    ])

    with patch(
        "api.services.canonical_auto_apply.get_client",
        return_value=fake_client,
    ), patch(
        "api.services.canonical_auto_apply.discover_merge_proposals",
        return_value=[p1, p2],
    ), patch(
        "api.services.canonical_auto_apply.apply_merge",
    ) as mock_apply, patch(
        "api.services.canonical_auto_apply.llm_canonical_match",
        gate,
    ):
        result = asyncio.run(auto_apply_after_capture("ks-test"))

    assert result == {"applied": 0, "blocked": 1, "uncertain": 1, "errors": 0}
    # Cost guard: apply_merge must NEVER be invoked with dry_run=False
    for call in mock_apply.call_args_list:
        _, kwargs = call
        assert kwargs.get("dry_run") is not False, (
            "apply_merge was called with dry_run=False despite non-yes verdicts"
        )
    mock_apply.assert_not_called()


# ---------------------------------------------------------------------------
# 4. discover raises -> error / stage
# ---------------------------------------------------------------------------

def test_discover_exception_returns_error_stage(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_client = MagicMock()

    with patch(
        "api.services.canonical_auto_apply.get_client",
        return_value=fake_client,
    ), patch(
        "api.services.canonical_auto_apply.discover_merge_proposals",
        side_effect=RuntimeError("ES is down"),
    ), patch(
        "api.services.canonical_auto_apply.apply_merge",
    ) as mock_apply, patch(
        "api.services.canonical_auto_apply.llm_canonical_match",
        new_callable=AsyncMock,
    ) as mock_gate:
        result = asyncio.run(auto_apply_after_capture("ks-test"))

    assert result == {"error": "ES is down", "stage": "discover"}
    mock_apply.assert_not_called()
    mock_gate.assert_not_called()
