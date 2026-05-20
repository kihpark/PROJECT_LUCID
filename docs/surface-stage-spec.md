# Lucid — Surface Stage Specification

**Status:** Beta Scope Locked
**Stage:** S (Surface) of CSVS
**Author:** PO + 박기흥
**Date:** 2026-05

---

## 0. 본 문서의 범위

CSVS 루프 중 **Surface 단계**의 베타 설계.
검증된 FactNode가 사용자의 작업·질의·새 캡처 시점에 능동적으로
등장하는 단계.

이 단계가 Lucid의 정체성을 가장 강하게 드러낸다. 다른 세 단계는
사용자가 시스템을 호출하지만, Surface는 시스템이 사용자를 돕는다.

---

## 1. 핵심 원칙

```
1. 검증된 사실로만 답한다. AI 일반 지식 사용 금지.
2. 자기 무지를 정직하게 표명한다.
3. 사용자의 작업 흐름을 방해하지 않는다.
4. 응답 시작 표현으로 정체성을 매번 확인시킨다.
5. 사용자가 켜고 끌 수 있어야 한다.
```

---

## 2. Lucid 응답의 정체성 규약

Lucid의 모든 능동적 응답은 다음 표현으로 시작한다.

```
"As far as I know..."
"According to your knowledge graph..."
"기흥님 그래프 기준으로..."
"내가 아는 한..."

응답 끝에는 항상:
  · 검증 사실 인용 (fn-ID + 출처)
  · 검증된 사실이 없을 시 정직한 자백
  · 새 캡처 제안 (필요 시)
```

이 표현은 **단순 말투가 아니라 인식론적 약속**이다.

```
LLM:    인류 평균 지식으로 답하는 시스템
Lucid:  사용자 검증 사실로만 답하는 시스템

이 표현이 매 응답에 박혀 있어야 사용자가 Lucid의 정체성을
체득한다. 베타에서 이걸 어기는 응답이 나오면 안 된다.
```

---

## 3. Surface의 5개 작동 모드

```
Mode 0. Lucid On/Off       사용자가 Surface 전체 켜고 끄기
Mode 1. Active Recall      타이핑 중 관련 사실 자동 등장
Mode 2. Passive Recall     대화형 QnA로 그래프 조회 (Ask Lucid)
Mode 3. Contradiction      모순 감지 (비동기)
Mode 4. Gatekeeping        가짜 정보 입구 차단
Mode 5. Staleness          시간 만료 사실 재검토 알림
```

Mode 0이 다른 모든 모드를 제어하는 마스터 토글.

---

## 4. Mode 0 — Lucid On/Off 토글

### 진입점
```
브라우저 확장 아이콘    클릭 한 번으로 토글
모바일 앱               메인 화면 상단 스위치
데스크탑 앱             시스템 트레이/메뉴바
```

### OFF 상태에서의 동작
```
중단되는 것:
  · Active Recall (점선 밑줄·풍선 비활성)
  · 새 Contradiction 알림 토스트
  · Staleness 알림

계속 작동하는 것:
  · 수동 Capture (사용자가 우클릭으로 트리거)
  · Validate 큐 (배지 카운트 갱신)
  · Passive Recall (Ask Lucid는 켜져 있음 — 명시 호출이므로)
  · 백그라운드 모순 감지 (큐에만 적재, 알림 없음)
  · Staleness 백그라운드 스캔 (마크만, 알림 없음)
```

### ON 복귀 시
```
누적된 알림이 있으면:
  "Lucid was off. While away: 3 contradictions detected, 
   12 stale facts found. [Review]"
```

---

## 5. Mode 1 — Active Recall (작성 중 자동 등장)

### 트리거
```
입력 디바운스 300-500ms 후 자동 검색
또는 단축키 (Cmd/Ctrl + L)로 강제 호출
```

### 작동 환경
```
✅ Lucid 자체 에디터
✅ Chrome 확장이 감지하는 모든 텍스트 영역:
   · Gmail, Google Docs, Notion(웹)
   · Slack, Twitter/X, Discord 작성창
   · 일반 웹 폼의 textarea·contenteditable

❌ 데스크탑 네이티브 앱 (Word, Slack 데스크탑) — Phase 1
❌ 모바일 키보드 시스템 — Phase 2
```

### 표시 방식 — 인라인 풍선 + 키워드 밑줄

