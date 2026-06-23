"""One-shot CLI for retroactive entity class backfill.

Resolves a user by email -> picks the user's first knowledge_space ->
runs the entity_reclassifier over every entity in that KS, promoting
legacy 'concept' rows to 'person' / 'organization' / 'place' / 'event'.

Dry-run by default. Pass --apply to actually write changes. Pass
--no-llm to use ONLY the Korean-name heuristic (cheap, deterministic,
zero LLM spend) — useful for a first pass that catches obvious cases.

Usage::

    docker compose exec backend python -m scripts.backfill_entity_class \\
        --email kihpark85@gmail.com

    docker compose exec backend python -m scripts.backfill_entity_class \\
        --email kihpark85@gmail.com --apply

    docker compose exec backend python -m scripts.backfill_entity_class \\
        --email kihpark85@gmail.com --no-llm --apply

Idempotent: rerunning the same command after success is a no-op.
"""
from __future__ import annotations

import argparse
import logging
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.storage.elasticsearch.client import get_client
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker
from api.structure.entity_reclassifier import run_backfill

logger = logging.getLogger("lucid.scripts.backfill_entity_class")


def _find_user(session: Session, email: str) -> User | None:
    return session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()


def _find_first_ks_id(session: Session, user_id) -> str | None:
    ks = session.execute(
        select(KnowledgeSpace.id)
        .where(KnowledgeSpace.user_id == user_id)
        .order_by(KnowledgeSpace.created_at)
    ).scalars().first()
    return str(ks) if ks else None


def run(email: str, apply: bool, use_llm: bool) -> int:
    session = make_sessionmaker()()
    try:
        user = _find_user(session, email)
        if user is None:
            print(f"[error] no user found for email={email!r}")
            return 2

        ks_id = _find_first_ks_id(session, user.id)
        if ks_id is None:
            print(f"[error] user {email} has no knowledge_space")
            return 2

        print(
            f"user: id={user.id} email={user.email} is_admin={user.is_admin}"
        )
        print(f"target knowledge_space: {ks_id}")
    finally:
        session.close()

    client = get_client()
    prefix = "[DRY-RUN]" if not apply else "[APPLY]"
    llm_tag = "heuristic+llm" if use_llm else "heuristic-only"
    print(f"\n{prefix} starting backfill ({llm_tag})...\n")

    result = run_backfill(
        client, ks_id, use_llm=use_llm, apply=apply,
    )

    print(f"scanned: {result['scanned']}")
    print(f"updated: {result['updated']}")
    print(f"skipped: {result['skipped']}")
    print(f"by_class: {result['by_class']}")

    samples = result.get("samples") or []
    if samples:
        print("\nfirst 20 changes:")
        for s in samples:
            method = s.get("method", "?")
            print(
                f"  {str(s.get('doc_id', ''))[:8]}  "
                f"{s.get('name', '')!r:30}  "
                f"{s.get('old', '') or '(empty)':>10} -> "
                f"{s.get('new', ''):10}  [{method}]"
            )
    else:
        print("\n(no changes detected)")

    if not apply:
        print(
            "\n[DRY-RUN] no writes were performed. "
            "Re-run with --apply to commit."
        )

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--email",
        required=True,
        help="Email of the user whose KS should be backfilled.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually write changes. Without this flag, dry-run only.",
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="Skip the LLM fallback — heuristic-only mode.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return run(
        email=args.email,
        apply=args.apply,
        use_llm=not args.no_llm,
    )


if __name__ == "__main__":
    sys.exit(main())
