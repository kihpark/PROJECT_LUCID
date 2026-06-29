# Lucid E2E (Playwright)

이 디렉토리는 Lucid 프론트엔드의 **end-to-end 검증**을 담당한다. 목적은 단 하나 — **"거짓 ship" 차단**.
에이전트가 코드만 보고 "ship 완료"라고 보고하던 관행을 끝내고, 실제 브라우저에서 화면을 렌더해
**스크린샷 evidence**를 남긴 케이스만 ship으로 인정한다.

## ★ Ship 전 의무 절차 (PO 결정 2026-06-29)

1. 코드 변경 후 **반드시** 관련 e2e 시나리오를 로컬에서 실행한다.
2. `playwright-evidence/` 아래에 생성된 스크린샷을 직접 눈으로 확인한다.
3. 변경된 화면이 의도대로 렌더되었는지 검증 (로그/HTML 텍스트만으로 ship 금지).
4. PR/커밋 본문에 evidence 파일명을 명시한다. 누락 시 PO가 reject한다.

## 실행 (Commands)

```bash
# 전체 e2e 실행 (chromium only)
cd frontend/web
corepack pnpm e2e

# 인터랙티브 UI 모드 (디버깅용)
corepack pnpm e2e:ui

# HTML report 보기
corepack pnpm e2e:report

# 단일 spec 실행
corepack pnpm exec playwright test e2e/sanity.spec.ts --reporter=list

# 단일 테스트 디버그 (headed + slow)
corepack pnpm exec playwright test e2e/sanity.spec.ts --headed --debug
```

> dev 서버는 `playwright.config.ts`의 `webServer` 항목이 자동으로 띄운다 (`corepack pnpm dev`,
> 포트 3000). 이미 떠 있으면 재사용한다 (`reuseExistingServer: !CI`).

## Evidence 위치

- **`playwright-evidence/`** — `captureEvidence()` 헬퍼가 남기는 의도된 스크린샷. ★ ship 검증의 1차 증거.
- **`playwright-report/`** — HTML report (`corepack pnpm e2e:report`로 열람).
- **`test-results/`** — 실패 시 자동 캡처되는 스크린샷/비디오/trace.

세 디렉토리 모두 `.gitignore` 처리되어 있어 커밋되지 않는다. Ship 보고 시에는 파일명만 인용.

## 6 위반 클래스 검증 시나리오 (Future PR 범위)

본 PR은 **infrastructure-only**다. 아래 6 클래스 위반 검증 spec은 후속 PR에서 추가한다.

1. **거짓 ship (false ship)** — "code OK"만 보고 ship한 PR을 e2e가 잡아낸다.
2. **무한 로딩 (stuck loading)** — `networkidle` 도달 실패 케이스를 fail로 처리한다.
3. **빈 상태 누락 (empty state)** — 데이터 0건일 때 placeholder가 렌더되는지 검증.
4. **권한 누락 (auth missing)** — 비인증 상태에서 보호 라우트가 401/redirect 처리되는지.
5. **REAL 모드 미진입 (STELLAR fallback)** — `/stellar`에서 REAL 모드 진입 후 그래프 노드가 ≥1.
6. **regression 회귀** — 이전에 통과하던 시나리오가 회귀했는지 retry 1회로 감지.

## 인증

`e2e/fixtures/auth.ts`가 PO 계정 JWT를 쿠키로 주입한다 (`lucid_jwt`).
`process.env.JWT_SECRET`을 사용하며, 미설정 시 `dev-secret-change-me` (백엔드 dev 기본값).

## 추가 시나리오 작성 가이드

- 모든 spec은 `e2e/fixtures/auth.ts`의 `test` import를 사용 (`authenticatedPage` fixture).
- 스크린샷은 반드시 `captureEvidence(page, '<test-name>', '<step-label>')`로 남길 것.
- 라벨은 `01-..`, `02-..` prefix로 순서를 명시한다 (PO 리뷰 시 시간순으로 정렬되도록).
- `page.waitForLoadState('networkidle')` 후 캡처 — 로딩 중 화면을 evidence로 남기지 않는다.
