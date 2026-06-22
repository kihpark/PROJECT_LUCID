"""Extractor dispatcher.

`get_extractor(source_type)` returns the single Extractor mapped to
each source_type, with one exception: YouTube has a two-step chain
(transcript first, Whisper STT on `NoTranscriptError`) which the
helper `extract_youtube(raw, metadata)` handles. Callers (PR-2C-3
processor) should prefer `extract_youtube` for YouTube and
`get_extractor(...).extract(...)` for everything else.

Routing table:

    web_article       -> WebArticleExtractor
    highlighted_text  -> HighlightedTextExtractor
    youtube           -> YoutubeTranscriptExtractor (fallback: Whisper)
    page_image        -> ImageExtractor
    pdf               -> PdfExtractor

`pwa_share` and `url_paste` are entry-point markers, NOT extractor
source types — they get re-classified into `web_article` /
`youtube` at the route layer based on the URL host. The dispatcher
raises `UnknownSourceTypeError` if a marker leaks through.
"""
from __future__ import annotations

import logging
from typing import Any

from api.extractors.base import (
    Extractor,
    ExtractorError,
    ExtractResult,
    NoTranscriptError,
    UnknownSourceTypeError,
)
from api.extractors.highlighted_text import HighlightedTextExtractor
from api.extractors.image import ImageExtractor
from api.extractors.pdf import PdfExtractor
from api.extractors.web_article import WebArticleExtractor
from api.extractors.youtube_transcript import YoutubeTranscriptExtractor
from api.extractors.youtube_whisper import YoutubeWhisperExtractor
from api.extractors.video_stt import VideoSttExtractor
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.dispatcher")


SOURCE_TYPE_TO_EXTRACTOR: dict[SourceType, type[Extractor]] = {
    SourceType.WEB_ARTICLE: WebArticleExtractor,
    SourceType.HIGHLIGHTED_TEXT: HighlightedTextExtractor,
    SourceType.YOUTUBE: YoutubeTranscriptExtractor,  # primary; fallback in extract_youtube
    SourceType.PAGE_IMAGE: ImageExtractor,
    SourceType.PDF: PdfExtractor,
    SourceType.VIDEO_STT: VideoSttExtractor,  # B-46: dedicated STT path
}


def get_extractor(source_type: SourceType | str) -> Extractor:
    """Return a fresh Extractor instance for `source_type`.

    Raises `UnknownSourceTypeError` if the type is not mapped. Note:
    YouTube returns the transcript extractor; callers handling YouTube
    should use `extract_youtube()` to get the fallback chain.
    """
    try:
        st = source_type if isinstance(source_type, SourceType) else SourceType(source_type)
    except ValueError as exc:
        raise UnknownSourceTypeError(f"Not a SourceType: {source_type!r}") from exc

    extractor_cls = SOURCE_TYPE_TO_EXTRACTOR.get(st)
    if extractor_cls is None:
        raise UnknownSourceTypeError(f"No extractor mapped to source_type={st!r}")
    return extractor_cls()


def extract_youtube(raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
    """Two-step YouTube extraction: transcript first, Whisper fallback.

    Returns the transcript result on success. On `NoTranscriptError`,
    runs `YoutubeWhisperExtractor` and appends a warning. Any other
    extractor error propagates.
    """
    transcript_extractor = YoutubeTranscriptExtractor()
    try:
        result = transcript_extractor.extract(raw, metadata)
        logger.info("YouTube transcript extracted for url=%s", metadata.get("source_url"))
        return result
    except NoTranscriptError as exc:
        logger.info(
            "YouTube transcript unavailable (%s); falling back to Whisper for url=%s",
            exc,
            metadata.get("source_url"),
        )
        whisper_extractor = YoutubeWhisperExtractor()
        result = whisper_extractor.extract(raw, metadata)
        # Make the fallback visible to the Decide overlay (Sprint 4A)
        if "Whisper STT fallback used" not in " | ".join(result.extraction_warnings):
            result.extraction_warnings.append(
                "Whisper STT fallback used (no transcript available)."
            )
        return result


def extract(raw: bytes, metadata: dict[str, Any], *, source_type: SourceType) -> ExtractResult:
    """Single entry point used by the processor (PR-2C-3).

    Routes by source_type, transparently handling the YouTube fallback
    chain.
    """
    if source_type == SourceType.YOUTUBE:
        return extract_youtube(raw, metadata)
    extractor = get_extractor(source_type)
    try:
        return extractor.extract(raw, metadata)
    except ExtractorError:
        # Re-raise as-is so the processor can record status=extract_failed
        raise
    except Exception as exc:  # noqa: BLE001
        # Wrap unexpected errors so callers get a uniform exception class
        raise ExtractorError(f"{type(extractor).__name__} failed: {exc}") from exc

