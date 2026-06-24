# Lucid — Master Roadmap & Product Spec (v3.0)

> **문서 목적:** Lucid 의 단일 진실 원천(single source of truth). 마일스톤(알파→베타→런칭) 전체 로드맵 +
> 화면별 코드네임/구성/연결 + 기능 명세서. Agent 는 이 문서를 기준으로 구현하고 PO 가 관리한다.
> **상태 규약:** ✅ 완료(라이브 검증) · 🟢 구현됨(검증 미확인) · 🟡 진행중 · 📋 계획 · ⬜ 미착수
> **버전 규약:** 0.MINOR = dogfood 라운드. 태그 = PO dogfood 졸업장. 알파 직전 0.9.x → 공개 1.0.0.

---

## PART I. 제품 정의 (PRD)

### 1.1 한 줄 정의
**인간이 검증한 사실만 저장하는 개인 지식그래프.** AI 는 구조화·소환을 돕고, 진실의 판정은 인간이 한다.

### 1.2 철학 (불변 원칙 — 모든 결정의 상위 규범)
| # | 원칙 | 구현 함의 |
|---|---|---|
| P1 | **知之爲知之** — 아는 것과 모르는 것의 경계 | 검증 안 된 건 답하지 않음. 검색도 틀린 답보다 침묵. |
| P2 | **판정은 AI 에 넘기지 않는다** | AI=구조화/소환 보조. 참/거짓은 인간. (vs InTruth) |
| P3 | **Provenance 무결성** | 모든 fact 는 출처 추적. 요약경유(lilys 등) 금지 = one-hop. |
| P4 | **소유(Own) > 앎(Know)** | 검증 지식은 사용자 자산. |
| P5 | **명료함(明了) > 전지성** | 적게, 정확히. 다다익선 거부. |

### 1.3 핵심 차별점 (경쟁 우위)
- 영속적 지식그래프(vs 휘발성 AI 답변) · 인간검증 신뢰 · 교차주장/시계열 모순감지 · 다국어 · entity 메타네트워크.
- 약점(의도적 범위 밖): 답변 범위·실시간성·생태계 — 거점(정책·정치·언론) 집중으로 상쇄.

### 1.4 타깃 / 거점
- 1차 사용자: 정책·거버넌스·정보 분석가(알파 3~5명).
- 거점 도메인: 정치·정책·언론. 1차 소스 = 청문회·기자회견·인터뷰 **영상** + 보도.

---

## PART II. 시스템 아키텍처

### 2.1 CSVS 파이프라인
```
Capture ──→ Structure ──→ Validate ──→ Surface
 (수집)      (구조화)       (검증)        (소환)
 확장/이미지   LLM 3종분해    Decide 큐     Recall/어시스턴트/Stellar
 /영상STT     +entity분류    인간 accept    검증된 것만 노출
```

### 2.2 데이터 모델 (v0.2.0 — Fact 3종 + Entity 메타네트워크)
```
[Atomic Fact 3종]
 ├─ 행위(Action)      : S-P-O + 시점·장소        "그 일이 일어났나"
 ├─ 말(Claim)         : speaker+speech_act+content+stance   "그가 그렇게 말했나"(one-hop)
 └─ 수치(Measurement) : metric+value+unit+as_of   시점에 매인 값 → 시계열
[횡단] negation(부정 극성, 데이터로) · fact_type 분류는 LLM=classifier
[상위] Entity(타입+속성) → Meta-Network(social/knowledge/assignment… CASOS/DNA)
[탐지] Contradiction = fact간 충돌(극성/값/양립불가/출처상충) — negation 은 그 한 원천
```
> 상세: `Lucid_FactModel_DataArchitecture_v1.md`

### 2.3 기술 스택
- Backend: FastAPI · Postgres · Elasticsearch · Claude API · OpenAI embeddings · Whisper large-v3(STT)
- Frontend: Next.js 15 · Chrome Extension
- Infra: Docker Desktop · GitHub `kihpark/PROJECT_LUCID`
- Repo 규약: agent worktree 격리 · ship-race 직렬화 · 단일 task dispatch

---

## PART III. 화면 명세 (코드네임 · 구성 · 연결 · 기능)

