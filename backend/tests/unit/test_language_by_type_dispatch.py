"""B-62-fix-v7 unit tests — type-based dispatch in `_match_object`.

PO 2026-06-22 (feat/spo-subject-language-by-type):

Replaces the 6th-round unconditional violation+recovery branch with a
four-way dispatch keyed on `StructureObject.entity_type`:

  - "company" / "brand" / "product"     → English canonical
                                          (brand_resolver + LLM `name`)
                                          NO claim recovery
  - "person" with person_origin == "ko" → claim recovery (Korean)
  - "person" with person_origin != "ko" → trust LLM English/canonical
  - "country" / "government" / "institution" / "concept" / "policy"
    / "event" / "location"              → claim recovery (Korean)
  - else (None / unknown)               → 6th-round behavior (fallback)

Each test drives `_match_object` against a mocked ES client and asserts
the final `primary_label` in the indexed body. The mocked ES client
returns "no existing object" so every call enters the CREATE path,
where `primary_label` is set from `pick_natural_primary(...)`.
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

# `unit` is not a registered marker (pytest.ini only registers
# `integration`). Discovery picks the file up via its filename +
# tests/unit/ location regardless of markers.
_ = pytest  # imported for fixture availability in the helpers


def _run(decomp: StructureResult) -> tuple[dict, bool]:
    """Drive `_match_object` on decomp.objects[0]. Returns
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
            decomp.objects[0],
            knowledge_space_id="ks-test",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    body = mock_client.index.call_args.kwargs["document"]
    return body, needs_review


def _decomp(
    *,
    name: str,
    name_en: str | None,
    obj_class: ObjectClass,
    entity_type: str | None,
    person_origin: str | None = None,
    claim: str,
    subject_surface: str | None,
) -> StructureResult:
    return StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": obj_class.value},
                name=name,
                name_en=name_en,
                entity_type=entity_type,
                person_origin=person_origin,
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


# ─── COMPANY ──────────────────────────────────────────────────────────


