# feat/decide-ux-fix — discovery

PR-A baseline = `f5d2ca9`. Three PO bugs, frontend only.

## 0.1 PendingQueueList overlap

`frontend/web/components/PendingQueueList.tsx`, `PendingCard`:

- Header is `<header className="flex items-baseline justify-between mb-2">`.
- The source_type badge `<code class="text-xxs ... shrink-0 ml-2">{job.source_type}</code>` lives inside that header, anchored top-right.
- The 폐기 button is `absolute top-3 right-3 ...`.

Both occupy the same top-right region. The absolute-positioned 폐기 button overlays the inline source_type badge with no horizontal gap or z-stack rule.

## 0.2 DecideOverlay KR/EN toggle

`frontend/web/components/DecideOverlay.tsx`:

- LangToggle is imported and rendered in the header.
- `lang` state lives at `useState<Lang>('en')`.
- `lang` IS passed down to every FactCard.

FactCard:
- displayClaim(fact, lang) flips claim_en/claim.
- resolveEntity(value, labelMap, lang) flips name_en/name.

Toggle IS technically wired. But all UI chrome (button labels, dl labels subject/predicate/object, the instructional line) is hard-coded English and does NOT respond. For facts where claim_en is null, displayClaim falls back to KR — toggle visibly does nothing on those rows.

PO observed "안 먹힘". Decision: Path B — remove the toggle. Render claim with prefer-EN fallback via a default 'en' lang on FactCard. Strip LangToggle import, lang useState, and toggle UI from DecideOverlay.

## 0.3 FactCard edit mode buttons

Bottom button row in FactCard:
- Left cluster: [Edit] [Discard/취소]
- Right cluster (edit mode only): [취소 cancel-edit]

NO save/commit button. Confirmed.

Edits are persisted live via emitEdit on every keystroke. Missing: exit edit mode while preserving edits.

Implementation: add local editFormOpen state. 저장 hides form but keeps action='edit' so DecideOverlay's submit still includes edited_metadata. 취소 reverts to accept AND closes form. Re-clicking Edit re-opens form. No backend PATCH needed — existing submitDecisions carries edited_metadata.

## Tests to add

- PendingQueueList.test.tsx: assert badge and discard button don't overlap.
- DecideOverlay.test.tsx: assert LangToggle no longer renders.
- FactCard.test.tsx: edit mode has TWO buttons (취소 + 저장); 저장 click hides form but preserves edits.
