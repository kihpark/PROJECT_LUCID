# Legacy Korean relabel discovery

Ran against dev ES (`lucid_objects`, 81 docs) at 2026-06-22 using the
predicate that ships with PR-B (`_looks_like_brand` + `_detect_lang`).

## Predicate

A doc is a relabel candidate when ALL of the following hold:

  - `primary_lang == "en"` (or, when `primary_lang` is missing,
    `_detect_lang(primary_label or name) == "en"`),
  - at least one entry in `aliases` OR the legacy `name` field is
    Korean (`_detect_lang(...) == "ko"`) AND not equal to the current
    primary,
  - `_looks_like_brand(primary)` returns False (i.e. NOT single-token
    Latin <=16 chars — SpaceX / OpenAI / IBM stay English even with a
    Korean alias).

## Result against dev ES

```
Total docs in lucid_objects:                 81
  already-Korean primary (skipped):          22
  English primary, no Korean alias:          59
  brand-shape exclusions (kept English):      0
  candidates for relabel:                     0
```

## Why zero?

Every English-primary doc in dev ES has `aliases: []` AND its legacy
`name` field equals the primary (English). The pre-PR-B capture path
never wrote a Korean alias against an English primary — the regression
PR-B fixed shows up as **silent translation** (Korean surface
overwritten by Claude's English form), not as a divergent Korean form
landing in aliases. So there is nothing in legacy ES that fits the
predicate above.

Sampled English-primary entries include:

  - Single-word brands (Bastrop, ETF) — would be brand-shape excluded.
  - Multi-word brands and firms (Mirae Asset Securities, Morgan Stanley,
    SpaceX IPO) — English-only, no Korean alias.
  - Descriptive metric names (initial funding raised, IPO price, total
    funding raised) — these are the entities PR-B is meant to catch
    going FORWARD; legacy copies have no Korean alias to promote.
  - Long descriptive phrases (Park Hyeon-joo publicly expressed
    expectations…, The failed allocation process has triggered…) —
    English-only, no Korean alias.

The legacy data is consistent with "PR-B's regression silently
translated, then lost the Korean form." There is no recoverable Korean
surface to promote.

## Decision

The backfill script is still landed because:

  1. The predicate is now codified and runnable on demand.
  2. The mapping change (`relabel_history` nested field) makes future
     relabels auditable.
  3. The script is idempotent, so re-runs after replay or after fresh
     captures populate Korean aliases will catch new candidates without
     any code change.
  4. Tests pin the predicate (brand exclusion, no-Korean-alias
     exclusion, already-Korean-primary exclusion).

## What was NOT included

- No write to ES on the apply path because there are no candidates.
  The apply pass executes the (no-op) loop and finishes; idempotence is
  trivially confirmed.
- No alembic migration. ES `put_mapping` only, as the PR directive
  requires.
