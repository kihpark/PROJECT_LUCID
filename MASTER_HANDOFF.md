# Lucid — Master Handoff for Claude Code / Codex

**Version:** v2 (wireframes + specs aligned)
**Date:** 2026-05
**Audience:** Claude Code (primary), Codex (secondary)
**Status:** Ready for Sprint 0 execution

---

## 0. 이 문서의 역할

이건 Lucid 베타 개발의 **단일 진입점**이다. 이 문서를 읽으면 Sprint 0부터 자율 실행이 가능해야 한다.

```
모든 명세 + 와이어프레임 + 백로그 + 정책 결정 → 한 문서로 통합
이 문서를 컨텍스트로 받고 명시된 첫 작업부터 실행
의문이 생기면 referenced 문서로 깊이 들어감
```

옛 핸드오프 파일들은 `archive/` 폴더로 이동됨. 이 문서가 최신이고 유일한 진실이다.

---

## 1. Lucid가 무엇인가 — 30초 요약

**한 문장:** Lucid는 사용자가 저장한 글·영상·문서를 검증된 지식 그래프로 만드는 시스템이다.

**카피:**
- Main: *Own what you know.*
- Sub (EN): *Lucid saves your reading to a personal knowledge graph — verified, searchable, yours.*
- Sub (KR): *당신이 읽은 것을 Lucid가 지식 그래프로 만듭니다. 검증되고 검색이 가능하면 이 지식은 온전히 당신의 것이 됩니다.*

**경쟁 포지셔닝:**
일반 LLM은 학습 데이터에서 평균낸 답변을 한다. Lucid는 사용자가 직접 검증한 사실에서만 답한다.
- "Same question. Very different answer."
- Identity protocol: "As far as I know..." / "According to your knowledge graph..." — 모든 응답에 인식론적 서명.

**3-layer 가치:**
- Surface: 검증해서 저장
- Middle: 인식론적 위생 (내가 뭘 아는지 정확히 안다)
- Deep: 암묵지의 명시화 (내 머릿속 지식을 외부 구조화)

---

## 2. CSVS 루프 — 시스템 핵심

Lucid는 4단계 루프로 작동한다.

```
사용자 행동                  시스템 동작
─────────────────────────────────────────────────────────
[1] Save to Lucid           Capture (URL, 메타데이터, 콘텐츠)
       ↓
                            Structure (AtomicFact 분해,
                            12 Object class 분류, 링크 추출)
       ↓
[2] Decide                  Validate UI (Accept all / Review /
                            Discard) 또는 Trusted 자동 Accept
       ↓
[3] 작업·질문               Surface (5 modes로 사용자에게 떠오름)
```

Capture/Structure는 백그라운드. Decide/Surface가 사용자가 만나는 면.

**핵심 디자인 결정 — 이건 절대 흔들면 안 됨:**

```
1. Save / Decide 분리
   "Save to Lucid" 클릭은 분석 트리거.
   사실이 그래프에 들어가는 결정은 Decide 단계에서.

2. Per-source policy는 Settings에 한 번
   Decide 시점에 "이 출처 신뢰할까?" 같은 질문 절대 금지.
   Trusted/Careful은 Settings SET-2에서 한 번 설정.

3. Stale 시스템 없음
   시점 사실은 영원히 진실 ("한국 금리 2024-12 기준 3.5%").
   valid_until 필드 없음. is_stale 플래그 없음.

4. Identity protocol 강제
   Surface 모든 응답은 "As far as I know..." 같은 표현으로 시작.
   사용자가 끌 수 없음 (베타).

5. Warn, never block
   Gatekeeping은 경고만, 차단 안 함.
   override_warning 메타데이터로 흔적 보존.

6. Smart dismiss
   ESC/×/바깥 클릭 = Pending 큐. 결정이 사라지지 않음.
   auto-dismiss 타이머 없음. "Done" 버튼 없음.

7. 학습 곡선 낮음
   "사용자 진입장벽을 높이지 말아라. 학습 곡선이 절대 가파라서는 안 된다."
   PO 원칙. 복잡성 추가 시 항상 PO 확인.
```

