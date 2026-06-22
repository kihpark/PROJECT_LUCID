"""Faster-whisper local engine (B-46 PR1).

Default STT engine for the video/audio capture adapter. Uses
``faster-whisper`` with ``large-v3`` by default for production-grade
Korean accuracy (PO directive). Model name and download dir are
configurable via env vars so CI/test environments can point at a
lighter model without code changes.

Environment variables
---------------------
STT_WHISPER_MODEL
    faster-whisper model name. Default ``large-v3``.
FASTER_WHISPER_DOWNLOAD_DIR
    Directory where model weights are cached. Default ``/models``.

Concurrency
-----------
Module-level ``_TRANSCRIBE_LOCK`` (``threading.Lock``) ensures only
one transcription runs at a time per process, matching the pattern in
``youtube_whisper.py``.

Model loading
-------------
Lazy — ``_load_model()`` constructs the ``WhisperModel`` on first call
and caches it in ``_MODEL``. Tests reset the cache via
``_reset_model()``.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any

from api.capture.stt.engine import Transcript, TranscriptSegment

logger = logging.getLogger("lucid.capture.stt.whisper_local")

STT_WHISPER_MODEL: str = os.getenv("STT_WHISPER_MODEL", "large-v3")
STT_DOWNLOAD_DIR: str = os.getenv("FASTER_WHISPER_DOWNLOAD_DIR", "/models")

_TRANSCRIBE_LOCK = threading.Lock()
_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()


def _load_model() -> Any:
    """Construct and cache the WhisperModel. Thread-safe lazy init."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is None:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]

            _MODEL = WhisperModel(
                STT_WHISPER_MODEL,
                device="auto",
                compute_type="auto",
                download_root=STT_DOWNLOAD_DIR,
            )
            logger.info(
                "Loaded Whisper model %s from %s", STT_WHISPER_MODEL, STT_DOWNLOAD_DIR
            )
    return _MODEL


def _reset_model() -> None:
    """Test-only: drop the cached model so the next call constructs fresh."""
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None


class WhisperLocalEngine:
    """STT engine backed by faster-whisper (large-v3 default).

    Satisfies the ``STTEngine`` Protocol. Keeps the faster-whisper
    import inside ``transcribe`` (via ``_load_model``) so unit tests
    can mock without pulling the native library.
    """

    name: str = "whisper-local-v3"

    def transcribe(
        self,
        audio_path: str,
        *,
        language_hint: str | None = None,
    ) -> Transcript:
        """Transcribe ``audio_path`` using faster-whisper.

        Parameters
        ----------
        audio_path:
            Path to a wav / mp3 file. The extractor always passes a
            16 kHz mono WAV.
        language_hint:
            BCP-47 tag override (e.g. ``"ko"``). ``None`` means
            auto-detect.
        """
        with _TRANSCRIBE_LOCK:
            model = _load_model()
            segments_iter, info = model.transcribe(
                audio_path,
                beam_size=5,
                language=language_hint,  # None = auto-detect
            )

            raw_segs: list[TranscriptSegment] = []
            for seg in segments_iter:
                text = (seg.text or "").strip()
                if not text:
                    continue
                raw_segs.append(
                    TranscriptSegment(
                        start_ms=int(seg.start * 1000),
                        end_ms=int(seg.end * 1000),
                        text=text,
                    )
                )

            detected_lang: str = (
                info.language if hasattr(info, "language") else "unknown"
            )
            duration_ms: int = (
                int(info.duration * 1000) if hasattr(info, "duration") else 0
            )

            return Transcript(
                segments=tuple(raw_segs),
                language=detected_lang,
                engine_name=self.name,
                duration_ms=duration_ms,
            )
