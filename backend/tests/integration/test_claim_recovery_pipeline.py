"""B-62-fix-v6 end-to-end pipeline tests (PO 2026-06-22).

feat/spo-subject-claim-recovery — deterministic Korean subject recovery
from claim text via particle boundary parsing. Replaces the prior
"keep English surface + needs_review" fallback with hard recovery.

Each test drives the production `_match_object` against a mocked
LLM payload that anglicizes the subject. We assert the final
`primary_label` in the indexed body is the RECOVERED Korean form
(NOT the LLM's English) and `needs_review` is False — except in the
no-particle pathological case where recovery cannot proceed.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.models.objects import ObjectClass
from api.structure.models import (
    StructureFact,
    StructureObject,
    StructureResult,
)
from api.structure.processor import _build_surface_map, _match_object

pytestmark = pytest.mark.integration


def _run(decomp: StructureResult, obj_index: int = 0) -> tuple[dict, bool]:
    """Drive `_match_object` against a mocked ES client. Returns
    (indexed-body, needs_review)."""
    surface_map = _build_surface_map(decomp)
    mock_client = MagicMock()
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with patch(
        "api.structure.entity_resolver.get_client", return_value=mock_client,
    ), patch(
        "api.structure.processor.get_embedding", return_value=None,
    ):
        result, _resolved_class, needs_review = _match_object(
            decomp.objects[obj_index],
            knowledge_space_id="ks-test",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    body = mock_client.index.call_args.kwargs["document"]
    return body, needs_review


def _decomp_one(
    *,
    obj_name: str,
    name_en: str | None,
    obj_class: ObjectClass = ObjectClass.ORGANIZATION,
    claim: str,
    subject_surface: str | None,
) -> StructureResult:
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": obj_class.value},
                name=obj_name,
                name_en=name_en,
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim=claim,
                subject_uid="obj-1",
                subject_surface=subject_surface,
                predicate="announces",
                object_value="결과",
            ),
        ],
        extraction_status="success",
    )


# ─── 1. PRIMARY ACCEPTANCE: Japan recovery ────────────────────────────


def test_japan_recovery_from_claim() -> None:
    """LLM emits subject_name='Japan', subject_surface='Japan' on the
    Korean claim '일본은 무기 수출 규제를 완화하며…'. Recovery parses
    the 은 particle boundary and replaces 'Japan' with '일본'.

    This is the PR's primary ★ acceptance case (PO #1)."""
    decomp = _decomp_one(
        obj_name="Japan",
        name_en="Japan",
        claim="일본은 무기 수출 규제를 완화하며 외교적 영향력을 강화했다.",
        subject_surface="Japan",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "일본"
    assert body["primary_lang"] == "ko"


# ─── 2. Ministry recovery ─────────────────────────────────────────────


def test_ministry_recovery_from_claim() -> None:
    """LLM emits 'Ministry of Commerce of China'. Recovery walks the
    는 particle in '중국 상무부는…' and yields '중국 상무부'."""
    decomp = _decomp_one(
        obj_name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        claim="중국 상무부는 미국 반도체 수출통제에 대응했다.",
        subject_surface="Ministry of Commerce of China",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"


# ─── 3. Leading time excluded ────────────────────────────────────────


def test_leading_time_excluded_from_recovery() -> None:
    """'22일 중국 상무부는 발표했다' — recovery must NOT include the
    leading '22일' adverbial. Result: '중국 상무부'.

    PO ★ acceptance #2."""
    decomp = _decomp_one(
        obj_name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        claim="22일 중국 상무부는 발표했다.",
        subject_surface="Ministry of Commerce of China",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"


# ─── 4. Person recovery (out-of-dictionary) ───────────────────────────


def test_person_recovery_from_claim() -> None:
    """안도걸 더불어민주당 의원 — out-of-dictionary Korean person.
    LLM emits 'Ahn Do-geol'. Recovery from the 은 particle in
    '의원은' yields the full Korean noun phrase."""
    decomp = _decomp_one(
        obj_name="Ahn Do-geol",
        name_en="Ahn Do-geol",
        obj_class=ObjectClass.PERSON,
        claim="안도걸 더불어민주당 의원은 청문회에서 발언했다.",
        subject_surface="Ahn Do-geol",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "안도걸 더불어민주당 의원"
    assert body["primary_lang"] == "ko"


# ─── 5. Brand path preserved (SpaceX from English source) ────────────


def test_english_brand_in_korean_text_no_recovery_needed() -> None:
    """SpaceX in Korean text — verbatim substring of source, brand-
    shaped → no violation → no recovery invoked. Existing path
    preserved."""
    decomp = _decomp_one(
        obj_name="SpaceX",
        name_en="SpaceX",
        claim="SpaceX는 발사에 성공했다.",
        subject_surface="SpaceX",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "SpaceX"


# ─── 6. Korean brand transliteration → English canonical ─────────────


def test_korean_brand_transliteration_still_canonicalizes() -> None:
    """스페이스X — brand_resolver maps to SpaceX BEFORE the violation
    check. The recovery path is not triggered. Existing brand path
    preserved (PO: 'brand transliteration 기존 brand_resolver 그대로')."""
    decomp = _decomp_one(
        obj_name="SpaceX",
        name_en="SpaceX",
        claim="스페이스X가 한국 시장에 진출했다.",
        subject_surface="스페이스X",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "SpaceX"


# ─── 7. Lockheed Martin (English verbatim) — kept English ─────────────


def test_lockheed_martin_verbatim_substring_kept_english() -> None:
    """Lockheed Martin is multi-word English (not brand-shaped per
    `_looks_like_brand`), but its surface IS a verbatim substring of
    the Korean claim. detect_violation returns False → no recovery
    → kept English. PO: 'Lockheed 영어 유지'."""
    decomp = _decomp_one(
        obj_name="Lockheed Martin",
        name_en="Lockheed Martin",
        claim="Lockheed Martin이 새 무기 체계를 발표했다.",
        subject_surface="Lockheed Martin",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "Lockheed Martin"
    assert body["primary_lang"] == "en"


# ─── 8. No-particle Korean claim → genuine needs_review fallback ─────


def test_no_particle_claim_falls_back_to_needs_review() -> None:
    """'일본 무기 수출 규제 완화' — title-like Korean fragment, NO
    subject particle. Recovery returns None; the LLM's 'Japan' surface
    is kept and needs_review=True. This is the ONLY genuine HITL case
    left in the loop (rare; titles / fragments without a clausal
    structure)."""
    decomp = _decomp_one(
        obj_name="Japan",
        name_en="Japan",
        claim="일본 무기 수출 규제 완화",
        subject_surface="Japan",
    )
    body, needs_review = _run(decomp)
    assert needs_review is True
    # No recovery → LLM surface preserved exactly.
    assert body["primary_label"] == "Japan"
