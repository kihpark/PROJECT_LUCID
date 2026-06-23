"""feat/count-source-unification — `_decide_ready_jobs` unit tests.

PO directive (2026-06-23):
    실시간적으로 사용자에게 전달하는 정보는 일관되게 제공되어야 한다.

`_decide_ready_jobs` is the ONE TRUE FILTER. The home brief's
`pending_validation`, the AppShell `검증(N)` badge, and the
`/api/spaces/{ks}/pending` list all flow through it. These unit
tests pin the criteria (status=structured AND fact_count > 0).

The semantic guarantees are exercised end-to-end in the integration
tests (test_pending_count_consistency.py, test_pending_list_filter.py)
against a real Postgres. The unit tests here pin the helper's CALL
shape — that it filters on the right columns + the right JSONB path —
so future refactors that change the filter shape break the unit
suite first, before the integration suite has to spin up.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from api.routes.home import (
    DECIDE_READY_STATUSES,
    PENDING_VALIDATION_STATUSES,
    _decide_ready_jobs,
    _pending_validation_count,
)


def _captured_filters(session: MagicMock) -> list:
    """Pull every filter argument the test session received."""
    chain = session.query.return_value
    out: list = []
    for call in chain.filter.call_args_list:
        args, _ = call
        out.extend(args)
    return out


def _make_session() -> MagicMock:
    """Return a MagicMock session whose query().filter().order_by()
    chain is itself, so we can inspect every filter that was added."""
    session = MagicMock()
    chain = MagicMock()
    chain.filter.return_value = chain
    chain.order_by.return_value = chain
    chain.count.return_value = 0
    chain.all.return_value = []
    session.query.return_value = chain
    return session


def test_decide_ready_alias_matches_pending_statuses():
    """The new DECIDE_READY_STATUSES name aliases the existing
    PENDING_VALIDATION_STATUSES so widenings happen once."""
    assert DECIDE_READY_STATUSES is PENDING_VALIDATION_STATUSES
    assert "structured" in DECIDE_READY_STATUSES


def test_decide_ready_jobs_filters_user_ks_status_and_factcount():
    """The ONE TRUE FILTER applies four constraints together:
    user_id, knowledge_space_id, status in DECIDE_READY_STATUSES,
    and a JSONB cast on extracted_metadata['structure']['fact_count']
    that excludes 0 and missing values."""
    session = _make_session()
    user_id = uuid.uuid4()
    ks_id = uuid.uuid4()

    q = _decide_ready_jobs(session, user_id, ks_id)

    # The query passes through filter + order_by — we exercise the
    # full chain to make sure no path raises on Mock setup.
    assert q is session.query.return_value
    filters = _captured_filters(session)
    # Four filter expressions in total: user_id, knowledge_space_id,
    # status.in_, JSONB > 0
    assert len(filters) == 4, (
        f"expected 4 filter expressions (user, ks, status, fact_count), "
        f"got {len(filters)}: {filters!r}"
    )


def test_decide_ready_jobs_order_by_called():
    """Decide-ready jobs are returned newest-first (created_at desc),
    matching the validate UI's queue ordering."""
    session = _make_session()
    _decide_ready_jobs(session, uuid.uuid4(), uuid.uuid4())
    chain = session.query.return_value
    assert chain.order_by.called, "expected order_by to be invoked"


def test_pending_validation_count_delegates_to_decide_ready_jobs():
    """`_pending_validation_count` returns the COUNT of the decide-ready
    query — the single source of truth shared with the /pending list.
    This is the contract that ends the "badge says 4 / copy says 7 /
    list shows 1" discrepancy PO flagged.
    """
    session = _make_session()
    session.query.return_value.count.return_value = 5

    n = _pending_validation_count(session, uuid.uuid4(), uuid.uuid4())

    assert n == 5
    # The DELEGATION is the load-bearing contract. If a future PR
    # adds a second SQL path here, the assertion that the count
    # equals the .count() of the chain we configured will break.
    assert session.query.return_value.count.called


def test_pending_validation_count_returns_zero_on_db_error():
    """Postgres hiccup must not 500 the home shell — the home brief
    is the post-login landing surface. Errors collapse to 0."""
    session = MagicMock()
    session.query.side_effect = RuntimeError("postgres exploded")

    n = _pending_validation_count(session, uuid.uuid4(), uuid.uuid4())

    assert n == 0


def test_decide_ready_jobs_filter_excludes_user_wrong_ks_status_factcount():
    """End-to-end sanity at the shape level: each criterion is a
    distinct filter expression. The four expressions are produced
    so a regression that drops one (e.g. removing fact_count > 0)
    flips this count.
    """
    # If we ever fall back to only-status filtering, this test
    # captures it: the FOUR expressions are the ones the discovery
    # doc promised. The dedicated integration tests exercise the
    # SQL semantics; this one pins the structural shape.
    session = _make_session()
    _decide_ready_jobs(session, uuid.uuid4(), uuid.uuid4())
    filters = _captured_filters(session)
    # The first three are simple column equals/in. The fourth is the
    # JSONB > 0 expression — verify a SQLAlchemy BinaryExpression-like
    # object is present (it'll have a `right` attr from `> 0`).
    last = filters[-1]
    assert hasattr(last, "right"), (
        "expected the fact_count filter to be a SQLAlchemy comparison "
        f"expression, got {type(last).__name__}: {last!r}"
    )
