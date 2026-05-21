# Lucid — Beta Backlog & Execution Plan

**Status:** Beta Locked
**Audience:** Claude Code / Codex (primary developer) + Founder (PO)
**Date:** 2026-05

---

## 0. 본 문서의 목적

CSVS 4단계 명세가 완성된 시점에서 **베타 8주 실행 계획**을 정의한다.
주개발자는 Claude Code/Codex이며, 본 문서는 sprint 단위 자율 실행이
가능한 수준으로 작성된다.

베타의 핵심 가설:
```
어떤 archetype의 사용자가 Lucid에 강하게 retain하는가?
```

이전 가정(학술 연구자 중심)은 무효화되었다. 베타는 wedge 검증이 아닌
**wedge 발견**이다. 데이터가 segment를 결정한다.

---

> ## v2 stack update (2026-05-21, chore/lucid-v2-doc-sweep)
>
> Beta now runs on Postgres + Elasticsearch (with the nori plugin
> for Korean). Neo4j and FAISS are retired (PO directive [변경 1]).
> The staleness system (`valid_until`, `is_stale`, Mode 5
> Staleness) is also retired (DR-053 / C-14). Where this document
> still references the v1 stack, the v2 stack is canonical; the
> sprint scope and test lists in this PR have been swept for the
> highest-traffic references but some incidental wording may
> remain.
>
> Surface modes are now five (0..4), not six. Sprint 6D drops the
> Staleness sub-mode and is renamed accordingly.

---

## 1. 베타 사용자 전략

### 1.1 모집 원칙

```
✅ Universal 공개 + 자기선택 screening
   누구나 신청 가능, 짧은 사용 의도 질문으로 self-select

✅ 30-40명, quality 우선
   50명을 채우려 무리하지 않음
   진성 사용자 30명이 70명 명단보다 가치 있음

✅ Job title 무관, archetype 기반 측정
   가입 시 직군 묻지만 segment 가정은 안 함
   사용 패턴이 archetype을 정의

❌ 가족·학술 네트워크 동원 금지
   베타에서 이 채널은 쓰지 않음
   Phase 1 expansion 자원으로 보존
```

### 1.2 측정할 Archetype 차원

가입 시 짧은 설문 + 사용 패턴 데이터로 다음 차원에서 분류.

```
차원 1. 정보 소비 강도
  · 가벼움 (주 5-10개 캡처)
  · 중간 (주 20-50개)
  · 무거움 (주 100+)

차원 2. 검증 빈도
  · 캡처 즉시 검증 위주 (careful 모드 선호)
  · 큐 누적 후 일괄 검증 (defer 선호)
  · trusted 모드 위주 (자동 수락 비중 높음)

차원 3. Surface 활용 패턴
  · Active Recall 주력 (작성 중 자동 등장)
  · Passive Recall 주력 (Ask Lucid 호출)
  · 둘 다 거의 안 씀 (저장만 함)

차원 4. 도메인 다양성
  · 단일 도메인 집중
  · 2-3 도메인 병행
  · 광범위 (5+ 도메인)

차원 5. 도구 환경
  · 데스크탑 위주
  · 모바일 위주
  · 혼합
```

### 1.3 Wedge 발견 지표

```
8주 후 분석:
  · 어떤 (직군 × 사용 패턴) 조합이 가장 높은 retention?
  · 어떤 조합이 가장 높은 NPS?
  · 어떤 조합이 가장 많이 referral?

이 3개 지표가 교차하는 archetype = Phase 1 wedge

Phase 1 expansion 채널 매핑:
  찾은 archetype에 맞춰 가족·학술·전문가 네트워크 투입
```

### 1.4 베타 게이트 (재확인)

```
필수:
  · 페이징 사용자 30명 이상 (50명 목표가 아닌 floor)
  · 12개월 retention 60%+ (특정 archetype에서)
  · NPS 40+ (해당 archetype에서)
  · 명확한 wedge archetype 식별

이 4가지 모두 달성 시 Phase 1 진입.
부분 달성 시 가설 재검토.
```

---

## 2. 작업 분해 — 7 Epic

CSVS 4단계 + 인프라 3개.

```
Epic 1.  Foundation               인프라 + 데이터 모델
Epic 2.  Capture                  베타 7개 진입점
Epic 3.  Structure                AtomicFact 분해
Epic 4.  Validate                 HITL UI
Epic 5.  Surface                  6 모드
Epic 6.  Stellar View             시각화
Epic 7.  Onboarding + Polish      사용자 진입 + 운영
```

---

## 3. P0 / P1 분류

P0 = 베타 launch 필수 — 없으면 가설 검증 불가
P1 = 베타 중 추가 — retention 영향, 핵심 기능 아님

