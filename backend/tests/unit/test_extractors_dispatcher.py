"""Unit: dispatcher routing + youtube fallback chain (no live calls)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from api.extractors.base import (
    ExtractorError,
    ExtractResult,
    NoTranscriptError,
    UnknownSourceTypeError,
)
from api.extractors.dispatcher import (
    SOURCE_TYPE_TO_EXTRACTOR,
    extract,
    extract_youtube,
    get_extractor,
)
from api.models.source import SourceType


def test_dispatcher_routes_all_known_source_types():
    """5 source_types map to 5 extractor classes (YouTube primary = transcript)."""
    for st in (
        SourceType.WEB_ARTICLE,
        SourceType.HIGHLIGHTED_TEXT,
        SourceType.YOUTUBE,
        SourceType.PAGE_IMAGE,
        SourceType.PDF,
    ):
        e = get_extractor(st)
        assert e.supports(st), f"{type(e).__name__} should support {st}"


def test_dispatcher_unknown_string_raises():
    with pytest.raises(UnknownSourceTypeError):
        get_extractor("telegram_chat")


def test_dispatcher_unmapped_marker_raises():
    """SourceType marker entries that aren't real extractor types (pwa_share /
    url_paste) should be re-classified at the route layer, not routed here."""
    for marker in (SourceType.PWA_SHARE, SourceType.URL_PASTE):
        if marker in SOURCE_TYPE_TO_EXTRACTOR:
            pytest.skip(f"Marker {marker} now has an extractor mapping")
        with pytest.raises(UnknownSourceTypeError):
            get_extractor(marker)


def test_extract_youtube_uses_transcript_on_success():
    """When transcript succeeds, Whisper is never called."""
    happy = ExtractResult(merged_text="hello", language="en")
    with patch(
        "api.extractors.dispatcher.YoutubeTranscriptExtractor"
    ) as transcript_cls, patch(
        "api.extractors.dispatcher.YoutubeWhisperExtractor"
    ) as whisper_cls:
        transcript_cls.return_value.extract.return_value = happy
        out = extract_youtube(b"", {"source_url": "https://youtu.be/abc"})
        assert out.merged_text == "hello"
        assert whisper_cls.called is False


def test_extract_youtube_falls_back_to_whisper_on_NoTranscriptError():
    """NoTranscriptError -> Whisper runs and a warning is appended."""
    happy_whisper = ExtractResult(merged_text="from whisper", language="en")
    with patch(
        "api.extractors.dispatcher.YoutubeTranscriptExtractor"
    ) as transcript_cls, patch(
        "api.extractors.dispatcher.YoutubeWhisperExtractor"
    ) as whisper_cls:
        transcript_cls.return_value.extract.side_effect = NoTranscriptError("no captions")
        whisper_cls.return_value.extract.return_value = happy_whisper
        out = extract_youtube(b"", {"source_url": "https://youtu.be/abc"})
        assert out.merged_text == "from whisper"
        assert any("Whisper STT fallback" in w for w in out.extraction_warnings)
        assert whisper_cls.return_value.extract.called is True


def test_extract_top_level_routes_youtube_through_fallback():
    """extract(..., source_type=YOUTUBE) goes through extract_youtube."""
    happy = ExtractResult(merged_text="ok", language="en")
    with patch(
        "api.extractors.dispatcher.YoutubeTranscriptExtractor"
    ) as cls:
        cls.return_value.extract.return_value = happy
        out = extract(b"", {"source_url": "https://youtu.be/abc"}, source_type=SourceType.YOUTUBE)
        assert out.merged_text == "ok"


def test_extract_wraps_unexpected_errors_in_ExtractorError():
    """Non-ExtractorError exceptions become ExtractorError to keep the
    processor's status='extract_failed' contract uniform."""
    class _Boom(Exception):
        pass

    with patch.object(
        get_extractor(SourceType.PDF).__class__,
        "extract",
        side_effect=_Boom("bang"),
    ):
        with pytest.raises(ExtractorError):
            extract(b"%PDF-1.4", {}, source_type=SourceType.PDF)
