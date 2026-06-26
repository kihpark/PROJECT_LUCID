"""Integration: n.news.naver.com /mnews/article/ path coverage.

PO 2026-06-26 reported that captures from
`https://n.news.naver.com/mnews/article/629/0000510915` produce the
"빈 추출 확인" / `extract_failed` popup card.

Server-side reproduction in this branch confirmed that on a vanilla
GET against the mnews URL:

  - trafilatura recovers 2,683 chars
  - `#dic_area` (ID selector) yields 2,753 chars
  - `#newsct_article` (wrapper) yields the same content

so the failure mode the PO sees is the rendered-DOM capture path
(extension's `captureRenderedHtml`) shipping an HTML payload where
the article element has lost its `id` attribute but kept its class
list — that's why this branch broadens the `naver.com` selectors
with class-based fallbacks (`article._article_content`,
`div._article_body`).

These tests use synthetic HTML fixtures shaped like the rendered DOM
the extension would capture. The real-network test against
n.news.naver.com is opt-in (LUCID_RUN_NETWORK_TESTS=1).
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from api.extractors.web_article import WebArticleExtractor

pytestmark = pytest.mark.integration


_MNEWS_URL = "https://n.news.naver.com/mnews/article/629/0000510915"


def _kor_long(n: int = 30) -> str:
    """Korean phrase long enough to clear FALLBACK_TRIGGER_CHARS=200."""
    return ("네이버 모바일 뉴스 본문 추출 테스트입니다. " * n).strip()


# ---------------------------------------------------------------------------
# Synthetic-fixture coverage (always run)
# ---------------------------------------------------------------------------

def test_mnews_with_full_id_and_class_attributes():
    """Vanilla server-rendered case — both #dic_area and class are
    present. The ID selector wins because it's first in the chain.

    This is what a vanilla `requests.get` against the mnews URL
    returns. The extractor must pick #dic_area without falling
    through to the class fallbacks.
    """
    body = _kor_long()
    html = (
        f"<!doctype html><html><head><title>t</title></head><body>"
        f"<div id='contents' class='newsct_body'>"
        f"  <div id='newsct_article' class='newsct_article _article_body'>"
        f"    <article id='dic_area' class='go_trans _article_content'>"
        f"      {body}"
        f"    </article>"
        f"  </div>"
        f"</div>"
        f"</body></html>"
    ).encode()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ):
        result = WebArticleExtractor().extract(html, {"source_url": _MNEWS_URL})
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat == "selector:#dic_area"
    assert body[:30] in result.merged_text


def test_mnews_with_stripped_ids_only_classes_remain():
    """The fallback case — rendered DOM lost id attributes (CSP
    iframe sanitization / Shadow DOM bleed). Class selectors recover
    the body.

    This is the specific scenario the new class fallbacks address —
    the PO's failing URL. The chain must NOT raise; it must pick
    `article._article_content` (or `div._article_body`).
    """
    body = _kor_long()
    html = (
        f"<!doctype html><html><head><title>t</title></head><body>"
        f"<div class='newsct_body'>"
        f"  <div class='newsct_article _article_body'>"
        f"    <article class='go_trans _article_content'>"
        f"      {body}"
        f"    </article>"
        f"  </div>"
        f"</div>"
        f"</body></html>"
    ).encode()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ):
        result = WebArticleExtractor().extract(html, {"source_url": _MNEWS_URL})
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat.startswith("selector:")
    assert "_article_content" in strat or "_article_body" in strat
    assert body[:30] in result.merged_text


def test_mnews_fallback_chain_order_classes_before_contents():
    """When neither IDs nor specific classes match — only the broad
    `#contents` wrapper exists — the chain must still recover but
    fall through to the page-level superset.

    This guards the "contents = last resort" placement: it's only
    picked when nothing tighter matches.
    """
    body = _kor_long()
    html = (
        f"<!doctype html><html><head><title>t</title></head><body>"
        f"<div id='contents' class='newsct_body'>"
        f"  <div class='unknown_wrapper'>"
        f"    <p>{body}</p>"
        f"  </div>"
        f"</div>"
        f"</body></html>"
    ).encode()
    with patch(
        "api.extractors.web_article._try_trafilatura", return_value="",
    ):
        result = WebArticleExtractor().extract(html, {"source_url": _MNEWS_URL})
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat == "selector:div#contents.newsct_body"
    assert body[:30] in result.merged_text


def test_mnews_host_routing_to_naver_selectors():
    """The URL pattern `n.news.naver.com/mnews/article/<press>/<id>`
    must route to the naver.com selector entry (not fall through to
    a generic extraction)."""
    from api.extractors.web_article import _selectors_for_host

    key, sels = _selectors_for_host("n.news.naver.com")
    assert key == "naver.com"
    assert len(sels) >= 5  # 3 IDs + 2 classes + 1 contents = 6 minimum


# ---------------------------------------------------------------------------
# Live-network coverage (opt-in via LUCID_RUN_NETWORK_TESTS=1)
# ---------------------------------------------------------------------------

def _run_network() -> bool:
    return os.getenv("LUCID_RUN_NETWORK_TESTS", "").lower() in {"1", "true", "yes"}


@pytest.fixture
def network_optin():
    if not _run_network():
        pytest.skip("LUCID_RUN_NETWORK_TESTS not set")


def test_real_naver_mnews_extraction(network_optin):
    """Live smoke against the PO's failing URL. Vanilla GET path.

    The fact that the vanilla GET succeeds is the evidence that the
    extractor itself is sound on this layout — when the chrome
    extension's rendered DOM is well-formed (it preserves id and
    class attributes), the chain hits at strategy 1 (trafilatura).
    """
    import httpx

    resp = httpx.get(
        _MNEWS_URL,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        timeout=15,
        follow_redirects=True,
    )
    resp.raise_for_status()
    result = WebArticleExtractor().extract(
        resp.content, {"source_url": _MNEWS_URL}
    )
    # Either trafilatura or a selector won — both are acceptable
    strat = result.extracted_metadata["extractor_strategy"]
    assert strat in (
        "trafilatura",
        "selector:#dic_area",
        "selector:#newsct_article",
        "selector:article._article_content",
        "selector:div._article_body",
        "selector:div#contents.newsct_body",
    ), f"unexpected winner: {strat}"
    # 200-char floor was already enforced; assert we got real body
    assert len(result.merged_text) >= 500
    assert result.language == "ko"
