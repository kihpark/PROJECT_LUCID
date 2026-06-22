"""Unit: B-46 _attach_video_locators helper and processor integration."""
from __future__ import annotations

from typing import Any


def _make_timecodes() -> list[dict[str, Any]]:
    return [
        {"text": "박지원 의원은 새로운 통계를 발표했다.", "start_ms": 0,     "end_ms": 3000,  "char_start": 0,  "char_end": 19,  "speaker": None},
        {"text": "이 통계는 GDP 성장률을 보여준다.",     "start_ms": 3000,  "end_ms": 6000,  "char_start": 20, "char_end": 38,  "speaker": None},
        {"text": "전문가들은 이에 동의했다.",              "start_ms": 6000,  "end_ms": 9000,  "char_start": 39, "char_end": 52,  "speaker": None},
    ]


def _make_merged_text() -> str:
    segs = _make_timecodes()
    return "\n".join(s["text"] for s in segs)


def test_attach_video_locators_adds_locator_to_each_fact() -> None:
    """_attach_video_locators writes locators onto each fact dict."""
    from api.structure.processor import _attach_video_locators

    timecodes = _make_timecodes()
    merged = _make_merged_text()
    facts: list[dict] = [
        {"uid": "fn-1", "claim": "박지원 의원은 새로운 통계를 발표했다."},
        {"uid": "fn-2", "claim": "이 통계는 GDP 성장률을 보여준다."},
    ]

    _attach_video_locators(
        facts_payload=facts,
        segment_timecodes=timecodes,
        merged_text=merged,
        media_url="https://example.com/v.mp4",
        source_uid="src-abc",
    )

    for fact in facts:
        assert "locators" in fact, f"Missing locators in fact {fact['uid']}"
        loc = fact["locators"][0]
        assert loc["kind"] == "video"
        assert loc["source_uid"] == "src-abc"
        assert isinstance(loc["start_ms"], int)
        assert isinstance(loc["end_ms"], int)
        assert loc["media_url"] == "https://example.com/v.mp4"


def test_attach_video_locators_correct_segment_match() -> None:
    """Each fact matches the segment whose char range contains the claim."""
    from api.structure.processor import _attach_video_locators

    timecodes = _make_timecodes()
    merged = _make_merged_text()
    facts: list[dict] = [
        {"uid": "fn-1", "claim": "박지원 의원은 새로운 통계를 발표했다."},
        {"uid": "fn-2", "claim": "전문가들은 이에 동의했다."},
    ]

    _attach_video_locators(
        facts_payload=facts,
        segment_timecodes=timecodes,
        merged_text=merged,
        media_url="https://x.com/v.mp4",
        source_uid="uid-1",
    )

    assert facts[0]["locators"][0]["start_ms"] == 0
    assert facts[1]["locators"][0]["start_ms"] == 6000


def test_attach_video_locators_noop_on_no_timecodes() -> None:
    """When segment_timecodes is empty, facts are not modified."""
    from api.structure.processor import _attach_video_locators

    facts: list[dict] = [{"uid": "fn-1", "claim": "test"}]
    _attach_video_locators(
        facts_payload=facts,
        segment_timecodes=[],
        merged_text="test",
        media_url="https://x.com",
        source_uid="uid",
    )
    assert "locators" not in facts[0]


def test_attach_video_locators_fallback_to_segment_0() -> None:
    """Fact whose claim is not found in merged_text falls back to segment 0."""
    from api.structure.processor import _attach_video_locators

    timecodes = _make_timecodes()
    merged = _make_merged_text()
    facts: list[dict] = [
        {"uid": "fn-1", "claim": "이 텍스트는 merged_text에 없음"}
    ]

    _attach_video_locators(
        facts_payload=facts,
        segment_timecodes=timecodes,
        merged_text=merged,
        media_url="https://x.com/v.mp4",
        source_uid="uid-x",
    )

    # Should fall back to segment 0 (start_ms=0)
    assert facts[0]["locators"][0]["start_ms"] == 0
