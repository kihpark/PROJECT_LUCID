# Lucid — Surface Stage Specification

**Status:** Beta Scope Locked (v2 — wireframes aligned, 5 modes)
**Stage:** S (Surface) of CSVS
**Author:** PO + 박기흥
**Date:** 2026-05

---

> ## v2 supersession notice (2026-05-21)
>
> This specification was authored before the MASTER_HANDOFF v2 stack
> + UX consolidation (PO directives 2026-05-21). Where this document
> conflicts with MASTER_HANDOFF.md or with the wireframes
> (`frontend/stellar-graph/pack5-stellar-settings.html` for Stellar +
> Settings; other packs TBD), the wireframes win, MASTER_HANDOFF wins
> second, and this spec is reference-only third (per the truth
> priority directive [변경 9]).
>
> Specific v2 changes that affect this document:
> - Surface has **5 modes** (0 / 1 / 2 / 3 / 4) in v2. Mode 5
>   Staleness is RETIRED (PO directive [변경 4], DR-053 / C-14).
>   §9 in this file already reflects the retraction.
> - All Surface responses must begin with an identity phrase and
>   cite `fn-ID` for every claim (DR-047 / Critical Rule 15).
>
> The body below is preserved for historical context; pointers to the
> v2-correct shape are inline where the conflict is sharp.

---


## 0. 본 문서의 범위

CSVS 루프 중 **Surface 단계** = 검증된 지식이 사용자에게 다시
"떠오르는" 방식. 핵심 변경:

- **Stale 모드 완전 제거**. 6 modes → **5 modes**.
- 시점 사실은 영구 보존, 만료 없음.
- Entity 색 코딩이 fact 텍스트 안에 등장 (subtle 배경).
- Identity protocol 강화 ("As far as I know...").
- Ask Lucid (Passive Recall) 가 베타 킬러 기능.
- Gatekeeping은 베타에서 자기 그래프 비교만.

와이어프레임: Pack 4 (S-1 ~ S-5), Pack 5 SV-1, SV-3.

---

## 1. 핵심 원칙

> **그래프는 보여줘야 가치다. 사용자가 검증한 지식이 작업 흐름 속에서 자연스럽게 떠올라야 한다.**

Surface는 Lucid의 출력 면이다. 사용자가 "왜 Lucid를 쓰는가"에 대한
답이 여기서 결정된다. Surface 없는 Lucid는 그냥 또 다른 노트앱이다.

```
Surface의 다섯 가지 모드:

Mode 0  Lucid On/Off       사용자가 Surface 전체 켜고 끄기
Mode 1  Active Recall      타이핑 중 관련 사실 자동 등장
Mode 2  Passive Recall     대화형 QnA로 그래프 조회 (Ask Lucid)
Mode 3  Contradiction      모순 감지 (비동기)
Mode 4  Gatekeeping        가짜 정보 입구 차단
```

(Mode 5 Staleness는 베타에서 제거됨.)

Mode 0이 다른 모든 모드를 제어하는 마스터 토글.

---

## 2. Identity Protocol — 모든 Surface 출력의 인식론적 서명

베타 핵심 결정: Lucid가 사용자에게 무언가를 떠올려줄 때는
**그것이 사용자의 검증된 지식이라는 점이 명시적으로 드러나야 한다.**

### 2.1 응답 시작 표현 (3가지 중 하나)

```
EN:
  "As far as I know,"
  "According to your knowledge graph,"
  "Based on what you've validated,"

KR:
  "제가 아는 한,"
  "그래프 기준으로,"
  "기흥님이 검증한 것 기준으로,"
```

### 2.2 왜 중요한가

이건 단순 말투가 아니다. **인식론적 약속**이다:

- Lucid는 사용자가 검증한 것을 넘어 말하지 않는다.
- "내 생각엔..." 표현 금지 — 의견 없음.
- 일반 지식으로 메우기 금지 — 검증되지 않은 정보는 답에 포함 안 됨.
- 그럴듯하게 들리는 창작 금지 — hallucination 없음.

