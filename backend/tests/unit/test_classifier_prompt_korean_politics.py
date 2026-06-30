"""M-Dogfood 보강 A — 분류 prompt 도메인 보강 검증.

PO scope (2026-07-01 dogfood):
  - 한국 정치·인명·정당 맥락 보강
  - "OO사무처장/OO장관/OO대표" = person
  - "OO당/OO혁신당" = organization
  - 신진창·점정식 (인명) → person, 조국혁신당 → organization
  - 시간 표현 (2016-18년 등) = event 아님 → when 속성 (★ event 는
    명명된 사건만 — 6·3선거 등)

Two layers covered:
  A. _LLM_CLASSIFY_SYSTEM_PROMPT — system prompt few-shot / 규칙 텍스트.
     ★ prompt 문자열 자체에 새 가이드 라인이 들어갔는지 substring 검사.
  B. _classify_type_heuristic — fallback path 패턴 보강 검증.
     ★ Claude 호출 실패 시 heuristic 만으로도 정치 직함 / 정당이
     올바르게 떨어지는지.

★ live smoke (★ Claude 진짜 호출) 는 본 test 파일이 아닌 별도 manual
스모크 단계에서 — API key + 비용 발생하므로 unit test 는 prompt 텍스트와
heuristic 만 검증한다.
"""
from __future__ import annotations

import pytest

from api.structure.resolution_gateway import (
    _LLM_CLASSIFY_SYSTEM_PROMPT,
    _classify_type_heuristic,
)


# ---------------------------------------------------------------------------
# A. system prompt 텍스트 — 새 가이드 라인 / few-shot 흡수 확인
# ---------------------------------------------------------------------------

class TestClassifySystemPromptKoreanPolitics:
    """★ _LLM_CLASSIFY_SYSTEM_PROMPT 안에 PO 가 요구한 도메인 보강
    문구·예시가 모두 들어있는지 substring 으로 검증.

    ★ prompt 가 다시 정돈되더라도 의미가 빠지면 fail — 의미를 잃지 않게
    가드.
    """

    # ----- person: 한국 정치 직함 + 인명 -----
    def test_prompt_mentions_korean_political_titles_as_person(self):
        # 직함이 붙은 인명도 person 으로 분류해야 한다는 규칙
        assert "사무처장" in _LLM_CLASSIFY_SYSTEM_PROMPT
        assert "장관" in _LLM_CLASSIFY_SYSTEM_PROMPT
        assert "대표" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_includes_shin_jinchang_person_example(self):
        # 신진창 = PO 의뢰서 verbatim 예시
        assert "신진창" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_includes_jeom_jeongsik_person_example(self):
        # 점정식 = PO 의뢰서 verbatim 예시
        assert "점정식" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_distinguishes_title_only_from_person(self):
        # 직함만 단독 ("장관" 만) 은 person 아니다 — 의미 가드
        # ★ 'person 아님' 또는 '직함만' 키워드가 prompt 안에 있어야 한다
        assert (
            "직함만" in _LLM_CLASSIFY_SYSTEM_PROMPT
            or "person 아님" in _LLM_CLASSIFY_SYSTEM_PROMPT
        )

    # ----- organization: 한국 정당 -----
    def test_prompt_includes_jokuk_innovation_party_org_example(self):
        # 조국혁신당 = PO 의뢰서 verbatim 예시
        assert "조국혁신당" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_mentions_party_suffix_pattern(self):
        # OO당 / OO혁신당 패턴 가이드
        assert "혁신당" in _LLM_CLASSIFY_SYSTEM_PROMPT
        # 'OO당' / 'OO혁신당' 패턴 단어가 들어가야
        assert "OO당" in _LLM_CLASSIFY_SYSTEM_PROMPT \
            or "OO혁신당" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_includes_major_korean_parties(self):
        # 한국 주요 정당 example
        assert "더불어민주당" in _LLM_CLASSIFY_SYSTEM_PROMPT
        assert "국민의힘" in _LLM_CLASSIFY_SYSTEM_PROMPT

    # ----- event vs when: 시간 표현 ≠ event -----
    def test_prompt_distinguishes_time_expression_from_event(self):
        # 시간 표현은 event 아니다 (★ when 속성)
        # 핵심 키워드: "시간 표현" + "event 아님" / "when"
        assert "시간 표현" in _LLM_CLASSIFY_SYSTEM_PROMPT
        assert "when" in _LLM_CLASSIFY_SYSTEM_PROMPT.lower()

    def test_prompt_includes_time_range_not_event_example(self):
        # 2016-2018년 같은 시간 범위 예시
        assert "2016" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_clarifies_event_means_named_only(self):
        # event 는 명명된 사건만
        assert "명명된 사건" in _LLM_CLASSIFY_SYSTEM_PROMPT

    def test_prompt_includes_canonical_event_examples(self):
        # 6·3선거 = PO 의뢰서 명시 anchor
        assert "6·3선거" in _LLM_CLASSIFY_SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# B. heuristic fallback — 한국 정치 직함·정당 패턴이 잘 떨어지는지
