"""Run the 50-sample baseline against the Structure decomposer.

Usage (real API):
    cd backend
    ANTHROPIC_API_KEY=... python -m tests.baseline.measure_baseline

Usage (dry run / mock):
    cd backend
    LUCID_MOCK_STRUCTURE=1 python -m tests.baseline.measure_baseline

Output:
  - Per-sample line: id, expected_facts, actual_facts, latency_ms, status
  - Aggregate JSON summary written to docs/sprint-3-baseline-results.json
  - Markdown summary appended to docs/sprint-3-baseline.md (Latest run)

The aggregate metric definitions match docs/sprint-3-baseline.md:
  M1  Fact-count delta (mean abs error vs ground truth)
  M2  Negation flag accuracy (correct flags / total negation cases)
  M3  Failure-reason precision (correct reason / total failure cases)
  Latency p50 / p95 ms per call
  Total input + output tokens (estimated)
  Total cost estimate ($)
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any


def _load_samples() -> list[dict[str, Any]]:
    p = Path(__file__).parent / "samples.json"
    return json.loads(p.read_text(encoding="utf-8"))


def _run_one(sample: dict[str, Any], mock_mode: bool) -> dict[str, Any]:
    from api.structure.decomposer import decompose

    if mock_mode:
        # In mock mode we just stub the call so the harness shape can be tested
        from api.structure.models import StructureResult

        result = StructureResult(
            extraction_status=sample.get("expected_status", "success"),
            failure_reason=sample.get("expected_failure_reason"),
            facts=[],
            objects=[],
        )
        result.model_used = "mock"
        return _evaluate(sample, result)

    start = time.monotonic()
    result = decompose(sample["text"], {"source_url": f"baseline://{sample['id']}"})
    elapsed_ms = int((time.monotonic() - start) * 1000)
    return _evaluate(sample, result, override_latency_ms=elapsed_ms)


def _evaluate(
    sample: dict[str, Any], result: Any, *, override_latency_ms: int | None = None
) -> dict[str, Any]:
    actual_facts = len(result.facts)
    expected_facts = sample["expected_facts"]
    actual_neg_flags = sum(1 for f in result.facts if getattr(f, "negation_flag", False))
    actual_status = getattr(result, "extraction_status", "")
    actual_failure_reason = getattr(result, "failure_reason", None)
    return {
        "id": sample["id"],
        "category": sample["category"],
        "lang": sample["lang"],
        "expected_facts": expected_facts,
        "actual_facts": actual_facts,
        "fact_count_delta": actual_facts - expected_facts,
        "expected_negation_flags": sample.get("expected_negation_flags", 0),
        "actual_negation_flags": actual_neg_flags,
        "expected_status": sample.get("expected_status", "success"),
        "actual_status": actual_status,
        "expected_failure_reason": sample.get("expected_failure_reason"),
        "actual_failure_reason": actual_failure_reason,
        "latency_ms": override_latency_ms or getattr(result, "latency_ms", 0),
        "input_token_estimate": getattr(result, "input_token_estimate", 0),
        "output_token_estimate": getattr(result, "output_token_estimate", 0),
        "model_used": getattr(result, "model_used", ""),
    }


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(rows)
    fact_deltas = [abs(r["fact_count_delta"]) for r in rows]
    latencies = [r["latency_ms"] for r in rows if r["latency_ms"] > 0]

    # M2: among samples with expected_negation_flags >= 1, count those
    # where actual_negation_flags == expected_negation_flags.
    neg_rows = [r for r in rows if r["expected_negation_flags"] >= 1]
    neg_correct = sum(
        1 for r in neg_rows
        if r["actual_negation_flags"] == r["expected_negation_flags"]
    )

    # M3: failure-reason precision
    fail_rows = [r for r in rows if r["expected_failure_reason"]]
    fail_correct = sum(
        1 for r in fail_rows
        if r["actual_failure_reason"] == r["expected_failure_reason"]
    )

    input_tokens = sum(r["input_token_estimate"] for r in rows)
    output_tokens = sum(r["output_token_estimate"] for r in rows)
    # Rough cost estimate for claude-sonnet-4-5:
    #   input  ~ $3 / 1M tokens
    #   output ~ $15 / 1M tokens
    cost_usd = (input_tokens / 1_000_000) * 3 + (output_tokens / 1_000_000) * 15

    return {
        "sample_count": n,
        "M1_fact_count_mean_abs_error": (
            statistics.fmean(fact_deltas) if fact_deltas else 0.0
        ),
        "M2_negation_accuracy": (
            (neg_correct / len(neg_rows)) if neg_rows else None
        ),
        "M2_negation_total_cases": len(neg_rows),
        "M3_failure_reason_precision": (
            (fail_correct / len(fail_rows)) if fail_rows else None
        ),
        "M3_failure_total_cases": len(fail_rows),
        "latency_p50_ms": (
            statistics.median(latencies) if latencies else None
        ),
        "latency_p95_ms": (
            statistics.quantiles(latencies, n=20)[18]
            if len(latencies) >= 20 else None
        ),
        "input_tokens_total": input_tokens,
        "output_tokens_total": output_tokens,
        "estimated_cost_usd": round(cost_usd, 4),
    }


def main() -> int:
    mock_mode = os.getenv("LUCID_MOCK_STRUCTURE") == "1"
    samples = _load_samples()
    print(f"# Running {len(samples)} baseline samples ({'MOCK' if mock_mode else 'REAL'})")

    rows: list[dict[str, Any]] = []
    for idx, sample in enumerate(samples, start=1):
        row = _run_one(sample, mock_mode)
        rows.append(row)
        marker = "OK" if row["expected_status"] == row["actual_status"] else "MISMATCH"
        print(
            f"[{idx:02d}/{len(samples)}] {row['id']:>22s}  "
            f"facts {row['expected_facts']}->{row['actual_facts']:<2}  "
            f"neg {row['expected_negation_flags']}->{row['actual_negation_flags']:<2}  "
            f"{row['latency_ms']:>5}ms  {marker}"
        )

    summary = _aggregate(rows)
    print()
    print("# Aggregate")
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    out_dir = Path(__file__).resolve().parents[3] / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "sprint-3-baseline-results.json").write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
