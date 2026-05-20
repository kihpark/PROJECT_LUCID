# Lucid

**Be lucid.** — 검증된 두 번째 뇌 (Your verified second brain).

AI가 무한히 생성하는 시대의 *검증된 진실 인프라*. 사용자가 마찰 없이 캡처한 정보를 AI가 구조화하고, 인간 검증(HITL)을 거친 지식만 개인 그래프에 저장한다. 모든 사실은 4단계 검증 서명(본인 / 신뢰망 / 시스템 / 전문가)을 보유한다.

> Lucid는 Student 데모(`../student-demo/`)와 별개의 벤처 프로젝트다.
> Student와 WisdomDB 두 MVP의 메커니즘을 통합·발전시킨 것이 Lucid의 제품 비전이다.

## Quick start (developers)

베타 개발 환경 부팅 가이드. 자세한 작업 분해는 `MASTER_HANDOFF.md`와
`docs/beta-backlog.md` 참조.

**요구 사항**
- Docker Desktop
- Python 3.11+
- Node 18+ (extension / pwa 작업 시)

**부팅**

```bash
cp .env.example .env                  # ANTHROPIC_API_KEY 채우기
docker compose up -d                  # neo4j + backend
curl http://localhost:8000/api/health
# {"status":"ok","neo4j":"connected","version":"0.3.0"}
```

**백엔드 로컬 개발 (Docker 외부)**

```bash
cd backend
pip install -r requirements.txt
uvicorn api.main:app --reload         # http://localhost:8000
```

**테스트 / 린트 / 타입체크**

```bash
cd backend
pytest tests/unit -v                  # 단위 테스트 (Neo4j 불필요)
pytest tests/integration -v           # 통합 (docker compose 실행 중이어야 함)
ruff check .                          # 린트
mypy .                                # 타입체크
```

CI는 `.github/workflows/ci.yml`에서 ruff + mypy + pytest를 모든 push와 PR에 실행.

**디렉토리 구조 (베타 목표)**

```
Lucid/
├── backend/        FastAPI + Neo4j 서비스
├── extension/      Chrome Extension (Sprint 2A)
├── pwa/            Mobile PWA Share Target (Sprint 2B)
├── frontend/       Lucid 앱 (Stellar View 등)
├── docs/           명세서, 백로그, 결정 로그
├── pitch/          IR / 사업 자료 (기존)
├── docker-compose.yml
└── MASTER_HANDOFF.md   ← 단일 진입점
```

다음 sprint 작업 시작: `MASTER_HANDOFF.md` §7 또는 `docs/beta-backlog.md` §5.

---

## 폴더 구조

```
Lucid/
├── README.md            ← 본 문서
└── pitch/               ← IR / 사업 자료
    ├── .venv/            python-docx · python-pptx (자체 venv)
    ├── make_pitch.py     사업계획서 + 피칭덱의 단일 소스
    ├── requirements.txt
    ├── Lucid_Business_Plan.docx   (생성물)
    └── Lucid_Pitch_Deck.pptx      (생성물)
```

향후 확장 예정: `product/` (Student + WisdomDB 통합 코드), `brand/` (로고·에셋), `docs/` (전략 문서).

## 피칭 자료 재생성

`make_pitch.py`가 사업계획서(docx)와 피칭덱(pptx)의 단일 소스다. 내용 수정 후:

```powershell
cd "C:\Users\kihpa\Documents\09. 카네기멜론대학교\AI 프로젝트\Lucid\pitch"
.venv\Scripts\python.exe make_pitch.py
```

브랜드명·슬로건·태그라인은 `make_pitch.py` 상단 상수에서 일괄 변경 가능:

```python
BRAND      = "Lucid"
SLOGAN_EN  = "Be lucid."
SLOGAN_KO  = "분명해져라."
TAGLINE_EN = "Your verified second brain."
```

## 메시지 계층

| 계층 | 메시지 | 용도 |
|---|---|---|
| 시그니처 슬로건 | Be lucid. (분명해져라.) | 로고·CTA·해시태그·서명 |
| 태그라인 | Your verified second brain. | 랜딩·앱스토어·SNS bio |
| 투자자 명제 | Validation infrastructure for the post-AI internet. | IR·피칭덱·인터뷰 |

## 현재 상태 (2026-05)

- 사업계획서 v3 (Validation-first 컨셉) — 완료
- 피칭덱 16슬라이드 (영문) — 완료
- 자금 전략: Phase 0 부트스트랩(5천만~1.5억) → Phase 1 한국 시드 → Phase 2 시리즈 A/흑자

## 다음 단계 후보

- 60초 데모 영상 스토리보드
- Phase 0 콜드 메일 (엔젤·액셀러레이터·CMU 동문)
- Validation Layer UX 목업
- Student + WisdomDB 통합 아키텍처 문서
