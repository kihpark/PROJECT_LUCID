# chore/lucid-extension-toast-css-inline — inline toast CSS (work around @crxjs v2 beta path bug)

Off `main` (commit 1df6169, includes PR-2A-2). Tiny follow-up branch addressing the `chrome://extensions → Load unpacked → dist/` failure PO surfaced during walking-skeleton verification.

PR-2A-3 (selection prefix/suffix) is independent of this fix — they touch different file sets and can land in any order.

## Root cause

`@crxjs/vite-plugin` v2 beta leaves the source-tree path in the emitted manifest.json:

```json
"content_scripts": [{"css": ["src/content/toast.css"], ...}]
```

…but `dist/` never contains `src/content/toast.css`, so Chrome fails to load the extension. PO manually copied the file during walking-skeleton verification; this PR ships the permanent fix per **PO option B (inline injection)**.

Option A (crxjs CSS handling) depends on the v2 beta plugin behaviour; option C (custom vite plugin) is over-engineering. Option B has zero dependency on the broken plugin path **and** eliminates the unstyled-flash race that `content_scripts.css` has at `run_at: document_end`.

## Three changes

1. **`extension/manifest.config.ts`** — drop the `content_scripts.css` entry. Add an explanatory comment so a future contributor doesn't re-add it.
2. **`extension/src/content/toast.ts`** — new `INLINE_CSS` template literal carrying the same rules verbatim from `toast.css`. New `ensureStyle()` helper creates a single `<style id="lucid-toast-styles" data-lucid-toast="1">` element and appends it to `document.head` once. Called from the top of `ensureRoot()` so the style is in place before the toast div mounts. `__test__.reset()` strips the style element for jsdom hygiene. Docstring updated.
3. **`extension/src/content/toast.css`** — deleted (now inlined).

## DoD

| Check | Expected |
|-------|----------|
| `pnpm typecheck` | green (CSS is now a plain TypeScript template literal) |
| `pnpm test` | 19 cases pass — the four `toast.test.ts` cases assert class names + textContent, not visual styles, so jsdom continues to pass |
| `pnpm build` | `dist/manifest.json` no longer carries the broken `content_scripts[0].css` path |
| `chrome://extensions → Load unpacked → dist/` | Lucid extension loads without manual `cp` |
| Backend tests / lint / mypy | unchanged from main (215 / 90 / 0) |

## Commit

```
b0aae17  chore(extension): inline toast CSS — work around @crxjs v2 beta path bug
```

## What this PR does NOT do

- Does NOT upgrade `@crxjs/vite-plugin` — keeps the beta version pinned; option B sidesteps the plugin path
- Does NOT touch any source files outside `extension/src/content/` and `manifest.config.ts`
- Does NOT change the wireframe-parity styles — the rules are byte-identical to the deleted CSS file
- Does NOT add a Shadow DOM isolation around the toast — separate polish item

## Test plan

- [ ] `cd extension && pnpm install && pnpm typecheck && pnpm test && pnpm build`
- [ ] `cat extension/dist/manifest.json | jq '.content_scripts[0]'` — no `css` key
- [ ] `chrome://extensions → Reload Lucid → right-click → Save page to Lucid`
- [ ] Toast appears with the correct styling (bottom-right card, dark theme) without any manual file copy
- [ ] `document.head.querySelector('#lucid-toast-styles')` resolves in devtools after the first toast fires