### 2.3 응답 3 패턴

| 패턴 | 시작 표현 | 본문 | 끝 |
|------|-----------|------|----|
| **Affirmative** | "As far as I know," | 그래프 사실 N개 + fn-IDs | (선택) 후속 질문 제안 |
| **Contradictive** | "According to your knowledge graph," | 사용자 주장과 충돌하는 사실 + fn-IDs + 검토 제안 | "Save claim for review" 버튼 |
| **Honest empty** | "As far as I know," | "그래프에 X에 대한 검증된 사실이 없습니다" | "관련 자료를 저장해주세요" 제안 |

---

## 3. Entity Color Coding — 사실 텍스트 시각화

베타에서 fact 텍스트 안의 entity 멘션은 Object class 색으로 표시.

### 3.1 적용 방식

```
스타일:
  · 배경: rgba(class_color, 0.10)
  · border: 1px solid rgba(class_color, 0.22)
  · 작은 좌측 점 표시
  · 텍스트 색은 본문 색 유지

예시 (Ask Lucid 응답 안):
  "[ChatGPT] had 200M weekly users in [May 2026]."
       ↑                                  ↑
   Service 청록색                       Event 분홍색
   배경 + 점                            배경 + 점
```

### 3.2 12 Object Class 색

```
AtomicFact          warm yellow   #ffd966
Concept             purple        #b794f6
Entity:Person       pink          #f6a5c0
Entity:Organization blue          #6db4f5
Entity:Service      teal          #4ecdc4
Entity:Product      teal          #4ecdc4
Entity:Place        green         #95e1a3
Knowledge           green         #95e1a3
Event               light pink    #e8b8d4
Procedure           orange        #ffa07a
Task                light teal    #a8dadc
Metric              light yellow  #ffe66d
Resource            tan           #c9b48a
Problem             red           #ff6b6b
Source              grey          #888888
```

### 3.3 적용 범위

| 화면 | 적용 | 비고 |
|------|------|------|
| S-1 Active Recall 툴팁 | ✓ | fact 텍스트 안 entity 색 |
| S-2 See All 패널 | ✓ | 각 fact card 안 |
| S-3 Ask Lucid 응답 | ✓ | 사실 목록 안 |
| S-4 Contradiction Queue | ✓ | Subject 라벨 + fact 본문 |
| S-5 Gatekeeping | ✓ | 주장 + 반대 증거 |
| Stellar View (SV-1) | ✓ | 별 색이 곧 entity class |

### 3.4 적용 안 하는 곳

- 편집기 본문 (S-1 Gmail mockup) — 점선 밑줄만, 색은 안 더함 (시각 노이즈)
- 사이드바, 헤더 등 UI chrome

---

## 4. Mode 0 — Lucid On/Off 토글

### 4.1 위치 — Chrome 확장 팝업 + Settings

```
Chrome 확장 클릭 → 작은 팝업:
┌─────────────────────────────┐
│ Lucid                       │
│ ●━━━━━━━━━━ ON  this device │
│                             │
│ Pending decisions: 7        │
│ Settings                    │
└─────────────────────────────┘
```

Settings SET-1에서도 동일한 마스터 토글.

### 4.2 OFF일 때 작동 정지하는 것

```
정지:
  · Active Recall (점선 밑줄)
  · Contradiction 자동 감지
  · Gatekeeping 경고
  · Passive Recall은 사용자가 명시적으로 호출하면 작동

계속 작동:
  · Save to Lucid (캡처 자체는 됨)
  · Decide 오버레이
  · Pending 큐 백그라운드 분석
```

원칙: 작업 흐름에 끼어드는 기능들이 OFF의 대상. 사용자가 명시적으로
호출하는 기능은 OFF여도 사용 가능.

---

## 5. Mode 1 — Active Recall (작성 중 자동 등장)

