"""PO account data wipe - clean dogfood reset.

Deletes knowledge data scoped to a single user_id (resolved via email).
Schema, OPL seed, the user row itself, is_admin, user_settings,
source_policies, archetype_surveys, and auth sessions are PRESERVED.

Tables wiped (scoped to user's knowledge_space_ids OR user_id):
  - source_jobs (user_id) - captures / extraction jobs
  - structure_metrics_logs, validation_logs (cascade via source_jobs +
    user_id direct)
  - graph_notes (user_id)
  - disambiguation_logs, precision_logs, negation_logs,
    contradiction_logs (user_id)
  - understanding_depth_logs (user_id)
  - fact_relations (by from_fact_uid OR to_fact_uid IN PO's fact_uids,
    collected from ES BEFORE the ES wipe)

ES indices wiped (where knowledge_space_id IN PO's spaces):
  - lucid_facts, lucid_objects, lucid_sources

Preserved:
  - users row, is_admin
  - knowledge_spaces themselves (option a - keep the space shells)
  - user_settings, source_policies, archetype_surveys, sessions
  - predicates, tags (global OPL/taxonomy)
  - lucid_applications (landing intake)
  - other users' data - strictly user-scoped delete

Usage:
  docker compose exec backend python -m scripts.wipe_account_knowledge \
      --email kihpark85@gmail.com
  docker compose exec backend python -m scripts.wipe_account_knowledge \
      --email kihpark85@gmail.com --apply

Idempotent: re-running prints zero counts after a successful wipe.

Knowledge-space deletion choice
-------------------------------
Choice (a): the PO's knowledge_spaces ROWS are KEPT. Only the
contents are wiped. This guarantees every read path that assumes "user
has at least one personal space" still works on the first login after
the wipe, without depending on a lazy-create code path we did not
exhaustively verify.
"""
from __future__ import annotations

import argparse
import logging
import sys
import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from api.storage.elasticsearch.client import (
    LUCID_FACTS,
    LUCID_OBJECTS,
    LUCID_SOURCES,
    get_client,
)
from api.storage.postgres.orm import (
    ContradictionLog,
    DisambiguationLog,
    FactRelation,
    GraphNote,
    KnowledgeSpace,
    NegationLog,
    PrecisionLog,
    SourceJobORM,
    StructureMetricsLog,
    UnderstandingDepthLog,
    User,
    ValidationLog,
)
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.scripts.wipe_account")

_ES_INDICES = (LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES)

_USER_SCOPED_TABLES: tuple[tuple[str, type[Any]], ...] = (
    ("structure_metrics_logs", StructureMetricsLog),
    ("validation_logs", ValidationLog),
    ("source_jobs", SourceJobORM),
    ("graph_notes", GraphNote),
    ("disambiguation_logs", DisambiguationLog),
    ("precision_logs", PrecisionLog),
    ("negation_logs", NegationLog),
    ("contradiction_logs", ContradictionLog),
    ("understanding_depth_logs", UnderstandingDepthLog),
)


def find_user(session: Session, email: str) -> User | None:
    """Look up the user by email. Returns None if missing."""
    return session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()


def find_space_ids(session: Session, user_id: uuid.UUID) -> list[str]:
    """Return the PO's knowledge_space ids as strings (for ES filters)."""
    rows = session.execute(
        select(KnowledgeSpace.id).where(KnowledgeSpace.user_id == user_id)
    ).scalars().all()
    return [str(s) for s in rows]


def find_fact_uids_in_es(client: Any, space_ids: list[str]) -> list[str]:
    """Collect PO's fact_uids from ES BEFORE the ES wipe.

    Assumes the PO's fact count fits in a single 10k window (true
    for single-user dogfood scale). Guards against empty space_ids.
    """
    if not space_ids:
        return []
    res = client.search(
        index=LUCID_FACTS,
        size=10000,
        query={"terms": {"knowledge_space_id": space_ids}},
        _source=False,
    )
    return [hit["_id"] for hit in res["hits"]["hits"]]


def _es_count(client: Any, index: str, space_ids: list[str]) -> int:
    if not space_ids:
        return 0
    return int(
        client.count(
            index=index,
            query={"terms": {"knowledge_space_id": space_ids}},
        )["count"]
    )


def _pg_count_user_scoped(
    session: Session, model: type[Any], user_id: uuid.UUID
) -> int:
    return int(
        session.execute(
            select(func.count()).select_from(model).where(model.user_id == user_id)
        ).scalar_one()
    )


def _pg_count_fact_relations(session: Session, fact_uids: list[str]) -> int:
    if not fact_uids:
        return 0
    return int(
        session.execute(
            select(func.count()).select_from(FactRelation).where(
                or_(
                    FactRelation.from_fact_uid.in_(fact_uids),
                    FactRelation.to_fact_uid.in_(fact_uids),
                )
            )
        ).scalar_one()
    )


