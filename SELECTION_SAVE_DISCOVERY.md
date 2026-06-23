# Selection-save backstop — discovery

## 0.1 Extension — does selection-save exist? What does it send?

YES — selection-save is fully wired in
`extension/src/background/context-menu.ts`:

```ts
export const MENU_IDS = {
  page: 'lucid-save-page',
  selection: 'lucid-save-selection',  // ← exists
  image: 'lucid-save-image',
  screenshot: 'lucid-save-screenshot',
} as const;
```

The selection branch in `buildSyncPayload(...)` ships:

```ts
return {
  source_url: url,
  source_type: 'highlighted_text',     // distinct from web_article
  captured_from: 'chrome_ext',
  raw_payload_b64: utf8ToBase64(selected),  // the selection text itself
  client_metadata: {
    selection_range_start: '0',
    selection_range_end: String(selected.length),
    ...(pageTitle ? { page_title: pageTitle } : {}),
  },
};
```

So at the **extension layer** the selection IS treated distinctly:
different source_type, raw payload = selection text bytes, no
`outerHTML` capture. `executeScript` is asserted NOT to fire on
selection in `tests/context-menu.test.ts:275`.

## 0.2 Backend — does selection_text reach a bypass branch?

`backend/api/extractors/dispatcher.py:48` maps
`HIGHLIGHTED_TEXT → HighlightedTextExtractor`. The highlighted-text
extractor is a pass-through: it decodes the raw bytes as UTF-8 and
returns them as `merged_text`. So on the **dispatch layer** the
selection bypass already exists for `source_type='highlighted_text'`.

However, there is NO bypass branch keyed on `client_metadata`. If a
caller sends `source_type='web_article'` but also a
`selection_text` field, the web extractor runs anyway — there is no
"if selection_text is present, skip the chain" guard.

## 0.3 The actual newsis evidence — why PO sees the URL-extractor error

```
INFO:lucid.extractors.web:extractor[1/trafilatura] host=www.newsis.com len=0
INFO:lucid.extractors.web:extractor[3/readability] host=www.newsis.com len=0
INFO:lucid.extractors.web:extractor[4/newspaper3k] host=www.newsis.com len=0
INFO:lucid.extractors.processor:process_source_job: job a42fad78... extract failed (ExtractorError): Article body not found at www.newsis.com. Tried trafilatura, readability, newspaper3k. ... Try the selection-save action instead.
INFO:lucid.routes.capture:capture: duplicate suppressed user=cb27c5a5 ks=4a3a8bb7 url=https://www.newsis.com/view/NISX20260622_0003678123 -> existing job a42fad78...
INFO:lucid.routes.capture:capture: duplicate suppressed user=cb27c5a5 ks=4a3a8bb7 url=https://www.newsis.com/view/NISX20260622_0003678123 -> existing job a42fad78...
```

**Root cause:** the B-29 dedup guard
(`backend/api/routes/capture.py:139-159`) blocks **every** retry
for the same (user, ks, source_url) — including selection-save
retries on URLs whose previous web_article job was `extract_failed`.

So when PO drag-selected text on newsis after the first capture
failed, the backend returned the **failed** job's id with
`duplicate=True`. The Pending Queue card was the original failed
page-save card. Selection-save never reached the backend extractor.

The error PO saw is correct — it was the OLD job's error message
surfaced again because the new (selection) capture was deduped away.

## Decision

1. **Backend dedup**: allow re-capture when the prior job is in a
   terminal failure state (`extract_failed`, `structure_failed`)
   AND the new request carries `client_metadata.capture_mode='selection'`
   with non-empty `selection_text`. The web-article failed job is
   marked superseded; the new selection job is created and runs.

2. **Backend processor**: at the top of `process_source_job`, if
   `client_metadata.selection_text` is present and >= 50 chars,
   skip the dispatcher entirely. Build the ExtractResult inline
   from selection_text + page_title. This is the "보이는 화면 =
   만능 백스톱" contract — selection text is authoritative regardless
   of the declared source_type.

3. **Extension**: enrich the selection-save payload with
   `selection_text` and `capture_mode='selection'` in client_metadata
   so the backend bypass guard has the explicit signal.

4. **Threshold**: 50 characters. Below that, fall through to the
   pre-existing URL extraction path so an accidental 5-char drag
   does not poison a real capture. 50 chars is roughly one short
   Korean sentence and matches the lower end of body-recovery
   heuristics elsewhere in the codebase.
