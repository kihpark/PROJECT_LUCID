"""B-62-debug measurement fixture (PO 2026-06-22).

The third attempt at Korean primary preservation (B-62-fix-v2 +
resolver wiring) shipped to main but fresh captures STILL show
"Ministry of Commerce of China" / "Ministry of Finance of China" /
"export control" landing as the canonical primary_label instead of
their Korean source-language form. PO directive: "no more
speculative patches — measure first, then surgical fix."

This module exercises the production `_match_object` path against a
hand-crafted `StructureResult` that simulates the three live
failure scenarios, captures the four instrumentation points emitted
by the B-62-debug breadcrumbs (commit `instrument(spo): B-62-debug
…`), and asserts on the ES doc body that the resolver eventually
persisted.

Scenarios:

  A — LLM omits subject_surface entirely. The object's `name` is
      English ("Ministry of Commerce of China"). The processor's
      `_match_object` falls back to obj.name as the surface, runs
      _detect_lang on it (returns "en"), and the entire Korean
      defense chain in entity_resolver never engages. Persisted
      primary is English. **Mode A.**

  B — LLM emits English in subject_surface. The processor passes the
      English string straight through; same outcome as A.
      **Also Mode A (the matcher input is English regardless).**

  C — LLM correctly emits Korean subject_surface. Defense chain
      engages, primary stays Korean. Baseline showing the v2 fixes
      DO work when given the right input.

  Control — RedCat Holdings (English brand on an English claim).
      Stays English, no regression.

The measurements are saved to caplog text so a downstream operator
can read the actual breadcrumb output. The asserts on body fields
prove what the resolver wrote to ES.

DOES NOT touch decompose_via_claude / Anthropic — pure mocks.
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest

from api.models.objects import ObjectClass
from api.structure.models import (
    StructureFact,
    StructureObject,
    StructureResult,
)
from api.structure.processor import _build_surface_map, _match_object

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Scenario builders
# ---------------------------------------------------------------------------


def _build_decomp_scenario_a() -> StructureResult:
    """Scenario A: LLM omits subject_surface for a Korean-origin org.

    The object's `name` is English (the LLM translated 중국 상무부 →
    "Ministry of Commerce of China"). subject_surface is None because
    the LLM ignored the prompt directive to put the source-language
    span there.
    """
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="Ministry of Commerce of China",
                name_en="Ministry of Commerce of China",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="중국 상무부는 새로운 수출통제 조치를 발표했다.",
                subject_uid="obj-1",
                subject_surface=None,
                predicate="announces",
                object_value="새로운 수출통제 조치",
            ),
        ],
        extraction_status="success",
    )


def _build_decomp_scenario_b() -> StructureResult:
    """Scenario B: LLM emits English in subject_surface.

    The LLM honoured the schema field but populated it with the
    English translation rather than the Korean span. Result is the
    same as Scenario A: matcher receives an English surface.
    """
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="Ministry of Finance of China",
                name_en="Ministry of Finance of China",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="중국 재정부는 새 정책을 발표했다.",
                subject_uid="obj-1",
                subject_surface="Ministry of Finance of China",
                predicate="announces",
                object_value="새 정책",
            ),
        ],
        extraction_status="success",
    )


def _build_decomp_scenario_c() -> StructureResult:
    """Scenario C (baseline): LLM correctly emits Korean subject_surface."""
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="Ministry of Defense",
                name_en="Ministry of Defense",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="국방부는 새 사업을 발표했다.",
                subject_uid="obj-1",
                subject_surface="국방부",
                predicate="announces",
                object_value="새 사업",
            ),
        ],
        extraction_status="success",
    )


def _build_decomp_control_redcat() -> StructureResult:
    """Control: an English-only RedCat Holdings capture. Must remain
    English primary regardless of the new Korean defense — confirms
    the dictionary lookup is opt-in for known org names only."""
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="RedCat Holdings",
                name_en="RedCat Holdings",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="RedCat Holdings announced a new drone line.",
                subject_uid="obj-1",
                subject_surface="RedCat Holdings",
                predicate="announces",
                object_value="a new drone line",
            ),
        ],
        extraction_status="success",
    )


# ---------------------------------------------------------------------------
# Helper: drive the production path and return the indexed body.
# ---------------------------------------------------------------------------


def _run_match_object(decomp: StructureResult, caplog) -> dict:
    """Drive `decompose` + `_match_object` end-to-end against mocks.

    Patches `decompose_via_claude` so the real LLM is never called
    (the caller's `decomp` is returned as-is) and then runs the
    surface-map + matcher path. Returns the body passed into
    `client.index(...)` (the persisted canonical entity doc).

    Wiring `decompose` (not just `_match_object`) means Point 1
    instrumentation fires too — that's the only place the LLM_RAW
    breadcrumbs are emitted.
    """
    from api.structure.decomposer import decompose

    mock_client = MagicMock()
    # All lookups miss so we always reach the create path; that's where
    # the persisted primary is determined.
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with caplog.at_level(logging.DEBUG, logger="lucid.structure"), \
         caplog.at_level(logging.DEBUG, logger="lucid.structure.processor"), \
         caplog.at_level(logging.DEBUG, logger="lucid.structure.decomposer"), \
         caplog.at_level(logging.DEBUG, logger="lucid.structure.entity_resolver"), \
         patch(
             "api.structure.decomposer.decompose_via_claude",
             return_value=decomp,
         ), \
         patch("api.structure.entity_resolver.get_client", return_value=mock_client), \
         patch("api.storage.elasticsearch.embeddings.get_embedding", return_value=None):
        # Drive `decompose` so Point 1 (LLM_RAW) breadcrumbs fire.
        full = decompose("synthetic input", {"knowledge_space_id": "ks-debug"})
        surface_map = _build_surface_map(full)
        result, _resolved_class = _match_object(
            full.objects[0],
            knowledge_space_id="ks-debug",
            surface_map=surface_map,
        )

    assert result is not None
    assert mock_client.index.called, "expected create path to call client.index"
    body = mock_client.index.call_args.kwargs["document"]
    return body


# ---------------------------------------------------------------------------
# Scenario A — LLM omitted subject_surface, English name, Korean claim.
# ---------------------------------------------------------------------------


def test_scenario_a_llm_omitted_subject_surface_mode_a(caplog) -> None:
    """MEASUREMENT — Scenario A: persisted primary is ENGLISH.

    Confirms Mode A: the matcher fell back to obj.name (English)
    because surface_map had no entry for obj-1. The Korean defense
    chain in pick_natural_primary / _maybe_repromote_on_hit never
    engages because the input was already English.
    """
    decomp = _build_decomp_scenario_a()
    body = _run_match_object(decomp, caplog)

    # Point 1 — LLM raw must show subject_surface=None.
    assert any(
        "B-62-debug LLM_RAW" in rec.message and "subject_surface=None" in rec.message
        for rec in caplog.records
    ), "expected LLM_RAW breadcrumb showing subject_surface=None"

    # Point 2 — matcher input fell back to obj.name (English).
    assert any(
        "B-62-debug MATCHER_INPUT" in rec.message
        and "surface='Ministry of Commerce of China'" in rec.message
        and "surface_lang='en'" in rec.message
        and "raw_surface_from_map=None" in rec.message
        for rec in caplog.records
    ), "expected MATCHER_INPUT fallback to English obj.name"

    # Point 3 — resolver took the create_new branch with English primary.
    assert any(
        "B-62-debug RESOLVE branch=create_new" in rec.message
        and "picked_primary='Ministry of Commerce of China'" in rec.message
        and "picked_primary_lang=en" in rec.message
        for rec in caplog.records
    ), "expected RESOLVE create_new with English picked_primary"

    # Point 4 — persisted primary is ENGLISH. This is the bug.
    assert body["primary_label"] == "Ministry of Commerce of China"
    assert body["primary_lang"] == "en"


# ---------------------------------------------------------------------------
# Scenario B — LLM put English in subject_surface.
# ---------------------------------------------------------------------------


def test_scenario_b_llm_english_subject_surface_mode_a(caplog) -> None:
    """MEASUREMENT — Scenario B: LLM filled subject_surface with the
    English translation. Same outcome as A: persisted primary is
    English. This is still Mode A from the matcher's perspective:
    the surface forwarded into resolve_entity is English."""
    decomp = _build_decomp_scenario_b()
    body = _run_match_object(decomp, caplog)

    # Point 2 — matcher input is the LLM-supplied English string.
    assert any(
        "B-62-debug MATCHER_INPUT" in rec.message
        and "surface='Ministry of Finance of China'" in rec.message
        and "surface_lang='en'" in rec.message
        for rec in caplog.records
    ), "expected MATCHER_INPUT surface=English from LLM-supplied subject_surface"

    # Point 4 — persisted primary is ENGLISH.
    assert body["primary_label"] == "Ministry of Finance of China"
    assert body["primary_lang"] == "en"


# ---------------------------------------------------------------------------
# Scenario C — LLM correctly emitted Korean subject_surface.
# ---------------------------------------------------------------------------


def test_scenario_c_llm_korean_subject_surface_baseline(caplog) -> None:
    """BASELINE — Scenario C: defense chain works when input is right.

    The persisted primary is Korean. Confirms the v2 fixes ARE
    correct for the case where the LLM hands us the right input;
    the failure is upstream (the LLM doesn't reliably give us the
    right input)."""
    decomp = _build_decomp_scenario_c()
    body = _run_match_object(decomp, caplog)

    # Point 2 — matcher input is Korean from the LLM-supplied surface.
    assert any(
        "B-62-debug MATCHER_INPUT" in rec.message
        and "surface='국방부'" in rec.message
        and "surface_lang='ko'" in rec.message
        for rec in caplog.records
    ), "expected MATCHER_INPUT Korean surface"

    # Point 4 — persisted primary is Korean. Baseline correct.
    assert body["primary_label"] == "국방부"
    assert body["primary_lang"] == "ko"


# ---------------------------------------------------------------------------
# Control — RedCat Holdings stays English (brand regression guard).
# ---------------------------------------------------------------------------


def test_control_redcat_holdings_stays_english(caplog) -> None:
    """CONTROL — English claim about English brand stays English.

    Confirms the new Korean defense (Step 1 fix below) cannot
    inadvertently korean-ify a real English brand. RedCat Holdings
    is NOT in the dictionary and has an English claim — derivation
    must return None and the original English flow runs unchanged.
    """
    decomp = _build_decomp_control_redcat()
    body = _run_match_object(decomp, caplog)

    assert body["primary_label"] == "RedCat Holdings"
    assert body["primary_lang"] == "en"