### 3.1 화면 맵 & 코드네임
| 코드네임 | 경로 | 한글명 | 역할 | 상태 |
|---|---|---|---|---|
| **GATE** | `/login` `/register` | 인증 | 가입·로그인·welcome | 🟢 |
| **BEACON** | `/beta` | 랜딩 | 베타 신청 유입 | 🟢 |
| **HEARTH** | `/home` | 홈 | 브리핑·진입 허브 | 🟢 |
| **HARVEST** | extension | 캡처 | 웹/이미지/영상 수집 | 🟢 |
| **DECIDE** | `/pending` `/pending/[id]` | 검증 | Decide 큐·accept | 🟢 |
| **RECALL** | `/recall` | 소환 | entity 탐색·검색 | 🟡 |
| **ORACLE** | `/assistant` | 어시스턴트 | 검증기반 Q&A | 🟢 |
| **STELLAR** | `/stellar` | 그래프 | 3D 메타네트워크 | 🟡 |
| **CONSOLE** | `/admin` | 관리 | 신청 승인·운영 | 🟢 |
| **ATELIER** | `/settings` | 설정 | per-source·BYOK | 📋 |
| **LENS** | 오버레이(앱내/확장) | 능동 소환 | 읽는 중 entity 맥락 표출 | 📋 |

### 3.2 화면 연결도 (네비게이션)
```
BEACON ──신청──→ CONSOLE(승인) ──→ GATE ──→ HEARTH
                                              │
        ┌─────────────┬───────────────┬───────┴────────┬──────────────┐
        ▼             ▼               ▼                ▼              ▼
     HARVEST       DECIDE          RECALL           ORACLE        STELLAR
     (캡처)     (검증 큐)        (소환·탐색)      (Q&A)        (그래프)
        │             │               │                              │
        └─job tracker─┘               └──entity 클릭 상호이동─────────┘
   ★ 현재 단절: 5개 화면이 섬. 목표: entity 클릭 어디서든 ↔ 상호 이동(0.2.x).
```

### 3.3 화면별 기능 명세

#### GATE (인증) 🟢
- 기능: register/login, welcome gate, is_admin 분기.
- 연결: BEACON 승인 → GATE → HEARTH.
- 미검증: 신청→승인→가입 end-to-end 라이브.

#### BEACON (랜딩) 🟢
- 기능: v8.2 랜딩, 베타 신청 폼, 보상 카피("Phase 1 출시 시 평생 무료"), demo(ChatGPT vs Lucid).
- 데이터: 폼 → applications 테이블.
- 미검증: 폼 제출 → DB 적재 → CONSOLE 노출 end-to-end.

#### HEARTH (홈) 🟢
- 기능: 시간 인사 브리핑, 검증 카운트, 오늘의 브리핑(검증 대기·이번주 검증·활발 클러스터), 하단 카운터(검증사실/엔티티/출처).
- 연결: 모든 화면 진입 허브. "지금 검증" → DECIDE.
- 부채: greeting hydration(backlog).

#### HARVEST (캡처) 🟢
- 기능: Chrome 확장 — 페이지 캡처 / selection-save / 이미지(B-45 Haiku) / 영상 STT(B-46 PR1).
- 비동기: 캡처 → 분석(toast) → DECIDE 큐 등록.
- 부채: selection-save 백스톱(JS 사이트 미작동) · job tracker(FAB 상주 목록) 미구현.

#### DECIDE (검증) 🟢
- 기능: Decide 큐, 카드(제목·날짜·S/P/O), accept/edit/discard, 자동완성 칩, Submit, 자동수락 탭.
- 정책: status='structured' AND fact_count>0(ONE TRUE FILTER), validation_logs 영구.
- 부채: triage×entity 청킹(조직화) 미구현 — 평면 dump 상태.

#### RECALL (소환) 🟡 ← **재설계 대상**
- 현재: 3패널(좌 검색컨트롤 / 중앙 결과+요약 / 우 entity facet), fact_type 칩 분해.
- 재설계(0.2.x): 요약박스 통합 + AI 브리핑(entity 개관, ORACLE 와 구분) + 칩=필터 + 좌패널 슬림화(서버검색만).
- 부채: kNN embedding(가드는 ship, 분류 죽어 칩 무의미).

#### ORACLE (어시스턴트) 🟢
- 기능: 검증 지식 기반 Q&A, grounding guard(검증/AI추론 블록 분리, M4a).
- 구분: RECALL 브리핑=entity 개관 / ORACLE=질문 응답.

#### STELLAR (그래프) 🟡
- 기능: 3D 메타네트워크(B-62), 노드=entity, 엣지=관계, focus·zoom.
- 부채: zoom 회귀(state 갱신되나 카메라 미이동) · UUID 라벨 누락 가드.

#### CONSOLE (관리) 🟢
- 기능: `/api/admin/applications` 승인, is_admin.

#### ATELIER (설정) 📋
- 기능: per-source 정책, BYOK(API 키), FAB 토글, 알림 설정.