# ---------------------------------------------------------------------------

class TestHeuristicKoreanPolitics:
    """★ Claude 호출 실패 시 heuristic 으로도 PO scope 표면형을 합리적으로
    찍어야 한다. heuristic 은 'in s' substring 매칭이라 한계 있지만, PO 가
    명시한 직함·정당 suffix 는 떨어져야.
    """

    # ----- person: 정치 직함 -----
    # ★ heuristic 은 greedy 단음절 location pattern ("리", "시", "도") 때문에
    # "총리" 같은 직함은 location 으로 떨어진다 (★ 기존 test_stage1b_ii_final_llm
    # 에 문서화된 한계). 그러므로 이 parametrize 는 그 단음절 충돌이 없는
    # 직함만 다룬다 — "총리" 케이스는 ★ Claude LLM 통합 path 가 처리한다.
    @pytest.mark.parametrize(
        "surface",
        [
            "신진창 사무처장",
            "점정식 의원",
            "이재명 대표",
            "조국 위원장",
            "박찬대 원내대표",
            "김기현 의원",
        ],
    )
    def test_korean_political_titled_names_are_person(self, surface):
        assert _classify_type_heuristic(surface, "ko") == "person"

    def test_total_premier_falls_to_location_heuristic_limitation(self):
        """★ KNOWN heuristic 한계 문서화 — '총리' 는 '리' (location) 에
        먹혀 location 으로 떨어진다. ★ 이 약점이 ★ Claude LLM 분류가 필요한
        이유. 본 test 는 ★ heuristic 의 한계를 명시적으로 문서화 — 의도적
        bug acknowledgement (★ 실제 path 는 Claude 가 person 으로 잡음).
        """
        assert _classify_type_heuristic("김민석 국무총리", "ko") == "location"
        assert _classify_type_heuristic("한덕수 총리", "ko") == "location"

    # ----- organization: 정당 suffix -----
    @pytest.mark.parametrize(
        "surface",
        [
            "조국혁신당",
            "더불어민주당",
            "개혁신당",
        ],
    )
    def test_korean_political_parties_are_organization(self, surface):
        assert _classify_type_heuristic(surface, "ko") == "organization"

    # ----- '국민의힘' — substring 매칭 (★ heuristic 한계 알면서 보강) -----
    def test_kookminuihim_party_is_organization(self):
        # heuristic pattern 에 '국민의힘' 직접 들어가 있어야
        assert _classify_type_heuristic("국민의힘", "ko") == "organization"

    # ----- heuristic 한계: 직함 없는 단일 한국인 이름은 heuristic 만으론
    #   잡지 못 한다. (★ Claude 가 잡는 영역). 이 test 는 ★ 의도적인
    #   heuristic 의 약함을 문서화 — Claude 호출이 필요한 이유. -----
    def test_bare_korean_name_falls_back_to_concept_in_heuristic(self):
        # 직함 없는 인명은 heuristic 만으로는 분류 못함 — concept fallback
        # (★ live path 에서는 Claude 가 person 으로 잡는다)
        assert _classify_type_heuristic("신진창", "ko") == "concept"
        assert _classify_type_heuristic("점정식", "ko") == "concept"
