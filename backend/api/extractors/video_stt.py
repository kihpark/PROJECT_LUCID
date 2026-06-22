"""Video/audio STT extractor — dedicated capture adapter (B-46 PR1).

Handles ``SourceType.VIDEO_STT`` jobs submitted via
``POST /api/capture/video``.

Pipeline
--------
1. Determine audio source: use ``metadata["local_file_path"]`` when set
   (file-upload path), otherwise download from ``metadata["source_url"]``
   via yt-dlp.
2. Probe duration with ffprobe and apply the hard duration gate.
3. Re-encode to 16 kHz mono WAV via ffmpeg.
4. Transcribe with the configured STT engine (default: WhisperLocalEngine).
5. Build ``merged_text`` (newline-joined segment texts) and
   ``segment_timecodes`` (list of timed spans with char offsets into
   ``merged_text`` — used by the structure processor to attach
   per-fact video locators).
6. Clean up the temp work dir unconditionally in ``finally``.

The extractor intentionally does NOT load faster-whisper at import time
— ``WhisperLocalEngine`` is imported lazily inside the constructor so
unit tests can inject a mock engine via the ``engine=`` argument without
pulling native libraries.
"""
from __future__ import annotations

import logging
import shutil
import tempfile
from typing import Any

from api.capture.stt.gate import HardLimitExceeded, check_duration
from api.extractors.base import Extractor, ExtractorError, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.video_stt")


def _build_segment_timecodes(
    segments: Any,  # tuple[TranscriptSegment, ...] — typed loosely to avoid early import
    merged_text: str,
) -> list[dict[str, Any]]:
    """Compute per-segment timecodes with character offsets into ``merged_text``.

    ``char_start`` / ``char_end`` record where each segment's text lives
    inside ``merged_text`` (the newline-joined full transcript). The
    structure processor uses these to map a fact's surface text back to
    the originating segment, enabling per-fact video locators.
    """
    timecodes: list[dict[str, Any]] = []
    cursor = 0
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        char_start = cursor
        char_end = cursor + len(text)
        timecodes.append(
            {
                "text": text,
                "start_ms": seg.start_ms,
                "end_ms": seg.end_ms,
                "speaker": seg.speaker,
                "char_start": char_start,
                "char_end": char_end,
            }
        )
        # +1 for the '\n' joiner between segments
        cursor = char_end + 1
    return timecodes


class VideoSttExtractor(Extractor):
    """Dedicated STT extractor for generic video/audio URLs.

    Parameters
    ----------
    engine:
        Override the STT engine (useful for tests). When ``None``
        (default) a fresh ``WhisperLocalEngine`` is constructed on
        first use.
    """

    def __init__(self, engine: Any | None = None) -> None:
        self._engine = engine

    def _get_engine(self) -> Any:
        if self._engine is not None:
            return self._engine
        # Lazy import so unit tests can mock without loading faster_whisper.
        from api.capture.stt.whisper_local import WhisperLocalEngine

        return WhisperLocalEngine()

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.VIDEO_STT

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:  # noqa: ARG002
        """Run STT extraction and return an ExtractResult.

        ``raw`` is ignored for VIDEO_STT (the media lives at ``source_url``
        or ``local_file_path``); it's accepted to satisfy the base class
        contract.
        """
        from api.capture.stt import audio_io

        source_url: str = metadata.get("source_url") or ""
        local_file_path: str | None = metadata.get("local_file_path")
        language_hint: str | None = metadata.get("language_hint")

        workdir = tempfile.mkdtemp(prefix="lucid-vstt-")
        try:
            # Step 1: resolve the media file
            if local_file_path:
                media_path = local_file_path
            else:
                if not source_url:
                    raise ExtractorError("VIDEO_STT requires source_url or local_file_path")
                try:
                    media_path = audio_io.download_from_url(source_url, workdir)
                except Exception as exc:
                    raise ExtractorError(f"audio download failed: {exc}") from exc

            # Step 2: probe duration + apply gate
            duration_ms = audio_io.get_duration_ms(media_path)
            try:
                check_duration(duration_ms)
            except HardLimitExceeded as exc:
                raise ExtractorError(
                    f"hard_limit_exceeded: duration_ms={exc.duration_ms} limit_ms={exc.limit_ms}"
                ) from exc

            # Step 3: re-encode to 16 kHz mono WAV
            try:
                wav_path = audio_io.extract_audio(media_path, workdir)
            except Exception as exc:
                raise ExtractorError(f"audio re-encode failed: {exc}") from exc

            # Step 4: transcribe
            engine = self._get_engine()
            try:
                transcript = engine.transcribe(wav_path, language_hint=language_hint)
            except ExtractorError:
                raise
            except Exception as exc:
                raise ExtractorError(f"STT engine failed: {exc}") from exc

            # Step 5: build merged_text + segment timecodes
            merged_text = transcript.full_text
            timecodes = _build_segment_timecodes(transcript.segments, merged_text)

            # Normalise language label (match existing convention)
            lang_raw = transcript.language or "mixed"
            if lang_raw.startswith("ko"):
                lang_label = "ko"
            elif lang_raw.startswith("en"):
                lang_label = "en"
            else:
                lang_label = "mixed"

            title = metadata.get("page_title") or metadata.get("title")

            return ExtractResult(
                merged_text=merged_text,
                title=title,
                language=lang_label,  # type: ignore[arg-type]
                extracted_metadata={
                    "video_stt": {
                        "engine": transcript.engine_name,
                        "duration_ms": duration_ms or transcript.duration_ms,
                        "media_url": source_url,
                        "segment_timecodes": timecodes,
                    }
                },
            )

        finally:
            shutil.rmtree(workdir, ignore_errors=True)

