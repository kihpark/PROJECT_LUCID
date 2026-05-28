"""YouTube Whisper STT extractor (fallback path).

Used when `YoutubeTranscriptExtractor` raises `NoTranscriptError`.

Pipeline:
  1. yt-dlp downloads audio to /tmp/lucid-{uuid}.{ext}
  2. faster-whisper transcribes (model='small', device='cpu')
  3. Build merged_text + timestamps from segments
  4. Always remove the temp file in `finally`

Concurrency:
  - Module-level `threading.Lock` (`_TRANSCRIBE_LOCK`) ensures only
    one transcribe runs at a time per process. Whisper-small needs
    ~1 GB RAM; the Hetzner 8 GB beta box can hold one + the rest of
    the stack but not two concurrently.

Model loading:
  - Lazy. `_load_model()` constructs the WhisperModel on first call
    and caches it in `_MODEL`. Tests reset via `_reset_model()`.
  - In production the Dockerfile preloads the weights to /models so
    the first transcribe call is fast (no HTTP download).
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from api.extractors.base import Extractor, ExtractorError, ExtractResult
from api.models.source import SourceType

logger = logging.getLogger("lucid.extractors.whisper")

WHISPER_MODEL_NAME = "small"
WHISPER_DOWNLOAD_DIR = os.getenv("FASTER_WHISPER_DOWNLOAD_DIR", "/models")
TEMP_PREFIX = "lucid-yt-"

_TRANSCRIBE_LOCK = threading.Lock()
_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()


def _load_model() -> Any:
    """Construct and cache the WhisperModel. Thread-safe lazy init."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is None:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]

            _MODEL = WhisperModel(
                WHISPER_MODEL_NAME,
                device="cpu",
                compute_type="int8",  # fastest on CPU
                download_root=WHISPER_DOWNLOAD_DIR,
            )
            logger.info("Loaded Whisper model %s from %s", WHISPER_MODEL_NAME, WHISPER_DOWNLOAD_DIR)
    return _MODEL


def _reset_model() -> None:
    """Test-only: drop the cached model so the next call constructs fresh."""
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None


def _download_audio(video_url: str, target_dir: Path) -> Path:
    """Use yt-dlp to download the audio track. Returns the file path.

    yt-dlp picks an audio format and writes to `{target_dir}/{TEMP_PREFIX}{uuid}.{ext}`.
    """
    try:
        import yt_dlp  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ExtractorError("yt-dlp not installed; cannot fall back to Whisper") from exc

    out_template = str(target_dir / f"{TEMP_PREFIX}{uuid.uuid4().hex}.%(ext)s")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=True)
        downloaded_path = ydl.prepare_filename(info)
    p = Path(downloaded_path)
    if not p.exists():
        raise ExtractorError(f"yt-dlp completed but output file missing: {p}")
    return p


class YoutubeWhisperExtractor(Extractor):
    """Whisper STT for YouTube videos lacking captions."""

    def supports(self, source_type: SourceType) -> bool:
        return source_type == SourceType.YOUTUBE

    def extract(self, raw: bytes, metadata: dict[str, Any]) -> ExtractResult:
        source_url = metadata.get("source_url", "")
        if not source_url:
            raise ExtractorError("Whisper fallback requires source_url in metadata")

        # One transcribe at a time per process (Whisper-small ~ 1 GB RAM).
        with _TRANSCRIBE_LOCK:
            workdir = Path(tempfile.mkdtemp(prefix=TEMP_PREFIX))
            audio_path: Path | None = None
            try:
                audio_path = _download_audio(source_url, workdir)
                model = _load_model()
                segments, info = model.transcribe(
                    str(audio_path),
                    beam_size=5,
                    language=None,  # auto-detect ko / en
                )

                lines: list[str] = []
                timestamps: list[dict[str, float | str]] = []
                for seg in segments:
                    text = (seg.text or "").strip()
                    if not text:
                        continue
                    lines.append(text)
                    timestamps.append(
                        {"start": float(seg.start), "duration": float(seg.end - seg.start), "text": text}
                    )

                merged_text = "\n".join(lines)
                lang = info.language if hasattr(info, "language") else "mixed"
                lang_label = "ko" if lang.startswith("ko") else "en" if lang.startswith("en") else "mixed"

                return ExtractResult(
                    merged_text=merged_text,
                    title=metadata.get("page_title"),
                    language=lang_label,  # type: ignore[arg-type]
                    extracted_metadata={
                        "video_id": metadata.get("video_id"),
                        "whisper_model": WHISPER_MODEL_NAME,
                        "detected_language": lang,
                        "timestamps": timestamps,
                    },
                    extraction_warnings=["Whisper STT fallback used (no transcript available)."],
                )
            finally:
                # Always remove the temp directory + audio file.
                try:
                    if audio_path and audio_path.exists():
                        audio_path.unlink(missing_ok=True)
                    shutil.rmtree(workdir, ignore_errors=True)
                except OSError as exc:
                    logger.warning("Temp cleanup failed for %s: %s", workdir, exc)
