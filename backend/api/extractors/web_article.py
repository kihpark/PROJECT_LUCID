"""Web article extractor.

Heuristic pipeline:
  1. readability.Document   -> main article body (HTML)
  2. BeautifulSoup          -> visible text
  3. langdetect             -> 'ko' / 'en' / 'mixed' label
  4. Paywall heuristic      -> warning if body too short relative to <html>

Heavy imports are inside `extract()` so the unit test suite can
exercise the class without lxml installed.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from api.extractors.base import Extractor, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.web")

PAYWALL_RATIO_THRESHOLD = 0.04  # body < 4% of full HTML -> suspected paywall
PAYWALL_ABS_FLOOR = 200  # characters; below this also warn


def _detect_language(text: str) -> str:
    """Return 'ko' / 'en' / 'mixed' based on character ratios + langdetect."""
    if not text:
        return "mixed"
    # Cheap heuristic first: count Hangul vs Latin
    hangul = sum(1 for c in text if "가" <= c <= "힣")
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


class WebArticleExtractor(Extractor):
    """Extracts the article body from a generic HTML page."""

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
