"""Image extractor (Claude Vision API).

B-45 multimodal Phase 1: an image is treated like any other extractor
input — we hand it to a vision-capable model and get back the same
`merged_text` shape every other extractor produces, so the existing
Structure → Validate → Surface pipeline runs unchanged.

Cost controls (PO directive 2026-06-18 [B-45]):
  - Default model = Haiku 4.5. The image-to-claim job is structured
    extraction; Haiku is sufficient and ~3-5× cheaper than Sonnet.
    Override via `CLAUDE_VISION_MODEL` env to swap to
    `claude-sonnet-4-6` per-deployment. Opus is forbidden by policy.
  - System prompt is cached (`cache_control: ephemeral`). The first
    capture in a window primes the cache; subsequent captures pay
    only the read-tokens fee.
  - Oversize images are resized to ≤ `LUCID_VISION_MAX_DIM` px on the
    longest side (default 1568, Anthropic's published vision sweet
    spot) BEFORE base64 + transit. A 4 K screenshot drops from
    ~8 MB → ~600 KB.
  - Every call logs `vision.usage` with input / output / cache_read /
    cache_create tokens so the operator can audit per-capture cost
    from the container logs without round-tripping to the API
    dashboard.

Tests never spend real tokens — `backend/tests/unit/test_image_extractor.py`
mocks `Anthropic.messages.create`.
"""
from __future__ import annotations

import base64
import io
import logging
import os
from typing import Any

from api.extractors.base import Extractor, ExtractorError, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.image")

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_MAX_TOKENS = 2048
DEFAULT_MAX_DIM = 1568

# PO requested explicit policy: Opus is too expensive for this task.
# We reject the model string defensively rather than silently spend.
_BANNED_MODEL_FRAGMENTS = ("opus",)

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


def _resolve_model() -> str:
    """Pick the vision model. Defensive against `opus` leaking through
    the env override — PO policy forbids it for this task."""
    model = os.getenv("CLAUDE_VISION_MODEL", DEFAULT_MODEL).strip()
    if not model:
        model = DEFAULT_MODEL
    if any(b in model.lower() for b in _BANNED_MODEL_FRAGMENTS):
        logger.warning(
            "vision: refusing banned model %r; falling back to %s",
            model, DEFAULT_MODEL,
        )
        return DEFAULT_MODEL
    return model


def _resolve_max_dim() -> int:
    """Longest-side cap for the pre-API resize. Bad env values fall
    back to the published sweet spot."""
    raw = os.getenv("LUCID_VISION_MAX_DIM")
    if not raw:
        return DEFAULT_MAX_DIM
    try:
        v = int(raw)
    except ValueError:
        return DEFAULT_MAX_DIM
    if v < 256 or v > 4096:
        # Below 256 px Anthropic vision misreads small text; above
        # 4096 the per-image tile cost balloons.
        return DEFAULT_MAX_DIM
    return v


def _maybe_resize(raw: bytes, max_dim: int) -> tuple[bytes, dict[str, Any]]:
    """Resize the image so its longest side is `max_dim` px when the
    input exceeds that bound. Returns (new_bytes, info) where info
    carries the original + final dimensions for the metadata log.

    Always passes through when Pillow can't decode the bytes — the
    Anthropic API will reject malformed input on its own, so we
    don't try to second-guess it here.
    """
    try:
        from PIL import Image
    except ImportError:
        return raw, {"resize": "pillow_missing"}
    try:
        with Image.open(io.BytesIO(raw)) as im:
            orig_w, orig_h = im.size
            longest = max(orig_w, orig_h)
            if longest <= max_dim:
                return raw, {
                    "resize": "noop",
                    "orig_width": orig_w, "orig_height": orig_h,
                }
            scale = max_dim / longest
            new_w = max(1, round(orig_w * scale))
            new_h = max(1, round(orig_h * scale))
            resized = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            # Re-encode to PNG to keep the alpha channel honest. JPEG
            # would be smaller for photos but a 4K screenshot of a
            # chart loses readability through chroma subsampling.
            if resized.mode in ("RGBA", "LA", "P"):
                resized.save(buf, format="PNG", optimize=True)
                fmt = "image/png"
            else:
                resized.save(buf, format="JPEG", quality=85, optimize=True)
                fmt = "image/jpeg"
            return buf.getvalue(), {
                "resize": "applied",
                "orig_width": orig_w, "orig_height": orig_h,
                "new_width": new_w, "new_height": new_h,
                "new_media_type": fmt,
            }
    except Exception as exc:  # noqa: BLE001
        logger.warning("vision: resize skipped (%s); sending original", exc)
        return raw, {"resize": "decode_failed", "reason": str(exc)}


def _log_usage(response: Any, model: str, job_id: str | None) -> dict[str, Any]:
    """Pull `usage` off the Anthropic response and emit a single
    structured log line plus return the dict so the metadata
    persists onto the SourceJob. Missing fields are tolerated for
    older SDK shapes."""
    usage = getattr(response, "usage", None)
    if usage is None:
        logger.info(
            "vision.usage job=%s model=%s usage=unavailable",
            job_id, model,
        )
        return {"unavailable": True}
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_create = getattr(usage, "cache_creation_input_tokens", 0) or 0
    logger.info(
        "vision.usage job=%s model=%s input=%d output=%d "
        "cache_read=%d cache_create=%d",
        job_id, model, input_tokens, output_tokens, cache_read, cache_create,
    )
    return {
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_create,
    }


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

        # B-45: shrink first so we pay for fewer image tokens.
        resized_bytes, resize_info = _maybe_resize(raw, _resolve_max_dim())
        media_type = resize_info.get("new_media_type") or _detect_image_media_type(
            resized_bytes,
        )
        b64 = base64.b64encode(resized_bytes).decode("ascii")
        model = _resolve_model()

        client = Anthropic()
        # cache_control on the text instruction keeps the prompt
        # primed across captures. The image block itself is fresh
        # per-call (the bytes change) so it stays uncached.
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
                    {
                        "type": "text",
                        "text": PROMPT_KO_EN,
                        "cache_control": {"type": "ephemeral"},
                    },
                ],
            }
        ]
        try:
            response = client.messages.create(
                model=model,
                max_tokens=DEFAULT_MAX_TOKENS,
                messages=message_list,
            )
        except Exception as exc:  # noqa: BLE001 - Anthropic SDK raises various types
            raise ExtractorError(f"Vision API call failed: {exc}") from exc

        usage_info = _log_usage(response, model, metadata.get("job_id"))

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
                "vision_model": getattr(response, "model", model),
                "media_type": media_type,
                "image_byte_count": len(resized_bytes),
                "image_orig_byte_count": len(raw),
                "page_url": metadata.get("source_url"),
                "vision_resize": resize_info,
                "vision_usage": usage_info,
            },
        )
