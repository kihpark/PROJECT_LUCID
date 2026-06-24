"""One-shot CLI to backfill the `embedding` field on `lucid_facts`.

Until search-embedding-restore landed, the validate/insert paths wrote
facts with `with_embedding=False` (and the canonical insert helper
didn't compute one at all), so every existing fact in production has an
empty or missing `embedding`. kNN against those rows matches nothing —
the recall route silently falls back to the entity-name path.

This script resolves a user by email, picks their first knowledge
space, scans every manual fact whose embedding is missing OR has
length 0, and writes a fresh `text-embedding-3-small` vector through
the same `get_embedding` helper the live insert path uses.

Dry-run by default. Pass --apply to actually write. Idempotent — a
second run after success is a no-op because the scan filter excludes
facts that already carry a non-empty embedding.

Cost: text-embedding-3-small is $0.02 per 1M tokens. A typical fact
claim is ~30 tokens, so ~$0.0006 per 1000 facts. The dry-run prints
an estimate before any spend.

Usage::

    docker compose exec backend python -m scripts.backfill_embeddings \\
        --email kihpark85@gmail.com

    docker compose exec backend python -m scripts.backfill_embeddings \\
        --email kihpark85@gmail.com --apply
"""
from __future__ import annotations

import argparse
import logging
import sys
from typing import Any

from elasticsearch.helpers import scan
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.storage.elasticsearch.client import LUCID_FACTS, get_client
from api.storage.elasticsearch.embeddings import batch_embeddings
from api.storage.postgres.orm import KnowledgeSpace, User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.scripts.backfill_embeddings")

BATCH_SIZE = 100
EST_TOKENS_PER_CLAIM = 30
EST_USD_PER_MTOKEN = 0.02


def _find_user(session: Session, email: str) -> User | None:
    return session.execute(
        select(User).where(User.email == email),
    ).scalar_one_or_none()


def _find_first_ks_id(session: Session, user_id: Any) -> str | None:
    ks = session.execute(
        select(KnowledgeSpace.id)
        .where(KnowledgeSpace.user_id == user_id)
        .order_by(KnowledgeSpace.created_at),
    ).scalars().first()
    return str(ks) if ks else None


def _missing_embedding_query(ks_id: str) -> dict[str, Any]:
    """ES query for facts in `ks_id` whose embedding field is missing
    OR an empty list. A `must_not exists` clause covers missing; a
    script clause covers the empty-list case (length 0). Restricts to
    manual + non-retracted so we don't waste calls on auto rows."""
    return {
        "query": {
            "bool": {
                "filter": [
                    {"term": {"knowledge_space_id": ks_id}},
                    {"term": {"validation_method": "manual"}},
                ],
                "must_not": [
                    {"exists": {"field": "retracted_at"}},
                    # Note: ES "exists" returns True even for empty arrays
                    # on some mapping shapes. Belt-and-braces post-filter
                    # in Python below catches the empty-list case.
                ],
            },
        },
        "_source": ["fact_uid", "claim", "embedding"],
    }


def run(email: str, apply: bool) -> int:
    """Returns the number of facts backfilled (or that WOULD be
    backfilled on dry-run). Non-zero exit code on hard errors."""
    session = make_sessionmaker()()
    try:
        user = _find_user(session, email)
        if user is None:
            logger.error("user not found: %s", email)
            return 0
        ks_id = _find_first_ks_id(session, user.id)
        if ks_id is None:
            logger.error("no knowledge_space for user: %s", email)
            return 0
    finally:
        session.close()

    client = get_client()
    body = _missing_embedding_query(ks_id)

    needs_backfill: list[tuple[str, str]] = []  # (fact_uid, claim)
    try:
        for hit in scan(client, index=LUCID_FACTS, query=body, size=500):
            src = hit.get("_source") or {}
            emb = src.get("embedding")
            if isinstance(emb, list) and len(emb) > 0:
                continue
            fact_uid = src.get("fact_uid") or hit.get("_id")
            claim = src.get("claim") or ""
            if fact_uid and claim:
                needs_backfill.append((str(fact_uid), str(claim)))
    except Exception as exc:  # noqa: BLE001
        logger.error("ES scan failed: %s", exc)
        return 0

    n = len(needs_backfill)
    est_tokens = n * EST_TOKENS_PER_CLAIM
    est_cost = est_tokens * EST_USD_PER_MTOKEN / 1_000_000
    print(f"user:        {email}")
    print(f"space:       {ks_id}")
    print(f"facts needing backfill: {n}")
    print(f"est. tokens: {est_tokens}")
    print(f"est. cost:   ${est_cost:.4f}")

    if n == 0:
        print("Nothing to do.")
        return 0

    if not apply:
        print("Dry-run. Re-run with --apply to write embeddings.")
        return n

    # Apply: batch-embed and update_per_doc. Batched OpenAI calls are
    # cheaper per token; per-doc ES updates keep the change isolated
    # (one failing fact does not roll back others).
    written = 0
    for start in range(0, n, BATCH_SIZE):
        chunk = needs_backfill[start : start + BATCH_SIZE]
        texts = [claim for _uid, claim in chunk]
        vecs = batch_embeddings(texts)
        for (fact_uid, _claim), vec in zip(chunk, vecs, strict=False):
            if vec is None:
                logger.warning("embedding failed for %s, skipping", fact_uid)
                continue
            try:
                client.update(
                    index=LUCID_FACTS,
                    id=fact_uid,
                    doc={"embedding": list(vec)},
                    refresh=False,
                )
                written += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "ES update failed for %s: %s", fact_uid, exc,
                )
        print(f"  written: {written}/{n}")
    # One final refresh so the next recall call sees the new vectors.
    try:
        client.indices.refresh(index=LUCID_FACTS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("final refresh failed: %s", exc)
    print(f"Done. {written}/{n} facts updated.")
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True, help="user email")
    parser.add_argument(
        "--apply", action="store_true",
        help="actually write embeddings (default: dry-run)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    run(args.email, args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
