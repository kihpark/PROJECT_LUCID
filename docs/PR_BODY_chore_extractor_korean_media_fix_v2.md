# chore/lucid-extractor-korean-media-fix-v2 — trafilatura-led hybrid + INFO logging

Off `main`. **Walking-Skeleton Iteration 5 result:** v1 still failed on hankyung.com despite correct selectors.

## v1 diagnosis (PO data)

- PO confirmed `docker compose exec backend python httpx` fetches hankyung successfully (200 OK, 85,996 chars)
- PO confirmed via DevTools the article body div has all three matchable attributes:
  ```html
  <div class="article-body" id="articletxt" itemprop="articleBody">
    오는 7월 6일부터 원·달러를 24시간 거래할 수 있게 된다...
  </div>
  ```
- v1's `KOREAN_MEDIA_SELECTORS["hankyung.com"]` lists `#articletxt`, `.article-body`, `.article-content`, `div[itemprop='articleBody']` — three of the four should hit
- Yet the v1 chain raised `ExtractorError("Article body not found on hankyung.com. Tried selectors: ...")`

Possible causes (impossible to discriminate from the v1 logs):
- A. The selector chain wasn't reached because readability returned `>= 200` chars of nav/footer noise — but PO got the error so this isn't it
- B. `BeautifulSoup(html, 'lxml')` parsed hankyung's HTML in a way that lost the article body div
- C. The selectors matched but `get_text()` after noise removal returned `< 200` chars

Rather than guess, **v2 ships two things at once**: a more robust primary extractor that should make most of the bug irrelevant, AND the INFO-level logging needed to debug residual misses.

## Hybrid chain (option C per PO recommendation)

Strategies tried in order until one returns `>= FALLBACK_TRIGGER_CHARS` (200) of stripped text:

| Order | Strategy | Why |
|-------|----------|-----|
| 1 | **trafilatura** | 95%+ of news + blog layouts, Korean-morpheme aware |
| 2 | per-host selectors | `KOREAN_MEDIA_SELECTORS` dict; v1 values kept verbatim with a BEST-EFFORT note |
| 3 | readability + bs4 | the pre-chore-6 pipeline as third fallback |
| 4 | newspaper3k | final fallback before raising |
| 5 | `ExtractorError` | site-aware diagnostic listing every strategy + selectors tried + `selection-save` hint |

`extracted_metadata.extractor_strategy` records the winning layer (`trafilatura` / `selector:#articletxt` / `readability` / `newspaper3k`). `extracted_metadata.strategies_attempted` lists every layer attempted — `GROUP BY` against that field gives per-publisher hit-rate analytics without log-mining.

## INFO-level logging at every strategy boundary

```
extractor[1/trafilatura] host=www.hankyung.com len=3421
extractor[2/selectors] host=... key=hankyung.com winner=#articletxt len=3421
extractor[3/readability] host=... len=187 title=True
extractor[4/newspaper3k] host=... len=0 title=False
selector '#articletxt' matched 1 nodes, 3421 chars
selector '.article-body' matched 1 nodes, 0 chars
```

PO can `docker compose logs backend | grep extractor` after a failure to see which layer returned what length and why the chain advanced.

## New dependency

`requirements.txt`: `trafilatura>=2.0` added. `newspaper3k` + `readability-lxml` already present; no removals.

## Tests — 11 cases (rewritten `test_extractor_web.py`)

| Group | Cases |
|-------|-------|
| `_selectors_for_host` | exact match, subdomain via suffix, unknown returns empty |
| Strategy ordering | trafilatura wins, selectors win when trafilatura short, readability wins when first two miss, newspaper3k wins as final |
| `ExtractorError` shape | known host (lists selectors + selection-save hint) + unknown host (paywall hint + selection-save) |
| Threshold | 199-char strategy result is NOT a hit; chain advances |
| Dict invariant | all 12 expected publishers present + non-empty selector lists |

## DoD

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in 90 source files |
| `pytest tests/unit -q` | **226 passed** (+3 net vs main; +11 new test_extractor_web cases minus 8 v1 cases retired) |

## Commit

```
7d3dd0e  chore(extractor): hybrid trafilatura chain + INFO logging (chore 6 v2)
```

## What this PR does NOT do

- Does NOT verify the v1 per-host selectors against live pages — kept verbatim with a BEST-EFFORT comment so PO can drop/update entries as misses are confirmed via the new INFO logs
- Does NOT add Playwright/Selenium dynamic-content rendering — trafilatura should obviate it for hankyung; deferred unless v2 logging shows a real JS-only site
- Does NOT change the Toast / Decide Overlay UI — the error message is already informative; a "Retry with selection" CTA stays a Sprint 7 polish item
- Does NOT backfill failed jobs — re-capture is simpler than rewriting JSONB

## Test plan (PO machine)

- [ ] `cd backend && pytest tests/unit/test_extractor_web.py -q` → 11 pass
- [ ] `docker compose build backend` (pulls trafilatura)
- [ ] Re-capture `https://www.hankyung.com/article/...` via Chrome Extension
- [ ] `SELECT status, extracted_metadata->'extractor_strategy', extracted_metadata->'strategies_attempted', error_message FROM source_jobs ORDER BY created_at DESC LIMIT 1;`
- [ ] Expected: `status='structured'`, `extractor_strategy='trafilatura'` (most likely) or `selector:#articletxt` if trafilatura miss + selector win
- [ ] `docker compose logs backend | grep extractor` shows per-strategy lengths — confirms which layer hit
- [ ] Repeat on chosun, joongang, donga, mk — `extractor_strategy` reflects which layer matched each publisher
- [ ] On a deliberate-fail page (e.g. paywall site that all four miss) → Toast message lists every strategy attempted + the selectors tried + `selection-save` hint