### 5.1 와이어프레임
Pack 4 S-1 (dotted underline + tooltip), S-2 (see all panel).

### 5.2 트리거 — 키 입력 디바운스

```
사용자가 어느 웹 텍스트 필드에서 입력
  ↓
500ms 디바운스 (Settings에서 조정 가능: 300/500/700ms/Off)
  ↓
Lucid가 키워드 스캔 (Chrome extension content script)
  ↓
그래프에서 매칭 사실 검색 (vector + graph distance)
  ↓
매칭 구문에 dotted orange underline
```

### 5.3 시각 — 점선 주황 밑줄

```
EU AI Act took effect on August 1, 2024...
~~~~~~~~~                                  ← 점선 주황
```

선택 이유:
- 점선 (실선 아님): "정보용" 신호, "오류"가 아님
- 주황 (빨강 아님): 맞춤법·문법 도구와 구분
- 호버 시에만 풍선 → 타이핑 중 방해 없음

### 5.4 풍선 (Tooltip)

```
호버 시 등장:
┌─────────────────────────────────┐
│ Lucid · related facts  3 of 7   │
├─────────────────────────────────┤
│ "EU AI Act took effect..."      │
│ fn-220 · wsj.com                │
│                                  │
│ "EU AI Act establishes a        │
│ risk-based framework..."        │
│ fn-221 · europa.eu              │
│                                  │
│ "High-risk systems require..."  │
│ fn-222 · europa.eu              │
├─────────────────────────────────┤
│ [Insert citation] [See all 7 →] │
└─────────────────────────────────┘
```

상위 3개 사실 표시. 더 많으면 "See all 7" 클릭 → S-2 패널.

### 5.5 액션

| 버튼 | 결과 |
|------|------|
| **Insert citation** | 커서 위치에 fn-ID 인라인 (예: `[fn-220]`) |
| **See all** | 사이드 패널 열림 (S-2) |
| 사실 카드 클릭 | Lucid 앱의 사실 상세로 이동 |

### 5.6 See All 패널 (S-2)

```
┌──────────────────────────────────────┐
│ All facts about [EU AI Act]   7 facts│
├──────────────────────────────────────┤
│ [All] [Recent] [By source]           │
├──────────────────────────────────────┤
│                                       │
│ "EU AI Act took effect on Aug 1..."  │
│ fn-220 · wsj.com · ai-governance     │
│ [Insert] [Open]                       │
│                                       │
│ ...                                   │
└──────────────────────────────────────┘
```

필터:
- All / Recent / By source
- 관련도 정렬 (vector + graph distance)

각 사실 카드:
- claim (entity 색 적용)
- fn-ID + 출처 + 태그
- Insert / Open 미니 액션

---

## 6. Mode 2 — Passive Recall (Ask Lucid)

### 6.1 와이어프레임
Pack 4 S-3 (Ask Lucid).

### 6.2 호출 방식

- 단축키: `⌘⇧L` (Mac) / `Ctrl+⇧L` (Win) — 어디서나
- Lucid 앱 사이드바 "Ask Lucid"
- Chrome 확장 팝업의 "Ask"

### 6.3 UI

```
┌─────────────────────────────────────┐
│ ⌬ Ask Lucid                  ⌘⇧L    │
├─────────────────────────────────────┤
│                                      │
│ [대화 내역]                          │
│                                      │
│ You: What do I know about protein   │
│      timing?                         │
│                                      │
│ Lucid:                               │
│   As far as I know, you have 4      │
│   validated facts on this topic:    │
│                                      │
│   "Daily total protein intake       │
│   matters more than timing..." fn-401│
│                                      │
│   "Protein distributed across 3-5   │
│   meals optimizes muscle protein    │
│   synthesis..." fn-402              │
│                                      │
│   ...                                │
├─────────────────────────────────────┤
│ [입력]                       [Send] │
└─────────────────────────────────────┘
```

### 6.4 응답 패턴 — 3가지 (Section 2.3 참조)

