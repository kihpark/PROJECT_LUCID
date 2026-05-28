"""Extractor base class + result + exceptions (Sprint 2C PR-2C-2).

Every concrete extractor inherits `Extractor` and implements
`extract(raw, metadata) -> ExtractResult`. The dispatcher routes by
`source_type` and the processor (PR-2C-3) calls into the dispatcher.

Exceptions:
  ExtractorError       Base class. Raised by any extractor on
                       unrecoverable failure. Processor catches and
                       writes status='extract_failed' + error_message.
  NoTranscriptError    Subclass. YouTube has no transcript; the
                       dispatcher's youtube fallback chain catches
                       this and tries Whisper.
  UnknownSourceTypeError  Dispatcher cannot route the source_type.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from api.models.base import LucidBaseModel
from api.models.source import SourceType


class ExtractorError(Exception):
    """Base for any unrecoverable extraction failure."""


class NoTranscriptError(ExtractorError):
    """YouTube transcript is unavailable; caller should try Whisper."""


class UnknownSourceTypeError(ExtractorError):
    """Dispatcher has no extractor mapped to this source_type."""


class ExtractResult(LucidBaseModel):
    """Output of an Extractor.

    `merged_text` is the canonical body used by the Structure stage
    (Sprint 3). `extraction_warnings` accumulate non-fatal issues so
    the Decide overlay (Sprint 4A) can surface them ("output 일부
    누락", "paywall detected", "Whisper STT fallback used"). The
    persisted shape is `ExtractedContent` in api.models.source_job;
    the processor (PR-2C-3) converts ExtractResult -> ExtractedContent.
    """

    merged_text: str
    title: str | None = None
    author: str | None = None
    publish_date: datetime | None = None
    language: Literal["ko", "en", "mixed"] = "mixed"
    extracted_metadata: dict[str, Any] = Field(default_factory=dict)
    extraction_warnings: list[str] = Field(default_factory=list)


class Extractor(ABC):
    """Abstract extractor interface.

    Concrete subclasses are lightweight (no heavy imports at class
    instantiation; heavy imports go inside `extract()` so unit tests
    can mock without pulling lxml/whisper/etc.).
    """

    @abstractmethod
    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        """Run extraction and return an ExtractResult.

        `raw` is the source bytes (HTML, PDF, image, etc., gzip-
        decompressed by the caller). `metadata` carries the source URL,
        client-provided context (page title, selection range, etc.),
        and the SourceJob row's stable fields.
        """

    @abstractmethod
    def supports(self, source_type: SourceType) -> bool:
        """Return True if this extractor handles `source_type`."""
