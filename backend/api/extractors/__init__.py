"""Lucid Capture-stage extractors (Sprint 2C PR-2C-2).

Six concrete extractors (`youtube` has two: transcript and whisper)
plus a dispatcher with a YouTube fallback chain (transcript first,
Whisper STT on `NoTranscriptError`).

Module-level Whisper model + a single-transcribe lock live in
`youtube_whisper.py`; both are lazy so importing this package on
a process without ffmpeg/cuda is cheap.
"""
from api.extractors.base import (
    Extractor,
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

__all__ = [
    "SOURCE_TYPE_TO_EXTRACTOR",
    "extract",
    "extract_youtube",
    "get_extractor",
    "Extractor",
    "ExtractResult",
    "ExtractorError",
    "NoTranscriptError",
    "UnknownSourceTypeError",
]
