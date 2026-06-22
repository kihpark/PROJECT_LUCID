"""Unit tests for B-46 STT hard duration gate."""
from __future__ import annotations

import pytest


def test_gate_passes_under_limit() -> None:
    """check_duration does not raise for a value below the default limit."""
    from api.capture.stt.gate import check_duration, DEFAULT_MAX_MS

    check_duration(DEFAULT_MAX_MS - 1)  # should not raise


def test_gate_passes_at_exactly_limit() -> None:
    """check_duration does not raise when duration equals the limit."""
    from api.capture.stt.gate import check_duration, DEFAULT_MAX_MS

    check_duration(DEFAULT_MAX_MS)  # equal is allowed


def test_gate_raises_over_limit() -> None:
    """check_duration raises HardLimitExceeded when duration exceeds limit."""
    from api.capture.stt.gate import check_duration, DEFAULT_MAX_MS, HardLimitExceeded

    over = DEFAULT_MAX_MS + 1
    with pytest.raises(HardLimitExceeded) as exc_info:
        check_duration(over)
    exc = exc_info.value
    assert exc.duration_ms == over
    assert exc.limit_ms == DEFAULT_MAX_MS


def test_gate_passes_unknown_duration_zero() -> None:
    """check_duration passes when duration_ms=0 (ffprobe failed = unknown)."""
    from api.capture.stt.gate import check_duration

    check_duration(0)  # should not raise


def test_gate_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """STT_MAX_AUTO_DURATION_MS env var overrides the default limit."""
    import api.capture.stt.gate as gate_mod

    monkeypatch.setenv("STT_MAX_AUTO_DURATION_MS", "60000")  # 60 seconds
    limit = gate_mod.get_max_auto_duration_ms()
    assert limit == 60_000

    # Should raise for 61 seconds
    from api.capture.stt.gate import HardLimitExceeded
    with pytest.raises(HardLimitExceeded) as exc_info:
        gate_mod.check_duration(61_000)
    assert exc_info.value.limit_ms == 60_000
    assert exc_info.value.duration_ms == 61_000
