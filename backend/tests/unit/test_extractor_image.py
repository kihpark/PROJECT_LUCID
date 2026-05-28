"""Unit: image extractor — media type detection + no live API call."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.extractors.base import ExtractorError
from api.extractors.image import ImageExtractor, _detect_image_media_type


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


def test_image_extractor_calls_vision_with_base64(monkeypatch):
    """Mock the Anthropic client and assert the messages payload."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    fake_response = MagicMock()
    fake_response.content = [MagicMock(type="text", text="추출된 텍스트")]
    fake_response.model = "claude-sonnet-4-5"

    fake_client = MagicMock()
    fake_client.messages.create.return_value = fake_response

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
