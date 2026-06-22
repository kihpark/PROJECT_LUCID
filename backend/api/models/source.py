"""Source + per-source policy enums.

PO directive 2026-05-21 [변경 3]: per-source policy (trusted vs careful)
is set in Settings SET-2 once per source domain, not asked at capture
time. The Source model below is the in-flight capture-time
representation; the persisted user-level policy lives in the Postgres
`source_policies` table (see api.storage.postgres.orm.SourcePolicyORM).
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now


class SourcePolicy(StrEnum):
    """Per-source validation policy (Settings SET-2)."""

    TRUSTED = "trusted"  # auto-accept into the graph
    CAREFUL = "careful"  # route through Decide overlay


class SourceType(StrEnum):
    """Capture entry-point that produced this source.

    Restricted to the seven beta entry points (see DR-025, DR-026):
    untraced inputs (screenshot, file_upload, camera, clipboard, voice,
    email_forward) are excluded from the beta and not enumerated here.
    """

    WEB_ARTICLE = "web_article"
    HIGHLIGHTED_TEXT = "highlighted_text"
    YOUTUBE = "youtube"
    PAGE_IMAGE = "page_image"
    PDF = "pdf"
    PWA_SHARE = "pwa_share"
    URL_PASTE = "url_paste"
    VIDEO_STT = "video_stt"  # B-46: generic video/audio STT capture adapter


class Source(LucidBaseModel):
    """In-flight source metadata produced at Capture time.

    Persisted in the lucid_sources ES index (PR-1A-3). The aggregate
    counts (`capture_count`) are maintained by the storage layer at
    index time.

    B-48a: `source_job_id` and `captured_at` are populated by the
    validate path so the fact-detail panel (B-48b) can hyperlink the
    user back to the source job and surface raw_payload snapshots.
    """

    source_uid: UID
    domain: str
    source_type: SourceType
    source_url: str
    title: str | None = None
    author: str | None = None
    published_at: datetime | None = None
    first_captured_at: datetime = Field(default_factory=utc_now)
    capture_count: int = 1
    knowledge_space_id: UID
    # B-48a reference-layer expansion.
    source_job_id: UID | None = None
    captured_at: datetime | None = None