#### LENS (능동 소환 — Active Recall) 📋 ★ 플래그십
> 과거 명세 Surface Mode 1. 영어사전 앱 패턴(단어 오버 → 뜻 팝업)의 검증지식 버전.
- **핵심:** 사용자가 콘텐츠를 **읽다가** 자기가 검증한 entity 가 나오면, Lucid 가 **먼저 다가와**(push)
  검증된 맥락을 풍선으로 표출. (RECALL/ORACLE/STELLAR=pull, LENS=push — 검증 ROI 가 실현되는 곳.)
- **표출:** entity 에 점선 밑줄(옵션) + 마우스 오버 → 풍선("한국은행 · 검증 8건: 외국인 자금 모니터링 강화 강조…").
- **범위:** Phase A=Lucid 앱 내부 텍스트 / Phase B=모든 웹페이지(확장 주입, 권한·침입성 가드).
- **트리거 정책:** 자동 하이라이트는 침입적 → 오버 시 풍선 or 사용자 토글 모드.
- **grounding:** 풍선은 **검증된 fact 만**(P1·P2). AI 생성 금지.
- **의존:** canonical entity 레이어(M3) 선행 — 읽는 텍스트의 "한국은행"↔내 그래프 entity 정확 매칭.
- **연결:** 풍선 → RECALL(그 entity) / STELLAR(그 노드) 딥링크 → 5섬 연결의 진입점.

---

## PART IV. 마일스톤 로드맵 (알파 → 베타 → 런칭)

### 로드맵 개요 (버전 게이트)
```
v0.2.0 ──→ v0.3.0 ──→ v0.4.0 ──→ ... ──→ v0.9.x ──→ 1.0.0
데이터모델   entity중심   영상클레임        알파freeze   공개런칭
+검증루프    +메타넷       +캡처확장
   ▲ 지금 여기 직전(gate 2 막힘)
각 태그 = PO dogfood 졸업장. 내부 M0 = PO 1회 완전 CSVS 루프 자가검증.
```

---

### 🎯 M1 — v0.2.0: 데이터 모델 + 검증 루프 (지금)
**목표:** Fact 3종이 라이브에서 실제 분류되고, 검증 루프가 끝까지 돈다.
**졸업 조건:** 아래 gate 전부 PO dogfood 통과 → v0.2.0 태그 + CHANGELOG.

| Gate | 작업 | 코드네임 | 상태 |
|---|---|---|---|
| G1 | classification 복구(LLM fact_type 출력) | prompts-classification-recovery | 📋 ★임계 |
| G2 | stellar zoom 회귀(카메라 미이동) | stellar-zoom-regression | 📋 |
| G3 | kNN embedding 복구+fallback 가드 | search-embedding-restore | 🟢 |
| G4 | measurement completeness(surface 보존) | measurement-completeness | 🟢 |
| G5 | dogfood 한 판(분류/필터/모순메커니즘/검색/줌) | — | 📋 PO |

> **선행 의존:** G1(분류)이 모든 것의 루트. 분류 죽으면 G4·RECALL 칩·요약 전부 무의미.

---

### 🎯 M2 — v0.2.x: 검증 UX + 정보구조 + 안정화
**목표:** dogfood 마찰 제거, 정보 조직화, 부채 청산.

| 작업 | 코드네임 | 화면 | 상태 |
|---|---|---|---|
| RECALL 재설계(요약통합+AI브리핑+칩필터+좌패널슬림) | recall-redesign | RECALL | 📋 |
| 캡처 작업추적(FAB 목록+배지, push/pull 분리) | capture-job-tracker | HARVEST | 📋 |
| Decide 조직화(triage×entity 청킹) | decide-triage | DECIDE | 📋 |
| selection-save 백스톱(JS 사이트) | selection-save-backstop | HARVEST | 📋 |
| agent 격리 영구화(--reload off/bind-mount 제거) | agent-isolation-hardening | infra | 📋 부채 |
| 레이블 정화(시스템어휘 숨김) | label-sanitize | 전역 | 📋 |

---

### 🎯 M3 — v0.3.0: Entity 중심 재조직 + 메타네트워크
**목표:** fact-중심 → entity-중심 조직 축 이동. 지식그래프를 그래프답게.

| 작업 | 코드네임 | 상태 |
|---|---|---|
| entity 중심 뷰(entity=1급, 프로필+관계+시간선) | entity-centric-view | 📋 |
| 메타네트워크(CASOS/DNA, 느슨한 ontology) | meta-network | 📋 |
| canonical 레이어(교차소스 dedup) | canonical-layer | 📋 |
| 내비게이션 연결(5섬 잇기, entity 상호이동) | nav-bridge | 📋 |
| ★LENS Phase A(앱내 Active Recall, 오버→풍선) | lens-active-recall | 📋 플래그십 |