#### 패턴 1. Affirmative
```
You: "What do I know about protein timing?"

Lucid: "As far as I know, you have 4 validated 
facts on this topic:

· [Daily total protein intake] matters more 
  than timing for [muscle protein synthesis]. fn-401

· [Protein] distributed across 3-5 meals optimizes 
  [muscle protein synthesis] better than 
  concentrated intake. fn-402

· The [post-workout anabolic window] is wider 
  than previously believed — approximately 
  4-6 hours. fn-403

· Recommended [daily protein for active adults]: 
  1.6-2.2g per kg body weight. fn-404"
```

#### 패턴 2. Contradictive
```
You: "Is fasted cardio better for fat loss?"

Lucid: "According to your knowledge graph, 
the claim that fasted cardio is superior for 
fat loss is not supported by your validated 
facts. You have:

· [Fasted cardio] shows no significant difference 
  vs [fed cardio] in 24-hour [fat oxidation]. fn-410

· [Post-meal exercise] reduces [muscle loss risk] 
  during caloric deficit. fn-411

⚠ Note: The popular belief about fasted cardio 
contradicts your validated evidence. Would you 
like to save the new claim for review?

[+ Save claim for review]"
```

#### 패턴 3. Honest empty
```
You: "What about creatine for endurance training?"

Lucid: "As far as I know, your graph has no 
validated facts about creatine and endurance 
training.

I can't answer this from your graph alone. 
If you'd like, save a relevant article and 
Lucid will analyze it — facts can then enter 
your graph after review."
```

### 6.5 베타에서 안 하는 것

- ❌ 일반 지식 메우기 (Wikipedia, training data)
- ❌ 의견·추측·창작
- ❌ "내 생각엔...", "아마도..."
- ❌ 그래프 밖 정보 합성
- ❌ Multi-step 추론 (베타는 그래프 검색만, Phase 1에 reasoning 추가)

이 모드의 가치 명제: "Same question, very different answer" —
ChatGPT는 학습 데이터에서, Lucid는 검증된 사실에서.

---

## 7. Mode 3 — Contradiction Detection

### 7.1 와이어프레임
Pack 4 S-4 (Contradiction Queue), Pack 5 SV-3 (시각화).

### 7.2 감지 패턴 — 3가지

#### 패턴 A — 자동 CONTRADICTS
```
같은 Subject + 같은 Property + 다른 값
같은 시점·관할권

예: fn-301 "ChatGPT 200M users May 2026" (openai.com)
    fn-318 "ChatGPT 500M users May 2026" (techcrunch.com)
  → 같은 Subject + Property + 시점, 다른 값
  → 자동 CONTRADICTS 관계 생성
```

#### 패턴 B — 의미적 반대 (Suspected)
```
같은 Subject + 의미적으로 반대인 Predicate

예: fn-187 "EU AI Act prohibits all forms of facial recognition"
    fn-225 "EU AI Act prohibits real-time biometric ID with exceptions"
  → 같은 Subject, 의미 차이
  → 임베딩 유사도 + 핵심 단어 분석
  → Suspected CONTRADICTS, 사용자 확인 요청
```

#### 패턴 C — 맥락 차이 (모순 아님, 같이 보존)
```
같은 Subject + Property, 다른 시점/관할권/측정기준

예: "ChatGPT 100M users (2023)"
    "ChatGPT 200M users (2024)"
  → 같은 Subject + Property, 다른 시점
  → 모순 아님. 시간 진화.
  → 두 사실 보존, SUPERSEDES로 연결
```

### 7.3 감지 시점

```
1. Validate 직후 즉시 (동기 빠른 체크)
   Accept 누른 직후 같은 Subject·Property 검색
   감지 시 사이드바 배지 +1

2. 백그라운드 매일 잡 (비동기)
   매일 자정 전체 그래프 스캔

3. 새 사실이 기존 Subject 노드에 연결될 때마다
```

### 7.4 Contradiction Queue UI (S-4)

