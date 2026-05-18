# Lucid

**Be lucid.** — 검증된 두 번째 뇌 (Your verified second brain).

AI가 무한히 생성하는 시대의 *검증된 진실 인프라*. 사용자가 마찰 없이 캡처한 정보를 AI가 구조화하고, 인간 검증(HITL)을 거친 지식만 개인 그래프에 저장한다. 모든 사실은 4단계 검증 서명(본인 / 신뢰망 / 시스템 / 전문가)을 보유한다.

> Lucid는 Student 데모(`../student-demo/`)와 별개의 벤처 프로젝트다.
> Student와 WisdomDB 두 MVP의 메커니즘을 통합·발전시킨 것이 Lucid의 제품 비전이다.

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
