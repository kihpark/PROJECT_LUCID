"""Highlighted-text extractor (pass-through).

When the Chrome Extension's "Save selection" path fires, the raw
payload is the selected text bytes (UTF-8). Selection range metadata
(start/end offsets) comes in via client_metadata.

This extractor preserves the selection verbatim — no readability
extraction, no body reshaping. It's the simplest path in beta.
"""
from __future__ import annotations

from typing import Any

from api.extractors.base import Extractor, ExtractResult
from api.models.source import SourceType


def _detect_language_quick(text: str) -> str:
    if not text:
        return "mixed"
    hangul = sum(1 for c in text if "가" <= c <= "힣")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    total = hangul + latin
    if total == 0:
        return "mixed"
    ratio = hangul / total
    if ratio > 0.85:
        return "ko"
    if ratio < 0.05:
        return "en"
    return "mixed"


class HighlightedTextExtractor(Extractor):
    """Pass-through extractor for user-selected text."""

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.HIGHLIGHTED_TEXT

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        text = text.strip()

        selection_range = metadata.get("selection_range")
        page_url = metadata.get("source_url")
        page_title = metadata.get("page_title")

        return ExtractResult(
            merged_text=text,
            title=page_title,
            language=_detect_language_quick(text),  # type: ignore[arg-type]
            extracted_metadata={
                "selection_range": selection_range,
                "page_url": page_url,
                "selected_char_count": len(text),
            },
        )