---

## 3. 12 Object Classes — Ontology

```
AtomicFact              검증된 사실 하나하나 (그래프의 별)
Concept                 추상 개념 (loss aversion, protein synthesis)
Entity:Person           사람 (Kahneman)
Entity:Organization     조직 (European Commission, OpenAI)
Entity:Service          서비스 (ChatGPT, Claude)
Entity:Product          제품 (GPT-5)
Entity:Place            장소 (Korea, EU)
Knowledge               지식 영역 (AI Governance, behavioral economics)
Event                   사건/사실/법안 (EU AI Act, GDPR)
Procedure               방법/절차 (facial recognition, fasted cardio)
Task                    할 일
Metric                  수치 (weekly users, daily protein g/kg)
Resource                자원 (U.S. beef, semiconductor exports)
Problem                 문제 (muscle loss, mad cow disease)
Source                  출처 (wsj.com, nature.com)
```

각 class에 고유 색이 있다 (와이어프레임 entity 색 코딩 참조).

**Link Types:**
- Fact↔Object: ASSERTS_PROPERTY, DESCRIBES_STATE, ADDRESSES, USES, INVOLVES
- Object↔Object: PART_OF, INSTANCE_OF, LOCATED_IN, HAS_ROLE
- Fact↔Fact: SUPPORTS, CONTRADICTS, EXAMPLE_OF, DERIVED_FROM, INTERPRETS, SUPERSEDES
- Fact↔Source: CAPTURED_FROM

---

## 4. Surface — 5 Modes

```
Mode 0  Lucid On/Off       마스터 토글
Mode 1  Active Recall      타이핑 중 점선 밑줄 + 풍선
Mode 2  Passive Recall     Ask Lucid (대화형, 베타 킬러)
Mode 3  Contradiction      모순 감지 + 해소 큐
Mode 4  Gatekeeping        가짜 정보 입구 경고

(Mode 5 Staleness는 베타에서 제거됨.)
```

---

## 5. 베타 스택 — 확정

```
백엔드:        FastAPI + Neo4j + FAISS + Anthropic Claude API
              + faster-whisper

프론트엔드:    Chrome Extension (Manifest V3)
              PWA (Share Target API)
              데스크탑 앱 UI는 PWA로

배포:          Docker Compose (단일 노드)
              Phase 1+에 분산

LLM 호출:      Claude API (분석·분해·답변)
              로컬 모델 안 씀 (베타 단순화)
```

**왜 이 스택인가:**
- Neo4j: 그래프 쿼리 성능 + ontology 표현력
- FAISS: 임베딩 기반 의미 검색
- Claude API: 분해 품질 (특히 한국어)
- faster-whisper: 유튜브 자막 없을 때
- Docker Compose: 베타 운영 단순함

---

## 6. 디렉토리 구조 (목표)

```
/lucid/
├── docs/                          명세서 5개
│   ├── capture-stage-spec.md      v2
│   ├── structure-stage-spec.md    v2
│   ├── validate-stage-spec.md     v2
│   ├── surface-stage-spec.md      v2
│   └── beta-backlog.md            v2 (Sprint 단위 실행 계획)
├── wireframes/                    HTML 와이어프레임 5 pack
│   ├── pack1-onboarding.html      O-1 ~ O-4
│   ├── pack2-capture.html         C-1 ~ C-6
│   ├── pack3-queue.html           Q-1 ~ Q-3
│   ├── pack4-surface.html         S-1 ~ S-5
│   └── pack5-stellar-settings.html SV-1 ~ SV-3, SET-1, SET-2
├── archive/                       옛 핸드오프 (참고용)
├── backend/                       FastAPI 서버 (구현 대상)
│   ├── app/
│   │   ├── main.py
│   │   ├── capture/               Sprint 2A-2C
│   │   ├── structure/             Sprint 3
│   │   ├── validate/              Sprint 4A-4B
│   │   ├── surface/               Sprint 5-6
│   │   └── models/                Sprint 1A
│   ├── tests/
│   └── pyproject.toml
├── extension/                     Chrome MV3 (구현 대상)
│   ├── manifest.json
│   ├── content/
│   ├── background/
│   ├── popup/
│   └── tests/
├── pwa/                           PWA (구현 대상)
│   ├── public/
│   ├── src/
│   └── package.json
├── frontend/                      Lucid 앱 (Stellar, 큐 등)
│   ├── src/
│   └── package.json
└── MASTER_HANDOFF.md              이 문서
```

