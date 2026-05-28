# Lucid — Structure Stage Specification

**Status:** Beta Scope Locked
**Stage:** S (Structure) of CSVS
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
> - The staleness system (`valid_until`, `is_stale`, Mode 5
>   Staleness) is RETIRED (DR-053 / C-14). `valid_from` is kept as
>   context-only metadata; it never triggers expiry or re-validation.
> - `confidence` is NOT assigned at the Structure stage (DR-028 /
>   Critical Rule 13). When it surfaces at Validate/Surface, it is
>   derived at read time from publisher_class + validation_method +
>   freshness + consensus.
>
> The body below is preserved for historical context; pointers to the
> v2-correct shape are inline where the conflict is sharp.

---

> ## v2.1 supersession notice (2026-05-28, DCR-001)
>
> DCR-001 (Negation, Disambiguation, Internal Metrics) added the
> following to this spec on top of the v2 banner above:
>
> - **Negation fields on AtomicFact / FactNode**: `negation_flag`
>   (bool, default False) and `negation_scope` ('full' | 'partial' |
>   None). See §3.
> - **NEGATES** link type added to Fact↔Fact (6 → 7 link types).
>   See §5. NEGATES is distinct from CONTRADICTS:
>   - **NEGATES** is intrinsic to a fact (this fact says "X is NOT Y"),
>     marked on a single fact via `negation_flag=True`.
>   - **CONTRADICTS** is a relationship between two facts whose
>     claims cannot both be true.
> - **7-step decomposition algorithm** (§6) — added "negation
>   detection" between Object identification and AtomicFact emission.
> - **Object matching thresholds tightened (DCR-001 / DR-065 reframes
>   DR-032)**: auto-merge stays at >=0.95 for most classes; Person /
>   Organization / Service require >=0.98. The 0.85-0.95 semi-auto
>   band is **retired** — those go to user disambiguation in Validate.
>   See §13 Q2.

---


## 0. 본 문서의 범위

CSVS 루프 중 **Structure 단계**의 베타 설계.
Capture가 만들어낸 merged_text를 받아 검증 가능한 AtomicFact로
분해하고, 그래프에 들어갈 Object들과 관계를 동시에 추출한다.

---

## 1. 핵심 원칙

```
1. 콘텐츠가 제공하는 사실 만큼 추출한다 (상한 없음)
2. 사용자가 캡처 시 검증 모드 선택 (신중 / 신뢰)
3. Confidence는 Structure 단계에서 부여하지 않는다
4. 분해 실패 시 정직하게 빈 결과 반환
5. AtomicFact + Object + Link를 한 번에 추출
```

---

## 2. 검증 모드 — 사용자 선택

캡처 시 사용자가 두 모드 중 선택.

```
[신중 모드] (기본값)
  추출된 모든 사실 → PendingFact 큐
  사용자가 하나씩 검증
  
[신뢰 모드]
  추출된 모든 사실 → 즉시 FactNode
  검증 절차 생략
  auto_accepted: true 메타데이터 박힘
  trust_basis: "source" 또는 "expert"
  
  사용 조건:
    - 명시적으로 신뢰 등록된 출처
      (예: WSJ, Nature, gov.kr, 본인 팔로우 전문가)
    - 사용자가 출처별로 사전 설정
```

신뢰 모드 사실도 다음 경우엔 자동으로 재검토 큐로:
- 기존 사실과 모순이 감지되었을 때
- 출처의 신뢰 등록이 해제되었을 때
- ~~시간 만료(valid_until) 도래했을 때~~ **RETRACTED (DR-053 / C-14)**: 만료 트리거 없음.

---

## 3. AtomicFact의 두 가지 표현 패턴

### 패턴 A — 명제형 (수치, 속성, 상태)

```
원문: "ChatGPT의 2024년 평균 월사용자는 2.2M이었다"

AtomicFact:
  subject: "ChatGPT"
  predicate: "has_monthly_users"
  object: "2.2M"
  type: "proposition"

연결 Object:
  Service { name: "ChatGPT", class: "AI_Service" }
  Metric { name: "monthly_active_users",
           value: 2200000, unit: "users", year: 2024 }

그래프 표현:
  (Fact)-[:ASSERTS_PROPERTY {
    property: "monthly_active_users",
    value: 2200000, unit: "users", year: 2024
  }]->(Service:ChatGPT)
```

### 패턴 B — 절차형 (방법, 조언, 가이드)