```
좌측 사이드바:    Contradictions (2) 배지
본문:             좌우 분할 카드
                  좌: 충돌 사실 1 (fn-ID + claim + 출처 + 시점)
                  우: 충돌 사실 2 (fn-ID + claim + 출처 + 시점)
```

각 카드에 entity 색 코딩 적용.

### 7.5 해소 옵션 — 4가지

| 옵션 | 결과 |
|------|------|
| **Keep one, drop the other** | 한쪽 명확히 강할 때 |
| **Keep both with context note** | 관할/범위/해석 차이 |
| **Demote both for review** | 둘 다 Pending 큐로 |

### 7.6 시각 신호

- 사이드바 배지에 빨간 숫자
- Stellar View에서 충돌 사실 두 개 사이 붉은 점선 곡선 (2초 주기 맥동)
- **방해적 toast 없음** — 사용자 흐름 보호

---

## 8. Mode 4 — Gatekeeping (가짜 정보 차단)

### 8.1 와이어프레임
Pack 4 S-5 (Gatekeeping Warning).

### 8.2 발동 조건 — 모두 충족

```
1. 새 주장과 충돌하는 기존 사실 2건 이상
2. 새 주장의 출처가 기존 사실의 출처들보다 약함
3. 기존 사실이 새 주장만큼 또는 더 최근에 검증됨
```

조건 모두 충족 시에만 발동. 단순 모순은 Section 7 (Contradiction Queue)로.

### 8.3 UI — 광우병 시나리오 (실제 와이어프레임)

```
┌─────────────────────────────────────┐
│ ⚠  This claim conflicts with        │
│    stronger evidence in your graph  │
├─────────────────────────────────────┤
│                                      │
│ You're trying to save:               │
│ "[U.S. beef imports] cause          │
│ [Korean people] to easily develop   │
│ [mad cow disease]."                  │
│ source: anonymous blog post · 2024   │
│                                      │
│ Counter-evidence in your graph:      │
│                                      │
│ "0 confirmed cases of [variant CJD]  │
│ in [Korea] since beef import         │
│ resumption (2008-present)."          │
│ Korea Disease Control Agency · fn-501│
│                                      │
│ "[Epidemiological investigation]     │
│ found no causal link..."             │
│ Korea National Institute of Health · │
│ fn-502                               │
│                                      │
│ "No documented cases of [vCJD]       │
│ transmission via [processed food]."  │
│ World Health Organization · fn-503   │
│                                      │
│ Why this warning:                    │
│ ✓ 3 existing facts directly contradict│
│ ✓ Counter-evidence sources are more  │
│   authoritative                      │
│ ✓ Counter-evidence is as recent or   │
│   more recent                        │
├─────────────────────────────────────┤
│ [Cancel save]  [Save anyway]         │
└─────────────────────────────────────┘
```

### 8.4 핵심 — Warn, never block

```
Lucid는 저장을 차단하지 않는다.
사용자는 언제든 "Save anyway"로 강제 진행 가능.
```

강제 저장 시:
- `override_warning: true` 메타데이터 표시
- 그래프에서 노란 테두리로 시각 구분
- Auto-accepted 탭의 Flagged 필터에 자동 등록

원칙: **사용자 자율성 + 투명성**. 차단하지 않지만 결정의 흔적은 남김.

### 8.5 베타 범위 — 자기 그래프만

```
베타:    사용자 자신의 검증된 사실만 비교
Phase 1: 팔로우한 전문가의 그래프 비교 추가
Phase 2: 외부 팩트체크 DB 추가 (선택적)
```

사용자가 "권위의 기준"을 통제하는 게 핵심. 외부 권위에 의존하지 않음.

---

## 9. Stellar View — 검증된 지식의 별자리

### 9.1 와이어프레임
Pack 5 SV-1 (Overview + facets), SV-2 (단일 class filter), SV-3 (Contradiction), SV-4 (Star System View).

### 9.2 핵심 원칙

