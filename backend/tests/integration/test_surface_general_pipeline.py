"""B-62-fix-v3-general end-to-end pipeline tests (PO 2026-06-22).

Exercises the production `_match_object` path with mocked LLM/ES to
prove the general verbatim-substring mechanism handles the 8 cases
in the PO's acceptance criteria:

  1. Korean person name (안도걸 의원) — Korean primary, no violation.
  2. Korean government verbatim (중국 상무부) — Korean primary, no violation.
  3. Korean government anglicized (Ministry of Commerce of China on a
     Korean claim) — VIOLATION flagged, LLM surface kept (English
     primary). HITL resolves; no dictionary guess.
  4. Korean brand transliteration (스페이스X) — brand resolver maps to
     SpaceX; English primary, no violation, no review flag.
  5. English brand in Korean text (SpaceX 발사) — kept English, no
     violation.
  6. Out-of-map Korean company (우리자산운용) — kept Korean, no
     violation. The generality proof: NOT in any curated dictionary,
     yet the verbatim rule preserves it.
  7. Real multi-word English company in Korean text (Lockheed Martin)
     — kept English (verbatim substring of source), no violation.
  8. Mixed text — Korean kept, brands kept English, English entity
     substrings kept English.
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


# ---------------------------------------------------------------------------
# 1. Korean person name
# ---------------------------------------------------------------------------


def test_korean_person_name_kept_korean() -> None:
    """안도걸 의원 — LLM emits Korean subject_surface. Primary Korean,
    no violation. This is the PO's acceptance criterion #1."""
    decomp = _decomp_one(
        obj_name="Ahn Do-geol",
        name_en="Ahn Do-geol",
        obj_class=ObjectClass.PERSON,
        claim="안도걸 더불어민주당 의원이 발표했다.",
        subject_surface="안도걸 의원",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "안도걸 의원"
    assert body["primary_lang"] == "ko"


# ---------------------------------------------------------------------------
# 2. Korean government entity verbatim
# ---------------------------------------------------------------------------


def test_korean_government_verbatim_kept_korean() -> None:
    """중국 상무부 — LLM correctly emits Korean subject_surface.
    Primary Korean. PO acceptance criterion #2."""
    decomp = _decomp_one(
        obj_name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        claim="중국 상무부는 새로운 수출통제 조치를 발표했다.",
        subject_surface="중국 상무부",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"


# ---------------------------------------------------------------------------
# 3. Korean government anglicized (violation case)
# ---------------------------------------------------------------------------


def test_korean_government_anglicized_flagged_for_review() -> None:
    """LLM emits subject_surface in English on a Korean claim. The
    English form is NOT a substring of the claim → violation
    flagged. Primary stays English (we do NOT guess). HITL resolves."""
    decomp = _decomp_one(
        obj_name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        claim="중국 상무부는 새로운 수출통제 조치를 발표했다.",
        subject_surface="Ministry of Commerce of China",
    )
    body, needs_review = _run(decomp)
    assert needs_review is True
    # Surface kept as LLM-emitted. Primary is English by the resolver's
    # natural-primary rule (no Korean surface was supplied to defend).
    assert body["primary_label"] == "Ministry of Commerce of China"


# ---------------------------------------------------------------------------
# 4. Korean brand transliteration → English canonical
# ---------------------------------------------------------------------------


def test_korean_brand_transliteration_canonicalizes_to_english() -> None:
    """스페이스X — Korean transliteration of an international brand.
    brand_resolver maps to SpaceX BEFORE the violation check, so the
    surface becomes English (brand-shaped) and the verbatim rule is
    satisfied. PO acceptance criterion #4 (브랜드)."""
    decomp = _decomp_one(
        obj_name="SpaceX",
        name_en="SpaceX",
        claim="스페이스X는 보통주를 매각해 750억달러를 조달했다.",
        subject_surface="스페이스X",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "SpaceX"
    assert body["primary_lang"] == "en"


# ---------------------------------------------------------------------------
# 5. English brand in Korean text
# ---------------------------------------------------------------------------


def test_english_brand_in_korean_text_kept_english() -> None:
    """SpaceX appears in English in a Korean claim. Brand-shaped, no
    violation. PO acceptance criterion #4 (Lockheed/RedCat 영어 유지)."""
    decomp = _decomp_one(
        obj_name="SpaceX",
        name_en="SpaceX",
        claim="SpaceX 발사 성공으로 시장이 반등했다.",
        subject_surface="SpaceX",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "SpaceX"
    assert body["primary_lang"] == "en"


# ---------------------------------------------------------------------------
# 6. Out-of-map Korean company — generality proof
# ---------------------------------------------------------------------------


def test_out_of_dictionary_korean_company_kept_korean() -> None:
    """우리자산운용 — NOT in any curated dictionary. The general
    verbatim rule preserves it as Korean primary. This is the PO's
    acceptance criterion #3 — the GENERALITY PROOF (사전 밖)."""
    decomp = _decomp_one(
        obj_name="Woori Asset Management",
        name_en="Woori Asset Management",
        claim="우리자산운용은 ETF를 운용한다.",
        subject_surface="우리자산운용",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "우리자산운용"
    assert body["primary_lang"] == "ko"


# ---------------------------------------------------------------------------
# 7. Real multi-word English company in Korean text
# ---------------------------------------------------------------------------


def test_lockheed_martin_in_korean_text_kept_english() -> None:
    """Lockheed Martin is multi-word English (not brand-shaped per
    `_looks_like_brand`), but its surface IS a verbatim substring of
    the Korean source. No violation. Primary stays English."""
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


# ---------------------------------------------------------------------------
# 8. Mixed text — Korean person + English brand + English person co-mention
# ---------------------------------------------------------------------------


def test_mixed_text_korean_kept_brands_kept_english() -> None:
    """One claim containing a Korean person (안도걸 의원), an English
    brand (SpaceX), and an English person name (Elon Musk).

    Each of the three is independently validated. We exercise all
    three objects against the same mocked client."""
    claim = "안도걸 의원과 SpaceX CEO Elon Musk가 회담했다."
    decomp = StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.PERSON.value},
                name="Ahn Do-geol",
                name_en="Ahn Do-geol",
            ),
            StructureObject(
                uid="obj-2",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="SpaceX",
                name_en="SpaceX",
            ),
            StructureObject(
                uid="obj-3",
                **{"class": ObjectClass.PERSON.value},
                name="Elon Musk",
                name_en="Elon Musk",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim=claim,
                subject_uid="obj-1",
                subject_surface="안도걸 의원",
                predicate="met_with",
                object_value="obj-3",
            ),
        ],
        extraction_status="success",
    )
    # Object 1: Korean person, kept Korean
    body_1, nr_1 = _run(decomp, obj_index=0)
    assert nr_1 is False
    assert body_1["primary_label"] == "안도걸 의원"
    assert body_1["primary_lang"] == "ko"

    # Object 2: English brand in Korean text — no violation. SpaceX
    # does NOT appear in surface_map (no fact has subject_uid=obj-2)
    # so the fallback surface is obj.name="SpaceX". Brand-shaped on a
    # Korean source IS LEGITIMATE per the rule. No violation.
    body_2, nr_2 = _run(decomp, obj_index=1)
    assert nr_2 is False
    assert body_2["primary_label"] == "SpaceX"

    # Object 3: English person in Korean text. Has no per-fact
    # surface (obj-3 referenced via object_value, not subject_uid in
    # this synthetic fact, but _build_surface_map skips obj-3 because
    # no object_surface was set). Fallback to obj.name="Elon Musk".
    # "Elon Musk" is a verbatim substring of the claim → no violation.
    body_3, nr_3 = _run(decomp, obj_index=2)
    assert nr_3 is False
    assert body_3["primary_label"] == "Elon Musk"