def count_targets(
    session: Session,
    client: Any,
    user_id: uuid.UUID,
    space_ids: list[str],
    fact_uids: list[str],
) -> dict[str, int]:
    """Return a labelled count of every wipe target (PG + ES)."""
    counts: dict[str, int] = {}
    for label, model in _USER_SCOPED_TABLES:
        counts[label] = _pg_count_user_scoped(session, model, user_id)
    counts["fact_relations"] = _pg_count_fact_relations(session, fact_uids)
    for index in _ES_INDICES:
        counts[f"es:{index}"] = _es_count(client, index, space_ids)
    return counts


def apply_wipe(
    session: Session,
    client: Any,
    user_id: uuid.UUID,
    space_ids: list[str],
    fact_uids: list[str],
) -> dict[str, int]:
    """Run the destructive wipe. Returns per-target deleted counts."""
    deleted: dict[str, int] = {}

    for index in _ES_INDICES:
        if not space_ids:
            deleted[f"es:{index}"] = 0
            continue
        res = client.delete_by_query(
            index=index,
            query={"terms": {"knowledge_space_id": space_ids}},
            refresh=True,
            conflicts="proceed",
        )
        deleted[f"es:{index}"] = int(res.get("deleted", 0))

    if fact_uids:
        fr_result = session.execute(
            delete(FactRelation).where(
                or_(
                    FactRelation.from_fact_uid.in_(fact_uids),
                    FactRelation.to_fact_uid.in_(fact_uids),
                )
            )
        )
        deleted["fact_relations"] = int(getattr(fr_result, "rowcount", 0) or 0)
    else:
        deleted["fact_relations"] = 0

    for label, model in _USER_SCOPED_TABLES:
        result = session.execute(
            delete(model).where(model.user_id == user_id)
        )
        deleted[label] = int(getattr(result, "rowcount", 0) or 0)

    session.commit()
    return deleted


def _format_table(rows: list[tuple[str, str]], title: str) -> str:
    if not rows:
        return f"{title}: (empty)\n"
    width = max(len(r[0]) for r in rows)
    lines = [f"{title}:"]
    for k, v in rows:
        lines.append(f"  {k.ljust(width)}  {v}")
    return "\n".join(lines) + "\n"


def run(
    email: str,
    apply: bool,
    *,
    session: Session | None = None,
    client: Any = None,
    output: Callable[[str], None] = print,
) -> int:
    """Programmatic entry point. Used by both the CLI and the test suite."""
    owns_session = session is None
    if session is None:
        session = make_sessionmaker()()
    if client is None:
        client = get_client()

    try:
        user = find_user(session, email)
        if user is None:
            output(f"[error] no user found for email={email!r}")
            return 2

        output(
            f"user: id={user.id} email={user.email} is_admin={user.is_admin}"
        )

        space_ids = find_space_ids(session, user.id)
        output(f"knowledge_spaces: count={len(space_ids)} ids={space_ids}")

        fact_uids = find_fact_uids_in_es(client, space_ids)
        output(f"fact_uids in ES: count={len(fact_uids)}")

        pre = count_targets(session, client, user.id, space_ids, fact_uids)
        output(_format_table(
            [(k, str(v)) for k, v in pre.items()],
            "pre-wipe counts",
        ))

        if not apply:
            output("[dry-run] no changes were made. Re-run with --apply to delete.")
            return 0

        deleted = apply_wipe(session, client, user.id, space_ids, fact_uids)
        output(_format_table(
            [(k, str(v)) for k, v in deleted.items()],
            "deleted",
        ))

        post_fact_uids = find_fact_uids_in_es(client, space_ids)
        post = count_targets(session, client, user.id, space_ids, post_fact_uids)
        verify_rows: list[tuple[str, str]] = []
        all_ok = True
        for k, v in post.items():
            ok = v == 0
            verify_rows.append((k, ("OK 0" if ok else f"FAIL {v}")))
            if not ok:
                all_ok = False
        output(_format_table(verify_rows, "post-wipe verification"))

        refreshed = find_user(session, email)
        if refreshed is None:
            output("[error] user row missing after wipe")
            return 1
        if refreshed.is_admin != user.is_admin:
            output(
                f"[error] is_admin changed: was {user.is_admin}, "
                f"now {refreshed.is_admin}"
            )
            return 1
        output(
            f"preserved: user_row=present is_admin={refreshed.is_admin} "
            f"knowledge_spaces={len(find_space_ids(session, refreshed.id))}"
        )

        return 0 if all_ok else 1
    finally:
        if owns_session:
            session.close()


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Wipe a user's knowledge data (dogfood reset).",
    )
    parser.add_argument(
        "--email",
        required=True,
        help="Email of the user whose data should be wiped.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually perform the deletes. Omit for a dry-run.",
    )
    args = parser.parse_args(argv)
    return run(email=args.email, apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
