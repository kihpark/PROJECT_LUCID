"""DEVX-01 — structural liveness smoke for the local stack.

Run:
    docker compose exec -T backend python -m api.ops.smoke

Exits 0 when every check passes, 1 otherwise. On failure, prints
one short line listing the failed check names so the operator can
scan it without scrolling — full per-check detail goes to stderr.

What this is, and what this isn't
---------------------------------

This file confirms the STACK is wired:
  - /api/health responds 200,
  - lucid_facts / lucid_objects / lucid_sources all exist,
  - lucid_facts and lucid_objects each carry ≥ 1 document
    (sources can be 0 on a fresh install — having ANY fact is the
     real "the loop ran" signal),
  - the recall route appears in the live OpenAPI surface.

It deliberately AVOIDS data-shape assertions ("국방부 검색 returns
N facts"). Those belong in `pytest tests/integration/...` so the
smoke survives content edits without false negatives.

Acceptance-criterion smoke for a specific task (PO acceptance lines)
is the task's pytest, not this module.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Callable
from typing import Any

# Where the backend is reachable from inside the container. When
# running via `docker compose exec backend python -m api.ops.smoke`
# we're already in the backend container — so loopback works.
# Override with `LUCID_SMOKE_API` if the caller runs the script from
# elsewhere (e.g. host: `http://localhost:8000`).
DEFAULT_API_BASE = "http://localhost:8000"


class _SmokeResult:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes: list[str] = []

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passes.append(name)
            print(f"  ✓ {name}", file=sys.stdout)
        else:
            self.failures.append(name)
            line = f"  ✗ {name}" + (f": {detail}" if detail else "")
            print(line, file=sys.stderr)


def _check_health(api_base: str, result: _SmokeResult) -> None:
    import httpx
    try:
        r = httpx.get(f"{api_base}/api/health", timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        result.record("health_endpoint", False, f"{type(exc).__name__}: {exc}")
        return
    if r.status_code != 200:
        result.record(
            "health_endpoint", False, f"status={r.status_code}",
        )
        return
    body: dict[str, Any] = {}
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        pass
    if body.get("status") != "ok":
        result.record(
            "health_endpoint", False,
            f"status={body.get('status')!r} pg={body.get('postgres')!r} "
            f"es={body.get('elasticsearch')!r}",
        )
        return
    result.record("health_endpoint", True)


def _check_es_indexes(result: _SmokeResult) -> None:
    """All three indexes must exist; facts + objects must each carry ≥1 doc.

    The lucid_sources count is tolerated at 0 on a fresh install
    because the index can be empty before the first capture — but the
    INDEX itself must be present (mapping wired)."""
    try:
        from api.storage.elasticsearch.client import (
            LUCID_FACTS,
            LUCID_OBJECTS,
            LUCID_SOURCES,
            get_client,
        )
        client = get_client()
    except Exception as exc:  # noqa: BLE001
        result.record(
            "es_client_bootstrap", False, f"{type(exc).__name__}: {exc}",
        )
        return

    for name in (LUCID_FACTS, LUCID_OBJECTS, LUCID_SOURCES):
        try:
            exists = client.indices.exists(index=name)
        except Exception as exc:  # noqa: BLE001
            result.record(f"index_{name}_exists", False, str(exc))
            continue
        result.record(f"index_{name}_exists", bool(exists))

    for name, require_nonempty in (
        (LUCID_FACTS, True),
        (LUCID_OBJECTS, True),
        (LUCID_SOURCES, False),  # tolerated at 0 on first install
    ):
        try:
            count = client.count(index=name).get("count", 0)
        except Exception as exc:  # noqa: BLE001
            result.record(f"index_{name}_count", False, str(exc))
            continue
        if require_nonempty:
            result.record(
                f"index_{name}_nonempty", count > 0, f"count={count}",
            )


def _check_recall_route_mounted(api_base: str, result: _SmokeResult) -> None:
    """Confirm the recall route is mounted via the live OpenAPI schema.

    A real `/api/spaces/{ks_id}/recall` call requires auth — we don't
    fabricate users for a structural probe. The OpenAPI surface is
    enough to assert "route wired" without leaking data dependencies.
    """
    import httpx
    try:
        r = httpx.get(f"{api_base}/openapi.json", timeout=10.0)
    except Exception as exc:  # noqa: BLE001
        result.record(
            "recall_route_mounted", False,
            f"openapi unreachable: {type(exc).__name__}: {exc}",
        )
        return
    if r.status_code != 200:
        result.record(
            "recall_route_mounted", False,
            f"openapi status={r.status_code}",
        )
        return
    try:
        paths = (r.json() or {}).get("paths") or {}
    except Exception:  # noqa: BLE001
        paths = {}
    has_recall = any(
        "/recall" in path and "/spaces/" in path for path in paths
    )
    result.record("recall_route_mounted", has_recall)


def run() -> int:
    api_base = os.getenv("LUCID_SMOKE_API", DEFAULT_API_BASE)
    print(f"DEVX-01 smoke (api_base={api_base})")

    result = _SmokeResult()
    checks: list[Callable[[], None]] = [
        lambda: _check_health(api_base, result),
        lambda: _check_es_indexes(result),
        lambda: _check_recall_route_mounted(api_base, result),
    ]
    for check in checks:
        try:
            check()
        except Exception as exc:  # noqa: BLE001 - never crash
            # A check that explodes is itself a failure — the operator
            # needs to know smoke couldn't even probe.
            result.record(check.__name__, False, repr(exc))

    if result.failures:
        print(
            f"smoke FAILED ({len(result.failures)} of "
            f"{len(result.passes) + len(result.failures)}): "
            + ", ".join(result.failures),
            file=sys.stderr,
        )
        return 1
    print(
        f"smoke OK ({len(result.passes)} checks)",
        file=sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(run())
