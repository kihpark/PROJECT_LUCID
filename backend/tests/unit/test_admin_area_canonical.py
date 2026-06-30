"""
★ PO 2026-07-01 M-Dogfood-B: 한국어 행정구역 약칭 canonical 통합 검증.

★ 현장 dogfood:
  - 옛 entity "광주" + 새 entity "광주광역시" → ★ 두 개의 location entity
  - cosine('광주', '광주광역시') ≈ 0.6 (★ < DISAMBIG_FLOOR 0.70) → kNN ★ 못 잡음
  → ★ exact alias dict 로 보강 (★ Korean 한정, exact match 만)

Coverage:
  1. _normalize_surface: "광주" (lang=ko) → "광주광역시"
  2. _normalize_surface: 17 시도 모두 약칭 → 정식 매칭
  3. _normalize_surface: lang=en 이면 ★ skip (★ Korean 한정)
  4. _normalize_surface: substring 미적용 ("광주은행" → ★ "광주광역시은행" 안 됨)
  5. resolve(): "광주" 입력 → 기존 "광주광역시" entity exact hit
  6. 보수성: "SK" / "SK하이닉스" 는 ★ admin-area dict 와 무관 → ★ 별도 entity 유지
  7. dict 자체 sanity (★ 17개 verbatim)
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.structure.resolution_gateway import (
    _KOREAN_ADMIN_AREA_ALIAS,
    _normalize_surface,
    ResolvedEntity,
    resolve,
)


# ---------------------------------------------------------------------------
# 1) _normalize_surface: 광주 → 광주광역시 (★ PO 핵심 사례)
# ---------------------------------------------------------------------------

def test_admin_area_gwangju_short_to_full():
    """★ "광주" + lang=ko → "광주광역시"."""
    assert _normalize_surface("광주", "ko") == "광주광역시"


def test_admin_area_seoul_short_to_full():
    """★ "서울" + lang=ko → "서울특별시"."""
    assert _normalize_surface("서울", "ko") == "서울특별시"


def test_admin_area_busan_short_to_full():
    """★ "부산" + lang=ko → "부산광역시"."""
    assert _normalize_surface("부산", "ko") == "부산광역시"


def test_admin_area_full_form_passthrough():
    """★ 정식 명칭 입력 → 그대로 반환 (★ idempotent)."""
    assert _normalize_surface("광주광역시", "ko") == "광주광역시"
    assert _normalize_surface("서울특별시", "ko") == "서울특별시"


# ---------------------------------------------------------------------------
# 2) 17 시·도 verbatim coverage
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("short,full", [
    ("서울", "서울특별시"),
    ("부산", "부산광역시"),
    ("대구", "대구광역시"),
    ("인천", "인천광역시"),
    ("광주", "광주광역시"),
    ("대전", "대전광역시"),
    ("울산", "울산광역시"),
    ("세종", "세종특별자치시"),
    ("경기", "경기도"),
    ("강원", "강원특별자치도"),
    ("충북", "충청북도"),
    ("충남", "충청남도"),
    ("전북", "전북특별자치도"),
    ("전남", "전라남도"),
    ("경북", "경상북도"),
    ("경남", "경상남도"),
    ("제주", "제주특별자치도"),
])
def test_admin_area_all_17(short: str, full: str):
    """★ 17 시·도 — 행안부 행정구역 기준."""
    assert _normalize_surface(short, "ko") == full


def test_admin_area_dict_has_exactly_17():
    """★ 사전 비대 가드 — 17개 만 존재 (★ 시·도 단위)."""
    assert len(_KOREAN_ADMIN_AREA_ALIAS) == 17


# ---------------------------------------------------------------------------
# 3) lang != "ko" → admin-area normalize 스킵
# ---------------------------------------------------------------------------

def test_admin_area_skipped_for_english():
    """★ lang=en 일 때 "광주" 입력은 ★ admin-area normalize 안 함.

    영어 surface 가 한국어 약칭과 우연히 일치하더라도 (★ "광주" 자체가
    영어로 들어오면 transliteration 문제이지 admin-area aliasing 이 아님)
    ★ Korean lang 한정 안전 규칙.
    """
    # ★ lang=en 일 때는 ★ admin-area alias 적용 X
    assert _normalize_surface("광주", "en") == "광주"


# ---------------------------------------------------------------------------
# 4) Substring 미적용 (★ 보수성)
# ---------------------------------------------------------------------------

def test_admin_area_substring_does_not_normalize():
    """★ "광주은행" 은 ★ 약칭이 아니다 — ★ exact dict miss → 그대로 반환.

    ★ 만약 prefix match 였다면 "광주은행" → "광주광역시은행" 같은 catastrophic
    false-positive 발생. ★ exact lookup 만 → 안전.
    """
    assert _normalize_surface("광주은행", "ko") == "광주은행"
    assert _normalize_surface("서울대학교", "ko") == "서울대학교"
    assert _normalize_surface("경기도청", "ko") == "경기도청"


def test_admin_area_with_particle_strips_then_normalizes():
    """★ "광주에" (particle "에" 붙음) → strip 후 "광주" → "광주광역시".

    ★ particles strip 후 admin-area alias 적용 (★ order: particles → admin).
    """
    assert _normalize_surface("광주에", "ko") == "광주광역시"
    assert _normalize_surface("서울이", "ko") == "서울특별시"


# ---------------------------------------------------------------------------
# 5) resolve() end-to-end: 광주 → 광주광역시 entity exact hit
# ---------------------------------------------------------------------------

@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_gwangju_short_form_hits_full_entity(mock_emb):
    """★ M-Dogfood-B 핵심: "광주" 입력 → 기존 "광주광역시" entity exact hit.

    ★ 정규화가 search query 에 들어가야 함 — 그래야 exact-match cascade 가
    name 필드의 "광주광역시" 와 일치한다.
    """
    mock_emb.return_value = None  # kNN 미진입
    client = MagicMock()
    # ★ 첫 tier (primary_label) 에서 "광주광역시" hit
    client.search.return_value = {"hits": {"hits": [{
        "_id": "gwangju-city-uid",
        "_source": {
            "object_uid": "gwangju-city-uid",
            "primary_label": "광주광역시",
            "name": "광주광역시",
            "class": "location",
            "entity_type": "location",
        },
    }]}}

    result = resolve("광주", "ko", "ks-1", client=client)
    assert isinstance(result, ResolvedEntity)
    assert result.entity_id == "gwangju-city-uid"
    assert result.source == "exact"
    assert result.entity_type == "location"
    # ★ 더 중요: 검색 query 의 term 이 "광주광역시" 여야 함 (★ normalize 적용 증거)
    call_kwargs = client.search.call_args.kwargs
    term_clause = call_kwargs["query"]["bool"]["filter"][1]
    assert term_clause["term"]["primary_label"] == "광주광역시"


# ---------------------------------------------------------------------------
# 6) 보수성: SK / SK하이닉스 는 admin-area dict 와 무관
# ---------------------------------------------------------------------------

def test_admin_area_does_not_touch_sk():
    """★ "SK" / "SK하이닉스" 는 ★ admin-area dict 와 무관 → 그대로 보존.

    ★ 별도 entity 유지 — admin-area normalize 가 ★ 회사명까지 잘못 묶지 않음.
    """
    # ★ admin-area dict 에 SK 없음 → normalize 영향 0
    assert _normalize_surface("SK", "ko") == "SK"
    assert _normalize_surface("SK하이닉스", "ko") == "SK하이닉스"
    # ★ 더 중요: SK 약칭이 admin-area dict 안에 ★ 들어가 있지 않은지 확인
    assert "SK" not in _KOREAN_ADMIN_AREA_ALIAS
    assert "SK하이닉스" not in _KOREAN_ADMIN_AREA_ALIAS


@patch("api.structure.resolution_gateway.get_embedding")
def test_resolve_sk_short_does_not_merge_with_sk_hynix(mock_emb):
    """★ "SK" → ★ admin-area normalize 영향 X → "SK하이닉스" entity 와 ★ 다른 path.

    ★ exact-match cascade 에서 SK 가 "SK하이닉스" 와 ★ 다른 surface 라 hit X
    → cross-lingual / kNN 도 못 잡으면 ★ 새 candidate entity.
    """
    mock_emb.return_value = None
    client = MagicMock()
    # ★ exact 4 tier 모두 miss (★ "SK" surface 와 "SK하이닉스" entity 는 다름)
    client.search.side_effect = [
        {"hits": {"hits": []}},  # primary_label
        {"hits": {"hits": []}},  # name
        {"hits": {"hits": []}},  # name_en
        {"hits": {"hits": []}},  # aliases
    ]

    result = resolve("SK", "ko", "ks-1", client=client)
    # ★ 새 candidate entity (★ 자동 병합 X)
    assert result.source == "candidate"