```
사용자 타이핑:
"한국의 AI 기본법은 2024년 12월 국회 본회의를 통과했고"
       ════════════════════════════════════════════════
       ↑ 점선 밑줄 (그래프에 관련 사실 존재)

호버 시 작은 풍선:
┌─────────────────────────────────────────┐
│ Related validated facts (3)              │
├─────────────────────────────────────────┤
│ · Korea AI Act passed Dec 2024  fn-220  │
│ · Promotion-weighted vs restriction      │
│   fn-221                                 │
│ · Investment up 31% in 2024     fn-222  │
│                                          │
│ [Insert citation] [See all]              │
└─────────────────────────────────────────┘
```

### 수량 정책
```
점선 밑줄:    매칭 발견 즉시 표시
풍선 내용:    상위 3개만 표시
"See all":   별도 패널·창에서 전체 네비게이션
1개만 매칭:   풍선만, "See all" 비활성
```

### 관련도 계산
```
1차: FAISS 벡터 유사도 (의미 기반)
2차: 그래프 거리 (Object 노드까지의 hop 수)
   → 의미적으로 가깝고 + 그래프 중심에 있는 사실 우선

베타에서 시간 가중치는 제외 (사실 양 적어 의미 없음).
```

---

## 6. Mode 2 — Passive Recall (Ask Lucid)

베타의 진짜 킬러 기능.

### 진입 방식
```
모바일:     "Hey Lucid" 음성 호출 또는 메인 화면 마이크 버튼
            (음성 인식은 Phase 1, 베타는 텍스트 입력)
데스크탑:   단축키 Cmd/Ctrl + Shift + L
            또는 Lucid 앱의 "Ask" 탭
확장:       어디서나 단축키 Cmd/Ctrl + L
```

### 응답 구조 — 정체성 규약 준수

**예시 1 — 정상 응답 (사실 있음)**
```
사용자: "다이어트에 대해 내가 검증한 사실은?"

Lucid:
"As far as I know, 다이어트 주제로 8개 검증 사실이 있습니다.

· 단백질 1kg당 1.6g이 근성장에 최적 (fn-401, HIGH)
· 공복 유산소는 지방 연소에 유의미한 차이 없음 (fn-403, HIGH)
· 식후 운동이 근손실 위험 낮음 (fn-404, MEDIUM)
· 식이섬유 일 25g 이상 권장 (fn-405, HIGH)
...

⚠ 충돌 1건: 단백질 골든타임에 대해 두 출처 결과 다름.

[See full list] [Ask follow-up]"
```

**예시 2 — 새 주장에 대한 검증**
```
사용자: "공복 유산소가 살 빠지는 데 최고지?"

Lucid:
"As far as I know — 기흥님 그래프에는 이 주제에 대해
2개 검증 사실이 있습니다:

· fn-403: 공복 유산소는 지방 연소에 유의미한 차이 없음
  (Stronger by Science 2024, HIGH)
· fn-404: 식후 운동이 근손실 위험 낮음
  (Layne Norton 2024, MEDIUM)

검증해두신 사실은 일반 통념과 다릅니다.
지금 들은 정보를 새로 캡처하시겠습니까?

[Capture this claim] [Dismiss]"
```

**예시 3 — 그래프에 답이 없을 때**
```
사용자: "비트코인 ETF 승인 영향은?"

Lucid:
"As far as I know — 비트코인 또는 ETF 관련 검증 사실이
그래프에 없습니다.

이 주제에 대한 답변은 드릴 수 없습니다.
관련 자료를 캡처하면 그때부터 답변 가능합니다.

[Search the web] [Mark topic for later]"
```

LLM에게 답을 위임하지 않는다. 정직하게 "모른다"고 한다.

### 응답 시작 표현 — 강제 규약
```
정상 응답:        "As far as I know..."
                  "According to your knowledge graph..."
                  "기흥님 그래프 기준으로..."

검증 사실 없음:   "I don't have validated facts on this..."
                  "기흥님 그래프엔 이 주제 검증 사실이 없습니다..."

부분 답변:        "Based on the X facts I have on this..."
                  "내가 가진 N개 사실 기준으로는..."

이 표현이 모든 응답에 박혀야 한다.
이걸 어기면 Lucid가 ChatGPT처럼 행동하기 시작한다.
```

### 응답 길이 정책
```
음성 호출 (모바일): 짧고 명료 — 2-3문장 + 사실 3개 이내
텍스트 호출:        구조화 — 사실 8개까지 + 메타정보
"See full list":   전체 보기 (별도 화면)
```

### 인용 정책 — 모든 사실 인용 강제
```
응답 안의 모든 주장은 fn-ID 명시 필수.
인용 없는 주장은 Lucid의 응답이 아니다.

잘못된 예: "다이어트는 칼로리가 중요하다."
올바른 예: "칼로리 적자가 체중 감량의 핵심이다 (fn-407, HIGH)"
```