> **사용자가 자기 그래프를 갖고 노는 경험이 deep value 다.**

검증된 지식의 통제권을 시각적으로 행사. faceted search + 자유 항해 + 4 레벨 줌으로 그래프를 깊이 탐색할 수 있다.

### 9.3 별 = 객체 노드

```
색       Object class (12색, entity 색과 동일)
크기     연결된 사실 수에 비례
밝기     검증 레벨 (manual > auto-trusted > auto-careful)
외곽     큰 허브에는 흰색 가는 테두리
```

### 9.4 선 = 관계

```
실선         일반 관계 (ASSERTS_PROPERTY, INVOLVES 등)
점선         약한 관계 (DERIVED_FROM 등)
붉은 점선    CONTRADICTS (긴장선, 2초 맥동)
```

### 9.5 4 레벨 줌 — 정보 밀도 변화

```
L0  GALAXY VIEW (전체)
    · 별 + 군집 자동 형성
    · 군집 라벨만 표시 (AI Governance, Personal Health 등)
    · 개별 별 라벨 숨김 (시각 노이즈 방지)
    · 모순·이벤트만 시각 강조

L1  CONSTELLATION VIEW (군집 줌 인)
    · 한 군집 가까이
    · 큰 별 (허브) 라벨 표시
    · 작은 별 (변두리) 라벨 숨김
    · 군집 내 연결 강조

L2  STAR SYSTEM VIEW (개별 객체)
    · 한 별과 1-hop 이웃
    · 모든 연결 라벨 표시
    · 사실 카드 사이드패널 자동 열림
    · Object properties 시각화

L3  FACT VIEW (사실 본문)
    · 한 사실 전문 + 출처
    · 검증 시점, Edit 이력
    · 관련 사실 (SUPPORTS/CONTRADICTS) 옆에 카드
    · Edit / Demote / Drop 가능
```

줌 인터랙션:
- 마우스 휠 → 부드러운 줌 (L0 ↔ L3)
- 더블 클릭 → 한 단계 줌 in
- ESC → 한 단계 줌 out
- G 키 → L0 즉시 복귀

### 9.6 Faceted Search — 6 차원 필터

좌측 패널 facets:

```
1. CLASS         12 Object Class 다중 선택
2. TAG           사용자 태그 다중 선택
3. SOURCE        출처 도메인 다중 선택
4. TIME          저장 시점 또는 valid_from 범위 (P1)
5. VALIDATION    검증 방법 + 출처 정책 (P1)
6. CONNECTIONS   연결 수 (hub vs leaf vs isolated) (P1)
```

각 facet 결합 규칙:
- facet 간 AND
- facet 내 옵션 OR

### 9.7 Facet UI 핵심 원칙

```
1. 카운트 항상 표시
   각 facet 옵션 옆에 "현재 결과 안에 몇 개"
   사용자가 클릭 전에 결과 예측 가능

2. Pivot facet
   가장 위 (CLASSES) 가 가장 강한 필터
   체크 시 즉시 그래프 갱신
   다른 facet 카운트도 즉시 갱신 (ES aggregation)

3. 후퇴, 삭제 아님
   필터 제외 노드 → 8% opacity 후퇴
   완전히 사라지지 않음 (공간 기억 유지)

4. 인디케이터
   "31 of 247" = 보이는 / 전체
   "Clear all" → L0 리셋
```

### 9.8 키워드 검색

좌측 패널 최상단 검색창. 7번째 차원 (facet과 AND 결합):

```
객체 이름         → 해당 별 하이라이트 + 자동 줌 in
사실 텍스트       → 매칭 fact 카드 표시
출처 도메인        → 해당 source 사실 모두 하이라이트
태그              → 태그 사실 모두 하이라이트
```

### 9.9 자유 항해 — 인터랙션