---

## 7. Sprint 0 — 시작점

**목표:** 개발 환경 + Docker Compose + 빈 FastAPI 부팅.

**작업 (1 PR):**

```
1. /backend, /extension, /pwa, /frontend 디렉토리 생성
2. backend/pyproject.toml 작성
   - fastapi, uvicorn, neo4j, faiss-cpu, anthropic,
     pydantic, pytest, ruff, mypy
3. backend/app/main.py — 빈 FastAPI 앱
   - GET /health → {"status": "ok"}
4. docker-compose.yml
   - neo4j (5.x community edition)
   - backend (FastAPI)
   - volumes
5. .env.example
   - ANTHROPIC_API_KEY=...
   - NEO4J_URI=...
   - NEO4J_USER=...
   - NEO4J_PASSWORD=...
6. README.md
   - 개발 환경 부팅 명령
   - 첫 실행 가이드
7. .github/workflows/ci.yml
   - pytest, ruff, mypy 실행
8. AGENTS.md
   - Claude Code/Codex 작업 가이드
   - 명령어 모음 (테스트, lint, type check)
```

**완료 조건:**
```
✓ docker-compose up → 모든 서비스 healthy
✓ curl http://localhost:8000/health → {"status": "ok"}
✓ pytest 실행 → 0 tests, 통과
✓ ruff + mypy 통과
✓ CI 그린
```

**다음 Sprint:** Sprint 1A (Data Models) + 1B (Auth) 병렬.

---

## 8. Sprint 실행 규칙

```
[1] beta-backlog.md의 해당 Sprint 섹션 정독
    · 목표
    · 구현 범위 (P0/P1 명시)
    · 의존성
    · 완료 조건
    · 테스트 케이스
    · 데모 시나리오

[2] 관련 spec 문서 정독
    · Sprint 2x (Capture) → capture-stage-spec.md
    · Sprint 3 (Structure) → structure-stage-spec.md
    · Sprint 4x (Validate) → validate-stage-spec.md
    · Sprint 5-6 (Surface, Stellar) → surface-stage-spec.md

[3] 관련 와이어프레임 정독
    · UI 작업이면 해당 pack HTML 열어서 직접 확인
    · 색·간격·인터랙션 그대로 구현

[4] 작업 분해
    · Sprint 정의를 PR 단위로 나눔 (1 Sprint = 보통 1-3 PR)
    · 각 PR은 독립적으로 테스트 가능

[5] 구현
    · 테스트 먼저 작성 (TDD)
    · 명세 위반 시 PO에게 질문 (Phase 1+ 검토 항목으로)

[6] PR 제출
    · 완료 조건 체크리스트 모두 ✓
    · 테스트 케이스 모두 통과
    · 데모 시나리오 캡처 (영상 또는 스크린샷)

[7] 다음 Sprint
    · 의존성 체크
    · 병렬 가능 Sprint 식별
```

---

## 9. 절대 금지 사항

