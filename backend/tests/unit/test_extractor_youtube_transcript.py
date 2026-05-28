"""Unit: youtube transcript helpers (url parsing only — fetch is mocked elsewhere)."""
from __future__ import annotations

from api.extractors.youtube_transcript import _video_id_from_url


def test_video_id_youtu_be():
    assert _video_id_from_url("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_video_id_watch_url():
    assert _video_id_from_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s") == "dQw4w9WgXcQ"


def test_video_id_shorts():
    assert _video_id_from_url("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_video_id_unknown_url_returns_none():
    assert _video_id_from_url("https://example.com/article") is None


def test_video_id_empty_returns_none():
    assert _video_id_from_url("") is None
