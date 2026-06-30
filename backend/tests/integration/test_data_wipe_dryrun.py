"""Integration tests for ``api.ops.wipe_data`` — discovery + dry-run only.

★ PO 의뢰서 verbatim: this PR ships discovery + dry-run + a structural
``apply()`` that is gated by ``NotImplementedError``. These tests lock:

  1. ``dry_run()`` returns counts for every preserve / delete target
     (no mutations).
  2. The preserve / delete classifications match the PO 의뢰서 verbatim.
  3. ``apply()`` raises ``NotImplementedError`` — the PO gate is in
     place.
  4. ``dry_run()`` does NOT touch ES mappings — only ``c.count`` is
     called, and the index mappings before/after are byte-identical.

The tests use the standard integration fixtures (``pg_session``,
``es_indexes``, ``alembic_upgrade``) so they run against ``lucid_test``
and ``test_lucid_*`` indexes, never dev.
"""
from __future__ import annotations

import pytest

from api.ops import wipe_data
from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# 1. Classification lock — preserve vs delete (★ PO 의뢰서 verbatim)
# ---------------------------------------------------------------------------

def test_preserve_vs_delete_classification_matches_po_brief():
    """The two lists in wipe_data.py are the verbatim PO scope.

    If a future refactor accidentally moves a preserve table into the
    delete list (e.g. ``users``), this test screams. The lists are the
    only thing standing between the apply PR and a real-account wipe.
    """
    # ★ 보존 대상 (절대 X) — PO 의뢰서 verbatim.
    expected_preserve = {
        "users",
        "sessions",
        "knowledge_spaces",
        "user_settings",
        "source_policies",
        "predicates",
        "tags",
        "alembic_version",
        "archetype_surveys",
        "graph_notes",
    }
    # ★ 삭제 대상 — PO 의뢰서 verbatim.
    expected_delete_pg = {
        "source_jobs",
        "validation_logs",
        "disambiguation_logs",
        "precision_logs",
        "negation_logs",
        "contradiction_logs",
        "structure_metrics_logs",
        "understanding_depth_logs",
        "fact_relations",
    }
    expected_delete_es = {LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES}

    assert set(wipe_data.PG_PRESERVE_TABLES) == expected_preserve
    assert set(wipe_data.PG_DELETE_TABLES) == expected_delete_pg
    assert set(wipe_data.ES_DELETE_INDEXES) == expected_delete_es
    # No overlap — every preserve table must be NOT in the delete list.
    assert (
        set(wipe_data.PG_PRESERVE_TABLES) & set(wipe_data.PG_DELETE_TABLES)
        == set()
    )


# ---------------------------------------------------------------------------
# 2. dry_run() shape — counts only, no mutation
# ---------------------------------------------------------------------------

def test_dry_run_returns_counts_and_does_not_mutate(
    pg_session, alembic_upgrade, es_indexes,
):
    """dry_run() returns ints for every target table / index it owns.

    pg_session opens a savepoint and rolls back on teardown, so any
    accidental mutation by ``dry_run`` would have to be visible WITHIN
    the call — which we lock by snapshotting the ES doc counts on both
    sides of the call.
    """
    from api.storage.elasticsearch.client import get_client
    c = get_client()

    before_es = {
        idx: c.count(index=idx)["count"]
        for idx in wipe_data.ES_DELETE_INDEXES
    }

    result = wipe_data.dry_run()

    # Shape: three sub-dicts, exhaustive on the two lists.
    assert set(result.keys()) == {"preserve_pg", "delete_pg", "delete_es"}
    assert set(result["preserve_pg"].keys()) == set(wipe_data.PG_PRESERVE_TABLES)
    assert set(result["delete_pg"].keys()) == set(wipe_data.PG_DELETE_TABLES)
    assert set(result["delete_es"].keys()) == set(wipe_data.ES_DELETE_INDEXES)

    # ES counts unchanged (★ 0 mutation).
    after_es = {
        idx: c.count(index=idx)["count"]
        for idx in wipe_data.ES_DELETE_INDEXES
    }
    assert before_es == after_es

    # Values are ints (count) or the soft-fail sentinel.
    for table, val in result["preserve_pg"].items():
        assert isinstance(val, int) or val == "TABLE NOT FOUND", (
            f"preserve_pg[{table}] = {val!r}"
        )
    for table, val in result["delete_pg"].items():
        assert isinstance(val, int) or val == "TABLE NOT FOUND", (
            f"delete_pg[{table}] = {val!r}"
        )
    for idx, val in result["delete_es"].items():
        assert isinstance(val, int), f"delete_es[{idx}] = {val!r}"


# ---------------------------------------------------------------------------
# 3. ★ PO 가드 — apply() raises NotImplementedError
# ---------------------------------------------------------------------------

def test_apply_is_gated_on_po_command():
    """apply() must raise NotImplementedError without force_po_approval=True.

    REQ-004 STAGE 1c-vii (★ PO 2026-06-30): the previous "wipe 실행"
    unblock PR (8d68825, 2026-06-28) removed this guard prematurely.
    PO directive verbatim: "wipe NotImplementedError 가드 ★ 왜 풀렸는지
    확인 + PO 승인 게이트 재설치." The new shape requires the caller to
    pass ``force_po_approval=True`` explicitly — automated scripts /
    tests that don't pass the flag continue to hit the raise.
    """
    with pytest.raises(NotImplementedError) as excinfo:
        wipe_data.apply()
    # The error message must mention the PO gate so a reader of the
    # traceback knows why the call refused.
    msg = str(excinfo.value)
    assert "PO" in msg
    assert "separate PR" in msg or "별도" in msg or "PO approval" in msg


# ---------------------------------------------------------------------------
# 4. ES mapping preservation lock — dry_run never touches mappings
# ---------------------------------------------------------------------------

def test_dry_run_preserves_es_mappings(es_indexes):
    """The dry-run code path must read counts only — never write to or
    delete from any ES mapping.

    We snapshot the mapping JSON before and after the call. If the
    discovery code ever evolves to call ``indices.delete`` /
    ``indices.put_mapping`` by mistake, this test fails.
    """
    from api.storage.elasticsearch.client import get_client
    c = get_client()

    before_mappings = {
        idx: c.indices.get_mapping(index=idx).raw
        for idx in wipe_data.ES_DELETE_INDEXES
    }

    wipe_data.dry_run()

    after_mappings = {
        idx: c.indices.get_mapping(index=idx).raw
        for idx in wipe_data.ES_DELETE_INDEXES
    }
    assert before_mappings == after_mappings, (
        "dry_run() must NOT modify ES mappings — PO 의뢰서 verbatim: "
        "'문서만 비움 (delete_by_query match_all), 인덱스 mapping 절대 X'."
    )