```
❌ stale / valid_until / is_stale 도입
   사실은 영원히 진실. 시점 컨텍스트로 충분.

❌ Save 시점 "이 출처 신뢰할까?" 질문
   Settings SET-2에서 한 번에 관리.

❌ Decide 시점 메모 필드
   태그만. Personal note는 Review mode V-2에서만.

❌ Auto-dismiss 타이머
   사용자 결정이 사라지지 않음. Smart dismiss → Pending 큐.

❌ "Done" 버튼 (Decide 오버레이)
   오버레이 자체가 결정 도구.

❌ Identity protocol 우회
   Lucid 응답은 항상 "As far as I know..." 같은 표현으로 시작.
   일반 지식 메우기 절대 금지.

❌ Mode 5 Staleness
   5 modes만. Mode 5 제거됨.

❌ Gatekeeping에서 차단
   경고만. override_warning으로 흔적.

❌ 외부 fact-check DB (베타)
   Gatekeeping은 사용자 자기 그래프만 비교.

❌ 임의 파일 업로드, 스크린샷, 카메라 캡처
   출처 없는 캡처는 베타에서 안 받음.

❌ "지금 검증 / 나중에" 옛 분기
   Decide 오버레이의 3 옵션 (Accept all / Review / Discard)으로 대체.
```

---

## 10. 와이어프레임 → 코드 매핑

| 와이어프레임 | Sprint | 컴포넌트 |
|-------------|--------|----------|
| O-1 Landing | Sprint 7 | `frontend/src/pages/landing.tsx` |
| O-2 Archetype Survey | Sprint 7 | `frontend/src/pages/signup/survey.tsx` |
| O-3 First Save Tutorial | Sprint 7 | `frontend/src/pages/onboarding/tutorial.tsx` |
| O-4 Initial Settings | Sprint 7 | `frontend/src/pages/onboarding/settings.tsx` |
| C-1 Right-click | Sprint 2A | `extension/content/context-menu.ts` |
| C-2 Analysis toast | Sprint 2A | `extension/content/toast.ts` |
| C-3 Decide Summary | Sprint 4A | `extension/content/decide-overlay.tsx` |
| C-4 Decide Review | Sprint 4A | `extension/content/decide-review.tsx` |
| C-5 PWA Home | Sprint 2B | `pwa/src/pages/home.tsx` |
| C-6 Save failure | Sprint 4A | `extension/content/empty-result.tsx` |
| Q-1 Pending Queue | Sprint 4A | `frontend/src/pages/pending/list.tsx` |
| Q-2 Group reopened | Sprint 4A | reuse Decide overlay |
| Q-3 Auto-accepted | Sprint 4A | `frontend/src/pages/auto-accepted/list.tsx` |
| S-1 Active Recall | Sprint 6A | `extension/content/active-recall.ts` |
| S-2 See All panel | Sprint 6A | `extension/content/see-all-panel.tsx` |
| S-3 Ask Lucid | Sprint 6B | `frontend/src/components/ask-lucid.tsx` |
| S-4 Contradiction | Sprint 6C | `frontend/src/pages/contradictions/list.tsx` |
| S-5 Gatekeeping | Sprint 6D | `extension/content/gatekeep-dialog.tsx` |
| SV-1 Stellar Overview | Sprint 5 | `frontend/src/pages/stellar/overview.tsx` |
| SV-2 Filtered | Sprint 5 | reuse Stellar with filter prop |
| SV-3 Contradiction viz | Sprint 5 | reuse Stellar with contradiction layer |
| SET-1 Main settings | Sprint 7 | `frontend/src/pages/settings/main.tsx` |
| SET-2 Trusted sources | Sprint 7 | `frontend/src/pages/settings/sources.tsx` |

---

## 11. 디자인 시스템 — 와이어프레임 추출

