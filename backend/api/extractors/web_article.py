"""Web article extractor.

Heuristic pipeline:
  1. readability.Document   -> main article body (HTML)
  2. BeautifulSoup          -> visible text
  3. Per-host selector fallback (chore 6)
                              if (1) + (2) yield too little, try the
                              site-specific selectors listed in
                              KOREAN_MEDIA_SELECTORS against the raw
                              HTML and use whichever produces useful
                              text. Covers major Korean publishers.
  4. langdetect             -> 'ko' / 'en' / 'mixed' label
  5. Paywall heuristic      -> warning if body too short relative to <html>
  6. Empty-body guard       -> raise ExtractorError with a
                              site-specific diagnostic so the toast
                              tells the user what to try next.

Heavy imports are inside `extract()` so the unit test suite can
exercise the class without lxml installed.
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

# chore 6 — when readability gives us less than this many usable
# characters, treat it as a miss and run the per-host selector chain.
FALLBACK_TRIGGER_CHARS = 200

# Per-host CSS selectors. The lookup is suffix-based: a URL whose host
# is `news.hankyung.com` matches the `hankyung.com` entry. List order
# is significance order — first selector that yields >= FALLBACK_TRIGGER_CHARS
# wins.
KOREAN_MEDIA_SELECTORS: dict[str, list[str]] = {
    "hankyung.com": [
        "#articletxt",
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
    """Return 'ko' / 'en' / 'mixed' based on character ratios + langdetect."""
    if not text:
        return "mixed"
    # Cheap heuristic first: count Hangul vs Latin
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
    """Suffix-match a host against KOREAN_MEDIA_SELECTORS.

    Returns the matched key + the selector list, or (None, []) when
    no entry covers this host.
    """
    if not host:
        return None, []
    host = host.lower()
    # Try the host itself, then progressively shorter suffixes:
    #   news.hankyung.com -> hankyung.com -> com  (stops on first hit)
    parts = host.split(".")
    for i in range(len(parts) - 1):
        candidate = ".".join(parts[i:])
        if candidate in KOREAN_MEDIA_SELECTORS:
            return candidate, KOREAN_MEDIA_SELECTORS[candidate]
    return None, []


def _selector_chain_extract(
    soup_full: Any, selectors: list[str]
) -> tuple[str, str | None]:
    """Try each selector in `selectors` against `soup_full`.

    Returns (text, winning_selector) on the first hit that yields
    >= FALLBACK_TRIGGER_CHARS of stripped text. Returns ("", None) if
    every selector fails.
    """
    for sel in selectors:
        try:
            nodes = soup_full.select(sel)
        except Exception:  # noqa: BLE001 - bad selector shouldn't crash extract
            continue
        if not nodes:
            continue
        text_lines: list[str] = []
        for node in nodes:
            # Drop noisy children (ads / scripts / inline styles)
            for bad in node(["script", "style", "noscript"]):
                bad.decompose()
            for line in node.get_text("\n").splitlines():
                stripped = line.strip()
                if stripped:
                    text_lines.append(stripped)
        merged = "\n".join(text_lines)
        if len(merged) >= FALLBACK_TRIGGER_CHARS:
            return merged, sel
    return "", None


class WebArticleExtractor(Extractor):
    """Extracts the main body of an HTML article."""

    source_type = SourceType.WEB_ARTICLE

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.WEB_ARTICLE

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        # Heavy imports inside the method
        from bs4 import BeautifulSoup
        from readability import Document

        html = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        full_len = len(html) or 1

        try:
            doc = Document(html)
            title = doc.short_title() or metadata.get("page_title")
            body_html = doc.summary(html_partial=True)
        except Exception as exc:  # noqa: BLE001 - readability is best-effort
            logger.warning("readability failed: %s", exc)
            title = metadata.get("page_title")
            body_html = html

        soup = BeautifulSoup(body_html, "lxml")
        # Drop script / style noise that occasionally survives readability
        for bad in soup(["script", "style", "noscript"]):
            bad.decompose()
        text_lines = [line.strip() for line in soup.get_text("\n").splitlines()]
        merged_text = "\n".join(line for line in text_lines if line)

        warnings: list[str] = []
        fallback_used: str | None = None
        host = urlparse(metadata.get("source_url") or "").hostname
        host_key, selectors = _selectors_for_host(host)

        # chore 6 — per-host fallback when readability didn't pull enough.
        if len(merged_text) < FALLBACK_TRIGGER_CHARS and selectors:
            soup_full = BeautifulSoup(html, "lxml")
            recovered, winning = _selector_chain_extract(soup_full, selectors)
            if recovered:
                merged_text = recovered
                fallback_used = winning
                warnings.append(
                    f"Used site-specific selector for {host_key}: {winning}"
                )

        if not merged_text.strip():
            # Hard fail with a useful diagnostic rather than letting the
            # downstream processor say "extracted_text is empty". This
            # message surfaces verbatim in the toast.
            if host_key:
                raise ExtractorError(
                    f"Article body not found on {host_key}. Tried selectors: "
                    f"{', '.join(selectors)}. Try the selection-save action "
                    "instead."
                )
            raise ExtractorError(
                f"Article body not found at {host or 'this URL'}. The page "
                "may be paywalled, JavaScript-rendered, or use an unusual "
                "layout. Try the selection-save action instead."
            )

        body_len = len(merged_text)
        if body_len < PAYWALL_ABS_FLOOR or body_len / full_len < PAYWALL_RATIO_THRESHOLD:
            warnings.append("Possible paywall: extracted body shorter than expected.")

        author = _meta_value(soup, ["author", "article:author"])
        publish_date_str = _meta_value(soup, ["article:published_time", "pubdate", "date"])
        publish_date: datetime | None = None
        if publish_date_str:
            try:
                publish_date = datetime.fromisoformat(publish_date_str.replace("Z", "+00:00"))
            except ValueError:
                warnings.append(f"Unparseable publish_date: {publish_date_str}")

        language = _detect_language(merged_text)

        return ExtractResult(
            merged_text=merged_text,
            title=title,
            author=author,
            publish_date=publish_date,
            language=language,  # type: ignore[arg-type]
            extracted_metadata={
                "source_url": metadata.get("source_url"),
                "body_char_count": body_len,
                "full_html_char_count": full_len,
                "extractor_strategy": (
                    f"selector:{fallback_used}" if fallback_used else "readability"
                ),
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
