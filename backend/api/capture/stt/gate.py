"""Hard duration gate for automatic STT capture (B-46 PR1).

Prevents runaway transcription jobs from consuming all GPU/CPU time.
The gate fires inside the extractor (async path) as a second line of
defence; the route handler may also use it as a pre-flight check when
it can determine the duration cheaply (e.g. for local file uploads).

Environment variables
---------------------
STT_MAX_AUTO_DURATION_MS
    Override the hard limit in milliseconds. Default: 20 minutes
    (1 200 000 ms). Set to 0 to disable (NOT recommended for prod).
"""
from __future__ import annotations

import os

DEFAULT_MAX_MS: int = 20 * 60 * 1000  # 20 minutes


def get_max_auto_duration_ms() -> int:
    """Return the configured hard limit in milliseconds."""
    raw = os.getenv("STT_MAX_AUTO_DURATION_MS")
    if raw is not None:
        try:
            return int(raw)
        except ValueError:
            pass
    return DEFAULT_MAX_MS


class HardLimitExceeded(Exception):
    """Raised when a media file exceeds the STT duration gate.

    Attributes
    ----------
    duration_ms:
        The probed duration of the media file in milliseconds.
    limit_ms:
        The configured hard limit that was exceeded.
    """

    def __init__(self, duration_ms: int, limit_ms: int) -> None:
        super().__init__(
            f"Media duration {duration_ms} ms exceeds hard limit {limit_ms} ms"
        )
        self.duration_ms = duration_ms
        self.limit_ms = limit_ms


def check_duration(duration_ms: int) -> None:
    """Raise ``HardLimitExceeded`` if ``duration_ms`` exceeds the limit.

    When ``duration_ms`` is 0 (unknown, ffprobe failed), the gate
    passes — we can't block on unknown duration. The extractor will
    naturally time out via its subprocess timeout instead.

    Parameters
    ----------
    duration_ms:
        Duration to check in milliseconds.

    Raises
    ------
    HardLimitExceeded
        When ``duration_ms > 0`` and ``duration_ms > limit``.
    """
    if duration_ms == 0:
        return  # unknown — let it through; ffmpeg timeout is the backstop
    limit = get_max_auto_duration_ms()
    if limit > 0 and duration_ms > limit:
        raise HardLimitExceeded(duration_ms=duration_ms, limit_ms=limit)