```
색상:
  --bg-base:        #0a0a0a
  --bg-elevated:    #141414
  --bg-card:        #1a1a1a
  --bg-hover:       #242424
  --border-subtle:  #2a2a2a
  --border-medium:  #3a3a3a
  --text-primary:   #f5f5f5
  --text-secondary: #a0a0a0
  --text-tertiary:  #707070
  --accent-warm:    #ffd966   (별의 따뜻한 빛, Lucid 정체성)
  --accent-cool:    #6db4f5   (fn-ID 인용)
  --success:        #4ecdc4
  --warning:        #ffd966
  --danger:         #ff6b6b

폰트:
  Inter (UI 본문)
  IBM Plex Mono (코드, 메타데이터, fn-ID)
  Pretendard (한국어 본문)

Object class 색 (12개):
  --c-fact:       rgb(255, 217, 102)
  --c-concept:    rgb(183, 148, 246)
  --c-person:     rgb(246, 165, 192)
  --c-org:        rgb(109, 180, 245)
  --c-service:    rgb(78, 205, 196)
  --c-product:    rgb(78, 205, 196)
  --c-place:      rgb(149, 225, 163)
  --c-knowledge:  rgb(149, 225, 163)
  --c-event:      rgb(232, 184, 212)
  --c-procedure:  rgb(255, 160, 122)
  --c-task:       rgb(168, 218, 220)
  --c-metric:     rgb(255, 230, 109)
  --c-resource:   rgb(201, 180, 138)
  --c-problem:    rgb(255, 107, 107)
  --c-source:     rgb(136, 136, 136)

Entity 멘션 스타일:
  .em + .em-{class}
  배경: rgba(class, 0.10)
  border: 1px solid rgba(class, 0.22)
  좌측 점: 5px 원, class 색
  padding: 1px 7px 1px 14px
  border-radius: 3px
  font-weight: 500
  텍스트 색은 본문 색 유지
```

---

## 12. Sprint 의존성 그래프

```
Sprint 0    Foundation (Docker Compose, FastAPI 기본)
   ↓
Sprint 1A   Data Models + Neo4j Schema      ┐  병렬
Sprint 1B   Auth + KnowledgeSpace API       ┘
   ↓
Sprint 2A   Chrome Extension Capture        ┐
Sprint 2B   PWA Share Target                ├  병렬
Sprint 2C   Extractor Pipeline              ┘
   ↓
Sprint 3    Structure Engine (의존: 2C)
   ↓
Sprint 4A   Validate UI                     ┐  병렬
Sprint 4B   Validate API                    ┘
   ↓
Sprint 5    Stellar View 기본
   ↓
Sprint 6A   Surface — On/Off + Active Recall    ┐
Sprint 6B   Surface — Passive Recall (Ask Lucid) ├  병렬
Sprint 6C   Surface — Contradiction               │
Sprint 6D   Surface — Gatekeeping                 ┘
   ↓
Sprint 7    Onboarding + 결제 + Polish
```

병렬 가능:
- 1A + 1B
- 2A + 2B + 2C
- 4A + 4B
- 6A + 6B + 6C + 6D

---

## 13. 베타 launch 조건

```
P0 완료 = launch 가능
P1은 continuous deployment

베타 launch 게이트:
  ✓ 모든 Sprint 0-7 P0 완료
  ✓ E2E 시나리오 5개 통과
     1. 가입 → 첫 저장 → Decide → 그래프 진입
     2. Trusted 출처 자동 수락 → Auto-accepted 탭 확인
     3. ESC로 Pending 큐 → 큐에서 재오픈 → 결정
     4. Ask Lucid 3 응답 패턴 모두 작동
     5. 모순 감지 → Contradiction Queue → 해소
  ✓ 30-40명 사용자 모집 페이지 라이브
  ✓ archetype 설문 → DB 저장 → 분석 dashboard
  ✓ 백업 + 데이터 export 작동
```

---

## 14. 모집 데이터 처리

베타의 핵심 가설은 "어떤 archetype이 retain하는가". 5 차원 설문 + 사용 패턴이 분석 입력.

