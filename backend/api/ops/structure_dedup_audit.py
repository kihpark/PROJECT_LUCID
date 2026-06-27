"""STAGE 2 SPO dedup verify — read-only audit of structure facts (PO 2026-06-27).

Scans every ``source_jobs`` row whose ``knowledge_space_id`` matches the
given KS and reports — per job and in aggregate — how many facts the
canonical (subject, predicate_code, object) dedup would drop today if
re-run over ``extracted_metadata.structure.facts``.

Why read-only:
  fact-dedup (b4266d6) ships at the *write* boundary — new captures get
  deduped before they hit ``extracted_metadata``. Old captures (before
  b4266d6) keep their 4-way duplicate facts on disk. PO decision per
  the STAGE 2 brief: *backfill is not in scope*. This module just
  surfaces the magnitude so the PO can decide whether to wipe vs.
  backfill the old data.

CLI::

    python -m api.ops.structure_dedup_audit <ks_id>
    python -m api.ops.structure_dedup_audit <ks_id> --top 20
    python -m api.ops.structure_dedup_audit <ks_id> --json

The default rendering is a stable text report (per-job lines + the
aggregate footer) so PR diffs over repeated runs are diffable. ``--json``
emits the same numbers as a single object for programmatic consumers
(later backfill ticket).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from typing import Any

from api.storage.postgres.orm import SourceJobORM
from api.storage.postgres.session import make_sessionmaker
from api.structure.fact_dedup import dedup_facts

# Mirror the structure stage's write path so the audit measures
# exactly what was (or would have been) deduped at write time.
_DUP_UID_PREVIEW = 5
_DEFAULT_TOP = 10


def _extract_facts(meta: Any) -> list[dict[str, Any]]:
    """Return the structure.facts list from a job's extracted_metadata.

    Returns an empty list if metadata is missing, the ``structure`` key
    is absent, or ``facts`` is not a list — the dedup pass needs a list
    of dicts, so anything else is treated as zero facts (no false dup
    counts from a malformed row).
    """
    if not isinstance(meta, dict):
        return []
    structure = meta.get("structure")
    if not isinstance(structure, dict):
        return []
    facts = structure.get("facts")
    if not isinstance(facts, list):
        return []
    return facts


def audit_ks(ks_id: str, *, top: int = _DEFAULT_TOP) -> dict[str, Any]:
    """Compute the dedup audit for a knowledge_space_id.

    Iterates every SourceJob in the KS (irrespective of status — failed
    structures simply contribute zero facts and zero dups). For each
    row, runs ``dedup_facts`` against the on-disk fact payload and
    accumulates counts. Returns the raw numbers; the CLI renderer turns
    them into the report PO sees.
    """
    SessionLocal = make_sessionmaker()
    total_jobs_scanned = 0
    total_jobs_with_facts = 0
    total_facts = 0
    total_dups = 0
    per_job: list[dict[str, Any]] = []

    ks_uuid = uuid.UUID(ks_id)
    with SessionLocal() as session:
        jobs = (
            session.query(SourceJobORM)
            .filter(SourceJobORM.knowledge_space_id == ks_uuid)
            .all()
        )
        for job in jobs:
            total_jobs_scanned += 1
            facts = _extract_facts(job.extracted_metadata)
            if not facts:
                continue
            total_jobs_with_facts += 1
            _kept, dropped_uids = dedup_facts(facts)
            total_facts += len(facts)
            dup_count = len(dropped_uids)
            total_dups += dup_count
            if dup_count:
                per_job.append(
                    {
                        "job_id": str(job.id),
                        "source_url": (job.source_url or "")[:60],
                        "fact_count": len(facts),
                        "dup_count": dup_count,
                        "dup_uids": sorted(dropped_uids)[:_DUP_UID_PREVIEW],
                    }
                )

    per_job.sort(key=lambda row: row["dup_count"], reverse=True)
    dup_ratio = round(total_dups / total_facts, 3) if total_facts else 0.0
    return {
        "ks_id": ks_id,
        "total_jobs_scanned": total_jobs_scanned,
        "total_jobs_with_facts": total_jobs_with_facts,
        "total_jobs_with_dups": len(per_job),
        "total_facts": total_facts,
        "total_dups_detected": total_dups,
        "dup_ratio": dup_ratio,
        "jobs_with_dups": per_job[:top],
        "jobs_with_dups_total_listed": min(len(per_job), top),
        "jobs_with_dups_truncated": max(0, len(per_job) - top),
    }


def _format_report(result: dict[str, Any]) -> str:
    """Pretty-print the audit numbers — stable + grep-friendly."""
    lines = [
        f"ks_id: {result['ks_id']}",
        f"total_jobs_scanned: {result['total_jobs_scanned']}",
        f"total_jobs_with_facts: {result['total_jobs_with_facts']}",
        f"total_jobs_with_dups: {result['total_jobs_with_dups']}",
        f"total_facts: {result['total_facts']}",
        f"total_dups_detected: {result['total_dups_detected']}",
        f"dup_ratio: {result['dup_ratio']}",
        "NOTE: read-only audit. Backfill is gated on PO command.",
        "",
    ]
    jobs = result.get("jobs_with_dups") or []
    if not jobs:
        lines.append("(no jobs with on-disk duplicates - pipeline output is clean)")
        return "\n".join(lines) + "\n"
    lines.append(
        f"--- top {result['jobs_with_dups_total_listed']} jobs by dup_count ---"
    )
    for idx, row in enumerate(jobs, start=1):
        lines.append(
            f"  {idx:>2}. job_id={row['job_id']} "
            f"facts={row['fact_count']} dups={row['dup_count']}"
        )
        lines.append(f"      source_url={row['source_url']}")
        lines.append(f"      dup_uids[0:{_DUP_UID_PREVIEW}]={row['dup_uids']}")
    if result["jobs_with_dups_truncated"]:
        lines.append(
            f"  ... +{result['jobs_with_dups_truncated']} more jobs with dups"
            " (raise --top to see them)"
        )
    return "\n".join(lines) + "\n"


def run(ks_id: str, *, top: int = _DEFAULT_TOP, as_json: bool = False) -> int:
    """CLI entry - print the report and return exit status (always 0).

    Returns non-zero only on hard failures (caught by argparse or
    propagated from the session - neither is silently swallowed).
    """
    result = audit_ks(ks_id, top=top)
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(_format_report(result))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "ks_id",
        help="Target knowledge_space_id to audit for on-disk duplicate facts.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=_DEFAULT_TOP,
        help=(
            f"Number of per-job rows to render (default: {_DEFAULT_TOP}). "
            "Rows are ordered by dup_count descending."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the raw audit object as JSON instead of the text report.",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return run(args.ks_id, top=args.top, as_json=args.json)


if __name__ == "__main__":
    sys.exit(main())