```
원문: "주방세제와 식초를 1:1 비율로 섞어 톡톡 두드린 뒤
       미지근한 물로 헹궈내면 커피 얼룩이 제거된다"

AtomicFact:
  claim: 위 문장 그대로 또는 정제된 한 문장
  type: "procedure"

연결 Object:
  Procedure { name: "Coffee Stain Removal" }
  Resource { name: "주방세제" }
  Resource { name: "식초" }
  Problem  { name: "옷 커피 얼룩" }

그래프 표현:
  (Fact)-[:ADDRESSES]->(Problem)
  (Fact)-[:USES]->(Resource:주방세제)
  (Fact)-[:USES]->(Resource:식초)
  (Fact)-[:HAS_TYPE]->(Procedure:Cleaning_Method)
```

### 패턴 C — 여러 문장이 한 주장을 떠받칠 때

여러 AtomicFact 사이의 관계를 동시에 추출.

```
원문 (논문):
  "프로스펙트 이론은 인간이 손실에 더 민감하다고 주장한다.
   Kahneman과 Tversky 연구에서 손실 회피 계수는 평균 2.25다.
   이는 같은 크기의 이득보다 손실이 2배 강하게 느껴진다는 의미다."

세 AtomicFact + 관계:
  fn-A: 프로스펙트 이론은 손실 민감성을 주장한다
  fn-B: 손실 회피 계수 평균은 2.25
  fn-C: 같은 크기 이득보다 손실이 2배 강하게 느껴진다

관계:
  (fn-B)-[:SUPPORTS]->(fn-A)
  (fn-C)-[:INTERPRETS_VALUE_OF]->(fn-B)
```

세 사실이 하나의 주장(프로스펙트 이론)을 떠받치는 구조 그대로
그래프에 새겨진다.

---

## 4. Lucid Ontology — 최종 12개 Object Classes

```
1.  AtomicFact      검증 단위 (claim, type, marks)
2.  Concept         추상 개념 (Loss Aversion, Democracy)
3.  Entity (parent class):
       Person       사람
       Organization 조직·기관
       Service      서비스 (ChatGPT, GitHub)
       Product      제품
       Place        장소·지역
4.  Event           사건 (date, location)
5.  Procedure       방법·과정
6.  Knowledge       지식 체계 (학술 이론, 경험적 지식, 체계화된 노하우)
7.  Task            과제·활동 (CASOS Meta-Network 정합)
8.  Metric          측정값 (value, unit, time)
9.  Resource        자원 (인적·재정적·물리적·정보적)
10. Problem         문제 상태
11. Source          출처
```

CASOS Meta-Network 4축 — Agent / Knowledge / Task / Resource —
가 모두 명시되어 있어 학술 분석 가능.

---

## 5. Link Types

```
Fact ↔ Object
  ASSERTS_PROPERTY    Fact가 Object의 속성을 주장
  DESCRIBES_STATE     Fact가 Object의 상태 묘사
  ADDRESSES           Fact가 Problem을 다룸
  USES                Fact가 Resource를 사용
  INVOLVES            Fact가 Person/Organization을 포함

Object ↔ Object
  PART_OF             Concept이 Knowledge의 일부
  INSTANCE_OF         Entity가 Class의 인스턴스
  LOCATED_IN          Entity가 Place에 위치
  HAS_ROLE            Person이 Organization에서 역할

Fact ↔ Fact (검증 인프라 핵심)
  SUPPORTS            한 사실이 다른 사실의 근거
  CONTRADICTS         한 사실이 다른 사실과 모순
  EXAMPLE_OF          한 사실이 다른 사실의 사례
  DERIVED_FROM        한 사실이 다른 사실에서 도출
  INTERPRETS          한 사실이 다른 사실을 해석
  SUPERSEDES          한 사실이 다른 사실을 대체 (시점 변화)

Fact ↔ Source
  CAPTURED_FROM       Fact의 원본 출처
```

---

## 6. 분해 알고리즘 — Claude API 프롬프트 구조

