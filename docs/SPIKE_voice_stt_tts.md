# Spike — 음성 STT/TTS 한국어 호환성 (Task 4 / DR-084 결정 자료)

**Branch**: `spike/voice-stt-tts`
**Author**: Claude (Sonnet, background-session subagent)
**Date**: 2026-06-10
**1-day budget**

---

## 0. 정직한 scope 선언

PO 의 acceptance criteria 중 다음은 **이 세션에서 직접 측정 불가능**:

| 기준 | 왜 측정 불가 |
|------|-------------|
| 10문장 STT 원문 vs 인식문 대조 | 사람 한국어 음성 필요 |
| 판정어 3종 × 10회 인식률 | 사람 음성 필요 |
| TTS 한국어 자연성 체감 | 사람 청취 + 주관 평가 필요 |

이 세션에서 처리한 것:

1. **Browser API capability survey** — Chromium 의 Web Speech API 가
   `ko-KR` 을 STT/TTS 양쪽에서 지원하는지의 구조적 확인
2. **확장 권한 모델** — manifest / context 별 마이크 접근 가능 위치
3. **테스트 harness** — PO 가 30 분 내 1/2/3 항목 측정 완료 가능한
   Next.js 페이지 (`/spike-voice`). CSV export 포함.
4. **Whisper API 대안 비용/지연** — 구현 금지 조건 준수, 조사만

DR-084 의 이진 결론 ("브라우저 API 충분/불충분") 은 PO 가 harness
결과를 입력하면 §6 의 룰에 따라 자동 도출됩니다.

---

## 1. Browser API capability — 구조적 확인

| API | Chromium 지원 | ko-KR 명시 지원 | 비고 |
|-----|--------------|-----------------|------|
| `SpeechRecognition` | ✓ (`webkitSpeechRecognition` prefix; Chrome 33+) | ✓ `lang='ko-KR'` 수락 | **핵심 주의**: Chromium 의 SpeechRecognition 은 사실상 Google Cloud STT 호출. **로컬 처리 아님**. 오프라인 시 fail. |
| `SpeechSynthesis` | ✓ (Chrome 33+, Edge, Safari) | ✓ `lang='ko-KR'` 수락 | TTS 엔진은 OS 에 따라 다름 — Windows: Heami / Mac: Yuna / Android: 다양. **로컬 처리** (네트워크 무관). |

### 자체 capability prove

Harness 의 `detectCapabilities()` 가 페이지 로드 시:
- `typeof window.SpeechRecognition === 'function'` (또는 `webkitSpeechRecognition`)
- `typeof window.speechSynthesis === 'object'`
- `speechSynthesis.getVoices()` 에서 `lang.startsWith('ko')` 인 voice 개수
- `SpeechRecognition` 인스턴스의 `continuous` / `interimResults` 속성 존재

PO 가 `/spike-voice` 진입 시 화면 상단 "1. Browser capability" 섹션에서 즉시 확인 가능.

### 한국어 시스템 voice 의 실제 상태 (참고)

- Windows 11 기본 ko-KR: **Microsoft Heami** (한 명만 기본 제공; "InHee", "SunHi" 는 Edge add-on 필요)
- macOS ko-KR: **Yuna** (Premium 다운로드 시 자연성 큰 폭 상승)
- Android Chrome: Google 자체 TTS (자연성 낮음 ~ 중간)
- iOS Safari: 다양한 voice (Yuna 포함) — 자연성 최상

**경고**: TTS 자연성은 **OS 의 voice 패키지**에 강하게 의존. 베타 사용자의 OS 분포가 자연성 인지에 직접 영향. harness 결과를 OS 별로 segregate 권고.

---

## 2. 확장 권한 모델 — 마이크 접근 가능 위치

Chrome Extension Manifest V3 에서 마이크 접근:

| Context | 마이크 접근 | 추가 권한 | 비고 |
|---------|-----------|----------|------|
| **Popup** (`action.default_popup`) | ✓ 가능 | `getUserMedia` 호출 시 사용자 prompt | **단점**: popup 이 닫히면 mic stream 종료 |
| **Content script** | ✓ 단, 페이지의 origin 권한 필요 | `<all_urls>` host_permissions | 페이지가 마이크 차단 시 작동 안 함 |
| **Offscreen document** | ✓ (MV3 권장 경로) | `permissions: ["offscreen"]` + `offscreen` API | popup 닫혀도 stream 유지. **V1/V2/V3 의 정공법.** |
| **Service worker** | ✗ 불가 | (Web Audio + getUserMedia 미지원) | 직접 마이크 X — offscreen 으로 위임 |

