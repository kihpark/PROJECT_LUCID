"""Unit: image extractor — media type detection + no live API call."""
from __future__ import annotations

import io
from unittest.mock import MagicMock, patch

import pytest

from api.extractors.base import ExtractorError
from api.extractors.image import (
    DEFAULT_MAX_DIM,
    DEFAULT_MODEL,
    ImageExtractor,
    _detect_image_media_type,
    _maybe_resize,
    _resolve_max_dim,
    _resolve_model,
)


def test_detect_image_media_type_png():
    assert _detect_image_media_type(b"\x89PNG\r\n\x1a\n") == "image/png"


def test_detect_image_media_type_jpeg():
    assert _detect_image_media_type(b"\xff\xd8\xff\xe0...") == "image/jpeg"


def test_detect_image_media_type_gif():
    assert _detect_image_media_type(b"GIF89a") == "image/gif"


def test_detect_image_media_type_webp():
    assert _detect_image_media_type(b"RIFF\x00\x00\x00\x00WEBP....") == "image/webp"


def test_image_extractor_raises_when_anthropic_key_missing(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ExtractorError, match="ANTHROPIC_API_KEY"):
        ImageExtractor().extract(b"\x89PNG fake", {})


def _ok_response(text="추출된 텍스트", model="claude-haiku-4-5"):
    """A minimal Anthropic SDK-shaped response with usage block."""
    usage = MagicMock()
    usage.input_tokens = 1234
    usage.output_tokens = 56
    usage.cache_read_input_tokens = 1000
    usage.cache_creation_input_tokens = 0
    fake = MagicMock()
    fake.content = [MagicMock(type="text", text=text)]
    fake.model = model
    fake.usage = usage
    return fake


def test_image_extractor_calls_vision_with_base64(monkeypatch):
    """Mock the Anthropic client and assert the messages payload."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _ok_response()

    with patch("anthropic.Anthropic", return_value=fake_client):
        png = b"\x89PNG\r\n\x1a\n" + b"x" * 100
        result = ImageExtractor().extract(png, {"source_url": "https://x"})

    assert "추출된 텍스트" in result.merged_text
    assert result.extracted_metadata["media_type"] == "image/png"

    # Verify the Anthropic call shape
    call_kwargs = fake_client.messages.create.call_args.kwargs
    user_msg = call_kwargs["messages"][0]
    assert user_msg["role"] == "user"
    content = user_msg["content"]
    assert content[0]["type"] == "image"
    assert content[0]["source"]["type"] == "base64"
    assert content[0]["source"]["media_type"] == "image/png"


# ---------------------------------------------------------------------------
# B-45 acceptance — Haiku default, cache_control, resize, usage logging
# ---------------------------------------------------------------------------

def test_resolve_model_defaults_to_haiku(monkeypatch):
    """★ Default vision model is Haiku 4.5 per PO directive."""
    monkeypatch.delenv("CLAUDE_VISION_MODEL", raising=False)
    assert _resolve_model() == "claude-haiku-4-5"
    assert DEFAULT_MODEL == "claude-haiku-4-5"


def test_resolve_model_refuses_opus(monkeypatch):
    """★ Opus is forbidden by policy. Override that names it falls
    back to the default rather than silently overspending."""
    monkeypatch.setenv("CLAUDE_VISION_MODEL", "claude-opus-4-8")
    assert _resolve_model() == DEFAULT_MODEL
    monkeypatch.setenv("CLAUDE_VISION_MODEL", "us.anthropic.claude-opus-4-1")
    assert _resolve_model() == DEFAULT_MODEL


def test_resolve_model_allows_sonnet_override(monkeypatch):
    """The PO leaves Sonnet as an explicit escape hatch."""
    monkeypatch.setenv("CLAUDE_VISION_MODEL", "claude-sonnet-4-6")
    assert _resolve_model() == "claude-sonnet-4-6"


def test_resolve_max_dim_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("LUCID_VISION_MAX_DIM", raising=False)
    assert _resolve_max_dim() == DEFAULT_MAX_DIM
    monkeypatch.setenv("LUCID_VISION_MAX_DIM", "garbage")
    assert _resolve_max_dim() == DEFAULT_MAX_DIM
    monkeypatch.setenv("LUCID_VISION_MAX_DIM", "100")  # too small
    assert _resolve_max_dim() == DEFAULT_MAX_DIM
    monkeypatch.setenv("LUCID_VISION_MAX_DIM", "9999")  # too big
    assert _resolve_max_dim() == DEFAULT_MAX_DIM
    monkeypatch.setenv("LUCID_VISION_MAX_DIM", "1024")  # valid
    assert _resolve_max_dim() == 1024


def _make_png(width: int, height: int) -> bytes:
    """Real PIL-encoded PNG so the resize path sees decodable bytes."""
    from PIL import Image
    im = Image.new("RGB", (width, height), color=(200, 220, 240))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def test_maybe_resize_passthrough_when_within_limit():
    """★ A small image is NOT touched — no needless re-encode cost."""
    raw = _make_png(400, 300)
    new_raw, info = _maybe_resize(raw, 1568)
    assert new_raw == raw
    assert info["resize"] == "noop"
    assert info["orig_width"] == 400


def test_maybe_resize_shrinks_oversized_image_longest_side():
    """★ A 4 K screenshot is resized to longest_side ≤ max_dim BEFORE
    base64 → bytes-on-wire drops dramatically."""
    raw = _make_png(3200, 1800)  # 4K-ish
    new_raw, info = _maybe_resize(raw, 1568)
    assert info["resize"] == "applied"
    assert info["new_width"] <= 1568
    assert info["new_height"] <= 1568
    # The longest side hits the cap, the other side scales proportionally.
    assert max(info["new_width"], info["new_height"]) == 1568
    # Resized payload is substantially smaller than the original.
    assert len(new_raw) < len(raw)


def test_maybe_resize_tolerates_undecodable_bytes():
    """Random bytes can't be decoded; we degrade quietly and ship the
    original to the API rather than raise."""
    raw = b"not-a-real-image"
    new_raw, info = _maybe_resize(raw, 1568)
    assert new_raw == raw
    assert info["resize"] == "decode_failed"


def test_extractor_uses_haiku_and_attaches_cache_control(monkeypatch):
    """★ Haiku by default; system prompt block carries
    cache_control = ephemeral so 78%-hit caching keeps working."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.delenv("CLAUDE_VISION_MODEL", raising=False)

    fake_client = MagicMock()
    fake_client.messages.create.return_value = _ok_response()
    with patch("anthropic.Anthropic", return_value=fake_client):
        ImageExtractor().extract(_make_png(800, 600), {"source_url": "https://x"})

    kw = fake_client.messages.create.call_args.kwargs
    assert kw["model"] == "claude-haiku-4-5"
    content = kw["messages"][0]["content"]
    # The text block (prompt) carries cache_control.
    text_blocks = [c for c in content if c["type"] == "text"]
    assert len(text_blocks) == 1
    assert text_blocks[0].get("cache_control") == {"type": "ephemeral"}


