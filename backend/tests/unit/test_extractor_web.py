"""Unit tests for the v2 hybrid web_article extractor.

The chain (in order):
  1. trafilatura
  2. per-host CSS selectors (KOREAN_MEDIA_SELECTORS)
  3. readability + BeautifulSoup
  4. newspaper3k
  5. ExtractorError (site-aware diagnostic)

Tests use stubs to force a strategy to "win" so the chain ordering is
deterministic. The host-suffix matcher gets its own test because that
helper is the one the v1 work didn't exercise.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from api.extractors.base import ExtractorError
from api.extractors.web_article import (
    FALLBACK_TRIGGER_CHARS,
    KOREAN_MEDIA_SELECTORS,
    WebArticleExtractor,
    _selectors_for_host,
)


def _html(body_html: str) -> bytes:
    return (
        f"<!doctype html><html><head><title>t</title></head>"
        f"<body>{body_html}</body></html>"
    ).encode()


def _kor_long(n: int = 25) -> str:
    """A Korean phrase long enough to clear FALLBACK_TRIGGER_CHARS."""
    return ("한국경제 기사 본문 테스트입니다. " * n).strip()


# ---------------------------------------------------------------------------
# Host suffix matcher
# ---------------------------------------------------------------------------

def test_selectors_for_host_exact_match():
    key, sels = _selectors_for_host("hankyung.com")
    assert key == "hankyung.com"
    assert "#articletxt" in sels


def test_selectors_for_host_subdomain_match():
    key, sels = _selectors_for_host("news.naver.com")
    assert key == "naver.com"
    assert "#dic_area" in sels


def test_selectors_for_host_unknown_returns_empty():
    key, sels = _selectors_for_host("randomblog.example.io")
    assert key is None
    assert sels == []


# ---------------------------------------------------------------------------
# Strategy ordering — each layer is stubbed to be the winner
# ---------------------------------------------------------------------------

def test_trafilatura_wins_when_it_returns_long_enough():
    """Strategy 1 — trafilatura content sufficient -> chain stops here."""
    body = _kor_long()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value=body,
    ):
        result = WebArticleExtractor().extract(
            _html("<div>noise</div>"),
            {"source_url": "https://www.hankyung.com/article/xyz"},
        )
    assert body[:20] in result.merged_text
    assert result.extracted_metadata["extractor_strategy"] == "trafilatura"
    assert result.extracted_metadata["strategies_attempted"] == ["trafilatura"]


def test_selectors_win_when_trafilatura_returns_short():
    """Strategy 2 — trafilatura too short, selector hit on hankyung."""
    body = _kor_long()
    raw = _html(f"<div id='articletxt'>{body}</div>")
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="x",
    ):
        result = WebArticleExtractor().extract(
            raw, {"source_url": "https://www.hankyung.com/article/xyz"},
        )
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat.startswith("selector:")
    assert "articletxt" in strat
    assert "selectors:hankyung.com" in result.extracted_metadata["strategies_attempted"]


def test_readability_wins_when_first_two_strategies_miss():
    """Strategy 3 — readability hit when nothing earlier worked."""
    body = _kor_long()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ), patch(
        "api.extractors.web_article._try_selector_chain",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_readability",
        return_value=(body, "T"),
    ):
        result = WebArticleExtractor().extract(
            _html("<div>x</div>"),
            {"source_url": "https://unknown.example/post/1"},
        )
    assert result.extracted_metadata["extractor_strategy"] == "readability"
    assert "readability" in result.extracted_metadata["strategies_attempted"]


def test_newspaper3k_wins_as_final_fallback():
    body = _kor_long()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ), patch(
        "api.extractors.web_article._try_selector_chain",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_readability",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_newspaper",
        return_value=(body, "T"),
    ):
        result = WebArticleExtractor().extract(
            _html("<div>x</div>"),
            {"source_url": "https://unknown.example/post/1"},
        )
    assert result.extracted_metadata["extractor_strategy"] == "newspaper3k"
    assert "newspaper3k" in result.extracted_metadata["strategies_attempted"]


# ---------------------------------------------------------------------------
# ExtractorError diagnostics
# ---------------------------------------------------------------------------

def test_known_host_all_strategies_fail_raises_site_aware_error():
    """Every strategy returns empty/short -> site-aware diagnostic."""
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ), patch(
        "api.extractors.web_article._try_selector_chain",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_readability",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_newspaper",
        return_value=("", None),
    ):
        with pytest.raises(ExtractorError) as exc:
            WebArticleExtractor().extract(
                _html(""),
                {"source_url": "https://www.hankyung.com/article/xyz"},
            )
    msg = str(exc.value)
    assert "hankyung.com" in msg
    assert "trafilatura" in msg
    assert "selection-save" in msg


def test_unknown_host_all_strategies_fail_raises_generic_error():
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ), patch(
        "api.extractors.web_article._try_selector_chain",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_readability",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_newspaper",
        return_value=("", None),
    ):
        with pytest.raises(ExtractorError) as exc:
            WebArticleExtractor().extract(
                _html(""),
                {"source_url": "https://example.com/post/1"},
            )
    msg = str(exc.value)
    assert "example.com" in msg
    assert "paywalled" in msg or "JavaScript-rendered" in msg
    assert "selection-save" in msg


def test_strategy_threshold_is_200_chars():
    """A 199-char body is "short" — strategies that return only that
    much are NOT treated as winners; the chain advances."""
    short = "한" * 100  # 100 chars, well below FALLBACK_TRIGGER_CHARS=200
    assert FALLBACK_TRIGGER_CHARS > len(short)
    body = _kor_long()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value=short,
    ), patch(
        "api.extractors.web_article._try_selector_chain",
        return_value=("", None),
    ), patch(
        "api.extractors.web_article._try_readability",
        return_value=(body, None),
    ):
        result = WebArticleExtractor().extract(
            _html("x"), {"source_url": "https://www.unknown.com/p"},
        )
    assert result.extracted_metadata["extractor_strategy"] == "readability"


# ---------------------------------------------------------------------------
# capture-naver-fix (PO 2026-06-24): n.news.naver.com mnews URL pattern
# ---------------------------------------------------------------------------

def test_naver_mnews_host_routes_to_naver_selectors():
    """The PO's failing URL pattern: n.news.naver.com/mnews/article/...

    Server-side reproduction confirmed `#dic_area` recovers the body
    cleanly on this layout. The host-suffix matcher must therefore
    route `n.news.naver.com` -> the `naver.com` selector entry.
    """
    key, sels = _selectors_for_host("n.news.naver.com")
    assert key == "naver.com"
    assert "#dic_area" in sels


def test_naver_selectors_cover_modern_mnews_layout():
    """The 2023+ mnews layout uses `#newsct_article` as the article
    wrapper. We keep it as belt-and-suspenders for when the inner
    `#dic_area` disappears in a future redesign."""
    _, sels = _selectors_for_host("n.news.naver.com")
    assert "#newsct_article" in sels
    # `#articleBodyContents` is kept for the pre-2023 archive layout.
    assert "#articleBodyContents" in sels


def test_naver_mnews_selector_chain_recovers_body():
    """End-to-end on a synthetic n.news.naver.com mnews HTML: trafilatura
    is stubbed to miss (simulating the "extension shipped empty
    outerHTML" failure mode where trafilatura returned <200 chars),
    and the selector chain rescues #dic_area.

    This is the regression test for the failing URL pattern. The fix
    is in `api.structure.claude_client._drop_facts_without_subject`
    (the actual root cause was Structure-stage subject_uid=null
    rejection), but extractor robustness on this layout is also part
    of the fix scope and the chain must continue to work.
    """
    body = _kor_long(30)
    raw = _html(
        f"<article id='newsct_article'>"
        f"<div id='dic_area'>{body}</div>"
        f"</article>"
    )
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ):
        result = WebArticleExtractor().extract(
            raw,
            {"source_url": "https://n.news.naver.com/mnews/article/001/0015421921"},
        )
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat.startswith("selector:")
    # Either #dic_area or #newsct_article is acceptable — both are in
    # the chain and either is a correct outcome.
    assert "dic_area" in strat or "newsct_article" in strat
    assert body[:20] in result.merged_text


# ---------------------------------------------------------------------------
# 12 Korean publishers must all have entries
# ---------------------------------------------------------------------------

def test_all_12_korean_publishers_have_selector_lists():
    expected = {
        "hankyung.com", "chosun.com", "joongang.co.kr", "donga.com",
        "mk.co.kr", "naver.com", "daum.net", "yna.co.kr",
        "ytn.co.kr", "kbs.co.kr", "mbc.co.kr", "sbs.co.kr",
    }
    assert expected.issubset(set(KOREAN_MEDIA_SELECTORS.keys()))
    for host, sels in KOREAN_MEDIA_SELECTORS.items():
        assert sels, f"{host} entry is empty"
        for sel in sels:
            assert isinstance(sel, str) and sel.strip()
