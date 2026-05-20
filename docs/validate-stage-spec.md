# Lucid — Validate Stage Specification

**Status:** Beta Scope Locked
**Stage:** V (Validate) of CSVS
**Author:** PO + 박기흥
**Date:** 2026-05

---

## 0. 본 문서의 범위

CSVS 루프 중 **Validate 단계**의 베타 설계.
Structure가 생성한 PendingFact를 사용자가 사실 단위로 판정하여
검증된 FactNode로 승격시키는 단계.

이 단계가 Lucid의 정체성이 가장 직접적으로 드러나는 화면이다.

---

## 1. 핵심 원칙

```
1. 검증은 사용자가 한다. AI는 제안만 한다.
2. 검증 행위 자체가 가치다. 가볍게 만들되 무의미하게 만들지 않는다.
3. 사용자 선택의 자유 — careful / trusted 모드는 Capture 시 결정.
4. Confidence는 Structure에서 부여하지 않는다.
   Validate 단계에서 외생적 메타정보로 대체 표시.
5. 검증 결과는 그래프에 즉시 반영되어 시각적 피드백 제공.
```

---

## 2. 검증 흐름 진입점

사용자는 Capture 시점에 검증 시점을 선택했다.

```
careful 모드:
  · 즉시 검증 (오버레이)        하이라이트·짧은 텍스트
  · 큐에 적재 (나중에)          영상·논문·긴 콘텐츠

trusted 모드:
  · 즉시 FactNode 진입
  · Validate UI 보지 않음 (Auto-accepted 탭에서 사후 검토 가능)
```

본 문서는 careful 모드의 검증 UI를 정의한다.

---

## 3. 즉시 검증 — 오버레이 화면

캡처 직후 그 자리에서 검증할 때.

### 트리거
하이라이트(선택 텍스트), 짧은 페이지, 사용자가 "지금 검증" 선택.

### 화면 흐름

```
[1] 오버레이가 페이지 우측 하단에 슬라이드 인 (300ms)
       ↓
[2] 추출된 사실들이 카드 형태로 세로 나열
    같은 출처에서 나온 N개 사실이 한 그룹으로 묶임
       ↓
[3] 각 카드별로 사용자가 Accept / Edit / Reject 결정
       ↓
[4] 모든 사실 처리되면 오버레이 자동 닫힘
    토스트 표시: "N facts validated"
```

### 카드 디자인 (압축 상태 기본)

```
┌───────────────────────────────────────────────────────────┐
│ 📄 [Wall Street Journal · 2024-08-15]                     │
├───────────────────────────────────────────────────────────┤
│                                                            │
│ "EU AI Act took 36 months to pass into law."              │
│                                                            │
│ Subject: EU AI Act                                         │
│ Type: proposition                                          │
│                                                            │
│ [▼ Show more]                                              │
│                                                            │
│ ┌─────────┐ ┌────────┐ ┌────────┐                         │
│ │ Accept  │ │  Edit  │ │ Reject │                         │
│ └─────────┘ └────────┘ └────────┘                         │
└───────────────────────────────────────────────────────────┘
```

### 카드 확장 상태 (Show more 클릭 시)

```
┌───────────────────────────────────────────────────────────┐
│ 📄 [Wall Street Journal · 2024-08-15]                     │
├───────────────────────────────────────────────────────────┤
│                                                            │
│ "EU AI Act took 36 months to pass into law."              │
│                                                            │
│ Subject: EU AI Act                                         │
│ Type: proposition                                          │
│                                                            │
│ ── Source detail ──────────────────────────────            │
│ URL: wsj.com/articles/...                                  │
│ Author: Sam Schechner                                      │
│ Publisher class: peer_reviewed_press                       │
│ Captured: 2026-05-19 14:32                                 │
│                                                            │
│ ── Related ──────────────────────────────────              │
│ ⚠ Possible related fact in your graph:                    │
│   "EU AI Act took effect August 2024" (fn-201)            │
│                                                            │
│ ── Time validity ───────────────────────────────           │
│ valid_from: 2024-08-01                                     │
│ valid_until: (none — structural fact)                      │
│                                                            │
│ Personal note (optional):                                  │
│ ┌──────────────────────────────────────────────────┐     │
│ │                                                    │     │
│ └──────────────────────────────────────────────────┘     │
│                                                            │
│ ┌─────────┐ ┌────────┐ ┌────────┐                         │
│ │ Accept  │ │  Edit  │ │ Reject │                         │
│ └─────────┘ └────────┘ └────────┘                         │
└───────────────────────────────────────────────────────────┘
```