```
입력:
  merged_text
  source_metadata (URL, title, author, published_at, captured_at)
  capture_mode ("careful" | "trusted")
  user_language (default "ko")

작업 순서:
  1. 텍스트에서 모든 Object 후보 식별
  2. 각 Object에 class 부여 (12개 중 하나)
  3. 모든 주장을 AtomicFact로 분해
     - 명제형: subject/predicate/object 명시
     - 절차형: claim 문장 + 관련 Object 연결
  4. AtomicFact ↔ Object 관계 추출
  5. AtomicFact ↔ AtomicFact 관계 추출
  6. 시간 메타데이터 추출 (valid_from만; valid_until은 v2에서 retired)
  7. 분해 불가 시 빈 배열 반환

출력 (JSON):
  {
    objects: [
      { uid, class, name, properties }
    ],
    facts: [
      { uid, type, claim, subject, predicate, object }
    ],
    fact_object_links: [
      { fact_uid, object_uid, link_type, properties }
    ],
    fact_fact_links: [
      { from_uid, to_uid, link_type }
    ],
    extraction_status: "success" | "no_facts_found",
    failure_reason: null | "opinion_content" | "advertisement" | ...
  }
```

---

## 7. 분해 실패 — 정직한 빈 결과

다음 경우 추출 시도 후 빈 결과 반환:

```
opinion_content        주관적 의견·감정 표현
advertisement          광고·판촉 콘텐츠
non_factual_creative   소설·시·창작물 (별도 처리 가능성)
ambiguous_attribution  화자 불명·인용 출처 불명
non_verifiable         검증 불가능한 형이상학적 주장
```

사용자에게 표시:

```
이 콘텐츠에서 추출 가능한 사실이 없습니다.
이유: 의견 콘텐츠로 판단됨

원본은 출처 메모로 저장됩니다. (검증 가능한 사실이 발견되면
나중에 다시 분해 가능)
```

---

## 8. 출처 메타데이터의 사실 단위 분배

한 캡처에서 추출된 N개 사실은 모두 동일한 source_metadata를 공유.

```
Capture 단계 출력:
  merged_text + source_metadata { URL, title, author, ... }

Structure 단계 처리:
  facts[i].captured_from = source_metadata (모든 i에 동일)
  facts[i].captured_at = 현재 시점 (모든 i에 동일)
  facts[i].validator_id = 사용자 ID
  
  단, 시간 메타데이터는 사실별로 다를 수 있음:
  facts[i].valid_from = AI가 텍스트에서 추출 (예: "2024-01-01")
  # facts[i].valid_until — RETRACTED (DR-053): AI가 만료를 추정하지 않음
```

같은 출처에서 여러 사실이 나와도, 각 사실은 독립적으로 검증·관리됨.

---

## 9. 사용자 사후 지식 관리 — Curation 기능

Validate를 통과한 FactNode도 시간이 지나면 재분류·정리 필요.
별도 큐레이션 모드 제공. Stellar View 위에서 직접 조작.

```
1.  Reclassify Object   class 변경 (오인식 교정)
2.  Merge Objects       같은 실체의 분리된 노드 통합
3.  Split Object        하나로 합쳐진 노드 분리
4.  Reclassify Fact     type 변경 (명제 ↔ 절차)
5.  Demote Fact         FactNode → PendingFact 재검토 큐로
6.  Drop Fact           archived 상태 (완전 삭제 아님)
7.  Tag / Untag         사용자 정의 태그
8.  Move between Spaces Personal ↔ Team 이동, 감사 로그
```

베타 시작 시점에는 1, 5, 6, 7만 우선 구현. 2, 3, 4, 8은 베타 후.

---

## 10. 데이터 흐름 — Capture → Structure → 다음 단계

```
[Capture 출력]
  merged_text + source_metadata + capture_mode

       ↓ Structure 처리

[중간 산출물]
  objects[] + facts[] + fact_object_links[] + fact_fact_links[]

       ↓ 분기

[신중 모드]                    [신뢰 모드]
PendingFact 큐로                즉시 FactNode로
status: pending_validation     status: auto_accepted
                               auto_accept_basis 메타데이터 박힘
       │                              │
       ↓                              ↓
   Validate 단계                  Surface 단계 가능 상태
```

---

## 11. 베타 범위 — 명시적 포함/제외

**베타에 포함:**
```
✅ 12개 Object Class 인식
✅ 명제형 / 절차형 AtomicFact 분해
✅ Fact ↔ Object ↔ Fact 관계 추출
✅ 신중 / 신뢰 모드 선택
✅ 분해 실패 시 빈 결과
✅ 큐레이션 기능 4종 (Reclassify Object, Demote, Drop, Tag)
```

**베타에서 제외:**
```
❌ 다국어 동시 분해 (베타는 한국어/영어만)
❌ 이미지 OCR 후 분해 (Phase 1)
❌ 음성 → STT → 분해 자동 파이프라인 (Phase 2)
❌ Object Merge/Split (Phase 1 후반)
❌ Cross-space Fact 이동 (Phase 1)
❌ 사용자 정의 Object Class 추가 (Phase 2)
```