```
설문 데이터 (가입 시 한 번):
  · consumption_intensity: light / moderate / heavy
  · validation_frequency: careful / deferred / trusting
  · surface_usage: active / passive / archive
  · domain_diversity: narrow / medium / broad
  · device_environment: desktop / mobile / mixed

사용 패턴 (지속 측정):
  · captures_per_day
  · decide_completion_rate
  · defer_rate
  · ask_lucid_queries_per_week
  · contradiction_resolution_time
  · gatekeeping_override_rate

분석 dashboard (Sprint 7):
  · self-report vs actual 비교
  · archetype × retention 매트릭스
  · 강한 retention의 archetype 조합 식별
```

이 데이터가 Phase 1의 segment 결정의 근거가 된다.

---

## 15. 응답 품질 — Claude API 사용 패턴

```
모델:        claude-sonnet-4-5 (분해, 분석)
            claude-haiku-4-5 (Active Recall 빠른 매칭)

분해 (Structure):
  System prompt: 12 class ontology + link types 정의
  User: merged_text
  Response: JSON (objects + facts + links)
  실패 시: 정직한 빈 결과 ({"objects":[],"facts":[]})
  Confidence: Structure 단계에서는 추출 안 함 (DR-026)

Ask Lucid (Surface Mode 2):
  System prompt: Identity protocol 강제 ("As far as I know...")
                 그래프 사실만으로 답변
                 인용 fn-ID 의무
                 없으면 honest empty
  User: 사용자 질문 + 그래프 검색 결과 컨텍스트
  Response: prefix + facts + (선택) suggested action

Gatekeeping (Surface Mode 4):
  사실 기반 매칭 + 출처 권위 비교
  Claude API 호출 없음 (deterministic 로직)
```

비용 통제:
- 분해는 캡처당 1회 호출
- Ask Lucid는 사용자 명시적 호출
- Active Recall은 캐시 사용 (같은 키워드 재호출 안 함)
- 모든 호출에 prompt caching 적용

---

## 16. 첫 작업 — Sprint 0 시작 명령

Claude Code가 이 핸드오프를 받으면 다음 순서로 진행:

```
1. 이 문서 정독
2. /docs/beta-backlog.md 정독 (Sprint 0 명세)
3. /docs/capture-stage-spec.md, structure-stage-spec.md,
   validate-stage-spec.md, surface-stage-spec.md 정독
4. /wireframes/*.html 5개 모두 열어서 확인
5. /backend, /extension, /pwa, /frontend 디렉토리 구조 생성
6. backend/pyproject.toml 작성
7. backend/app/main.py FastAPI 기본 앱
8. docker-compose.yml (Neo4j + backend)
9. .env.example
10. README.md (개발 환경 부팅 가이드)
11. .github/workflows/ci.yml
12. AGENTS.md (Claude Code/Codex 작업 가이드)
13. pytest + ruff + mypy 통과 확인
14. PR 제출
```

PR 통과 후 Sprint 1A (Data Models) + 1B (Auth) 병렬 시작.

---

## 17. 의문이 생기면

```
명세 모호함:
  → spec 문서 정독 후에도 해결 안 되면
  → 해당 부분을 GitHub Issue로 만들고 PO에게 ping
  → 우회 가능한 결정은 spec에 추가하고 진행

와이어프레임과 spec 충돌:
  → 와이어프레임이 우선 (사용자 결정 반영됨)
  → spec을 와이어프레임에 맞게 업데이트 PR

새 기능 아이디어:
  → 베타 범위 외이면 docs/phase-1-ideas.md에 기록
  → 베타에 즉시 추가는 PO 승인 필요

성능 트레이드오프:
  → spec의 P0/P1 우선순위에 맞춤
  → P0 안에서 단순함 우선
```

---

## 18. 진행 상황 보고

각 Sprint 완료 시:

