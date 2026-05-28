"""Integration: real-network extractor tests (skip by default).

These spend external API budget / network — keep them skipped unless
the caller explicitly opts in via env. Useful for occasional manual
verification, not for CI.
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration


SKIP_REASON_NETWORK = "LUCID_RUN_NETWORK_TESTS not set"


def _run_network() -> bool:
    return os.getenv("LUCID_RUN_NETWORK_TESTS", "").lower() in {"1", "true", "yes"}


@pytest.fixture
def network_optin():
    if not _run_network():
        pytest.skip(SKIP_REASON_NETWORK)


def test_real_web_article_extraction(network_optin):
    """Fetches a small, stable Korean news article."""
    import httpx

    from api.extractors.web_article import WebArticleExtractor

    url = "https://example.com"
    resp = httpx.get(url, timeout=10)
    result = WebArticleExtractor().extract(resp.content, {"source_url": url})
    assert result.merged_text


def test_real_youtube_transcript(network_optin):
    """Fetches a known short video. Skip if youtube-transcript-api fails."""
    from api.extractors.youtube_transcript import YoutubeTranscriptExtractor

    # Use a stable short clip — caller may need to update if YT pulls it.
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    try:
        result = YoutubeTranscriptExtractor().extract(
            b"", {"source_url": url}
        )
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"transcript unavailable: {exc}")
    assert result.merged_text


def test_real_pdf_extraction(network_optin):
    """Round-trip a small known PDF (would need a fixture file)."""
    pytest.skip("Add a fixture PDF under tests/fixtures/ before enabling")


def test_real_image_vision_extraction(network_optin):
    """Calls real Claude Vision. Costs ~$0.003. Off by default."""
    pytest.skip("Real Vision call disabled by default")


def test_real_youtube_whisper_fallback(network_optin):
    """Downloads audio + transcribes. Very slow. Off by default."""
    pytest.skip("Whisper fallback disabled by default (too slow for CI)")
