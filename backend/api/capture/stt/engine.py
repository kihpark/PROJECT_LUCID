"""STT engine Protocol interface (B-46 PR1).

Defines the abstract interface for speech-to-text engines so that the
default (faster-whisper) can be swapped for Clova, Deepgram, or any
cloud STT service without touching the extractor or route code.

Usage::

    engine: STTEngine = WhisperLocalEngine()
    transcript = engine.transcribe(audio_path, language_hint="ko")
    full_text = transcript.full_text   # newline-joined segments
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class TranscriptSegment:
    """One timed span of speech produced by an STT engine.

    `start_ms` / `end_ms` are milliseconds from the start of the
    media file. `text` is the raw transcript for this span. `speaker`
    is optional diarisation (None if the engine doesn't support it).
    """

    start_ms: int
    end_ms: int
    text: str
    speaker: str | None = None


@dataclass(frozen=True)
class Transcript:
    """Full STT output from one audio file.

    `segments` is the ordered list of timed spans. `full_text` is
    the canonical body produced by joining all segment texts with
    ``\\n`` — this is what the Structure stage ingests.
    `language` is the BCP-47 language tag detected by the engine
    (e.g. ``"ko"``, ``"en"``).
    `engine_name` identifies which engine produced this transcript
    so the audit trail can record it.
    """

    segments: tuple[TranscriptSegment, ...]
    language: str
    engine_name: str
    duration_ms: int
    full_text: str = field(init=False)

    def __post_init__(self) -> None:
        # full_text is derived — computed once, frozen with object.
        object.__setattr__(
            self,
            "full_text",
            "\n".join(s.text for s in self.segments if s.text.strip()),
        )


@runtime_checkable
class STTEngine(Protocol):
    """Protocol for STT engine implementations.

    Concrete engines must implement `transcribe` and expose a `name`
    string attribute. The `name` is written into
    ``extracted_metadata["video_stt"]["engine"]`` so the audit log can
    identify which engine produced the transcript without needing the
    full class path.
    """

    name: str

    def transcribe(
        self,
        audio_path: str,
        *,
        language_hint: str | None = None,
    ) -> Transcript:
        """Transcribe the audio file at `audio_path`.

        Parameters
        ----------
        audio_path:
            Path to an audio file (wav, mp3, m4a, etc.).  The extractor
            always passes a 16 kHz mono WAV produced by ffmpeg so the
            engine doesn't need to handle arbitrary formats.
        language_hint:
            BCP-47 tag to override auto-detection (e.g. ``"ko"``).
            ``None`` means let the engine auto-detect.

        Returns
        -------
        Transcript
            Ordered segments + joined full text.
        """
        ...