```
▸ 줌·팬
  · 휠 → 줌
  · 드래그 → 팬
  · 더블 클릭 → 그 노드로 줌 in
  · 모바일 pinch → 줌

▸ 노드 선택
  · 단일 클릭 → 선택 + 사이드패널
  · Shift+클릭 → 다중 선택
  · 빈 곳 클릭 → 선택 해제

▸ 컨텍스트 액션 (우클릭)
  · Show 1-hop neighbors
  · Filter to this cluster
  · Pin to view (필터 변경에도 유지)
  · Hide from view
  · Open in detail (L3)
  · Find similar facts

▸ 키보드 단축키
  · F          포커스 검색
  · G          Galaxy view 복귀
  · ESC        한 단계 줌 out
  · /          filter 패널 토글
  · Cmd+F      facet 추가
  · 1-6        facet 빠른 토글
  · Enter      선택 노드 줌 in
  · Backspace  선택 노드 그래프에서 제외

▸ Pin 시스템
  · 중요 노드 핀 → 필터 변경해도 항상 표시
  · 최대 10개
  · 핀 목록 좌측 패널 하단
```

### 9.10 베타 우선순위

```
P0 (Sprint 5 launch 필수):
  ✓ 줌·팬 (L0 ~ L2)
  ✓ Class facet (12 class)
  ✓ Tag facet
  ✓ Source facet
  ✓ 키워드 검색
  ✓ 노드 클릭 → 사이드패널
  ✓ ESC 줌 out
  ✓ Clear all 리셋
  ✓ "N of N" 인디케이터

P1 (Sprint 7 polish):
  · L3 Fact view (개별 사실 페이지)
  · Pin 시스템
  · 컨텍스트 메뉴
  · 키보드 단축키 전체
  · Validation facet
  · Connections facet

P2 (Phase 1+):
  · 시간 슬라이더 (Time facet)
  · 군집 자동 감지 + 명명 (community detection)
  · 그래프 export (PNG, GraphML)
  · 협업 공유 (read-only link)
```

### 9.11 백엔드 — ES Aggregation 패턴

Faceted search 가 ES 강점:

```
단일 쿼리로 필터 + 모든 facet 카운트 동시 반환:

GET /lucid_facts/_search
{
  "query": {
    "bool": {
      "filter": [
        {"terms": {"class": ["Event", "Knowledge"]}},
        {"terms": {"tags": ["ai-governance"]}},
        {"terms": {"source_domain": ["wsj.com"]}}
      ]
    }
  },
  "aggs": {
    "by_class": {"terms": {"field": "class"}},
    "by_tag": {"terms": {"field": "tags"}},
    "by_source": {"terms": {"field": "source_domain"}}
  }
}

→ 결과 + 다음 facet 카운트 한 번에
→ "31 of 247" 즉시 가능
```

### 9.12 시각 모드 요약

| 모드 | 시각 | 와이어프레임 |
|------|------|------|
| Galaxy (L0) | 전체 그래프, 군집 라벨만 | SV-1 |
| Single filter | 한 class 강조, 나머지 8% | SV-2 |
| Contradiction | 충돌 사실 + 긴장선 | SV-3 |
| Star System (L2) | 한 별 + 1-hop + 사이드패널 | SV-4 |

### 9.13 stale 시각 표시 제거됨

```
이전:  stale 별은 채도 낮아지고 천천히 깜박임
새:    제거됨. 모든 사실 영구 보존.
```

---

## 10. 알림 정책

```
즉시 알림 (in-app toast):
  · 분석 완료
  · 자동 수락 완료 (60초 Undo)
  · 모순 감지 (사이드바 배지)

주기 알림 (push 또는 in-app):
  · Pending 큐 누적
  · Auto-accepted 신규 모순 플래그

명시적으로 안 하는 것:
  ✗ Stale 알림 (제거됨)
  ✗ 그래프 변화 자동 push (in-app insight만)
  ✗ Surface 모드 호출 권장 push
```

---

## 11. 데이터 흐름 — Surface 단계 입출력

### 입력
```
ValidatedGraph {
  facts: [FactNode]
  objects: [ObjectNode]
  links: [LinkRecord]
  user_context: { active_app, recent_searches, ... }
}
```