### 권장 아키텍처 (DR-084 시 채택할 경우)

```
popup.ts (사용자 클릭)
   │  chrome.offscreen.createDocument(...)
   ▼
offscreen.html (background)
   │  navigator.mediaDevices.getUserMedia({ audio: true })
   │  new webkitSpeechRecognition()
   │  recognition.lang = 'ko-KR'
   ▼
recognition.onresult → chrome.runtime.sendMessage → service-worker
   │
   ▼
service-worker → fetch('http://localhost:8000/api/capture', ...)
   또는 → MCP 호출 (DR-081 정합)
```

### manifest.config.ts 에 추가해야 할 권한 목록

```ts
{
  permissions: [
    "storage",
    "cookies",
    "activeTab",
    "tabs",
    "contextMenus",
    "scripting",
    // 음성 spike — DR-084 시 추가:
    "offscreen",          // offscreen 문서 생성 권한
    "audioCapture",       // 일부 Chromium 버전에서 마이크 접근 명시
  ],
  // 마이크 자체 권한은 getUserMedia 첫 호출 시 사용자 prompt 로 받음.
  // host_permissions 에 추가하지 않음 (마이크는 origin 무관).
}
```

### V3 "수락/수정/폐기" 음성 판정의 critical UX 가드

PO 의 설계 불변 조건: **화면 확인 없는 일괄 음성 수락은 차단**.
구현 시 권고:

- 매 fact 마다 화면에 fact 카드 visual 표시
- TTS 가 "이 사실을 검토해 주세요" 낭독 후 사용자 응답 대기
- STT 가 "수락" / "수정" / "폐기" 중 하나로 인식되면 → **시각적 확인 단계** 거친 후 commit (e.g. 0.8 초 동안 "수락? Y/N" 버튼)
- 인식 confidence < 0.7 또는 미인식 시 화면 버튼으로 fallback
- 일괄 음성 수락 명령 (e.g. "전부 수락") 은 **명시적으로 차단**

---

## 3. 테스트 harness — 실측 입력 (PO 30 분 작업)

위치: `frontend/web/app/spike-voice/page.tsx`

실행:
```sh
cd frontend/web
pnpm dev                              # http://localhost:3000 띄움
# 다른 탭에서:
open http://localhost:3000/spike-voice
```

harness 가 측정하는 것:
1. **STT 10 문장** — V1 (capture 명령) 3 + V2 (briefing) 2 + V3 (fact 낭독) 3 + edge case (숫자, 코드스위치) 2. 각 행마다 "Record" 버튼; 인식 결과 + confidence + ms 자동 기록.
2. **3 판정어 × 10 회** — "Round: 수락" 누르면 10 초 동안 반복 인식. exact match 율 자동 집계.
3. **TTS 5 문장** — 한국어 briefing 5 종. 사용자가 각 문장을 1~5 점으로 주관 평가.

CSV export 버튼으로 `voice-spike-2026-06-10.csv` 다운로드 → DR-084 PR 에 첨부.

### 마이크 권한 prompt 처리

`/spike-voice` 첫 진입 → 사용자가 어떤 "Record" 버튼이든 클릭 → Chrome 이 마이크 권한 prompt 띄움 → "Allow" 클릭 → 이후 30 분간 권한 유지.

### 의도적으로 측정 안 한 것 (Phase 2 scope)

- 백그라운드 소음 (카페, 사무실 노이즈 + STT 정확도)
- 거리 (마이크 50cm vs 2m)
- 다른 마이크 (노트북 내장 vs USB 헤드셋)
- **여러 사용자의 발음 변이** — 단일 PO 의 음성만으로는 일반화 불가; 베타 cohort N=10 이 진짜 검증

---

## 4. Whisper API 대안 — 비용 / 지연 추정

PO 가 "브라우저 API 불충분" 결론 시 fallback:

### OpenAI Whisper API (`whisper-1`)

