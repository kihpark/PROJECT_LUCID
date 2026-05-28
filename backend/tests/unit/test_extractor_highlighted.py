"""Unit: highlighted_text extractor — pass-through behavior."""
from __future__ import annotations

from api.extractors.highlighted_text import HighlightedTextExtractor


def test_pass_through_preserves_text():
    text = "선택한 한국어 텍스트 그대로"
    out = HighlightedTextExtractor().extract(
        text.encode("utf-8"),
        {"source_url": "https://x", "selection_range": {"start": 0, "end": 11}},
    )
    assert out.merged_text == text
    assert out.language == "ko"
    assert out.extracted_metadata["selection_range"] == {"start": 0, "end": 11}


def test_pass_through_english_marks_language():
    out = HighlightedTextExtractor().extract(b"this is purely english text", {"source_url": "x"})
    assert out.language == "en"


def test_pass_through_strips_whitespace():
    out = HighlightedTextExtractor().extract(b"   hello   \n", {})
    assert out.merged_text == "hello"
