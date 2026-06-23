# CAPTURE_TOAST_DISCOVERY — feat/capture-complete-toast

## PO report (verbatim)

> 새 아티클 저장하기 -> 분석 중 -> 처리 지연 Pending Queue 에서 최신 상태를 확인하세요. 왜 완료 TOAST는 안뜨는지?

Save article → "분석 중" → "처리 지연 — Pending Queue 에서 확인" → no "분석 완료" ever fires.

## 0.1 Where do the toast strings live?

`"처리 지연"` (timeout fallback) lives at:
- `extension/src/content/toast.ts:295` — fires from `startPolling()` when `attempts > POLL_MAX_ATTEMPTS`.

`"분석 완료"` (completion) lives at:
- `extension/src/content/toast.ts:229` (renderInitial when status arrives as 'structured')
- `extension/src/content/toast.ts:248` (updateFromStatus when polling sees 'structured')

`"분석 중…"` (in-progress) lives at:
- `extension/src/content/toast.ts:225` (renderInitial for 'extracted' / 'structuring').

So the wiring is unambiguous: the timeout path AND the success path BOTH exist in `toast.ts`.

## 0.2 Backend status transitions (verified)

`backend/api/storage/postgres/orm.py:368–369`:

> status IN ('pending_extract', 'extracting', 'extracted', 'extract_failed', 'structuring', 'structured', 'structure_failed')

`backend/api/structure/processor.py`:
- `:769` `STRUCTURING` when the lock is taken.
- `:957` `STRUCTURED` after decompose → match-per-object → links → ES embeddings → telemetry.
- `:976` `STRUCTURE_FAILED` on any exception.

The backend does flip to `'structured'` correctly. No backend change needed.

## 0.3 Does polling exist? (Yes — and that's the cliff)

Polling lives in `extension/src/content/toast.ts:288–314` (`startPolling`).

Constants at top of file (`:31–33`):

```ts
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 60;
const FADE_OUT_MS = 12000;
```

Total polling window: **60 × 1 s = 60 seconds**.

After 60 attempts (line 293):

```ts
if (attempts > POLL_MAX_ATTEMPTS) {
  stopPolling();
  setStatusText('처리 지연');
  setDetail('Pending Queue 에서 최신 상태를 확인하세요.');
  scheduleFadeOut();
  return;
}
```

## 0.4 Why no completion toast fires — ROOT CAUSE

Two compounding issues:

1. **60-second poll window is too short for the real structure stage.** `process_extracted_job` does (per `:778–959`):
   - 1 × decompose LLM call (Claude — ~5–15 s on Korean text).
   - N × `_match_object` per LLM-emitted object (`:810–824`). Each object resolution can hit ES + brand_resolver + claim_recovery; a typical multi-entity article (5–10 objects) costs 10–30 s in aggregate.
   - ES embedding + adjacency writes + telemetry.

   Median end-to-end for a real article: 45–90 s. 60 s catches the tail; on an unlucky article the PO times out before `structured` is observed. That is exactly the "분석 중 → 처리 지연" path the PO described.

2. **Chrome backgrounds the polling.** When the host tab is not visible (PO switches tabs while waiting), Chrome throttles `setInterval(1000ms)` in inactive content scripts down to ≥1 Hz / minute on Chrome 88+. The poll attempts counter advances on wall-clock-derived ticks, so the 60-attempt budget can be reached in <60 s of structure-stage real time. The toast hits "처리 지연" before the backend even sees its first `structured` write.

The `'show_toast'` mechanism, the polling, the `'분석 완료'` rendering — all exist and all work. The window is just too short, and there is no out-of-tab fallback when the tab is backgrounded.

## 0.5 Toast dispatch mechanism (already three-tier in `context-menu.ts`)

`extension/src/background/context-menu.ts:531–552` (`notifyTab`):
1. Badge flash on the toolbar icon (`✓` / `!`).
2. `chrome.tabs.sendMessage(tabId, {type:'show_toast', ...})` — in-page toast.
3. Fallback: `chrome.notifications.create(...)` — system notification (used only when the in-page route fails, e.g. CSP-locked pages).

So the system-notification path exists but currently only fires the **start** message, never the completion message. The completion is observed inside the content-script polling loop, which has no path back to the SW to escalate to `chrome.notifications`.

## Fix (surgical)

A. **Extend the poll window with a step-down cadence** so steady articles don't waste the API but slow ones still resolve:
   - First 30 attempts at 1 s (covers the median fast path).
   - Remaining 50 attempts at 3 s.
   - New `POLL_MAX_ATTEMPTS = 80`, total ≈ 30 + 150 = **180 s**.
   - "처리 지연" still fires after 3 minutes as the true-fallback.

B. **Escalate completion / failure to a system notification** via the service worker, so a backgrounded tab still gets feedback:
   - Add an `'announce_terminal'` message handler in `service-worker.ts` that fires `chrome.notifications.create()` with a click handler opening `/pending/{jobId}`.
   - The content-script polling loop sends this once when it observes a terminal status.

C. **Wire the existing `'open_review'` SW message.** Currently `toast.ts:183` sends it but `service-worker.ts` has no handler — the only thing that opens the Pending page is the fallback `window.open` at `toast.ts:188`. The SW route is harmless when missing but a documented handler makes the click reliably target the existing Lucid tab if open. Add the handler.

This keeps the "처리 지연" toast as the genuinely-stuck fallback (per PR instructions) while making the success path actually visible in the common case.