### 출력 (mode별)

```
Active Recall:    HighlightAnnotations[]
Passive Recall:   StructuredResponse {
                    prefix: identity_phrase,
                    facts: [FactWithCitation],
                    pattern: affirmative | contradictive | empty
                  }
Contradiction:    ContradictionPair[]
Gatekeeping:      GatekeepWarning | null
Stellar View:     RenderedGraph
```

---

## 12. 측정 지표 — 베타에서 추적

| 지표 | 정의 | 베타 목표 |
|------|------|----------|
| Active Recall trigger rate | 점선 밑줄 등장 횟수 / 작성 시간 | 측정만 |
| Tooltip open rate | 풍선 호버 / 점선 밑줄 등장 | > 30% |
| Insert citation rate | Insert 클릭 / 풍선 호버 | > 10% |
| Ask Lucid usage | Mode 2 호출 / 사용자 / 주 | > 3회 |
| Contradiction resolution rate | 24h 내 해소 비율 | > 40% |
| Gatekeeping override rate | "Save anyway" 비율 | 측정만 (warning quality 지표) |

---

## 13. 베타에서 명시적으로 제외하는 것

- ❌ Mode 5 Staleness (영구 보존 모델로 대체)
- ❌ valid_until 기반 알림
- ❌ stale fact 시각 표시
- ❌ 일반 지식 응답 (Identity protocol)
- ❌ Multi-step reasoning (Phase 1+)
- ❌ 외부 그래프 비교 (Gatekeeping)
- ❌ 자동 fact 검색 push (Mode 1은 사용자가 보는 화면에서만)
- ❌ Surface mode 호출 권장 push

---

## 14. Development Phase Timeline

| Sprint | 작업 | 의존성 |
|--------|------|--------|
| Sprint 5 | Mode 0 (On/Off 토글) | Chrome 확장 |
| Sprint 5 | Mode 2 (Ask Lucid + Identity protocol) | 그래프 안정 |
| Sprint 6 | Mode 1 (Active Recall + 점선 밑줄) | Mode 2 |
| Sprint 6 | Mode 3 (Contradiction Queue) | Validate 완성 |
| Sprint 7 | Entity 색 코딩 (전 화면) | 그래프 ontology |
| Sprint 7 | Mode 4 (Gatekeeping Warning) | Mode 3 |
| Sprint 8 | Stellar View (SV-1, SV-2, SV-3) | 모든 mode |

---

## 15. 정책 결정 — 확정 사항

### Q1. Identity protocol — 사용자 무력화 옵션 없음 (확정)

Identity 표현 ("As far as I know...")은 베타에서 사용자가 끌 수 없음.
이건 제품 정체성이며 사용자 안심 장치다. Phase 1+에서 "Lucid voice"
설정 옵션 검토.

### Q2. 메타 응답 처리 (확정)

사용자가 "Are you sure?" 같은 메타 질문할 때:
- Lucid 응답: "I only know what's in your graph. The facts I cited
  carry the confidence of your validation."
- 한국어: "그래프에 있는 것만 압니다. 인용한 사실들은 기흥님이 검증한
  것의 무게를 가집니다."

### Q3. 빈 그래프 처리 (확정)

신규 사용자가 사실 0개일 때 Ask Lucid:
- "Your graph is empty. Save your first article and ask again."
- 한국어: "그래프가 비어 있습니다. 첫 자료를 저장한 뒤 다시 물어보세요."

---

## 16. 다음 단계

- [ ] Identity protocol 텍스트 finalize (EN/KR)
- [ ] Active Recall content script 디바운스 구현
- [ ] Ask Lucid prompt template 작성
- [ ] Contradiction 패턴 매칭 알고리즘 (A/B/C)
- [ ] Gatekeeping 조건 임계값 튜닝
- [ ] Stellar View D3 force simulation (Phase 1)

---

*Be lucid.*
