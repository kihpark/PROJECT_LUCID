# chore/lucid-extractor-korean-media-fix — per-host selector fallback + diagnostic ExtractorError

Off `main`. **Walking-Skeleton Iteration 4 Bug 2.** Korean publisher compatibility.

## Diagnosis

PO `Save page` on `https://www.hankyung.com/article/...` → toast: "Save failed - extracted_text is empty". `Save selection` on the same URL succeeded.

Root cause: `readability` heuristic doesn't recognise major Korean publisher article layouts. `web_article.py` returned an empty `merged_text` and the **downstream** `structure/processor.py` invented the one-line failure message after the upstream had already lost the diagnostic.

## Fix in three layers

### 1. `KOREAN_MEDIA_SELECTORS` — per-host CSS selector lists

| Host | Selectors (first match wins) |
|------|------------------------------|
| `hankyung.com` | `#articletxt`, `.article-body`, `.article-content`, `div[itemprop='articleBody']` |
| `chosun.com` | `#fusion-app .article-body`, `#news_body_id`, `.par`, `.article-body` |
| `joongang.co.kr` | `#article_body`, `.article_body`, `.article_content` |
| `donga.com` | `.article_txt`, `#article_txt`, `section.news_view` |
| `mk.co.kr` | `#article_body`, `.article_body` |
| `naver.com` | `#dic_area`, `#articleBodyContents` |
| `daum.net` | `#harmonyContainer`, `.article_view` |
| `yna.co.kr` | `#articleWrap article`, `.story-news` |
| `ytn.co.kr` | `#CmAdContent`, `#contentText` |
| `kbs.co.kr` | `.detail-body`, `#cont_newstext` |
| `mbc.co.kr` | `.news_txt`, `#content` |
| `sbs.co.kr` | `.text_area`, `#main_text` |

`_selectors_for_host()` walks `.`-separated suffixes so `news.hankyung.com` matches the `hankyung.com` entry without a literal subdomain row.

### 2. `_selector_chain_extract()`

Tries each selector against the **raw HTML** (not the readability-trimmed `body_html`), drops `script`/`style`/`noscript` noise, returns the first hit yielding `>= FALLBACK_TRIGGER_CHARS` (200) of stripped text. The chain runs only when readability + BeautifulSoup yielded less than that floor.

### 3. `ExtractorError` on truly-empty body — site-aware diagnostic

```
known host:
  Article body not found on hankyung.com. Tried selectors:
  #articletxt, .article-body, .article-content,
  div[itemprop='articleBody']. Try the selection-save action instead.

unknown host:
  Article body not found at <host>. The page may be paywalled,
  JavaScript-rendered, or use an unusual layout. Try the
  selection-save action instead.
```

The processor preserves this verbatim into `source_jobs.error_message`, which the in-page toast (PR-2A-2) surfaces. PO sees actionable guidance instead of "extracted_text is empty".

### Bonus: telemetry on which path won

`extracted_metadata['extractor_strategy']` records `'readability'` or `'selector:#articletxt'` per job. A simple `GROUP BY` later tells you readability vs site-specific hit rates by publisher.

### Latent fix: missing `supports()`

`WebArticleExtractor` was missing the `supports(source_type)` method required by the `Extractor` ABC; pre-existing tests were silently failing on the abstract-method violation. Added.

## Tests — 5 new (total 10 in `test_extractor_web.py`)

| Case | Asserts |
|------|---------|
| `test_hankyung_selector_fallback_recovers_body` | real Korean text body inside `#articletxt` → `merged_text` recovered |
| `test_chosun_selector_fallback_uses_par_class` | `.par` paragraphs → `merged_text` recovered |
| `test_unknown_host_with_empty_body_raises_with_url_hint` | truly empty HTML + unknown host → `ExtractorError` mentions host + `selection-save` hint |
| `test_known_host_empty_layout_raises_with_selectors_listed` | truly empty HTML + hankyung URL → `ExtractorError` lists every selector tried + `selection-save` hint |
| `test_selector_suffix_matching_subdomain` | `news.naver.com` → matches `naver.com` entry, `#dic_area` in selectors |

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in 90 source files |
| `pytest tests/unit -q` | **223 passed** (was 220; +5 chore 6 + 2 pre-existing test_extractor_web tests resolved by the `supports()` add) |

## Commit

```
dcf8ff0  chore(extractor): Korean media per-host fallback + diagnostic ExtractorError
```

## What this PR does NOT do

- Does NOT introduce Playwright / Selenium dynamic-content rendering — overkill for beta; the per-host selector list covers the publishers PO listed
- Does NOT trafilatura / dragnet replace readability — incremental upgrade, scope-bounded
- Does NOT add a UI redirect "Try selection save?" button — the toast already shows the message text; a one-click escalation is Sprint 7 polish
- Does NOT backfill the 7 existing `structure_failed` jobs — PO can re-capture or hand-update; cleaner than hand-rewriting JSONB
- Does NOT touch chore 7 (decided_fact_uids filter) — separate branch, independent

## Test plan (PO machine)

- [ ] `cd backend && pytest tests/unit/test_extractor_web.py -q` → 10 pass
- [ ] After merge: re-capture `https://www.hankyung.com/article/...` via Chrome Extension
- [ ] `SELECT status, extracted_metadata->'extractor_strategy', error_message FROM source_jobs ORDER BY created_at DESC LIMIT 1;`
- [ ] On success: `status='structured'`, `extractor_strategy='selector:#articletxt'` (or whichever selector won)
- [ ] On failure: `status='extract_failed'`, `error_message='Article body not found on hankyung.com. Tried selectors: ...'`
- [ ] Run the same flow on chosun, joongang, donga, mk — confirm `extractor_strategy` reflects which selector chain matched
- [ ] Capture an unknown-layout site (e.g. a personal blog) that previously failed — confirm the generic ExtractorError mentions the host + `selection-save` hint
