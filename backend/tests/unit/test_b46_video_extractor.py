"""Unit tests for B-46 VideoSttExtractor."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def _make_transcript(texts: list[str], start_base_ms: int = 0) -> object:
    """Build a fake Transcript-like object with segments."""
    from api.capture.stt.engine import Transcript, TranscriptSegment

    segs = []
    t = start_base_ms
    for text in texts:
        segs.append(TranscriptSegment(start_ms=t, end_ms=t + 1000, text=text))
        t += 1000

    return Transcript(
        segments=tuple(segs),
        language="ko",
        engine_name="mock-engine",
        duration_ms=t,
    )


def _make_mock_engine(texts: list[str]) -> MagicMock:
    transcript = _make_transcript(texts)
    engine = MagicMock()
    engine.name = "mock-engine"
    engine.transcribe.return_value = transcript
    return engine


@patch("api.capture.stt.audio_io.get_duration_ms", return_value=5000)
@patch("api.capture.stt.audio_io.extract_audio", return_value="/fake/audio.wav")
@patch("api.capture.stt.audio_io.download_from_url", return_value="/fake/video.mp3")
def test_happy_path(mock_dl, mock_extract, mock_dur) -> None:
    """Happy path: returns ExtractResult with merged_text + segment_timecodes."""
    from api.extractors.video_stt import VideoSttExtractor

    texts = ["박지원 의원은 새로운 통계를 발표했다.", "이 통계는 GDP 성장률을 보여준다."]
    engine = _make_mock_engine(texts)

    extractor = VideoSttExtractor(engine=engine)
    result = extractor.extract(b"", {
        "source_url": "https://example.com/video.mp4",
        "language_hint": "ko",
    })

    expected_merged = "\n".join(texts)
    assert result.merged_text == expected_merged
    assert result.language == "ko"

    meta = result.extracted_metadata["video_stt"]
    assert meta["engine"] == "mock-engine"
    assert meta["media_url"] == "https://example.com/video.mp4"

    timecodes = meta["segment_timecodes"]
    assert len(timecodes) == 2

    # First segment: char_start should be 0
    assert timecodes[0]["char_start"] == 0
    assert timecodes[0]["char_end"] == len(texts[0])
    assert timecodes[0]["start_ms"] == 0
    assert timecodes[0]["end_ms"] == 1000

    # Second segment: char_start = len(texts[0]) + 1 (for '\n')
    assert timecodes[1]["char_start"] == len(texts[0]) + 1
    assert timecodes[1]["char_end"] == len(texts[0]) + 1 + len(texts[1])


@patch("api.capture.stt.audio_io.get_duration_ms", return_value=99_999_999)
@patch("api.capture.stt.audio_io.extract_audio", return_value="/fake/audio.wav")
@patch("api.capture.stt.audio_io.download_from_url", return_value="/fake/video.mp3")
def test_hard_limit_branch(mock_dl, mock_extract, mock_dur) -> None:
    """When probed duration exceeds the limit, raises ExtractorError with hard_limit_exceeded."""
    import os
    from api.extractors.base import ExtractorError
    from api.extractors.video_stt import VideoSttExtractor

    engine = _make_mock_engine(["text"])
    extractor = VideoSttExtractor(engine=engine)

    with pytest.raises(ExtractorError) as exc_info:
        extractor.extract(b"", {"source_url": "https://example.com/long.mp4"})

    assert "hard_limit_exceeded" in str(exc_info.value)


@patch("api.capture.stt.audio_io.get_duration_ms", return_value=1000)
@patch("api.capture.stt.audio_io.extract_audio", return_value="/fake/audio.wav")
@patch("api.capture.stt.audio_io.download_from_url", return_value="/fake/video.mp3")
def test_cleanup_on_engine_failure(mock_dl, mock_extract, mock_dur) -> None:
    """Temp dir is cleaned up even when the engine raises."""
    import os
    import tempfile
    from api.extractors.base import ExtractorError
    from api.extractors.video_stt import VideoSttExtractor

    failing_engine = MagicMock()
    failing_engine.name = "failing"
    failing_engine.transcribe.side_effect = RuntimeError("engine crashed")

    extractor = VideoSttExtractor(engine=failing_engine)

    created_dirs: list[str] = []
    original_mkdtemp = tempfile.mkdtemp

    def capturing_mkdtemp(**kwargs):
        d = original_mkdtemp(**kwargs)
        created_dirs.append(d)
        return d

    with patch("tempfile.mkdtemp", side_effect=capturing_mkdtemp):
        with pytest.raises(ExtractorError):
            extractor.extract(b"", {"source_url": "https://example.com/video.mp4"})

    # All temp dirs should have been removed
    for d in created_dirs:
        assert not os.path.exists(d), f"Temp dir not cleaned up: {d}"


@patch("api.capture.stt.audio_io.get_duration_ms", return_value=1000)
@patch("api.capture.stt.audio_io.extract_audio", return_value="/fake/audio.wav")
def test_local_file_path_skips_download(mock_extract, mock_dur) -> None:
    """When local_file_path is set, download_from_url is NOT called."""
    from api.extractors.video_stt import VideoSttExtractor

    engine = _make_mock_engine(["오늘의 날씨"])
    extractor = VideoSttExtractor(engine=engine)

    with patch("api.capture.stt.audio_io.download_from_url") as mock_dl:
        result = extractor.extract(b"", {
            "source_url": "https://example.com/video.mp4",
            "local_file_path": "/tmp/uploaded.mp4",
        })
        mock_dl.assert_not_called()

    assert result.merged_text == "오늘의 날씨"