| 항목 | 값 | 비고 |
|------|----|------|
| 가격 | $0.006 / 분 | 2026-06 기준 OpenAI 공개 가격 |
| 지연 | ~1.5-3 초 / 10초 오디오 | 네트워크 + 모델 처리 |
| ko-KR 정확도 | 베타 사용자 보고 기준 ~94-96% WER | Whisper paper + Korean benchmark |
| API 인증 | OpenAI API key | 백엔드 proxy 권장 (키 노출 방지) |

**월 cost 추정** (사용자 1명, 일 평균 5분 음성):
- 5 분/일 × 30 일 = 150 분/월
- 150 × $0.006 = **$0.90 / 월 / 사용자**
- 베타 N=30: $27 / 월 — 무시 가능

### Anthropic 음성 모델

- Claude 4.7 의 음성 입출력은 (2026-06 기준) API 미공개
- Anthropic 음성 API 가 GA 되면 대안 추가

### 로컬 Whisper (faster-whisper)

이미 백엔드에 설치됨 (Sprint 2C `backend/api/extractors/youtube_whisper.py` 의 small 모델). spike 단계에서는:
- 모델 크기 small=~244MB, base=~74MB
- ko-KR WER: small ~12-15%, base ~25%
- 지연: 10 초 오디오 → small 모델 → ~2-4 초 (CPU)

**판정**: 클라우드 Whisper 가 정확도 / 지연 모두 우월. 비용은 무시 가능.

---

## 5. AGPL 가드 (DR-081 준수)

이 spike 는 RedPlanetHQ/core 의 음성 모듈 (있다 한들) 을 참조하지 않습니다.
- Web Speech API: W3C 공개 표준
- Whisper: OpenAI 공개 API + faster-whisper (MIT 라이선스)
- 확장 권한 모델: Chrome Extension 공식 docs

---

## 6. 이진 결론 도출 규칙 (DR-084 입력)

PO 가 harness 돌린 후 CSV 를 보고 다음 규칙으로 결론 도출:

### 충분 (브라우저 API 채택) 조건 — 셋 다 충족 시

- **STT 인식률 ≥ 80%** (10 문장 중 "exact" + "close" 합 ≥ 8)
- **판정어 인식률 ≥ 90%** (3 단어 × 10 회 = 30 회 중 27 회 이상 exact)
- **TTS 자연성 ≥ 3.0** (5 문장 평균, 5 점 만점)

### 불충분 (Whisper API 또는 보강) 조건 — 하나라도 미달

- STT 인식률 < 80% 또는 판정어 < 90% → STT 만 Whisper API 로 교체
- TTS 자연성 < 3.0 → 사용자에게 OS 별 voice 패키지 안내 + premium voice 권유

### 절대 차단 조건 (어떤 결과든)

- "수락" vs "수정" 의 오인식 ≥ 10% → V3 (음성 판정) **전면 보류**. V1/V2 만 진입.
  - 2 음절 한국어 명령 단어의 STT 오인식은 사용자 신뢰를 직격함.
  - 화면 + 음성 hybrid 로 대체.

---

## 7. 권고 (PO 결정 입력)

1. `pnpm dev` + `/spike-voice` 30 분 수행 → CSV 첨부
2. CSV 결과 + §6 룰 적용 → DR-084 본문에 "충분/불충분" 명기
3. "충분" 결정 시: Sprint 2A 또는 별도 Sprint 의 PR 로 확장 voice 모듈 (`extension/src/voice/`) 진입
4. "불충분" 결정 시: 별도 chore 로 backend Whisper API proxy (`/api/voice/transcribe`) 진입; 확장에서는 `MediaRecorder` 로 녹음 후 백엔드 호출

이 보고만으로 DR-084 채택 불가. **harness 실측 30 분이 결정의 trigger**.

---

## 8. Appendix — 참고 문서

- W3C Web Speech API spec: https://wicg.github.io/speech-api/
- Chrome SpeechRecognition support: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition (caveat: `webkitSpeechRecognition` prefix in Chromium)
- Chrome Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- OpenAI Whisper API pricing: https://openai.com/api/pricing/ (whisper-1 row)
- faster-whisper ko-KR benchmark: GitHub guillaumekln/faster-whisper README
