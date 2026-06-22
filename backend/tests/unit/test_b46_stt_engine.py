"""Unit tests for B-46 STT engine interface and WhisperLocalEngine."""
from __future__ import annotations

import types
from unittest.mock import MagicMock, patch

import pytest


def test_transcript_full_text_joins_segments() -> None:
    """Transcript.full_text is segments joined by newline."""
    from api.capture.stt.engine import Transcript, TranscriptSegment

    segs = (
        TranscriptSegment(start_ms=0, end_ms=1000, text="안녕하세요"),
        TranscriptSegment(start_ms=1000, end_ms=2000, text="오늘 날씨가 좋네요"),
        TranscriptSegment(start_ms=2000, end_ms=3000, text=""),  # empty — skipped
    )
    t = Transcript(segments=segs, language="ko", engine_name="test", duration_ms=3000)
    assert t.full_text == "안녕하세요\n오늘 날씨가 좋네요"


def test_transcript_full_text_empty_segments() -> None:
    """Transcript with no segments yields empty full_text."""
    from api.capture.stt.engine import Transcript

    t = Transcript(segments=(), language="ko", engine_name="test", duration_ms=0)
    assert t.full_text == ""


def test_whisper_local_engine_name() -> None:
    """WhisperLocalEngine.name is the expected string."""
    from api.capture.stt.whisper_local import WhisperLocalEngine

    assert WhisperLocalEngine().name == "whisper-local-v3"


def test_whisper_local_engine_loads_lazily_via_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    """WhisperModel is constructed lazily inside transcribe(), not at import."""
    import api.capture.stt.whisper_local as wl

    # Reset the module-level cache first.
    wl._reset_model()

    # Build fake faster_whisper.WhisperModel
    fake_seg = MagicMock()
    fake_seg.start = 0.0
    fake_seg.end = 1.5
    fake_seg.text = "테스트 텍스트"

    fake_info = MagicMock()
    fake_info.language = "ko"
    fake_info.duration = 1.5

    fake_model_instance = MagicMock()
    fake_model_instance.transcribe.return_value = ([fake_seg], fake_info)

    fake_model_cls = MagicMock(return_value=fake_model_instance)

    # Patch faster_whisper.WhisperModel inside the whisper_local module's namespace
    fake_fw = types.ModuleType("faster_whisper")
    fake_fw.WhisperModel = fake_model_cls  # type: ignore[attr-defined]
    monkeypatch.setitem(
        __import__("sys").modules, "faster_whisper", fake_fw
    )

    engine = wl.WhisperLocalEngine()
    transcript = engine.transcribe("/fake/audio.wav", language_hint="ko")

    # Model was constructed exactly once
    fake_model_cls.assert_called_once()
    # transcribe was called with the expected wav path
    fake_model_instance.transcribe.assert_called_once_with(
        "/fake/audio.wav",
        beam_size=5,
        language="ko",
    )

    assert transcript.language == "ko"
    assert len(transcript.segments) == 1
    assert transcript.segments[0].text == "테스트 텍스트"
    assert transcript.segments[0].start_ms == 0
    assert transcript.segments[0].end_ms == 1500

    # Cleanup cache so other tests start fresh
    wl._reset_model()
