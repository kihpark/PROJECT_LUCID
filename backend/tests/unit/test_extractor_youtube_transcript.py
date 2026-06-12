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


# ---------------------------------------------------------------------------
# Task 6 — v1.x API regression test
# ---------------------------------------------------------------------------

def test_youtube_extractor_uses_v1_list_then_fetch_chain():
    """Regression for the youtube-transcript-api v0.x -> v1.x migration.

    v0.x: `YouTubeTranscriptApi.list_transcripts(video_id)` (classmethod)
          + `transcript.fetch()` -> `list[dict]`
    v1.x: `YouTubeTranscriptApi().list(video_id)` (instance method)
          + `transcript.fetch()` -> `FetchedTranscript`
                                 -> `.to_raw_data()` -> `list[dict]`

    This test patches the v1.x interface (api.list + FetchedTranscript)
    and confirms the extractor walks the new chain and produces a
    merged_text from the transcript snippets.
    """
    from unittest.mock import MagicMock, patch

    from api.extractors.youtube_transcript import YoutubeTranscriptExtractor

    # Fake v1 chain:
    #   YouTubeTranscriptApi()  -> api
    #   api.list(video_id)      -> transcript_list (iterable + find_transcript)
    #   transcript_list.find_transcript([...])  -> transcript
    #   transcript.fetch()      -> fetched
    #   fetched.to_raw_data()   -> list[dict] (v0.x-shaped entries)
    fetched = MagicMock()
    fetched.to_raw_data.return_value = [
        {"text": "안녕하세요", "start": 0.0, "duration": 2.5},
        {"text": "오늘은 한국 경제 뉴스를 다룹니다", "start": 2.5, "duration": 3.0},
    ]
    transcript = MagicMock()
    transcript.fetch.return_value = fetched
    transcript.language_code = "ko"

    transcript_list = MagicMock()
    transcript_list.find_transcript.return_value = transcript

    api_instance = MagicMock()
    api_instance.list.return_value = transcript_list

    fake_class = MagicMock(return_value=api_instance)

    fake_exc_class = type("_NoExcCls", (Exception,), {})
    fake_disabled = type("_TranscriptsDisabled", (Exception,), {})

    fake_module = MagicMock()
    fake_module.YouTubeTranscriptApi = fake_class
    fake_module.NoTranscriptFound = fake_exc_class
    fake_module.TranscriptsDisabled = fake_disabled

    with patch.dict(
        "sys.modules",
        {"youtube_transcript_api": fake_module},
    ):
        result = YoutubeTranscriptExtractor().extract(
            b"", {"source_url": "https://youtu.be/dQw4w9WgXcQ"},
        )

    # Verify the new v1.x chain was used:
    fake_class.assert_called_once_with()
    api_instance.list.assert_called_once_with("dQw4w9WgXcQ")
    transcript_list.find_transcript.assert_called_once()
    transcript.fetch.assert_called_once_with()
    fetched.to_raw_data.assert_called_once_with()

    # And the merged_text picked up both snippets in order.
    assert "안녕하세요" in result.merged_text
    assert "한국 경제 뉴스" in result.merged_text
    assert result.language == "ko"


def test_youtube_extractor_propagates_no_transcript_on_v1_list_error():
    """If api.list() raises in v1.x, we still surface NoTranscriptError."""
    from unittest.mock import MagicMock, patch

    from api.extractors.base import NoTranscriptError
    from api.extractors.youtube_transcript import YoutubeTranscriptExtractor

    api_instance = MagicMock()
    api_instance.list.side_effect = RuntimeError("upstream-broke")

    fake_class = MagicMock(return_value=api_instance)
    fake_module = MagicMock()
    fake_module.YouTubeTranscriptApi = fake_class
    fake_module.NoTranscriptFound = type("_NoExcCls", (Exception,), {})
    fake_module.TranscriptsDisabled = type("_TranscriptsDisabled", (Exception,), {})

    with patch.dict(
        "sys.modules",
        {"youtube_transcript_api": fake_module},
    ):
        import pytest
        with pytest.raises(NoTranscriptError, match="upstream-broke"):
            YoutubeTranscriptExtractor().extract(
                b"", {"source_url": "https://youtu.be/dQw4w9WgXcQ"},
            )
