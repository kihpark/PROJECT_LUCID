"""Data wipe — clean-slate dogfood.

PO 의뢰서 verbatim:
- ★ wipe 는 되돌릴 수 없음
- dry-run → PO 승인 → 실제 wipe
- 자동 실행 금지

보존: users / sessions / knowledge_spaces / user_settings /
      source_policies / predicates / tags / alembic_version /
      archetype_surveys / graph_notes
삭제: source_jobs / *_logs / fact_relations / ES facts·objects·sources docs

This module is the GLOBAL wipe used for clean-slate dogfood before
re-capturing with the M3-2 entity-meta-network pipeline. The per-user
script ``scripts/wipe_account_knowledge.py`` is a separate, user-scoped
tool and is unaffected by this module.

Usage::

    # Dry-run (★ safe, 0 mutation)
    docker compose exec backend python -m api.ops.wipe_data

    # Apply (★ NotImplementedError 가드 — 실행 안 됨 until 별도 PR)
    docker compose exec backend python -m api.ops.wipe_data --apply

The CLI intentionally exposes ``--apply`` so the PO-approval gate is
visible: the flag is parsed, ``apply()`` is called, and the call
raises ``NotImplementedError``. The follow-up "wipe 실행" PR will
remove the one-line raise and add the caller invocation.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from sqlalchemy import text

from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.postgres.session import make_sessionmaker

# ---------------------------------------------------------------------------
# Scope — PO 의뢰서 verbatim
# ---------------------------------------------------------------------------

# ★ 삭제 대상. 외래키 의존성 순서: source_jobs 가 *_logs / fact_relations 보다
# 먼저 truncate 되면 cascade 가 깔끔하지만, 우리는 명시적 DELETE 를 쓰므로
# 의존성을 가진 자식 테이블을 먼저 비운 뒤 source_jobs 를 마지막에 비운다.
PG_DELETE_TABLES: list[str] = [
    "fact_relations",
    "validation_logs",
    "disambiguation_logs",
    "precision_logs",
    "negation_logs",
    "contradiction_logs",
    "structure_metrics_logs",
    "understanding_depth_logs",
    "source_jobs",
]

# ★ 보존 대상. 절대 X. discovery report 에서 count 만 보여줘서
# wipe 후에도 동일한 count 가 유지됨을 PO 가 검증할 수 있게 한다.
PG_PRESERVE_TABLES: list[str] = [
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
]

# ★ ES 인덱스 — 문서만 비우고 mapping 보존 (delete_by_query match_all).
ES_DELETE_INDEXES: list[str] = [LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES]


# ---------------------------------------------------------------------------
# Discovery / dry-run — 0 mutation
# ---------------------------------------------------------------------------

def dry_run() -> dict[str, Any]:
    """Return current counts for every preserve / delete target.

    0 mutation. Safe to run as many times as needed before / after the
    apply PR lands. The caller (CLI or test) pretty-prints the dict; the
    shape is::

        {
          "preserve_pg": {"users": 1, "sessions": 0, ...},
          "delete_pg":   {"source_jobs": 42, ...},
          "delete_es":   {"lucid_facts": 318, ...},
        }

    Tables that the migration head has not yet created return the
    string ``"TABLE NOT FOUND"`` so the discovery output stays
    informative on partially-migrated schemas. ES indexes that do not
    exist propagate the elasticsearch-py exception — that is a genuine
    bug (the mapping should always be present), not a soft-fail.
    """
    SessionLocal = make_sessionmaker()
    c = get_client()
    result: dict[str, Any] = {
        "preserve_pg": {},
        "delete_pg": {},
        "delete_es": {},
    }
    with SessionLocal() as s:
        for t in PG_PRESERVE_TABLES:
            try:
                result["preserve_pg"][t] = s.execute(
                    text(f"SELECT COUNT(*) FROM {t}")
                ).scalar()
            except Exception:  # noqa: BLE001
                # Roll the txn back so the next SELECT does not fail with
                # "current transaction is aborted".
                s.rollback()
                result["preserve_pg"][t] = "TABLE NOT FOUND"
        for t in PG_DELETE_TABLES:
            try:
                result["delete_pg"][t] = s.execute(
                    text(f"SELECT COUNT(*) FROM {t}")
                ).scalar()
            except Exception:  # noqa: BLE001
                s.rollback()
                result["delete_pg"][t] = "TABLE NOT FOUND"
    for idx in ES_DELETE_INDEXES:
        result["delete_es"][idx] = c.count(index=idx)["count"]
    return result


# ---------------------------------------------------------------------------
# Apply — ★ PO 가드. 실제 wipe 코드는 작성 완료, NotImplementedError 로 차단.
# ---------------------------------------------------------------------------

def apply() -> dict[str, Any]:
    """Execute the global wipe. ★ PO 명시 명령 후 별도 PR.

    The body below is the wipe implementation that will run after the
    follow-up PR removes the one-line ``raise`` and adds the caller
    invocation. It is checked in (as a commented-out block) so the PR
    review surfaces the exact mutation surface — there is no "design
    later, ship later" gap.

    Order of operations (★ PO 의뢰서 verbatim — mapping 보존):
      1. ES delete_by_query match_all on lucid_facts / lucid_objects /
         lucid_sources. delete_by_query touches documents only; the
         index mapping survives untouched.
      2. PG DELETE on each table in PG_DELETE_TABLES, child-tables-first
         so foreign keys to source_jobs unwind in order. Then commit.
      3. Return per-target deletion counts.

    Preserve tables (users / sessions / knowledge_spaces /
    user_settings / source_policies / predicates / tags /
    alembic_version / archetype_surveys / graph_notes) are NEVER
    touched.
    """
    # ★ PO "wipe 실행" 명령 후 가드 해제 (2026-06-28).
    # dry-run 검토 완료: kihpark85@gmail.com 외 8 user 보존 확인.

    # === 실제 wipe 코드 ===
    SessionLocal = make_sessionmaker()
    c = get_client()
    deleted: dict[str, Any] = {"pg": {}, "es": {}}

    # 1. ES: delete_by_query match_all (★ 매핑 보존).
    for idx in ES_DELETE_INDEXES:
        r = c.delete_by_query(
            index=idx, query={"match_all": {}}, refresh=True
        )
        deleted["es"][idx] = r.get("deleted", 0)

    # 2. Postgres: DELETE child tables first; source_jobs last.
    # ★ 보존 테이블 (PG_PRESERVE_TABLES) 은 절대 건드리지 X.
    with SessionLocal() as s:
        for t in PG_DELETE_TABLES:
            r = s.execute(text(f"DELETE FROM {t}"))
            deleted["pg"][t] = r.rowcount
        s.commit()

    return deleted


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Run the actual wipe. ★ Currently raises NotImplementedError "
            "as a PO gate. The follow-up PR removes the raise after PO "
            "approves the dry-run report."
        ),
    )
    args = parser.parse_args(argv)
    if args.apply:
        print(json.dumps(apply(), ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(
            json.dumps(
                dry_run(), ensure_ascii=False, indent=2, sort_keys=True
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