def test_company_aerovironment_keeps_llm_english_canonical() -> None:
    """Primary acceptance #1: 에이비옥스가 거래 종목에 포함되었다.
    LLM emits name='AeroVironment', subject_surface='에이비옥스',
    entity_type='company'. The 6th round would have over-corrected
    via claim recovery to '에이비옥스'. The new dispatch keeps
    'AeroVironment' as primary_label."""
    decomp = _decomp(
        name="AeroVironment",
        name_en="AeroVironment",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="company",
        claim="에이비옥스가 거래 종목에 포함되었다.",
        subject_surface="에이비옥스",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "AeroVironment"
    assert body["primary_lang"] == "en"


def test_company_known_transliteration_via_brand_resolver() -> None:
    """Primary acceptance #2: 스페이스X → SpaceX via brand_resolver.
    Known Korean transliteration in `_KO_TO_EN_BRAND`."""
    decomp = _decomp(
        name="SpaceX",
        name_en="SpaceX",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="company",
        claim="스페이스X가 한국 시장에 진출했다.",
        subject_surface="스페이스X",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "SpaceX"


def test_company_lockheed_martin_multiword_english_kept() -> None:
    """Lockheed Martin is multi-word English (NOT brand-shaped per
    `_looks_like_brand`); on a Korean claim it appears verbatim in
    the source. The company branch trusts the LLM's English `name`."""
    decomp = _decomp(
        name="Lockheed Martin",
        name_en="Lockheed Martin",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="company",
        claim="Lockheed Martin이 새 무기 체계를 발표했다.",
        subject_surface="Lockheed Martin",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "Lockheed Martin"
    assert body["primary_lang"] == "en"


# ─── PERSON ───────────────────────────────────────────────────────────


def test_person_korean_origin_recovers_from_claim() -> None:
    """Korean person → claim recovery fires. LLM emits 'Ahn Do-geol';
    the 은 particle in '의원은' yields '안도걸 더불어민주당 의원'."""
    decomp = _decomp(
        name="Ahn Do-geol",
        name_en="Ahn Do-geol",
        obj_class=ObjectClass.PERSON,
        entity_type="person",
        person_origin="ko",
        claim="안도걸 더불어민주당 의원은 청문회에서 발언했다.",
        subject_surface="Ahn Do-geol",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "안도걸 더불어민주당 의원"
    assert body["primary_lang"] == "ko"


def test_person_english_origin_keeps_llm_canonical() -> None:
    """Non-Korean person → trust LLM's English canonical. NO claim
    recovery (recovery would yield '트럼프 대통령' which destroys
    cross-source dedup against 'Donald Trump' captures)."""
    decomp = _decomp(
        name="Donald Trump",
        name_en="Donald Trump",
        obj_class=ObjectClass.PERSON,
        entity_type="person",
        person_origin="en",
        claim="트럼프 대통령은 행정명령에 서명했다.",
        subject_surface="Trump",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    # LLM English canonical preserved as primary; no Korean recovery.
    assert body["primary_label"] == "Donald Trump"
    assert body["primary_lang"] == "en"


def test_person_chinese_origin_keeps_romanized_canonical() -> None:
    """Chinese person → trust LLM's romanized canonical (Xi Jinping).
    v2 may add a native-script cascade (习近平); v1 lands on
    romanized."""
    decomp = _decomp(
        name="Xi Jinping",
        name_en="Xi Jinping",
        obj_class=ObjectClass.PERSON,
        entity_type="person",
        person_origin="zh",
        claim="시진핑 중국 국가주석은 회담을 가졌다.",
        subject_surface="Xi Jinping",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "Xi Jinping"
    assert body["primary_lang"] == "en"


# ─── COUNTRY / GOVERNMENT / CONCEPT ────────────────────────────────────


def test_country_japan_recovers_from_claim() -> None:
    """Country → claim recovery on violation. 일본 verbatim recovered
    from the 은 particle. The 6th-round behavior is preserved exactly
    for this category."""
    decomp = _decomp(
        name="Japan",
        name_en="Japan",
        obj_class=ObjectClass.PLACE,
        entity_type="country",
        claim="일본은 무기 수출 규제를 완화했다.",
        subject_surface="Japan",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "일본"
    assert body["primary_lang"] == "ko"


def test_government_ministry_with_leading_time_excluded() -> None:
    """Government → claim recovery + leading temporal adverbial strip.
    '22일' is excluded from the recovered noun phrase."""
    decomp = _decomp(
        name="Ministry of Commerce of China",
        name_en="Ministry of Commerce of China",
        obj_class=ObjectClass.ORGANIZATION,
        entity_type="government",
        claim="22일 중국 상무부는 미국 반도체 수출통제에 대응했다.",
        subject_surface="Ministry of Commerce of China",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"


def test_concept_export_controls_recovers_from_claim() -> None:
    """Concept → claim recovery. '수출통제가...' yields '수출통제'."""
    decomp = _decomp(
        name="export controls",
        name_en="export controls",
        obj_class=ObjectClass.CONCEPT,
        entity_type="concept",
        claim="수출통제가 강화되었다.",
        subject_surface="export controls",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "수출통제"
    assert body["primary_lang"] == "ko"


# ─── LEGACY (entity_type=None) FALLBACK ──────────────────────────────


def test_legacy_no_entity_type_falls_back_to_sixth_round() -> None:
    """Older captures that don't carry entity_type → else branch
    preserves 6th-round behavior. 'Japan' on Korean claim still
    recovers to '일본'."""
    decomp = _decomp(
        name="Japan",
        name_en="Japan",
        obj_class=ObjectClass.PLACE,
        entity_type=None,  # legacy capture
        claim="일본은 무기 수출 규제를 완화했다.",
        subject_surface="Japan",
    )
    body, needs_review = _run(decomp)
    assert needs_review is False
    assert body["primary_label"] == "일본"
    assert body["primary_lang"] == "ko"