---

## 12. Development Phase Timeline

```
  Beta (M0)              Phase 1 (M6)             Phase 2 (M12+)
  ────●─────────────────────●────────────────────────●──────────►

  Structure scope:        Add:                      Add:
  · 12 Object classes     · Object Merge/Split      · User-defined classes
  · Proposition + Proc.   · Cross-space moves       · Multi-language fusion
  · Fact-Fact relations   · Image OCR → decompose   · Voice STT pipeline
  · Trust mode (manual)   · Trust mode (auto-       · Federated trust
  · Curation: 4 ops         learned from history)     network propagation
```

---

## 13. 정책 결정 — 확정 사항

### Q1. 중복 캡처 처리 (확정)

```
완전 중복            무시. 한 번 입력으로 족함.
같은 사실 + 다른 출처  기존 FactNode에 출처 INCREMENT
                     source_count: 1 → 2 → 3...
                     다중 출처 사실은 자동으로 신호 강화
```

### Q2. Object 매칭 임계값 (확정)

```
자동 통합 (high)         시스템 즉시 처리, 사용자 통지만
  · 완전 일치 (대소문자/공백 정규화)
  · 명백한 표기 변이 ("OpenAI"/"Open AI"/"오픈에이아이")

반자동 통합 (medium)      사용자 승인 후 통합
  · 유사도 0.85 ~ 0.95
  · "두 노드가 같은 실체로 보입니다. 통합하시겠습니까?"

처리 안 함 (low)          별도 노드 유지
  · 유사도 0.85 미만
  · Curation에서 수동 Merge 가능
```

### Q3. Object Subclass 체계 (확정)

핵심 클래스만 subclass 적용. 나머지는 단일 클래스 + 자유 텍스트 name.

```
Subclass 적용 (베타 포함)
  Entity        Person / Organization / Service / Product / Place
  Knowledge     도메인 자유 (수학, 통계, 코딩, 행동경제학 등)
                Q2 매칭 알고리즘이 유의어 점진 통합

Subclass 미적용 (베타)
  Procedure, Resource, Event, Task, Metric, Problem
  → 단일 클래스로 처리. 자유 텍스트 name만.
  → 베타 데이터 수집 후 필요 시 subclass 도입 검토 (Phase 1+)
```

### Q4. Knowledge 노드 범위 (확정)

```
주어가 될 수 있는 명사형 지식 영역은 모두 허용.
  · 학문 분야: 수학, 통계, 컴퓨터과학
  · 실무 영역: 코딩, 프로그래밍, 데이터분석
  · 사회 도메인: 지능범죄, 육아, 부동산
  · 응용 분야: 행동경제학, 정책분석, AI 거버넌스

베타에서 카테고리 제한 없음.
유의어는 Q2 매칭 알고리즘이 자연스럽게 통합.
실제 분포 데이터 모이면 Phase 1에서 정책 재검토.
```

---

## 14. 다음 단계

Structure 단계 베타 범위 확정. 다음:

```
Validate 단계 명세서 작성
  - 신중 모드 HITL UI 흐름
  - 신뢰 모드 자동 수락 정책
  - 검증 시점 표시 정보 (출처 권위, 시간 신선도, 동의율)
  - 큐레이션 기능 4종 UI 흐름
```

---

*Lucid Structure Spec v1.0 | Beta Scope Locked | Be lucid.*


---

## A. DCR-001 detail (2026-05-28) — Negation, NEGATES, Algorithm v2.1

This appendix is the authoritative source for the DCR-001 additions
referenced in the v2.1 banner above. The original §3, §5, §6, §13
prose is preserved for historical context; this appendix overrides
it where they conflict.

### A.1 AtomicFact / FactNode negation fields

```
negation_flag: bool = False
    True when the decomposed claim is intrinsically negative, e.g.
    "X is NOT Y", "Z does not Y", "X is prohibited".
    The structurer sets this; the validator can override.

negation_scope: Optional[Literal["full", "partial"]] = None
    "full"      The entire claim is negated. ("X does not exist.")
    "partial"   Only part of the claim is negated. ("X is not Y, but
                X is Z.")  partial cases require user confirmation
                (the negation warning card in Validate).
    None        When negation_flag=False, scope is None.

failure_reason candidate (§7):
    "negation_ambiguous"  emitted when the structurer cannot decide
                          between full and partial scope; the
                          AtomicFact is sent to the Validate
                          disambiguation queue instead of the main
                          PendingFact list.
```

