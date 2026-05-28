"""Unit: web_article extractor."""
from __future__ import annotations

from api.extractors.web_article import WebArticleExtractor, _detect_language


def test_detect_language_ko():
    assert _detect_language("한국어 텍스트만") == "ko"


def test_detect_language_en():
    assert _detect_language("This is purely English text.") == "en"


def test_detect_language_mixed():
    assert _detect_language("English mixed 한국어 text") == "mixed"


def test_web_extractor_strips_script_style_and_extracts_title():
    html = (
        '<html><head><title>Real Title</title>'
        '<meta name="author" content="Jane Doe"></head>'
        '<body><h1>Header</h1><article><p>This is the body of the article that should be long enough to clear the paywall warning floor. ' + ("Filler. " * 100) + '</p></article>'
        '<script>alert(1)</script><style>.x{}</style></body></html>'
    ).encode("utf-8")
    e = WebArticleExtractor()
    result = e.extract(html, {"source_url": "https://example.com"})
    assert "alert(1)" not in result.merged_text
    assert ".x{}" not in result.merged_text
    assert "body of the article" in result.merged_text
    # paywall warning should NOT fire
    assert not any("paywall" in w.lower() for w in result.extraction_warnings)


def test_web_extractor_paywall_warning_on_short_body():
    """When readability extracts a body whose char-count falls under the
    PAYWALL_ABS_FLOOR (200), the warning must fire."""
    html = b"<html><head><title>X</title></head><body><article><p>too short</p></article></body></html>"
    result = WebArticleExtractor().extract(html, {})
    # body length is well below 200 chars, so paywall warning is mandatory
    assert any("paywall" in w.lower() for w in result.extraction_warnings), (
        f"warnings: {result.extraction_warnings}; body: {result.merged_text!r}"
    )