```
Epic 1  Foundation
  P0: 프로젝트 셋업, 데이터 모델, Postgres + ES 스키마, 기본 API, 인증
  P1: 결정 로그 자동화, 모니터링 대시보드

Epic 2  Capture
  P0: Chrome Extension, PWA, Capture API, YouTube + Web 추출
  P1: PDF·이미지·오디오 추출, 신뢰 모드 출처 등록 UI

Epic 3  Structure
  P0: AtomicFact 분해 엔진, Object 추출+매칭, Link 추출, ES dense_vector kNN
  P1: 분해 품질 자동 점검

Epic 4  Validate
  P0: 오버레이, 큐 화면, Validate API, Auto-accepted 탭
  P1: 큐레이션 4기능, 시각 피드백 (별 애니메이션)

Epic 5  Surface
  P0: On/Off 토글, Active Recall, Passive Recall, Contradiction,
      Gatekeeping  (5 modes; Staleness retired DR-053 / C-14)
  P1: 응답 길이 정책 튜닝, 인용 포맷 정제

Epic 6  Stellar View
  P0: 4-level zoom (L0~L2), 3 facet (Class/Tag/Source), 모순 시각화
  P1: L3 zoom, Pin, 컨텍스트 메뉴, 키보드 단축키 전체, 클러스터 라벨

Epic 7  Onboarding + Polish
  P0: 첫 사용자 경험, 결제, 설정 화면
  P1: 알림 시스템, 텔레메트리
```

베타 launch = 전체 P0 완료. P1은 continuous deployment.

---

## 4. Sprint 단위 분해

각 sprint = 한 PR = 한 Claude Code 세션 범위.
의존성 기반 순서. 시간(주) 단위 아님.

### Sprint Map

```
Sprint 0    Foundation
   ↓
Sprint 1A   Data Models + Postgres + ES Schema  병렬
Sprint 1B   Auth + KnowledgeSpace API       병렬
   ↓
Sprint 2A   Chrome Extension Capture        병렬
Sprint 2B   PWA Share Target                병렬
Sprint 2C   Extractor Pipeline              병렬
   ↓
Sprint 3    Structure Engine                Sprint 2C 의존
   ↓
Sprint 4A   Validate UI                     병렬
Sprint 4B   Validate API                    병렬
   ↓
Sprint 5    Stellar View 기본
   ↓
Sprint 6A   Surface — On/Off + Active Recall    병렬
Sprint 6B   Surface — Passive Recall (Ask Lucid) 병렬
Sprint 6C   Surface — Contradiction               병렬
Sprint 6D   Surface — Gatekeeping                병렬 (Staleness retired)
   ↓
Sprint 7    Onboarding + 결제 + Polish
```

---

## 5. Sprint 명세 (정의 수준 C — 풍부)

각 sprint마다 5개 섹션:
1. 목표
2. 구현 범위 (P0/P1 명시)
3. 의존성
4. 완료 조건 (Definition of Done)
5. 테스트 케이스 + 데모 시나리오

---

### Sprint 0 — Foundation

**목표**
Lucid 프로젝트 기본 인프라 구축. 다른 모든 sprint의 토대.

**구현 범위 (v2 stack: Postgres + Elasticsearch + nori)**
```
P0:
  · FastAPI 프로젝트 구조 (AGENTS.md §3)
  · Postgres + Elasticsearch (nori) Docker Compose — PR-1A-1
  · Anthropic API 클라이언트 wrapper (Sprint 3 / 6B)
  · 환경 변수 관리 (pydantic-settings)
  · 로깅 (structured logging)
  · 기본 에러 핸들링

P1:
  · GitHub Actions CI 셋업 — PR-1A-1 added ruff + mypy
  · Sentry 에러 트래킹
```

**의존성**
없음.

**완료 조건**
```
✓ docker-compose up 으로 전체 환경 기동 (PR-1A-1 reality)
✓ /api/health 응답 정상 (postgres + elasticsearch both connected)
✓ Anthropic API 호출 테스트 통과 (Sprint 3)
✓ Postgres 연결 테스트 통과 (SELECT 1)
✓ Elasticsearch nori 한국어 분석 테스트 통과
✓ pytest 기본 셋업 + 3개 smoke test 통과 (PR-1A-1 reality)
```

