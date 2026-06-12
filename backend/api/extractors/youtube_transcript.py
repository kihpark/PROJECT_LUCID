"""YouTube transcript extractor.

Uses `youtube-transcript-api` to fetch the auto-generated or
human-uploaded captions for a video. The dispatcher routes calls
here first; if `NoTranscriptError` fires, the dispatcher falls back
to `YoutubeWhisperExtractor`.

`metadata` must include `source_url` (the YouTube URL). `raw` is
ignored (the API fetches by video_id, not from local bytes).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlparse

from api.extractors.base import Extractor, ExtractResult, NoTranscriptError
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.youtube")

# Common YouTube URL forms; captures the video id in group 1.
_YT_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})"),
]
_LANG_PRIORITY = ("ko", "en", "en-US", "ko-KR")


def _video_id_from_url(url: str) -> str | None:
    if not url:
        return None
    # Try regex patterns first
    for pat in _YT_PATTERNS:
        m = pat.search(url)
        if m:
            return m.group(1)
    # Fallback: parse query string
    try:
        parts = urlparse(url)
        qs = parse_qs(parts.query)
        if "v" in qs and qs["v"]:
            candidate = qs["v"][0]
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                return candidate
    except ValueError:
        pass
    return None


class YoutubeTranscriptExtractor(Extractor):
    """YouTube transcript fetcher.

    Raises NoTranscriptError when the video has no captions in any
    of the preferred languages. The dispatcher catches this and
    routes to YoutubeWhisperExtractor.
    """

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.YOUTUBE

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        source_url = metadata.get("source_url", "")
        video_id = _video_id_from_url(source_url)
        if video_id is None:
            raise NoTranscriptError(
                f"Cannot parse a YouTube video id from URL: {source_url!r}"
            )

        # Lazy import — keep youtube-transcript-api out of the import path
        # for processes that never touch YouTube.
        try:
            from youtube_transcript_api import (  # type: ignore[import-not-found]
                NoTranscriptFound,
                TranscriptsDisabled,
                YouTubeTranscriptApi,
            )
        except ImportError as exc:
            raise NoTranscriptError(
                "youtube-transcript-api not installed; install or use Whisper"
            ) from exc

        try:
            # v1.x: list_transcripts is no longer a classmethod; must
            # instantiate then call .list(video_id).
            transcripts = YouTubeTranscriptApi().list(video_id)
        except (TranscriptsDisabled, Exception) as exc:  # noqa: BLE001
            raise NoTranscriptError(str(exc)) from exc

        # Prefer Korean / English; fall back to whatever's available.
        try:
            transcript = transcripts.find_transcript(list(_LANG_PRIORITY))
        except NoTranscriptFound:
            try:
                transcript = next(iter(transcripts))
            except StopIteration as exc:
                raise NoTranscriptError("no transcripts available") from exc
        except Exception as exc:  # noqa: BLE001
            raise NoTranscriptError(str(exc)) from exc

        try:
            # v1.x: .fetch() returns FetchedTranscript (not list[dict]);
            # .to_raw_data() converts to the v0.x-compatible shape that
            # the iteration loop below expects.
            entries = transcript.fetch().to_raw_data()
        except Exception as exc:  # noqa: BLE001
            raise NoTranscriptError(f"fetch failed: {exc}") from exc

        # Build merged_text + timestamps
        lines: list[str] = []
        timestamps: list[dict[str, float | str]] = []
        for entry in entries:
            text = (entry.get("text") or "").strip()
            if not text:
                continue
            start = float(entry.get("start") or 0.0)
            duration = float(entry.get("duration") or 0.0)
            lines.append(text)
            timestamps.append({"start": start, "duration": duration, "text": text})

        merged_text = "\n".join(lines)
        language: str = transcript.language_code if hasattr(transcript, "language_code") else "mixed"
        if language.startswith("ko"):
            lang_label = "ko"
        elif language.startswith("en"):
            lang_label = "en"
        else:
            lang_label = "mixed"

        return ExtractResult(
            merged_text=merged_text,
            title=metadata.get("page_title"),
            language=lang_label,  # type: ignore[arg-type]
            publish_date=_parse_publish_date(metadata.get("published_at")),
            extracted_metadata={
                "video_id": video_id,
                "transcript_language": language,
                "is_auto_generated": getattr(transcript, "is_generated", False),
                "timestamps": timestamps,
            },
        )


def _parse_publish_date(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