def test_extractor_logs_usage_and_carries_it_to_metadata(monkeypatch):
    """★ Per-capture token usage MUST land in container logs (so the
    operator can audit cost) AND on the SourceJob's
    `extracted_metadata.vision_usage` so the Decide overlay can
    display it later.

    The log emission is asserted by patching `logger.info` directly
    (caplog and handler-attach are both suite-order-fragile because
    earlier tests mutate the root config), while the metadata
    assertion is the user-facing contract."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _ok_response()

    info_calls: list[tuple[str, tuple]] = []

    def _record_info(fmt, *args, **kwargs):
        info_calls.append((fmt, args))

    with patch("api.extractors.image.logger.info", side_effect=_record_info), patch(
        "anthropic.Anthropic", return_value=fake_client,
    ):
        result = ImageExtractor().extract(
            _make_png(400, 300),
            {"source_url": "https://x", "job_id": "j-1"},
        )

    # The vision.usage log line includes the four counters as args.
    usage_lines = [
        (fmt, args) for fmt, args in info_calls if "vision.usage" in fmt
    ]
    assert len(usage_lines) == 1
    fmt, args = usage_lines[0]
    assert "input=%d" in fmt and "output=%d" in fmt and "cache_read=%d" in fmt
    # args: (job_id, model, input, output, cache_read, cache_create)
    assert "j-1" in args
    assert 1234 in args and 56 in args and 1000 in args

    # User-facing metadata contract on the extraction result.
    usage = result.extracted_metadata["vision_usage"]
    assert usage["input_tokens"] == 1234
    assert usage["output_tokens"] == 56
    assert usage["cache_read_input_tokens"] == 1000


def test_extractor_resize_info_lands_in_metadata(monkeypatch):
    """The resize report (orig/new dims) is preserved on the
    SourceJob's metadata so the operator can correlate cost spikes
    to image sizes after the fact."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _ok_response()
    with patch("anthropic.Anthropic", return_value=fake_client):
        result = ImageExtractor().extract(
            _make_png(3200, 1800), {"source_url": "https://x"},
        )
    rinfo = result.extracted_metadata["vision_resize"]
    assert rinfo["resize"] == "applied"
    assert rinfo["orig_width"] == 3200
    # Resized payload byte count is smaller than original.
    assert result.extracted_metadata["image_byte_count"] < (
        result.extracted_metadata["image_orig_byte_count"]
    )