---

## 7. Mode 3 — Contradiction Detection

### 트리거
```
1. Validate 직후 (즉시)
   사용자가 새 사실을 Accept하는 순간 같은 Subject·Property에
   대해 기존 그래프 검사

2. 백그라운드 (매일 1회)
   전체 그래프 스캔. 새로 발생한 모순 + 기존 모순 갱신
```

### 충돌 판단 기준 — 3 패턴
```
패턴 A. 명백한 모순 (CONTRADICTS 자동 생성)
  · 같은 Subject + 같은 Property + 다른 값
  · 시점·관할권 조건 동일

패턴 B. 의심 모순 (사용자 확인 요청)
  · 같은 Subject + 의미적으로 반대인 Predicate
  · 예: "X는 안전하다" vs "X는 위험하다"

패턴 C. 맥락 차이 (모순 아님, 같이 표시만)
  · 시점이 다름 (2020 vs 2024)
  · 관할권이 다름 (KR vs EU)
  · 측정 단위·기준이 다름
```

### 알림 정책
```
즉시 알림 (방해 효과 강함):     ❌ 베타 제외
큐 누적 + 배지:                  ✅ 메인 화면에서 확인
Stellar View 시각 표시:           ✅ 붉은 긴장선 자동

알림 강도:
  · 토스트 알림 없음 (방해 안 함)
  · 메인 화면에서 "⚠ 3 contradictions" 배지
  · Stellar View에서 충돌 별 사이 붉은 선
```

### 사용자 해소 옵션 (4 가지)
```
1. Drop one fact     한 쪽 사실 그래프에서 제거
2. Demote one fact   한 쪽을 PendingFact로 되돌리기
3. Keep both         두 사실 모두 유지 + 맥락 메모 추가
                     (관할권·시점·기준 차이 명시)
4. Ignore            모순 무시 (의도적 보존)
```

---

## 8. Mode 4 — Gatekeeping (가짜 정보 차단)

캡처 시점에 작동. 기존 그래프와 강하게 충돌하는 정보 차단.

### 차단 트리거 — 3 조건 모두 충족
```
조건 1: 동일 Subject + Property에 강한 모순 사실 N개 존재
조건 2: 새 사실보다 강력한 출처 권위
조건 3: 새 사실보다 최근의 검증
```

### 예시 1 — 광우병 주장 차단
```
캡처 시도 (2026):
새 주장: "미국산 쇠고기는 한국인을 광우병에 걸리게 한다"
출처: 익명 블로그 게시물 (2024)

3 조건 검사:
  조건 1: 반대 사실 3개
    · "수입 재개 후 국내 vCJD 확진 0명" (질병청, 2024)
    · "역학 조사에서 인과 발견 안 됨" (보건연구원)
    · "WHO: 가공식품 vCJD 전파 사례 없음"
    → ✓
  조건 2: 익명 블로그 < 질병청·WHO
    → ✓
  조건 3: 2024 블로그 vs 2024 질병청
    → ✓ (질병청 검증이 더 권위 있음)

→ 경고 발동

화면:
⚠ 이 주장은 기흥님이 검증해둔 사실들과 충돌합니다.

반대 근거:
· 수입 재개 후 국내 vCJD 확진 0명 (fn-501, 질병청 2024)
· WHO: 가공식품 vCJD 전파 사례 없음 (fn-502)
· 역학 조사 인과 발견 안 됨 (fn-503)

그래도 저장하시겠습니까?
[그래도 저장] [취소]
```

### 예시 2 — 정상 사실 진화 (경고 안 함)
```
캡처 시도:
새 주장: "ChatGPT 월간 사용자 5억 명 (OpenAI 공식, 2026)"

3 조건 검사:
  조건 1: 충돌 1개 — "2억 명 (2024)"
    → ✓
  조건 2: 새 출처(OpenAI) ≥ 기존(OpenAI)
    → ✗ 출처 권위 동등
  조건 3: 2026 > 2024
    → ✓ 새 검증이 더 최근

→ 조건 2 미충족, 경고 안 함

이유: 수치 변화는 정상 사실 진화.
두 사실 모두 저장. CONTRADICTS 관계 자동 형성.
사용자가 시점별 값 비교 가능.
```

