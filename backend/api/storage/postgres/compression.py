"""Gzip compression helpers for raw_payload BYTEA.

Decision (architect 2026-05-28): use stdlib `gzip` for raw_payload
compression. Reasoning: zero new dependency, good ratio on text-heavy
payloads (HTML / transcripts / PDF text), decompression only fires
at extraction time so latency cost is amortized over the slow
extractor path anyway.

5 MB pre-compression cap is enforced at the request layer
(api/routes/capture.py).
"""
from __future__ import annotations

import gzip

MAX_PRECOMPRESSION_BYTES = 5 * 1024 * 1024  # 5 MB


def compress_payload(raw: bytes) -> bytes:
    """Gzip-compress `raw`. Raises ValueError if larger than 5 MB."""
    if raw is None:
        return b""
    if len(raw) > MAX_PRECOMPRESSION_BYTES:
        raise ValueError(
            f"raw_payload too large: {len(raw)} bytes > {MAX_PRECOMPRESSION_BYTES}"
        )
    return gzip.compress(raw, compresslevel=6)


def decompress_payload(compressed: bytes) -> bytes:
    """Gzip-decompress. Empty input returns empty bytes (never raises)."""
    if not compressed:
        return b""
    try:
        return gzip.decompress(compressed)
    except gzip.BadGzipFile:
        # Fall back to raw bytes; useful when the payload was stored
        # before gzip wrapping landed (or in tests that bypass compress).
        return compressed