**테스트 케이스 (v2; PR-1A-1 lands #1-3, Sprint 3 lands #4)**
```
test_health_endpoint
  GET /api/health → 200 + postgres+elasticsearch connected

test_postgres_select_one
  SELECT 1 against DATABASE_URL → returns 1

test_nori_analyzer_extracts_korean_tokens
  POST /_analyze nori "지식 그래프 검증" → {지식, 그래프, 검증}

test_anthropic_client  (Sprint 3)
  Claude API 호출 → 정상 응답 (mock 사용)
```

**데모 시나리오**
```
1. git clone + docker-compose up
2. curl localhost:8000/api/health → ok
3. pytest 실행 → all green
```

---

### Sprint 1A — Data Models + Postgres + ES Schema

**v2 update (2026-05-21):** Split into 3 PRs (1A-pr1 infra v2 swap,
1A-pr2 Pydantic + Postgres, 1A-pr3 ES indexes). PR-1A-1 and PR-1A-2
have landed; PR-1A-3 in progress. See CONFLICTS.md C-14, C-22 for the
v1->v2 migration trail.

**목표**
CSVS 명세서의 13개 Object class + Link 15종을 Pydantic + Postgres ORM + ES 인덱스로 구현 (v2 stack).

**구현 범위**
```
P0:
  · Pydantic 모델
    - AtomicFact, PendingFact, FactNode
    - 12개 Object Class (Concept, Entity 서브클래스 포함)
    - ValidationRecord, KnowledgeSpace, Source
  · Postgres 스키마 (5 tables) + ES 3 인덱스 매핑
    - 노드 라벨 + 인덱스
    - 제약 조건 (uniqueness, required properties)
  · SQLAlchemy 2.x ORM + ES CRUD 헬퍼
    - create_node, link_nodes, find_by_uid
```

**의존성**
Sprint 0 완료.

**완료 조건**
```
✓ 모든 Pydantic 모델 정의 + JSON serialization 테스트
✓ Alembic 4 마이그레이션 chain (0001..0004) up/down
✓ 노드 생성·조회·삭제 라이브러리 함수 존재
✓ Object Class 12개 모두 생성 가능 확인
```

**테스트 케이스**
```
test_create_atomic_fact
  AtomicFact(claim="...", subject="...", ...) 생성
  → Pydantic validation 통과

test_create_fact_in_es
  FactNode를 ES `lucid_facts` 인덱스에 저장 → uid로 조회 가능

test_link_fact_to_object
  Fact → ASSERTS_PROPERTY → Metric 링크 생성
  → 양방향 traversal 가능

test_pending_to_validated
  PendingFact 생성 → Accept → FactNode 승격
  validation_record 자동 생성 확인

test_object_class_coverage
  12개 클래스 모두 생성·조회 가능
```

**데모 시나리오**
```
1. PendingFact 1개 수동 생성
2. Accept 처리
3. FactNode + ValidationRecord 동시 존재 확인
4. ES `_cat/indices` + Postgres `\dt` 로 시각 확인
```

---

### Sprint 1B — Auth + KnowledgeSpace API

**목표**
사용자 인증과 KnowledgeSpace CRUD. 베타는 Personal Space만.

**구현 범위**
```
P0:
  · /api/auth/{register, login, logout}
  · JWT 토큰 발급·검증
  · 사용자 가입 시 Personal Space 자동 생성
  · /api/spaces/{sid} GET, PATCH
  · 사용자 settings (검증 모드, 신뢰 출처, On/Off 기본값)

P1:
  · 소셜 로그인 (Google)
  · 비밀번호 재설정
```

**의존성**
Sprint 1A.

**완료 조건**
```
✓ 회원가입 → 로그인 → JWT 발급 시퀀스 통과
✓ 가입 시 Personal Space 자동 생성 확인
✓ Settings CRUD 작동
✓ 모든 보호된 엔드포인트가 JWT 검증
```

**테스트 케이스**
```
test_register_creates_personal_space
  /register → User + KnowledgeSpace (type=personal) 동시 생성

test_login_returns_jwt
  /login → 토큰 발급 → 유효 기간 확인

test_protected_endpoint_requires_jwt
  /api/spaces/me GET (no token) → 401
  (with token) → 200

test_settings_persistence
  PATCH settings → 재조회 시 반영
```

**데모 시나리오**
```
1. 신규 가입
2. 로그인
3. Personal Space 자동 생성 확인
4. 검증 모드 변경 (Quick → Strict) → 저장 → 재조회
```

---

### Sprint 2A — Chrome Extension Capture

**목표**
브라우저 확장으로 페이지·하이라이트·YouTube 캡처.

**구현 범위**
```
P0:
  · Manifest V3 확장
  · 우클릭 컨텍스트 메뉴 "Save to Lucid"
  · 페이지 전체 캡처 (URL + 본문 추출)
  · 하이라이트 캡처 (선택 텍스트)
  · YouTube 페이지 감지 + 메타데이터 추출
  · 단축키 Cmd/Ctrl+Shift+L
  · 오버레이 UI (캡처 중 상태 + 결과 + 메모 입력)
  · 검증 모드 토글 (careful/trusted)

P1:
  · 페이지 내 이미지 우클릭 캡처
  · PDF (Chrome에서 열린) 캡처
```

**의존성**
Sprint 1B.

**완료 조건**
```
✓ Chrome Store dev 모드 설치 가능
✓ 우클릭 → 캡처 → API 전송 → 응답 표시 전체 흐름
✓ 하이라이트 캡처 시 선택 텍스트만 전송
✓ YouTube URL 감지 → source_type=youtube
✓ JWT 토큰 안전 저장 (Chrome storage)
```

**테스트 케이스**
```
test_extension_loads
  Manifest 로딩 + 백그라운드 스크립트 등록

test_page_capture_sends_to_api
  우클릭 → POST /api/spaces/{sid}/capture/url
  요청 본문에 URL + 메타 포함

test_highlight_capture
  텍스트 선택 → 우클릭 → selected_text만 전송

test_youtube_detection
  youtube.com URL → source_type=youtube 자동

test_overlay_states
  capturing → analyzing → done 상태 전환

test_jwt_storage
  로그인 → 토큰 저장 → 재시작 후에도 인증 유지
```

**데모 시나리오**
```
1. 임의 기사 페이지 방문
2. 본문 일부 드래그 선택
3. 우클릭 → Save to Lucid
4. 오버레이에 추출 결과 표시
5. 메모 입력 → 검증 큐 진입
```

---

### Sprint 2B — PWA Share Target

**목표**
모바일에서 공유 시트로 Lucid 캡처. iOS 우회용 URL 붙여넣기 포함.

**구현 범위**
```
P0:
  · PWA manifest (icons, share_target API)
  · Service Worker (오프라인 기본 대응)
  · "홈화면에 추가" 가이드 페이지
  · 공유 시트 수신 처리 → /capture API 전송
  · URL 직접 붙여넣기 화면 (iOS 우회용)
  · 모바일 친화 캡처 결과 화면

P1:
  · 푸시 알림 (큐 임계값 등)
```

**의존성**
Sprint 1B.

**완료 조건**
```
✓ Android Chrome에서 PWA 설치 가능
✓ iOS Safari에서 "홈화면에 추가" 가능
✓ Android 공유 시트에서 Lucid 노출
✓ 공유된 URL/텍스트가 API로 전송
✓ URL 붙여넣기 fallback 작동
```

**테스트 케이스**
```
test_pwa_manifest_valid
  manifest.json 유효성 검사 통과

test_share_target_receives
  공유 시트 → share_target endpoint → URL 수신

test_url_paste_fallback
  URL 입력 → Capture 버튼 → API 전송

test_offline_basic
  네트워크 없을 때 오프라인 안내 표시
```

**데모 시나리오**
```
1. Android Chrome에서 lucid.app 방문
2. 홈화면 추가
3. 인스타그램에서 릴스 공유 → Lucid 선택
4. 캡처 결과 화면 확인
5. iOS에서 URL 직접 붙여넣기 시연
```

---

### Sprint 2C — Extractor Pipeline

**목표**
URL·텍스트에서 콘텐츠 추출. YouTube + Web 필수, 나머지 P1.

**구현 범위**
```
P0:
  · /api/capture/url 엔드포인트
  · YouTube 추출
    - youtube-transcript-api 우선
    - 실패 시 yt-dlp + faster-whisper
  · Web 추출 (newspaper3k + readability)
  · 출처 메타데이터 추출 (title, author, published_at)
  · 실패 처리 (정직한 에러)

P1:
  · PDF 추출 (pdfplumber)
  · 이미지 추출 (Claude Vision)
  · 오디오 추출 (faster-whisper)
```

**의존성**
Sprint 1B.

**완료 조건**
```
✓ YouTube URL → merged_text 추출 성공
✓ 일반 웹 페이지 → 본문 + 메타데이터 추출
✓ 추출 실패 시 명확한 에러 응답
✓ 추출 결과를 PendingFact 큐로 임시 적재
  (다음 sprint의 Structure가 처리)
```

**테스트 케이스**
```
test_youtube_extraction_with_captions
  자막 있는 YouTube URL → 텍스트 반환

test_youtube_extraction_fallback_whisper
  자막 없는 URL → Whisper 변환 시도

test_web_article_extraction
  뉴스 기사 URL → 본문 + 제목 + 작성자

test_extraction_failure_handling
  404 URL → 명확한 에러 메시지

test_metadata_completeness
  추출된 출처에 source_url, captured_at 필수 존재
```

**데모 시나리오**
```
1. YouTube URL POST → 자막 추출 결과
2. WSJ 기사 URL POST → 본문 추출
3. 깨진 URL POST → 정직한 에러
4. 모든 출력에 메타데이터 첨부 확인
```

---

### Sprint 3 — Structure Engine

**목표**
merged_text → AtomicFact + Objects + Links 분해.

**구현 범위**
```
P0:
  · Claude API 분해 프롬프트 (12 Object Class)
  · 명제형 / 절차형 분해 로직
  · Object 추출 + class 부여
  · Object 매칭 (자동 통합 > 0.95)
  · 반자동 통합 큐 (0.85 ~ 0.95)
  · Link 추출 (Fact↔Object, Fact↔Fact)
  · ES dense_vector 인덱스 + 임베딩 (kNN; PR-1A-3)
  · 분해 실패 처리 (정직한 빈 결과)
  · 출처 메타데이터 사실별 분배
  · 시간 메타데이터 추출 (valid_from만; valid_until은 v2 retired)

P1:
  · 분해 품질 자동 모니터링
```

**의존성**
Sprint 1A + Sprint 2C.

**완료 조건**
```
✓ 텍스트 입력 → 다수의 PendingFact 생성
✓ Object 자동 매칭 동작 (기존 노드와 통합)
✓ Link 자동 추출
✓ 분해 불가 텍스트 → 빈 결과 + 이유 명시
✓ 임베딩 인덱스에 모든 사실 등록
```

**테스트 케이스**
```
test_proposition_decomposition
  "ChatGPT 2024 평균 월사용자 2.2M" →
  AtomicFact + Service(ChatGPT) + Metric(monthly_users=2.2M)

test_procedure_decomposition
  "주방세제와 식초 1:1로 커피 얼룩 제거" →
  AtomicFact + Procedure + Resource×2 + Problem

test_multi_sentence_with_relations
  Kahneman 인용 3문장 →
  3 AtomicFact + SUPPORTS/INTERPRETS Link

test_object_auto_merge
  "OpenAI" 이미 그래프에 존재 + 새 캡처 "Open AI" →
  자동 통합, source_count++

test_decomposition_failure
  광고성 텍스트 → 빈 결과 + failure_reason

test_time_metadata_extraction
  "EU AI Act 2024년 8월 발효" →
  valid_from="2024-08-01"
```

**데모 시나리오**
```
1. Kahneman 강의 텍스트 입력
2. 3개 AtomicFact + 다수 Object 생성 확인
3. ES `_cat/indices` + Stellar View에서 그래프 시각 확인
4. 같은 강의 다른 영상 재캡처 → Object 자동 통합 확인
```

---

### Sprint 4A — Validate UI

**목표**
PendingFact 검증 화면. 오버레이 (즉시) + 큐 (지연).

**구현 범위**
```
P0:
  · 오버레이 검증 (캡처 직후, 페이지 우측 하단)
  · 큐 검증 화면 (Lucid 앱 내, 출처별 그룹)
  · Accept / Edit / Reject 버튼
  · Personal note 입력
  · 압축/확장 카드 (Show more)
  · Edit 시 alias 보존
  · 진행도 표시 (X/Y)
  · 세션 중단·재개

P1:
  · 큐레이션 4기능
  · 별 떠오르는 애니메이션
  · 인사이트 토스트
```

**의존성**
Sprint 3.

**완료 조건**
```
✓ 오버레이에서 카드 표시 + 3개 행동 처리
✓ 큐 화면에서 출처별 그룹 표시
✓ Edit 시 원본 alias로 보존
✓ Reject 시 PendingFact 삭제
✓ Accept 시 FactNode + ValidationRecord 생성
✓ 모바일 큐 화면 작동
```

**테스트 케이스**
```
test_overlay_renders_pending_facts
  3개 PendingFact 입력 → 3 카드 표시

test_accept_flow
  Accept → PendingFact 삭제 + FactNode 생성

test_edit_preserves_alias
  Edit "EU AI Act 2024년 8월" → "EU AI Act 2024년 8월 1일"
  → aliases 배열에 원본 보존

test_reject_flow
  Reject → PendingFact 삭제, FactNode 미생성

test_queue_grouping
  3개 캡처 × 5개 사실 → 3개 그룹 (각 5장 카드)

test_progress_persistence
  큐 진행 중 페이지 닫기 → 재접속 시 이어서 가능
```

**데모 시나리오**
```
1. 캡처 → 오버레이에 5장 카드
2. 첫 카드 Show more 클릭 → 출처 메타데이터 표시
3. 3장 Accept, 1장 Edit, 1장 Reject
4. Stellar View에서 4개 별 그래프 진입 확인
```

---

### Sprint 4B — Validate API

**목표**
검증 행위의 백엔드. UI와 병렬 개발.

**구현 범위**
```
P0:
  · GET /api/spaces/{sid}/validate/queue
  · GET /api/spaces/{sid}/validate/queue/{group_id}
  · POST /api/spaces/{sid}/validate/decide
    - {fact_uid, action, edited_claim?, personal_note?}
  · GET /api/spaces/{sid}/auto-accepted
  · POST /api/spaces/{sid}/curation/{op}
    - reclassify_object, demote_fact, drop_fact, tag (P1)

P1:
  · 일괄 처리 API (Phase 1)
```

**의존성**
Sprint 1B + Sprint 3.

**완료 조건**
```
✓ 큐 조회 API → 출처별 그룹 응답
✓ Decide API → 3개 행동 모두 처리
✓ Auto-accepted 별도 조회 가능
✓ JWT로 본인 Space만 접근
```

**테스트 케이스**
```
test_queue_list_by_groups
  여러 캡처의 PendingFact → 그룹별 묶여 반환

test_decide_accept
  POST decide accept → FactNode 생성 응답

test_decide_edit_with_alias
  POST decide edit → 원본 alias 보존 응답

test_auto_accepted_separate_endpoint
  trusted 모드 사실은 main queue에 없음, auto-accepted에 있음

test_cross_space_access_denied
  다른 사용자 Space 접근 시도 → 403
```

**데모 시나리오**
```
1. 큐에 PendingFact 10개 적재
2. API로 5개 Accept, 3개 Edit, 2개 Reject
3. ES `lucid_facts` 에서 5+3 = 8개 FactNode 확인
4. Auto-accepted 탭 별도 조회
```

---

### Sprint 5 — Stellar View 기본 (v2: 4-level zoom + faceted search)

**목표**
검증된 그래프 시각화. D3 force simulation 위에 4-level zoom과
faceted search를 얹는다. wireframes/pack5 (SV-1~SV-4)가 진실의 원천.

**작업 추정:** ~10 days (이전 7일 + 4-level zoom + facet 작업 +3일)

**구현 범위 (P0/P1/P2 — PO 지시 2026-05-21)**
```
P0 (베타 launch 필수):
  · D3 force simulation 기본 렌더링
  · 별 속성 표현:
    - 크기: 연결 수
    - 색상: Object class (13 색, MASTER_HANDOFF §11 디자인 시스템)
    - 밝기: 검증 레벨 (L1 흐림 → L4 밝음)
  · 호버 시 사실 미리보기
  · Elastic 필터링 (8% 불투명도 후퇴)
  · 모순 시각화 (붉은 긴장선, 0.5Hz pulse)
  · 줌 L0 — Galaxy overview (SV-1: 전체 우주)
  · 줌 L1 — Constellation (SV-2: 필터된 별자리)
  · 줌 L2 — Star System (SV-4: 한 별 + 1-hop 이웃 + 사이드패널)
  · Faceted search 3종:
    - Class facet (13 Object class 다중 선택)
    - Tag facet (사용자 태그 다중 선택)
    - Source facet (소스 도메인 다중 선택)
  · 검색창 (claim full-text + facet 조합)

P1 (continuous deployment):
  · 줌 L3 — Atom view (단일 사실 + 모든 관계)
  · Pin 기능 (별 고정)
  · 컨텍스트 메뉴 (별 우클릭 → 액션)
  · 키보드 단축키 전체 (Cmd+F 검색, J/K 이동 등)
  · 클러스터 라벨 자동

P2 (Phase 1+):
  · 시간 facet (valid_from 기반 슬라이드, valid_until은 retired)
  · 군집 자동 감지 (Louvain 또는 유사 알고리즘)
```

**의존성**
Sprint 4A · 4B.

**완료 조건**
```
✓ ES `lucid_facts` + `lucid_objects` → D3 렌더
✓ 별 호버 시 사실 카드 팝업
✓ 도메인 필터 → 후퇴 애니메이션
✓ 모순 관계 자동 시각 표시
✓ 줌 L0/L1/L2 전환 동작 (SV-1/SV-2/SV-4)
✓ 3 facet 선택 + 검색 동작
✓ 100+ 노드에서 부드러운 렌더 (FPS 30+)
✓ pack5 와이어프레임과 시각 일치
```

**테스트 케이스**
```
test_graph_data_endpoint
  GET /api/spaces/{sid}/graph → nodes + edges JSON

test_force_simulation_renders
  D3 시뮬레이션 시작 → 안정 상태 수렴

test_filter_animation
  도메인 필터 → 8% opacity 후퇴 확인

test_contradiction_visual
  CONTRADICTS 엣지 → 붉은 점선 표시

test_zoom_level_transitions
  L0 → L1 → L2 → L1 → L0 round-trip

test_facet_search_combination
  Class=Knowledge + Tag=AI + Source=wsj.com → 정확한 부분집합

test_text_search_in_facts
  검색어 → claim full-text 매치 + facet 결합

test_performance_100_nodes
  100 노드 + 200 엣지 → 30 FPS 이상
```

**데모 시나리오**
```
1. 50개 FactNode가 있는 Space 열기 (L0 Galaxy view)
2. 별자리 자동 형성 확인 + Constellation 라벨
3. "Knowledge" Class facet → 다른 별 후퇴 (L1)
4. 한 별 더블클릭 → Star System (L2 + 사이드패널)
5. 모순 사실 한 쌍 → 붉은 선 + pulse
6. 검색창에 "AI Act" → 매칭 별 강조
```

**참조 와이어프레임:** `frontend/stellar-graph/pack5-stellar-settings.html`
SV-1 (L0 Galaxy), SV-2 (L1 Filtered), SV-3 (L2 Contradiction viz),
SV-4 (L2 Star System View — 1-hop 이웃 + 사이드패널)

---

### Sprint 6A — Surface: On/Off + Active Recall

**목표**
사용자 제어 토글 + 작성 중 사실 자동 등장.

**구현 범위**
```
P0:
  · On/Off 토글 (확장 아이콘 + 모바일 상단)
  · OFF 시 동작 명세 (Surface 명세 §4)
  · Active Recall 디바운스 검색 (300-500ms)
  · 점선 밑줄 + 호버 풍선
  · 상위 3개 사실 표시
  · "See all" 별도 화면
  · 단축키 Cmd/Ctrl+L
  · Lucid 자체 에디터 + Chrome 확장 작동

P1:
  · 응답 속도 최적화 (캐싱)
```

**의존성**
Sprint 5.

**완료 조건**
```
✓ 토글 클릭 → 즉시 모든 Surface 기능 ON/OFF
✓ 작성 중 키워드 점선 밑줄
✓ 호버 → 3개 사실 풍선
✓ Gmail·Google Docs에서 작동 확인
✓ 응답 시간 P95 < 500ms
```

**테스트 케이스**
```
test_toggle_off_disables_underline
  OFF → 점선 밑줄 미표시

test_toggle_off_capture_still_works
  OFF에서도 우클릭 캡처 작동

test_active_recall_debounce
  500ms 입력 없을 때만 검색 트리거

test_top_3_facts_in_tooltip
  매칭 10개 발견 → 상위 3개만 풍선에

test_see_all_opens_panel
  See all 클릭 → 별도 화면 전체 목록

test_works_in_gmail
  Gmail 작성창에서 keyword 감지 + 풍선 표시
```

**데모 시나리오**
```
1. Gmail 작성창에서 "EU AI Act" 타이핑
2. 점선 밑줄 → 호버 → 3개 사실 표시
3. "Insert citation" → 본문에 인용 삽입
4. 확장 아이콘 클릭 → OFF
5. 같은 키워드 → 밑줄 미표시
```

---

### Sprint 6B — Surface: Passive Recall (Ask Lucid)

**목표**
대화형 QnA. 베타 킬러 기능.

**구현 범위**
```
P0:
  · 단축키 Cmd/Ctrl+Shift+L (또는 확장 popup)
  · 대화 UI (질문 입력 + 응답 표시)
  · 정체성 표현 강제
    - "As far as I know..."
    - "According to your knowledge graph..."
    - "기흥님 그래프 기준으로..."
  · fn-ID 인용 강제
  · 검증 사실 없을 시 정직한 자백
  · 새 주장 처리 (일치/보강/모순/무관계 4 패턴)
  · "Insert at cursor", "Copy" 옵션

P1:
  · 음성 입력 (Phase 1)
  · 대화 이력 보존
```

**의존성**
Sprint 5.

**완료 조건**
```
✓ Ask Lucid 호출 → 대화창 표시
✓ 모든 응답이 정체성 표현으로 시작
✓ 응답 내 모든 주장에 fn-ID 인용
✓ 검증 사실 없을 시 "I don't have validated facts..." 응답
✓ LLM 일반 지식 사용 0건 (테스트로 검증)
```

**테스트 케이스**
```
test_identity_phrase_always_present
  100개 임의 질의 → 모두 정체성 표현으로 시작

test_citation_required
  응답 파싱 → 모든 사실 주장에 fn-ID

test_no_facts_honest_admission
  검증 사실 없는 주제 질의 →
  "I don't have validated facts" 응답

test_contradicting_new_claim
  그래프 사실과 충돌하는 새 주장 →
  "검증된 사실과 충돌합니다" + 인용

test_no_llm_general_knowledge
  잘 알려진 일반 지식 질의
  (예: "프랑스 수도는?") →
  Lucid는 답하지 않음 ("not in your graph")

test_response_brevity_mobile
  모바일 호출 시 응답 2-3문장 + 사실 3개 이내
```

**데모 시나리오**
```
1. "다이어트에 대해 내가 검증한 사실은?" → 8개 사실 브리핑
2. "공복 유산소가 살 빠지는 데 최고지?" → 그래프 사실로 반박
3. "비트코인 ETF 영향은?" → 정직한 모름 + 캡처 제안
4. Insert at cursor → 작성 중 문서에 인용 삽입
```

---

### Sprint 6C — Surface: Contradiction Detection

**목표**
모순 자동 감지 + 사용자 해소 UI.

**구현 범위**
```
P0:
  · Validate 직후 즉시 검사 (동기)
  · 백그라운드 매일 잡 (전체 그래프)
  · 3 패턴 판단 로직 (명백/의심/맥락차이)
  · 큐 누적 (메인 화면 배지)
  · Stellar View 시각 표시 (붉은 긴장선)
  · 4 해소 옵션 UI
    - Drop one
    - Demote one
    - Keep both + context note
    - Ignore

P1:
  · 모순 패턴 분석 통계
```

**의존성**
Sprint 5.

**완료 조건**
```
✓ Accept 직후 모순 검사 동작
✓ 매일 잡 스케줄러 작동
✓ 큐 배지 카운트 정확
✓ Stellar View 붉은 선 표시
✓ 4 해소 옵션 모두 작동
```

**테스트 케이스**
```
test_obvious_contradiction_detected
  "ChatGPT 1억 monthly" + "ChatGPT 2억 monthly" (같은 시점)
  → CONTRADICTS 자동 생성

test_context_difference_not_flagged
  "ChatGPT 1억 (2023)" + "ChatGPT 2억 (2024)" → 모순 아님

test_suspected_contradiction_asks_user
  의미적 반대 predicate → "확인하시겠습니까?" prompt

test_resolve_drop_one
  Drop → 한 사실만 제거, 다른 사실 유지

test_resolve_keep_both_with_note
  Keep both → 두 사실 유지 + context_note 저장
```

**데모 시나리오**
```
1. ChatGPT 사용자 수 충돌하는 3개 사실 적재
2. 메인 화면 배지 "⚠ 1 contradiction"
3. Stellar View에서 붉은 긴장선 확인
4. 해소 화면 → Keep both + 시점 차이 메모
5. 모순 플래그 해소 확인
```

---

### Sprint 6D — Surface: Gatekeeping + Staleness

**목표**
가짜 정보 입구 차단 + 시간 만료 알림.

**구현 범위**
```
P0:
  Gatekeeping:
    · 캡처 시점 3 조건 검사
    · 경고 다이얼로그
    · "그래도 저장" 옵션
    · override_warning 메타데이터

  Staleness:
    · 매일 자정 스캔
    · 동적 트리거 (Surface 시점)
    # is_stale 마크 — RETRACTED (DR-053 / C-14): 표시 안 함
    · 라벨과 함께 노출
    · 재검토 / Drop / Keep as historical 옵션
    · 30일 전 / 도래 / 90일 후 알림

P1:
  · 시점별 알림 강도 튜닝
```

**의존성**
Sprint 6C (모순 시스템 재활용).

**완료 조건**
```
✓ 광우병 예시 시나리오 차단 작동
✓ 정상 사실 진화는 차단 안 함 (ChatGPT 수치 변화)
✓ "그래도 저장" 시 메타데이터 보존
✓ Stale 사실 라벨 표시
✓ 재검토 액션 → PendingFact 큐 복귀
```

**테스트 케이스**
```
test_gatekeeping_3_conditions_blocks
  광우병 시나리오 → 경고 발동

test_normal_evolution_not_blocked
  ChatGPT 수치 진화 → 경고 없음

test_override_metadata
  "그래도 저장" → override_warning=true

test_staleness_daily_scan
  # valid_until 트리거 — RETRACTED (DR-053 / C-14): 만료 없음

test_dynamic_trigger
  Active Recall이 stale 사실 surface →
  즉시 stale 라벨 표시

test_re_validation_flow
  Stale 사실 → 재검토 → PendingFact 큐 복귀
```

**데모 시나리오**
```
1. 광우병 주장 캡처 시도 → 경고
2. "그래도 저장" → 노란 테두리로 그래프 진입
3. 금리 3.5% (2025-03 만료) 사실 자동 stale
4. "기준금리" 검색 → stale 라벨 함께 표시
5. 재검토 → 새 출처로 PendingFact 복귀
```

---

### Sprint 7 — Onboarding + 결제 + Polish

**목표**
첫 사용자 경험 + 운영.

**구현 범위**
```
P0:
  · 가입 → 첫 캡처 안내 튜토리얼
  · 샘플 그래프 옵션 (선택)
  · "5개 캡처 검증해보기" 가이드
  · Settings 화면
    - 검증 모드 (Quick/Strict/Hybrid)
    - 신뢰 출처 등록
    - Lucid On/Off 기본값
  · Stripe 결제 (Free / Pro $19)
  · 베타 사용자 코드 발급
  · 가입 시 archetype 설문 (5 차원)
  · 기본 알림 시스템

P1:
  · 텔레메트리 대시보드
  · 사용자 활동 분석
```

**의존성**
모든 이전 sprint.

**완료 조건**
```
✓ 신규 가입자 5분 안에 첫 캡처 → 검증 → Surface 경험
✓ 베타 코드로 무료 Pro 활성화
✓ 설문 데이터 archetype 차원으로 저장
✓ Stripe 테스트 결제 통과
```

**테스트 케이스**
```
test_onboarding_completion
  가입 → 튜토리얼 5단계 완료 → 첫 캡처

test_beta_code_activates_pro
  베타 코드 입력 → Free → Pro 전환

test_archetype_survey_persistence
  가입 설문 5문항 → archetype 차원으로 저장

test_settings_update
  Quick → Strict 변경 → 캡처 흐름에 반영

test_stripe_test_payment
  test card → Pro 결제 성공
```

**데모 시나리오**
```
1. 신규 가입
2. 5단계 튜토리얼
3. 샘플 그래프 옵션 → "예" 선택
4. 첫 캡처 안내 → 임의 기사 캡처
5. 검증 → Surface 시연
6. 베타 코드 입력 → Pro 활성화
```

---

## 6. 의존성 그래프

```
Sprint 0  Foundation
   │
   ├─→ Sprint 1A  Models + PG+ES     ←─┐
   ├─→ Sprint 1B  Auth + Space         │
   │                                    │
   ├─→ Sprint 2A  Chrome Extension     │
   ├─→ Sprint 2B  PWA                  │
   └─→ Sprint 2C  Extractors           │
                       │                │
                       └─→ Sprint 3 Structure ←─┘
                                  │
                       ┌──────────┤
                       ↓          ↓
                  Sprint 4A    Sprint 4B
                  Validate UI  Validate API
                       │          │
                       └────┬─────┘
                            ↓
                       Sprint 5 Stellar View
                            │
              ┌─────┬───────┼───────┬─────┐
              ↓     ↓       ↓       ↓     ↓
           6A    6B      6C      6D
        On/Off  Ask    Contra. Gate+Stale
              └─────┴───────┼───────┴─────┘
                            ↓
                       Sprint 7 Onboarding
```

병렬 가능 sprint:
- 1A + 1B
- 2A + 2B + 2C (셋 다)
- 4A + 4B
- 6A + 6B + 6C + 6D (넷 다)

---

## 7. 성공 지표 매핑

각 sprint가 어떤 베타 게이트 지표에 기여하는지.

```
페이징 사용자 30+:
  → Sprint 7 (가입·결제·온보딩)

12개월 retention 60%+:
  → Sprint 4 (Validate UX 마찰)
  → Sprint 6A·6B (Surface 가치 전달)
  → Sprint 5 (Stellar View 감성)

NPS 40+:
  → Sprint 6B (Passive Recall — 킬러 기능)
  → Sprint 6C·6D (모순·가짜 차단의 신뢰감)

Wedge archetype 식별:
  → Sprint 7 (가입 설문 + 텔레메트리)
  → 전체 sprint (사용 패턴 데이터)
```

---

## 8. 베타 마케팅 토픽 (참고)

베타 사용자 모집 시 강조할 메시지. 사업 전략 문서가 확정되면 갱신.

```
현재 강한 카드:
  "An AI that knows what it knows."
  "Your firewall for what's true."

베타에서 검증할 메시지:
  · 어떤 메시지가 가입 전환율 높은가
  · 어떤 메시지가 retention과 정합인가

이 데이터가 Phase 1 마케팅 전략을 결정.
```

---

## 9. 베타 후 회고 항목

8주 종료 시 검토할 것.

```
1. Archetype 발견
   · 어떤 (직군 × 사용 패턴)이 강한 retention?
   · 어떤 조합이 NPS 40+?
   · 어떤 조합이 referral 발생?

2. 기능 사용도
   · 6 Surface 모드 중 가장 많이 쓰인 것?
   · 가장 안 쓰인 것?
   · 큐레이션 기능은 실제로 쓰이나?

3. CSVS 마찰 지점
   · 어느 단계에서 사용자가 멈추는가?
   · 검증 평균 시간은 30초 안에 들어오는가?

4. 가짜 정보 차단 작동
   · Gatekeeping 발동 빈도
   · "그래도 저장" 비율

5. Phase 1 expansion 전략
   · 발견된 wedge → 가족·학술 채널 매핑
   · 가격 정책 재검토
```

---

## 10. 미해결 사항 (Phase 1 결정)

```
Q1. 베타 결과로 발견될 wedge가 예상과 다르면?
    → Phase 1 전략 전면 재검토
    
Q2. 30명 미만이면?
    → 가설 검증 실패. 캡처 단계 마찰 재검토

Q3. NPS 40+ 못 넘으면?
    → 핵심 가치 가설 재검토
    → Surface 모드 우선순위 재정렬
```

---

*Lucid Beta Backlog v1.0 | Sprint-based, Codex-friendly | Be lucid.*