Negation token list (Korean + English, beta seed list):

```
EN:  not, no, never, n't, prohibit, forbid, deny, banned, illegal, fail to
KO:  않다, 없다, 아니다, 금지, 불가능, 못, 안, 제외
```

The structurer's prompt includes this list; misses go to
`negation_ambiguous`. Updates to the list are tracked in the
beta-backlog (Sprint 3 P0-EVAL).

### A.2 NEGATES link type

`NEGATES` is a **Fact -> Fact** link distinct from `CONTRADICTS`:

```
CONTRADICTS  (existing, 6th link)
    Symmetric. Two facts that cannot both be true.
    Example: fn-201 "interest rate is 3.5%" vs fn-205
             "interest rate is 4.0%" (same Subject, same
             property, different value).

NEGATES      (new in DCR-001, 7th link)
    Directional. Fact A negates Fact B if A is the explicit
    negative statement of B.
    Example: fn-310 "EU AI Act does NOT apply to military"
             NEGATES fn-309 "EU AI Act applies to military".
    Distinct from CONTRADICTS because the asymmetry is meaningful:
    fn-310 carries negation_flag=True and is the negating party;
    fn-309 is the affirmed party (unmarked).
```

After DCR-001 the Fact <-> Fact link enum has 7 members:
`SUPPORTS, CONTRADICTS, EXAMPLE_OF, DERIVED_FROM, INTERPRETS,
SUPERSEDES, NEGATES`.

C1 contradiction detection considers both CONTRADICTS and NEGATES
when computing the same-Subject + same-Property check.

### A.3 Decomposition algorithm — 7 steps

```
Input:    merged_text + source_metadata + capture_mode + user_language
Output:   {objects, facts, fact_object_links, fact_fact_links,
           disambiguation_candidates, extraction_status, failure_reason}

Step 1.  Identify all Object candidates in the text.
Step 2.  Assign each Object a class from the 13-class ontology.
Step 3.  Decompose all assertions into AtomicFact candidates
         (proposition / procedure).
Step 4.  [NEW in DCR-001] Negation detection.
         For each AtomicFact candidate:
           - scan for negation tokens (A.1 list)
           - if found, set negation_flag=True
           - decide scope (full / partial) by syntactic context
           - on ambiguity, emit with failure_reason='negation_ambiguous'
Step 5.  Extract AtomicFact <-> Object relations (5 link types).
Step 6.  Extract AtomicFact <-> AtomicFact relations
         (now 7 link types including NEGATES).
Step 7.  Extract time metadata (valid_from only; valid_until retired).
         Emit JSON; on overall failure return an empty result with
         `failure_reason` set.
```

### A.4 Output JSON shape (DCR-001 additions)

```jsonc
{
  "objects": [...],
  "facts": [
    {
      "uid": "fn-...",
      "type": "proposition" | "procedure",
      "claim": "...",
      "subject_uid": "...",
      "predicate": "...",
      "object_value": "...",
      "negation_flag": true,                 // DCR-001
      "negation_scope": "full" | "partial" | null  // DCR-001
    }
  ],
  "fact_object_links": [...],
  "fact_fact_links": [
    { "from_uid": "...", "to_uid": "...",
      "link_type": "negates" }               // DCR-001 (one of 7)
  ],
  "disambiguation_candidates": [             // DCR-001
    {
      "fact_uid": "...",
      "mention_text": "Apple",
      "candidate_object_uids": ["obj-a1", "obj-a2"],
      "scores": [0.91, 0.88]
    }
  ],
  "extraction_status": "success" | "no_facts_found",
  "failure_reason": null | "opinion_content" | "advertisement" |
                    "negation_ambiguous" | ...
}
```

### A.5 Object matching thresholds (DCR-001 / DR-065)

```
Auto-merge:
  Most classes               score >= 0.95
  Person / Organization / Service   score >= 0.98 (tighter — high
                                                   confusion cost)
Disambiguation queue (user-delegated):
  Everything below the auto-merge threshold goes here. No more
  semi-auto 0.85-0.95 band (retired; DR-032 reframed).
Keep separate:
  When the user clicks "create new" in the Disambiguation card.

Every disambiguation decision is logged to the Postgres
`disambiguation_logs` table (DCR-001 schema).
```
