"""Web article extractor — hybrid chain (chore 6 v2).

Extraction strategies, tried in order until one returns
>= FALLBACK_TRIGGER_CHARS of stripped text:

  1. trafilatura          primary; 95%+ of news + blog layouts including
                          most Korean publishers. Korean-morpheme aware.
  2. per-host selectors   backup for sites trafilatura misses. The list
                          in KOREAN_MEDIA_SELECTORS is BEST-EFFORT —
                          values were not verified against live pages
                          and should be updated when a site is found to
                          fall through.
  3. readability + bs4    the pre-chore-6 pipeline as third fallback.
  4. newspaper3k          final fallback before raising; older but
                          sometimes catches edge cases the other three
                          miss.

If every strategy produces empty / too-short merged_text we raise
ExtractorError with a site-aware diagnostic so the toast (PR-2A-2)
tells the user what to try next.

extracted_metadata['extractor_strategy'] records which strategy won
(`trafilatura` / `selector:#articletxt` / `readability` /
`newspaper3k`) for per-publisher hit-rate analytics.

Heavy imports stay inside `extract()` so the unit test suite can
exercise the class without trafilatura / readability / newspaper3k
all installed at import time.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from api.extractors.base import Extractor, ExtractorError, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.web")

PAYWALL_RATIO_THRESHOLD = 0.04  # body < 4% of full HTML -> suspected paywall
PAYWALL_ABS_FLOOR = 200  # characters; below this also warn

# Minimum recovered text length to call a strategy a hit. Strategies
# that return less than this are considered failures and the chain
# advances to the next layer.
FALLBACK_TRIGGER_CHARS = 200

# Per-host CSS selectors. The lookup is suffix-based: a URL whose host
# is `news.hankyung.com` matches the `hankyung.com` entry.
#
# BEST-EFFORT WARNING: these values were not verified against live
# pages in chore 6 v1; hankyung's `#articletxt` is known stale. When
# trafilatura covers the site they are dead code; when trafilatura
# misses, PO can fetch the page once and update the entry. Each list
# is tried in order; first selector that yields >= FALLBACK_TRIGGER_CHARS
# wins.
KOREAN_MEDIA_SELECTORS: dict[str, list[str]] = {
    "hankyung.com": [
        "#articletxt",  # legacy; verify
        ".article-body",
        ".article-content",
        "div[itemprop='articleBody']",
    ],
    "chosun.com": [
        "#fusion-app .article-body",
        "#news_body_id",
        ".par",
        ".article-body",
    ],
    "joongang.co.kr": [
        "#article_body",
        ".article_body",
        ".article_content",
    ],
    "donga.com": [
        ".article_txt",
        "#article_txt",
        "section.news_view",
    ],
    "mk.co.kr": [
        "#article_body",
        ".article_body",
    ],
    "naver.com": [
        "#dic_area",
        "#articleBodyContents",
    ],
    "daum.net": [
        "#harmonyContainer",
        ".article_view",
    ],
    "yna.co.kr": [
        "#articleWrap article",
        ".story-news",
    ],
    "ytn.co.kr": [
        "#CmAdContent",
        "#contentText",
    ],
    "kbs.co.kr": [
        ".detail-body",
        "#cont_newstext",
    ],
    "mbc.co.kr": [
        ".news_txt",
        "#content",
    ],
    "sbs.co.kr": [
        ".text_area",
        "#main_text",
    ],
}


def _detect_language(text: str) -> str:
    """Return 'ko' / 'en' / 'mixed' based on character ratios."""
    if not text:
        return "mixed"
    hangul = sum(1 for c in text if "\uac00" <= c <= "\ud7a3")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    total = hangul + latin
    if total == 0:
        return "mixed"
    ko_ratio = hangul / total
    if ko_ratio > 0.85:
        return "ko"
    if ko_ratio < 0.05:
        return "en"
    return "mixed"


def _selectors_for_host(host: str | None) -> tuple[str | None, list[str]]:
    """Suffix-match a host against KOREAN_MEDIA_SELECTORS."""
    if not host:
        return None, []
    host = host.lower()
    parts = host.split(".")
    for i in range(len(parts) - 1):
        candidate = ".".join(parts[i:])
        if candidate in KOREAN_MEDIA_SELECTORS:
            return candidate, KOREAN_MEDIA_SELECTORS[candidate]
    return None, []


# ---------------------------------------------------------------------------
# Strategy 1: trafilatura
# ---------------------------------------------------------------------------
def _try_trafilatura(html: str) -> str:
    """Return trafilatura's extracted body text or empty string on miss."""
    try:
        import trafilatura
    except ImportError:
        logger.warning("trafilatura not installed; skipping strategy")
        return ""
    try:
        text = trafilatura.extract(
            html,
            include_comments=False,
            include_tables=False,
            no_fallback=False,
            favor_recall=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("trafilatura raised: %s", exc)
        return ""
    return (text or "").strip()


# ---------------------------------------------------------------------------
# Strategy 2: per-host selectors against the raw HTML
# ---------------------------------------------------------------------------
def _try_selector_chain(html: str, selectors: list[str]) -> tuple[str, str | None]:
    """Returns (recovered_text, winning_selector) or ("", None)."""
    if not selectors:
        return "", None
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return "", None
    soup = BeautifulSoup(html, "lxml")
    for sel in selectors:
        try:
            nodes = soup.select(sel)
        except Exception as exc:  # noqa: BLE001 - bad selector shouldn't crash
            logger.info("selector %r raised: %s", sel, exc)
            continue
        if not nodes:
            logger.debug("selector %r matched 0 nodes", sel)
            continue
        lines: list[str] = []
        for node in nodes:
            for bad in node(["script", "style", "noscript"]):
                bad.decompose()
            for raw_line in node.get_text("\n").splitlines():
                stripped = raw_line.strip()
                if stripped:
                    lines.append(stripped)
        merged = "\n".join(lines)
        logger.info(
            "selector %r matched %d nodes, %d chars",
            sel, len(nodes), len(merged),
        )
        if len(merged) >= FALLBACK_TRIGGER_CHARS:
            return merged, sel
    return "", None


# ---------------------------------------------------------------------------
# Strategy 3: readability + BeautifulSoup (the pre-chore-6 pipeline)
# ---------------------------------------------------------------------------
def _try_readability(html: str) -> tuple[str, str | None]:
    """Returns (text, title_or_none) or ("", None) on miss / failure."""
    try:
        from bs4 import BeautifulSoup
        from readability import Document
    except ImportError:
        return "", None
    try:
        doc = Document(html)
        title = doc.short_title()
        body_html = doc.summary(html_partial=True)
    except Exception as exc:  # noqa: BLE001
        logger.info("readability raised: %s", exc)
        return "", None
    soup = BeautifulSoup(body_html, "lxml")
    for bad in soup(["script", "style", "noscript"]):
        bad.decompose()
    lines = [line.strip() for line in soup.get_text("\n").splitlines()]
    merged = "\n".join(line for line in lines if line)
    return merged.strip(), title


# ---------------------------------------------------------------------------
# Strategy 4: newspaper3k
# ---------------------------------------------------------------------------
def _try_newspaper(html: str, url: str | None) -> tuple[str, str | None]:
    """Returns (text, title) or ("", None) on miss / failure."""
    try:
        from newspaper import Article
    except ImportError:
        return "", None
    try:
        a = Article(url or "")
        a.set_html(html)
        a.parse()
    except Exception as exc:  # noqa: BLE001
        logger.info("newspaper3k raised: %s", exc)
        return "", None
    text = (a.text or "").strip()
    return text, (a.title or None)


# ---------------------------------------------------------------------------
# WebArticleExtractor — orchestrates the chain
# ---------------------------------------------------------------------------
class WebArticleExtractor(Extractor):
    """Hybrid HTML article body extractor."""

    source_type = SourceType.WEB_ARTICLE

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.WEB_ARTICLE

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        # Heavy imports inside the method
        from bs4 import BeautifulSoup

        html = (
            raw.decode("utf-8", errors="replace") if isinstance(raw, bytes)
            else str(raw)
        )
        full_len = len(html) or 1
        url = metadata.get("source_url") or ""
        host = urlparse(url).hostname
        host_key, selectors = _selectors_for_host(host)

        warnings: list[str] = []
        strategy_used: str | None = None
        title: str | None = metadata.get("page_title")
        merged_text = ""
        attempts: list[str] = []

        # Strategy 1 — trafilatura
        attempts.append("trafilatura")
        recovered = _try_trafilatura(html)
        logger.info(
            "extractor[1/trafilatura] host=%s len=%d", host, len(recovered),
        )
        if len(recovered) >= FALLBACK_TRIGGER_CHARS:
            merged_text = recovered
            strategy_used = "trafilatura"

        # Strategy 2 — per-host selector chain
        if not merged_text and selectors:
            attempts.append(f"selectors:{host_key}")
            recovered, winning_sel = _try_selector_chain(html, selectors)
            logger.info(
                "extractor[2/selectors] host=%s key=%s winner=%s len=%d",
                host, host_key, winning_sel, len(recovered),
            )
            if recovered:
                merged_text = recovered
                strategy_used = f"selector:{winning_sel}"
                warnings.append(
                    f"Used site-specific selector for {host_key}: {winning_sel}"
                )

        # Strategy 3 — readability + bs4
        if not merged_text:
            attempts.append("readability")
            recovered, r_title = _try_readability(html)
            logger.info(
                "extractor[3/readability] host=%s len=%d title=%s",
                host, len(recovered), bool(r_title),
            )
            if len(recovered) >= FALLBACK_TRIGGER_CHARS:
                merged_text = recovered
                strategy_used = "readability"
                title = title or r_title

        # Strategy 4 — newspaper3k
        if not merged_text:
            attempts.append("newspaper3k")
            recovered, n_title = _try_newspaper(html, url)
            logger.info(
                "extractor[4/newspaper3k] host=%s len=%d title=%s",
                host, len(recovered), bool(n_title),
            )
            if len(recovered) >= FALLBACK_TRIGGER_CHARS:
                merged_text = recovered
                strategy_used = "newspaper3k"
                title = title or n_title

        # All strategies failed — site-aware ExtractorError
        if not merged_text.strip():
            if host_key:
                raise ExtractorError(
                    f"Article body not found on {host_key}. "
                    f"Tried {', '.join(attempts)}. "
                    f"Selectors tried: {', '.join(selectors)}. "
                    f"Try the selection-save action instead."
                )
            raise ExtractorError(
                f"Article body not found at {host or 'this URL'}. "
                f"Tried {', '.join(attempts)}. "
                "The page may be paywalled, JavaScript-rendered, or use an "
                "unusual layout. Try the selection-save action instead."
            )

        # Pull author + publish_date from raw HTML meta tags regardless of
        # which strategy won the body.
        meta_soup = BeautifulSoup(html, "lxml")
        author = _meta_value(meta_soup, ["author", "article:author"])
        publish_date_str = _meta_value(
            meta_soup, ["article:published_time", "pubdate", "date"]
        )
        publish_date: datetime | None = None
        if publish_date_str:
            try:
                publish_date = datetime.fromisoformat(
                    publish_date_str.replace("Z", "+00:00")
                )
            except ValueError:
                warnings.append(f"Unparseable publish_date: {publish_date_str}")

        body_len = len(merged_text)
        if (
            body_len < PAYWALL_ABS_FLOOR
            or body_len / full_len < PAYWALL_RATIO_THRESHOLD
        ):
            warnings.append("Possible paywall: extracted body shorter than expected.")

        language = _detect_language(merged_text)

        return ExtractResult(
            merged_text=merged_text,
            title=title,
            author=author,
            publish_date=publish_date,
            language=language,  # type: ignore[arg-type]
            extracted_metadata={
                "source_url": url,
                "body_char_count": body_len,
                "full_html_char_count": full_len,
                "extractor_strategy": strategy_used,
                "strategies_attempted": attempts,
            },
            extraction_warnings=warnings,
        )


def _meta_value(soup: Any, keys: list[str]) -> str | None:
    """Pick the first non-empty `<meta>` value by name/property in `keys`."""
    for key in keys:
        node = soup.find("meta", attrs={"name": key}) or soup.find(
            "meta", attrs={"property": key}
        )
        if node is not None:
            value = node.get("content")
            if value:
                return value
    return None