---

## 4. 큐 검증 — 별도 화면

긴 영상·논문에서 추출된 다수의 사실을 나중에 일괄 처리할 때.

### 진입
Lucid 메인 화면 → "Review queue" 탭

### 그룹화 정책

**같은 캡처에서 나온 사실을 한 그룹으로 묶는다.**
한 영상·논문에서 추출된 N개 사실은 맥락을 공유하므로
같이 봐야 판단하기 쉽다.

### 화면 흐름

```
┌────────────────────────────────────────────────────────┐
│  Review queue                            12 captures   │
├────────────────────────────────────────────────────────┤
│                                                         │
│  📹 Kahneman lecture on Prospect Theory                 │
│      8 facts pending · captured 3 days ago             │
│      [Open group →]                                     │
│                                                         │
│  📄 EU AI Act analysis (WSJ)                           │
│      3 facts pending · captured 1 week ago             │
│      [Open group →]                                     │
│                                                         │
│  📹 Korean Budget Committee hearing                    │
│      14 facts pending · captured 2 weeks ago           │
│      [Open group →]                                     │
│                                                         │
│  ...                                                    │
│                                                         │
└────────────────────────────────────────────────────────┘
```

### 그룹 열기 후 화면

```
┌────────────────────────────────────────────────────────┐
│  ← Back to queue                                       │
│                                                         │
│  📹 Kahneman lecture on Prospect Theory                │
│  YouTube · 28 min · captured 2026-05-16                │
│                                                         │
│  Progress: 0 / 8                                        │
│                                                         │
├────────────────────────────────────────────────────────┤
│                                                         │
│  [Card 1/8]                                            │
│  "Loss aversion coefficient averages 2.25"             │
│  Subject: Loss aversion · Type: proposition            │
│                                                         │
│  [Accept] [Edit] [Reject]                              │
│                                                         │
├────────────────────────────────────────────────────────┤
│                                                         │
│  [Card 2/8]                                            │
│  "Prospect theory published 1979 by Kahneman&Tversky"  │
│  ...                                                    │
│                                                         │
└────────────────────────────────────────────────────────┘
```

세로 스크롤로 그룹 내 모든 카드 표시.
일괄 수락 옵션은 베타에서 제외 (Phase 1).

---

## 5. 사용자 행동 옵션 — Accept / Edit / Reject

베타에서 3가지로 제한.

### Accept
```
사용자 의도: "이 사실은 맞다. 그래프에 들어가도 된다."

시스템 동작:
  1. PendingFact → FactNode 승격
  2. L1 validation mark 부여 (validator_id, timestamp)
  3. 관련 Object 노드들 그래프에 진입
  4. Fact ↔ Object, Fact ↔ Fact 관계 형성
  5. 그래프 시각 피드백 발동 (별이 떠오르는 애니메이션)
  6. 인사이트 표시 조건 충족 시 토스트 알림
```

### Edit
```
사용자 의도: "내용은 맞는데 표현이 정확하지 않다. 수정해서 수락."

시스템 동작:
  1. 카드가 편집 모드로 전환
  2. claim 필드 수정 가능
  3. subject/predicate/object 수정 가능
  4. 사용자 저장 시 Accept와 동일한 흐름
  5. edit 이력 보존 (원본 vs 편집본)
```

### Reject
```
사용자 의도: "이 사실은 그래프에 들어가면 안 된다."

시스템 동작:
  1. PendingFact 삭제
  2. reject 이력 보존 (몇 개 reject했는지 통계용)
  3. 관련 Object 노드는 그래프에 진입 안 함
     (단, 다른 Fact가 같은 Object를 참조하면 유지)
```

---

## 6. 검증 시점에 보여줄 메타 정보

Confidence를 부여하지 않는 대신, 외생적으로 측정 가능한 정보 표시.

### 기본 (압축 상태)

```
원문 발췌
Subject + Type (proposition / procedure)
```

### 확장 (Show more 클릭 시)

```
출처 권위
  Publisher class:
    primary              정부·기관 1차 자료
    peer_reviewed        학술지·동료심사 매체
    reputable_press      신뢰 받는 언론
    secondary            일반 매체
    user_generated       블로그·SNS

캡처 메타데이터
  URL, 작성자, 게시일, 캡처 시점

같은 주제 기존 사실 (있을 때만)
  같은 Subject에 연결된 기존 FactNode 표시
  → 사용자가 모순 여부 즉석 확인 가능

시간 메타데이터
  valid_from / valid_until
  AI가 텍스트에서 추출했거나 추정한 값

Personal note 입력란
  옵션. 사용자가 "왜 수락하는지" 메모 가능.
  암묵지의 명시화 도구.
```

