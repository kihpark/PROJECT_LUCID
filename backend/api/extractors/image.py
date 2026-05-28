"""Image extractor (Claude Vision API).

Uses the Anthropic SDK to call claude-sonnet-4-5 with the image bytes
as a vision input. The prompt asks Claude to transcribe every text +
visual signal in Korean and English at fact granularity (charts, tables
become text).

Cost (beta scale): ~$0.003 per image; ~$0.5 / month for 30 users x 5
images. No caching in beta (per PO 2026-05-28 architect decision).

Tests mock the OpenAI / Anthropic call; never spend real tokens
under `pytest tests/unit`.
"""
from __future__ import annotations

import base64
import logging
import os
from typing import Any

from api.extractors.base import Extractor, ExtractorError, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.image")

DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_MAX_TOKENS = 2048

PROMPT_KO_EN = (
    "이미지의 모든 텍스트와 시각 정보를 한국어와 영어로 추출해 주세요. "
    "사실 단위로 정확히 옮기고, 시각 정보(차트·표·다이어그램)도 텍스트화합니다. "
    "출처 표시는 별도 메타데이터로 받으니 본문에 포함하지 마세요."
)


def _detect_image_media_type(raw: bytes) -> str:
    """Sniff the leading magic bytes for the Anthropic media_type field."""
    if raw.startswith(b"\x89PNG"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"GIF87a") or raw.startswith(b"GIF89a"):
        return "image/gif"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp"
    # Default to PNG so the API attempt at least sees a valid header type;
    # Anthropic will reject if mismatch.
    return "image/png"


class ImageExtractor(Extractor):
    """Image text + visual-content extraction via Claude Vision."""

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.PAGE_IMAGE

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        try:
            from anthropic import Anthropic
        except ImportError as exc:
            raise ExtractorError("anthropic package not installed") from exc

        if not os.getenv("ANTHROPIC_API_KEY"):
            raise ExtractorError("ANTHROPIC_API_KEY missing")

        if not raw:
            raise ExtractorError("Image bytes empty")

        media_type = _detect_image_media_type(raw)
        b64 = base64.b64encode(raw).decode("ascii")

        client = Anthropic()
        # Build the message dict separately + cast to Any to bypass the
        # SDK's strict TypedDict overloads; the runtime shape is what
        # the API expects.
        message_list: Any = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": PROMPT_KO_EN},
                ],
            }
        ]
        try:
            response = client.messages.create(
                model=os.getenv("CLAUDE_MODEL", DEFAULT_MODEL),
                max_tokens=DEFAULT_MAX_TOKENS,
                messages=message_list,
            )
        except Exception as exc:  # noqa: BLE001 - Anthropic SDK raises various types
            raise ExtractorError(f"Vision API call failed: {exc}") from exc

        # Concatenate all returned text blocks.
        text_blocks: list[str] = []
        for block in response.content:
            block_type = getattr(block, "type", "")
            if block_type == "text":
                text_blocks.append(getattr(block, "text", "") or "")
        merged_text = "\n".join(t for t in text_blocks if t).strip()

        return ExtractResult(
            merged_text=merged_text,
            title=metadata.get("page_title"),
            language="mixed",
            extracted_metadata={
                "vision_model": getattr(response, "model", DEFAULT_MODEL),
                "media_type": media_type,
                "image_byte_count": len(raw),
                "page_url": metadata.get("source_url"),
            },
        )
