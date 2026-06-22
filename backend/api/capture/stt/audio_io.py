"""Audio I/O helpers for the video/audio STT adapter (B-46 PR1).

Three lightweight helpers:

download_from_url(url, dest_dir) -> str
    Download audio (or video) from any yt-dlp-supported URL and
    convert to mp3 via the mp3 postprocessor. Returns the local path.

extract_audio(media_path, dest_dir) -> str
    Re-encode any media file to a 16 kHz mono WAV suitable for
    faster-whisper. Returns the output .wav path.

get_duration_ms(media_path) -> int
    Probe the duration of a media file via ffprobe. Returns 0 on
    any error so callers can guard without crashing.

All heavy imports (yt_dlp, subprocess) are inside the functions so
unit tests can mock at the function boundary without pulling the real
binaries.
"""
from __future__ import annotations

import logging
import os
import subprocess
import uuid

logger = logging.getLogger("lucid.capture.stt.audio_io")


def download_from_url(url: str, dest_dir: str) -> str:
    """Download audio from ``url`` into ``dest_dir`` using yt-dlp.

    Uses ``bestaudio/best`` format and the mp3 postprocessor so the
    output is always a plain .mp3 that ffmpeg can re-encode.

    Parameters
    ----------
    url:
        Any URL supported by yt-dlp (YouTube, Vimeo, direct mp4, …).
    dest_dir:
        Directory to write the downloaded file into.

    Returns
    -------
    str
        Absolute path to the downloaded audio file.

    Raises
    ------
    RuntimeError
        When yt-dlp fails to produce an output file.
    """
    try:
        import yt_dlp  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("yt-dlp not installed; cannot download video audio") from exc

    stem = f"lucid-vid-{uuid.uuid4().hex}"
    out_template = os.path.join(dest_dir, f"{stem}.%(ext)s")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "noplaylist": True,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "128",
            }
        ],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(url, download=True)

    expected = os.path.join(dest_dir, f"{stem}.mp3")
    if not os.path.exists(expected):
        # Some yt-dlp builds keep the original extension
        for name in os.listdir(dest_dir):
            if name.startswith(stem):
                return os.path.join(dest_dir, name)
        raise RuntimeError(f"yt-dlp completed but output file not found in {dest_dir}")
    return expected


def extract_audio(media_path: str, dest_dir: str) -> str:
    """Re-encode ``media_path`` to a 16 kHz mono WAV using ffmpeg.

    Parameters
    ----------
    media_path:
        Source file (video or audio in any ffmpeg-supported format).
    dest_dir:
        Directory to write the output file into.

    Returns
    -------
    str
        Absolute path to the produced WAV file.

    Raises
    ------
    RuntimeError
        When ffmpeg exits with a non-zero code.
    """
    out_path = os.path.join(dest_dir, f"audio-{uuid.uuid4().hex}.wav")
    cmd = [
        "ffmpeg",
        "-y",
        "-i", media_path,
        "-ac", "1",       # mono
        "-ar", "16000",   # 16 kHz — whisper's native sample rate
        "-vn",            # drop video stream
        out_path,
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,  # 10 min hard ceiling
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}): {result.stderr[-500:]}"
        )
    return out_path


def get_duration_ms(media_path: str) -> int:
    """Probe the duration of ``media_path`` in milliseconds via ffprobe.

    Returns 0 when ffprobe is unavailable or fails — callers should
    treat 0 as "unknown duration" and let the gate inside the extractor
    be the second line of defence.
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        media_path,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            logger.debug("ffprobe returned %d for %s", result.returncode, media_path)
            return 0
        duration_s = float(result.stdout.strip())
        return int(duration_s * 1000)
    except Exception as exc:  # noqa: BLE001
        logger.debug("get_duration_ms failed for %s: %s", media_path, exc)
        return 0