---

## 7. 자동 수락(Trusted) 사실의 별도 탭

Trusted 모드로 들어온 사실은 메인 큐에 안 보이고 별도 탭에 표시.

### 진입
Lucid 메인 → "Auto-accepted" 탭

### 화면

```
┌────────────────────────────────────────────────────────┐
│  Auto-accepted facts                       247 total   │
│  Sources: WSJ, Nature, gov.kr, 3 expert graphs         │
├────────────────────────────────────────────────────────┤
│                                                         │
│  Recent additions:                                      │
│                                                         │
│  📄 [WSJ · 2026-05-18]                                 │
│      "EU AI Act enforcement begins August 2024"        │
│      auto_accepted · trust_basis: source               │
│      [Demote to pending] [Drop]                        │
│                                                         │
│  📊 [Nature · 2026-05-17]                              │
│      "Loss aversion coefficient varies by..."           │
│      auto_accepted · trust_basis: source               │
│      [Demote to pending] [Drop]                        │
│                                                         │
│  ...                                                    │
│                                                         │
└────────────────────────────────────────────────────────┘
```

### 자동 메인 큐로 복귀 조건

```
1. 모순 감지
   기존 FactNode 또는 새로 캡처된 사실과 충돌 시
   → 자동으로 메인 큐로 끌어올림
   → "Contradiction detected — please review" 표시

2. 출처 신뢰 해제
   사용자가 출처의 trusted 등록을 해제하면
   해당 출처에서 자동 수락된 사실들 메인 큐로 이동

3. 시간 만료
   valid_until 도래 시
   → "Time-expired — please review" 표시
```

---

## 8. 검증 후 시각적 피드백

### Animation — 별이 그래프에 떠오르는 효과

Accept 또는 Edit 직후:

```
1. 카드가 부드럽게 사라지는 애니메이션 (200ms)
2. 화면 한쪽에 미니 그래프 thumbnail 표시
3. 새 별이 thumbnail 위에 페이드 인 (400ms)
4. 별의 색상 = Object class에 해당하는 색
5. 별의 밝기 = L1 (희미한 빛)
6. 기존 별과 연결된 경우 light beam이 잠시 연결선 표시
```

이게 사용자에게 "방금 내가 그래프를 키웠다"는 즉각 피드백을 준다.
Stellar View와 자연스럽게 연결된다.

### Insight Notification

특정 조건이 충족될 때만 토스트로 표시.

```
조건 1: 그래프 변곡점
  "This fact connects 3 existing facts in your graph"

조건 2: 새 클러스터 형성
  "New constellation forming: AI Governance"

조건 3: 시간 마일스톤
  (Phase 1+에서 추가, 베타는 위 두 가지만)
```

빈도 제한: 한 검증 세션당 최대 2회. 과다 알림 방지.

---

## 9. 큐 알림 정책

PendingFact 적체 방지.

```
50개 미만        정상 상태. 알림 없음.
50개 ~ 99개      약한 알림. "Review queue is filling up (N pending)"
100개 이상      강한 알림. 메인 화면 상단 배너.
                "Queue at N items. Spend 10 minutes to clear."
200개 이상      캡처 시 경고. "Your queue has 200+ pending facts.
                Consider reviewing before capturing more."
```

베타 데이터로 임계값 조정 예정.

---

## 10. 세션 중단·재개

긴 큐는 한 번에 처리 어려움. 자동 저장.

```
세션 중단 시:
  · 검증 진행 상황 자동 저장 (그룹 ID + 마지막 카드 인덱스)
  · 명시적 "Save and exit" 버튼도 제공

재개 시:
  · "Resume? You were 12/50 through 'Kahneman lecture'."
  · [Continue] [Skip this group] [Start fresh]
```

---

## 11. 베타에서 명시적으로 제외하는 것

```
❌ Skip 옵션 (Phase 1)
   사용자가 결정 미루기 → 큐 적체 위험. 베타에서는 강제 결정.

❌ Bulk accept (Phase 1)
   "이 그룹 전체 수락" 옵션. 신중 모드 본질 훼손 우려.

❌ Accept with note (Phase 1)
   Personal note는 Edit 안에서 추가 가능. 별도 옵션 불필요.

❌ Defer to expert (Phase 2+)
   특정 전문가에게 검토 의뢰. 네트워크 효과 단계에 필요.

❌ Streak / Badges / Score (Gamification)
   Phase 1 이후 검토. 베타는 본질에 집중.

❌ 검증 후 즉시 Surface 트리거
   막 검증한 사실이 바로 추천에 등장하는 기능.
   베타에서는 검증과 Surface 분리.
```

