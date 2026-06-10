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


# ---------------------------------------------------------------------------
# chore 6 — Korean media fallback + diagnostic ExtractorError
# ---------------------------------------------------------------------------
def _wrap_html(body_html: str) -> bytes:
    return (
        f"<!doctype html><html><head><title>t</title></head>"
        f"<body>{body_html}</body></html>"
    ).encode()


def test_hankyung_selector_fallback_recovers_body():
    """A hankyung-style article with empty readability output recovers
    via the #articletxt selector chain."""
    from api.extractors.web_article import WebArticleExtractor

    # Use real Korean text (>= 200 chars after merging) so the
    # FALLBACK_TRIGGER_CHARS threshold is crossed naturally.
    body = "한국경제 기사 본문입니다. 한경 기사 테스트. " * 30
    raw = _wrap_html(
        f"<div class='ad'>ad ad ad</div>"
        f"<div id='articletxt'><p>{body}</p></div>"
    )
    result = WebArticleExtractor().extract(
        raw, {"source_url": "https://www.hankyung.com/article/2026010101"}
    )
    assert "한국경제 기사 본문" in result.merged_text
    assert (
        result.extracted_metadata["extractor_strategy"]
        in ("selector:#articletxt", "readability")
    )


def test_chosun_selector_fallback_uses_par_class():
    """A chosun-style layout with .par paragraphs recovers."""
    from api.extractors.web_article import WebArticleExtractor

    body = "<p class='par'>" + "조선일보 기사 본문 테스트. " * 50 + "</p>"
    raw = _wrap_html(f"<div class='ad'>ad</div>{body}")
    result = WebArticleExtractor().extract(
        raw, {"source_url": "https://news.chosun.com/site/data/html/2026/01.html"}
    )
    assert "조선일보 기사 본문" in result.merged_text


def test_unknown_host_with_empty_body_raises_with_url_hint():
    """Unknown host + nothing usable -> ExtractorError mentioning host."""
    import pytest

    from api.extractors.base import ExtractorError
    from api.extractors.web_article import WebArticleExtractor

    # Empty body produces truly empty merged_text (no <title>/<div>x
    # leaking through readability's fallback path).
    raw = b"<!doctype html><html><head></head><body></body></html>"
    with pytest.raises(ExtractorError) as exc_info:
        WebArticleExtractor().extract(
            raw, {"source_url": "https://example.com/whatever"}
        )
    msg = str(exc_info.value)
    assert "example.com" in msg
    assert "selection-save" in msg


def test_known_host_empty_layout_raises_with_selectors_listed():
    """Known host + no selector hits -> ExtractorError lists the
    selectors tried so PO can see what failed."""
    import pytest

    from api.extractors.base import ExtractorError
    from api.extractors.web_article import WebArticleExtractor

    raw = b"<!doctype html><html><head></head><body></body></html>"
    with pytest.raises(ExtractorError) as exc_info:
        WebArticleExtractor().extract(
            raw, {"source_url": "https://www.hankyung.com/article/xyz"}
        )
    msg = str(exc_info.value)
    assert "hankyung.com" in msg
    assert "#articletxt" in msg
    assert "selection-save" in msg


def test_selector_suffix_matching_subdomain():
    """news.naver.com should match the `naver.com` entry."""
    from api.extractors.web_article import _selectors_for_host

    key, sels = _selectors_for_host("news.naver.com")
    assert key == "naver.com"
    assert "#dic_area" in sels
