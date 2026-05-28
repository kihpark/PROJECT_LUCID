"""PDF extractor (pdfplumber).

Digital-PDF only in beta — no OCR. When a page yields very few
characters but contains images, we emit an `extraction_warnings`
entry so the Decide overlay (Sprint 4A) can show "scanned PDF
detected; OCR coming in Phase 1".

Tables are extracted opportunistically (extracted_metadata.tables).
"""
from __future__ import annotations

import io
import logging
from typing import Any

from api.extractors.base import Extractor, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.pdf")

# A page below this many characters with at least one image -> likely scanned
SCAN_PAGE_CHAR_FLOOR = 20


class PdfExtractor(Extractor):
    """Extracts text + tables from a digital PDF."""

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.PDF

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        import pdfplumber  # type: ignore[import-not-found]

        page_texts: list[str] = []
        tables: list[list[list[str]]] = []
        warnings: list[str] = []
        scanned_pages = 0
        total_chars = 0

        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            for idx, page in enumerate(pdf.pages, start=1):
                text = (page.extract_text() or "").strip()
                page_texts.append(text)
                total_chars += len(text)

                # Cheap scanned-page heuristic: page has images but very little text
                if len(text) < SCAN_PAGE_CHAR_FLOOR and (page.images or []):
                    scanned_pages += 1

                # Tables (only if pdfplumber finds them quickly)
                try:
                    page_tables = page.extract_tables() or []
                    for tbl in page_tables:
                        tables.append([[c or "" for c in row] for row in tbl])
                except Exception as exc:  # noqa: BLE001
                    logger.debug("pdfplumber table extract failed on page %d: %s", idx, exc)

        merged_text = "\n\n".join(t for t in page_texts if t)

        if scanned_pages > 0:
            warnings.append(
                f"Scanned PDF detected: {scanned_pages} page(s) have images but little text. "
                "OCR is not enabled in beta."
            )
        if total_chars == 0:
            warnings.append("No text extracted from the PDF.")

        title = metadata.get("page_title")

        return ExtractResult(
            merged_text=merged_text,
            title=title,
            language="mixed",
            extracted_metadata={
                "page_count": len(page_texts),
                "scanned_page_count": scanned_pages,
                "table_count": len(tables),
                "tables": tables[:10],  # cap to keep doc size sane
            },
            extraction_warnings=warnings,
        )