```
1. PR description에 다음 포함:
   · 완료 조건 체크리스트
   · 테스트 케이스 결과
   · 데모 시나리오 (영상 or 스크린샷)
   · 다음 Sprint 의존성 변경 사항
   · 발견된 PO 승인 필요 항목

2. /docs/changelog.md 업데이트 (없으면 생성)
3. /docs/beta-backlog.md의 해당 Sprint에 [완료] 표시
```

---

## 19. PO와의 협업 원칙

```
PO 박기흥 — 박사과정 + 전 Samsung/CMU/WCO
요구 사항:
  · 솔직함 (no flattery, no over-engineering)
  · 학습 곡선 낮음 (사용자 진입장벽 절대 금지)
  · 한국어 1차, 영어 기술 용어
  · 와이어프레임/spec 위반 시 즉시 push back

자율 결정 가능:
  · 명세에 명시된 P0 작업
  · 의존성 처리, 테스트 작성
  · 코드 구조, 라이브러리 선택
  · CI/CD 설정

PO 확인 필요:
  · 명세 변경
  · 새 기능 도입
  · 베타 범위 확대
  · 디자인 시스템 변경
  · 와이어프레임에 없는 UI 추가
```

---

## 20. 시작하기 — 실행 명령

이 핸드오프를 받은 Claude Code/Codex는 다음 메시지로 응답하고 시작:

```
다음을 확인했습니다:
✓ MASTER_HANDOFF.md 정독
✓ 4 spec 문서 정독
✓ 5 wireframe pack 확인
✓ beta-backlog.md Sprint 0 명세 확인

Sprint 0 작업 시작합니다.
첫 커밋: 디렉토리 구조 + backend 기본 골격.
```

그리고 작업 시작.

---

## Appendix A. 참조 문서

```
/docs/capture-stage-spec.md       Capture 단계 (Save to Lucid)
/docs/structure-stage-spec.md     Structure 단계 (AtomicFact 분해)
/docs/validate-stage-spec.md      Validate 단계 (Decide UI)
/docs/surface-stage-spec.md       Surface 단계 (5 modes)
/docs/beta-backlog.md             Sprint 단위 실행 계획
/wireframes/pack1-onboarding.html         O-1 ~ O-4
/wireframes/pack2-capture.html            C-1 ~ C-6
/wireframes/pack3-queue.html              Q-1 ~ Q-3
/wireframes/pack4-surface.html            S-1 ~ S-5
/wireframes/pack5-stellar-settings.html   SV-1 ~ SV-3, SET-1, SET-2
/archive/                         옛 핸드오프 (v1, 참고용)
```

## Appendix B. 핵심 용어 사전

| 용어 | 의미 |
|------|------|
| CSVS | Capture · Structure · Validate · Surface (시스템 루프) |
| AtomicFact | 검증 가능한 한 줄짜리 사실 |
| Object | Subject·Person·Org·Place 등 그래프의 노드 |
| Link | 객체 또는 사실 간 관계 |
| KnowledgeSpace | 사실 그래프의 단위 (Personal/Team/Policy/Public) |
| fn-ID | Fact UID의 표시 형식 (fn-220, fn-301 등) |
| Decide overlay | 분석 후 Accept/Review/Discard 결정 UI |
| Pending 큐 | 결정 보류된 캡처들 |
| Auto-accepted | Trusted 출처에서 자동 그래프 진입한 사실들 |
| Trusted/Careful | 출처별 정책 (Settings SET-2) |
| Identity protocol | "As far as I know..." 같은 응답 시작 표현 |
| Active Recall | 작성 중 dotted underline + 풍선 |
| Passive Recall | Ask Lucid 대화 |
| Gatekeeping | 가짜 정보 입구 경고 |
| Stellar View | 별자리 형태 그래프 시각화 |
| Entity color coding | Object class별 색 (12색, subtle 배경) |

---

*Be lucid.*