> **M3 의 LENS 는 canonical-layer 선행 필수.** Phase B(전 웹페이지 확장 주입)는 M5 로.

---

### 🎯 M4 — v0.4.0: 영상·음성 캡처 + Claim 심화
**목표:** 거점 1차 소스(영상) 직접 캡처. Claim 층위가 빛나는 곳.
**선행:** M1 G1(claim 라이브) 필수.

| 작업 | 코드네임 | 상태 |
|---|---|---|
| 영상 타임코드 앵커링(발언↔시점 provenance) | b46-timecode | 📋 |
| 영상 거버넌스(옵트인 청킹·쿼터·user-pays) | b46-governance | 📋 |
| ★화자 분리/귀속(diarization→claim, 청문회 다화자) | speaker-attribution | 📋 |
| 오디오 캡처(팟캐스트·인터뷰) | audio-capture | 📋 |

---

### 🎯 M5 — v0.5~0.8: 캡처 확장 + 유료 기능 기반
| 작업 | 코드네임 | 상태 |
|---|---|---|
| measurement 권위지표 대조+모순알림(유료) | authoritative-index | 📋 |
| 역방향 출처보강(주장→출처후보 제시, 유료) | reverse-sourcing | 📋 |
| 스크린샷 백스톱 | screenshot-backstop | 📋 |
| 모바일·이메일·PDF 캡처 | capture-multichannel | 📋 |
| LENS Phase B(전 웹페이지 Active Recall, 확장 주입) | lens-web-overlay | 📋 |
| contradiction 정확도 튜닝(데이터 축적 후) | contradiction-tune | 📋 |

---

### 🎯 M6 — v0.9.x: 알파 테스트 (Feature Freeze)
**목표:** 외부 분석가 3~5명, 7월 중순~말. feature-freeze + 안정화.

| 작업 | 코드네임 | 상태 |
|---|---|---|
| 베타 신청 end-to-end 검증(폼→DB→승인→가입) ★ | beta-flow-verify | 📋 |
| ATELIER 설정(per-source·BYOK·알림) | settings-build | 📋 |
| 알파 플레이북 v0.2(인원·기간·성공기준·스코프) | — | 📋 |
| 온보딩 정제(GATE→HEARTH 첫경험) | onboarding-polish | 📋 |
| 안정화·버그 freeze | — | 📋 |

---

### 🎯 M7 — v1.0.0: 베타 → 공개 런칭
| 작업 | 상태 |
|---|---|
| BYOK BM 확정·과금 | 📋 |
| 법인 설립(한·미, IP·비자·변호사) — 7월 | 📋 |
| 글로벌 거점(하나 집중) | 📋 |
| 공개 런칭 1.0.0 | 📋 |

---

## PART V. 의존성 & 임계경로

### 5.1 임계경로 (Critical Path)
```
G1 분류복구 ──→ G5 dogfood ──→ v0.2.0 ──→ M3 entity중심 ──→ M4 영상claim ──→ M6 알파 ──→ 1.0
   (지금 막힘)                              (canonical)      (G1 의존)
```
- **G1 이 전체 임계경로의 시작.** 분류 안 살면 M1·M3·M4 연쇄 정체.
- M4(영상)는 G1(claim 라이브) 없이는 무의미 — 영상 캡처해도 전부 action.

### 5.2 병렬 가능 (디스조인트)
- G2(stellar zoom, frontend) ∥ G1(backend).
- M2 의 capture-job-tracker(extension) ∥ recall-redesign(frontend) ∥ agent-isolation(infra).
- ★ 동시 backend-mutating agent 금지(ES race) — backend 트랙은 직렬.

### 5.3 상시 운영 규율
- done = git-green + **PO 실화면+DB 재현**. tests pass ≠ 라이브(G1 이 산 증거).
- agent worktree 격리 · ship-race 직렬 · 단일 task dispatch · 실제 API smoke(분류·임베딩).
- 한글 소스 PowerShell 텍스트조작 금지 · git HEAD 확인 · alembic 수동 upgrade.

---

## PART VI. 변경 이력
- v3.0: 마일스톤 M1~M7 재구조화(유형별 그룹핑), 화면 코드네임 11종 + 연결도 + 기능명세, 임계경로 명시.
  영상 트랙 1급 격상(M4), 베타 end-to-end 검증 미확인 명시(M6), **LENS(Active Recall) 플래그십 격상**
  (Phase A=M3 앱내·canonical 의존 / Phase B=M5 전웹).
- 참조 문서: FactModel_DataArchitecture_v1 · InTruth_경쟁분석 · 각 의뢰서.