---

## 12. 데이터 모델 — Validate 단계 입출력

```
[입력] — PendingFact 큐에 있는 항목
  pending_fact: {
    uid, claim, subject, predicate, object,
    type: "proposition" | "procedure",
    source_uid, captured_at, captured_by,
    suggested_objects: [...],
    suggested_links: [...]
  }

       ↓ Accept

[출력] — FactNode 그래프 진입
  fact_node: {
    uid, claim, ...
    l1_validated: true,
    l1_validated_at: ISO8601,
    l1_validator_id: UUID,
    personal_note: "...",  // optional
    edit_history: [],      // if edited
    source_count: 1
  }
  + objects: [...]
  + links: [...]

       ↓ Edit
       
  동일하지만 edit_history에 원본 보존

       ↓ Reject

[출력] — PendingFact 삭제
  reject_log: {
    pending_fact_uid, rejected_at, rejected_by
  }
```

---

## 13. Development Phase Timeline

```
  Beta (M0)              Phase 1 (M6)             Phase 2 (M12+)
  ────●─────────────────────●────────────────────────●──────────►

  Validate scope:         Add:                      Add:
  · 3 actions             · Bulk accept             · Defer to expert
    (Accept/Edit/Reject)  · Skip option             · Voice validation
  · Group by source       · Streak/badges           · Multi-validator
  · Two-tab structure       (gamification)            quorum (Team)
    (Main + Auto-accept)  · Personal note as        · Expert L4
  · Visual feedback         separate field            certification flow
    (star animation +     · Adaptive queue
    insight toast)          thresholds
```

---

## 14. 정책 결정 — 확정 사항

### Q1. Edit 이력 정책 (확정)

**Edit이 필요한 세 가지 경우:**
```
1. Structure 단계 분해 오류 보정
   AI 분해가 부정확할 때 사용자가 정확하게 수정.

2. 사용자 표현 정제
   의미는 같지만 본인 그래프 기준에 맞게 정리.

3. 맥락 보강
   추출된 사실에 빠진 단서를 사용자가 추가.
```

**이력 보존 — Alias 방식:**
```
FactNode 저장:
  claim:    현재 (최신) 표현
  aliases:  과거 표현들 (text + edited_at 페어 리스트)

용도:
  · 검색 강건성 (alias도 검색 후보)
  · 사용자가 과거 표현 확인 가능
  · 데이터 부담 최소 (사용자가 반복 수정하지 않는 이상)
```

### Q2. 같은 사실 검증 여부 — 사용자 설정 (확정)

**Settings > Validation Preferences > Duplicate Facts**
```
○ Quick mode (기본값)
  이미 존재하는 사실은 자동으로 출처만 증가
  검증 절차 생략

○ Strict mode
  같은 사실이라도 매번 검증 단계 거침
  출처 증가 + 검증 이력 누적

○ Hybrid mode
  동일 출처 → quick / 새 출처 → strict
```

사용자가 자기 검증 정책을 직접 선택.

### Q3. Auto-accepted 사실의 사후 처리 (확정)

```
✅ Edit 가능   — 표현 정제, 메모 추가
✅ Demote 가능 — 다시 PendingFact 큐로
✅ Drop 가능   — 그래프에서 제거
```

이 셋이 Auto-accepted 탭의 사후 큐레이션 도구.

### Q4. 출처 자동 평가 — 베타 제외 (확정)

```
베타에서 출처 자동 평가 안 함.

이유:
  · 신뢰 모드는 사용자가 명시 등록한 출처에만 적용
  · 사용자가 직접 trusted 등록·해제 가능
  · 자동 평가는 사용자 자율성 침해 가능

Reject 통계는 단순 기록용으로만 보존.
사용자가 조회 가능. 시스템 자동 조정 없음.
```

---

## 15. 다음 단계

Validate 단계 베타 범위 확정. 다음:

```
Surface 단계 명세서 작성
  - 작성·검색 시 어떻게 떠올라오는가
  - C1 모순 감지 트리거 (Validate 후 비동기)
  - C3 컨텍스트 서페이싱
  - 가짜 정보 입구 차단 (Capture와 연결)
  - 시간 기반 stale 알림
```

---

*Lucid Validate Spec v1.0 | Beta Scope Locked | Be lucid.*