### 예시 3 — 학술 논쟁 (출처에 따라 다름)
```
캡처 시도:
새 주장: "전기차는 환경에 더 해롭다"

기존 사실:
· "전기차 평생 탄소 50%" (IEA, 2024)
· "배터리 탄소 5년 내 회수" (MIT, 2023)

조건 1: 충돌 ✓

Case A — 새 출처가 정부 보고서:
  조건 2: 출처 동등 → ✗
  → 경고 안 함 (정상 학술 논쟁)
  → 양쪽 모두 그래프에 저장, CONTRADICTS

Case B — 새 출처가 블로그:
  조건 2: 약함 → ✓
  조건 3: 검증 권위 약함 → ✓
  → 경고 발동
```

### 차단 강도
```
✅ 경고 + 사용자 선택 ("그래도 저장")
❌ 강제 차단 (사용자 자율성 침해)

"그래도 저장"한 사실:
  · 메타데이터에 override_warning: true 박힘
  · Stellar View에서 노란 테두리 표시
  · 사후 검토 가능
```

---

## 9. Mode 5 — Staleness Notification

### Stale의 정의
```
is_stale: true 가 되는 조건:
  1. valid_until 필드가 존재함
  2. 현재 시점이 valid_until 이후
  3. 사용자가 아직 재검토하지 않음

예시:
  fn-301: "기준금리 3.5% (2024년 12월 기준)"
    valid_until: 2025-03-01 (다음 금통위 예상)
    → 2025-03-02부터 is_stale = true
    
  fn-302: "한국 AI 기본법 시행 (2026년 1월)"
    valid_until: null (구조적 사실, 만료 없음)
    → 영원히 stale 아님
```

### 감지 방식
```
1. 백그라운드 일일 잡 (매일 자정)
   전체 그래프 스캔 → valid_until 도래 사실 마크
   
2. 동적 트리거 (Surface 시점)
   사용자가 stale 사실을 Active/Passive Recall로 호출 시
   즉시 알림
```

### 알림 시점
```
valid_until 도래 30일 전:    "Coming up for review" 부드러운 알림
valid_until 도래:              is_stale = true 마크 + 정식 알림
valid_until 도래 후 90일:     "Re-validation strongly recommended"
                              강한 알림 (배지 빨강)
```

### Stale 사실의 동작
```
Surface에서 숨기지 않음. 라벨과 함께 노출:

  "기준금리 3.5% (2024년 12월 기준)
   ⏰ 이 사실은 2025-03-01 이후 stale 상태입니다.
   [재검증] [Drop] [Keep as historical]"

사용자 선택:
  · 재검증: PendingFact 큐로 다시 보내 새 출처 확인
  · Drop: 그래프에서 제거 (archived)
  · Keep as historical: stale 표시 유지하되 보존
                        역사적 사실로 활용 가능
```

Stellar View에서 stale 별은 채도가 낮아지고 천천히 깜박임.

---

## 10. 검증된 사실 vs 새 주장 — Lucid의 반응 패턴

Lucid의 핵심 행동 양식이다.

```
사용자가 새 주장을 던지면 Lucid는 항상:

1. 그래프에서 관련 사실 검색
2. 검색 결과를 인용하며 응답
3. 새 주장이 그래프 사실과
   · 일치 → "이미 검증된 내용입니다. fn-XXX"
   · 보강 → "기존 사실과 정합적입니다. 새 출처로 저장하시겠습니까?"
   · 모순 → "검증된 사실과 충돌합니다. 검토 후 저장하시겠습니까?"
   · 무관계 → "관련 검증 사실이 없습니다. 새로 캡처하시겠습니까?"
4. 응답에 항상 한계 명시 ("As far as I know..." 시작)
5. 새 캡처 옵션 제공
```

이게 Lucid가 ChatGPT와 결정적으로 다른 지점이다.
ChatGPT는 어떤 주장이든 그럴듯하게 동의·반박한다.
Lucid는 자기 그래프 안에서만 응답한다.

---

## 11. 데이터 흐름 — Surface 단계 입출력

```
[입력]
  · 사용자 작성 텍스트 (Active Recall)
  · 사용자 질의 (Passive Recall)
  · 새 캡처 PendingFact (Gatekeeping)
  · 그래프 변화 이벤트 (Contradiction, Staleness)

       ↓ 검색 엔진

[처리]
  · FAISS 벡터 유사도
  · Neo4j 그래프 거리
  · 사실 메타데이터 (validation_level, source authority, time)

       ↓ 응답 구성

[출력]
  · 인라인 점선 밑줄 + 호버 풍선 (Active Recall)
  · 구조화된 텍스트 응답 (Passive Recall)
  · 경고 다이얼로그 (Gatekeeping)
  · 모순 큐 항목 + Stellar View 시각 표시 (Contradiction)
  · Stale 라벨 + 재검토 알림 (Staleness)

[정체성 규약]
  모든 응답은 "As far as I know..." 등의 시작 표현 필수.
  모든 주장은 fn-ID 인용 필수.
  답할 사실 없으면 정직하게 자백.
```

---

## 12. 베타에서 명시적으로 제외하는 것

```
❌ 음성 호출 ("Hey Lucid")
   Phase 1 — 베타는 텍스트만

❌ 모바일 키보드 통합
   Phase 2 — 베타는 앱 내·웹에서만

❌ 데스크탑 네이티브 앱 통합
   Phase 1 — 베타는 웹·브라우저에서만

❌ 외부 신뢰 그래프 참조 (Gatekeeping)
   Phase 1 — 베타는 자체 그래프만

❌ AI 사전 팩트체크 (Gatekeeping)
   Phase 2 — 베타는 그래프 비교만

❌ 즉시 토스트 모순 알림
   사용자 흐름 보호. 큐 + 시각 표시로 대체.

❌ 시간 가중치 관련도 계산
   Phase 1 — 베타는 양 적어 의미 없음

❌ Bulk 인용 삽입 (Active Recall)
   Phase 1 — 베타는 한 번에 1개 인용
```

---

## 13. Development Phase Timeline

```
  Beta (M0)              Phase 1 (M6)             Phase 2 (M12+)
  ────●─────────────────────●────────────────────────●──────────►

  Surface scope:          Add:                      Add:
  · On/Off toggle         · Voice "Hey Lucid"       · Mobile keyboard
  · Active Recall          · Desktop native apps     · OS-level surface
    (web + extension)     · External trust graph    · AI pre-factcheck
  · Passive Recall          (Gatekeeping)             (Gatekeeping)
    (Ask Lucid, text)     · Time-weighted recall    · Bulk citation
  · Contradiction         · Bulk citation insert    · Real-time
    (queue + visual)      · Personalized alert        contradiction
  · Gatekeeping             thresholds                propagation
    (self-graph)
  · Staleness
    (daily scan +
    dynamic trigger)
```

---

## 14. 정책 결정 — 확정 사항

### Q1. 인라인 풍선 vs 측면 패널 (확정)
인라인 풍선 + 키워드 점선 밑줄. 측면 패널은 베타 제외.
정보가 텍스트에 녹아들어야 한다.

### Q2. Active Recall 작동 범위 (확정)
Lucid 자체 앱 + Chrome 확장이 감지하는 모든 웹 텍스트 영역.
데스크탑 네이티브·모바일 키보드는 Phase 1+.

### Q3. 관련도 계산 (확정)
벡터 유사도 + 그래프 거리. 시간 가중치 베타 제외.

### Q4. 모순 알림 강도 (확정)
큐 누적 + Stellar View 시각 표시. 즉시 토스트 안 함.
사용자 작업 흐름 보호.

### Q5. Gatekeeping 강도 (확정)
경고 + 사용자 선택. 강제 차단 안 함.
"그래도 저장"한 사실은 메타데이터에 표시.

### Q6. Lucid 정체성 표현 (확정 — 핵심)
모든 응답 시작에 "As far as I know..." 또는 동등 표현.
검증 사실 없을 시 정직한 자백.
모든 주장에 fn-ID 인용 강제.

---

## 15. 미해결 — 베타 후 결정

```
Q1. Active Recall에서 키워드 매칭 강도 임계값
    너무 민감 → 노이즈, 너무 둔감 → 발견 안 됨

Q2. Passive Recall 응답에서 사실 정렬 기준
    관련도? 신뢰도? 최신? 사용자 설정?

Q3. Gatekeeping에서 N의 값 (반대 사실 몇 개부터 강한 모순?)
    베타: 2개 이상 + 출처 권위 차이
    데이터 모이면 조정

Q4. 음성 응답 시 표현 길이 정책
    Phase 1 음성 도입 시 결정
```

---

## 16. 다음 단계

Surface 단계 베타 범위 확정. **CSVS 4단계 모두 명세 완료.**

```
다음 작업 후보:
  · 4개 명세를 Claude Agents에 전달해 통합
  · 베타 백로그 우선순위 작성
  · 베타 사용자 모집·테스트 계획
  · UI 와이어프레임 또는 프로토타입
  · API 명세 작성
```

---

*Lucid Surface Spec v1.0 | Beta Scope Locked | Be lucid.*
