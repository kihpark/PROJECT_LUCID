# SPO Subject Natural-Language — Discovery (2026-06-22)

## ES inspection
- lucid_facts: 66 total. Most recent post-natural-spo Korean captures (2026-06-21, naver.com SpaceX article) produce Korean claims and Korean object_value correctly.
- lucid_objects: 81 total. Korean firms like 우리자산운용, KB증권, 미래에셋증권 stored with Korean `name` and English `name_en`. Pattern is consistent.
- 4 stubs with `properties.stub=true` from the B-48a-2 replay orphan-backfill path — legacy artifacts, not the regression.

## The actual regression — `pick_natural_primary` over-trusts English llm_name

natural-spo (c0c15a7) designed it so `llm_name` always wins. The unit test `test_korean_capture_with_english_llm_name_keeps_english_primary` proves this is intentional behavior. But it produces:

  pick_natural_primary('corporate bonds', None, '회사채', 'ko')       -> ('corporate bonds', 'en')   # BUG
  pick_natural_primary('Woori Asset Management', 'Woori Asset Management', '우리자산운용', 'ko') -> ('Woori Asset Management', 'en')   # BUG
  pick_natural_primary('SpaceX', 'SpaceX', '스페이스X', 'ko')          -> ('SpaceX', 'en')           # correct (brand)

Bug location: backend/api/structure/entity_resolver.py:67-90.

## Root cause: combination of prompt bias + resolver over-trust

Claude is permitted by the existing Step 2a (B-52) prompt to normalize `name` to a different language. For brands (SpaceX) that's fine. For Korean common nouns / firm names, it produces translations. The resolver then follows blindly.

## Fix plan: layered defense (A + B)

- Fix A: prompts.py Step 2a — add explicit "Korean common nouns and descriptive translations stay in source language" rule with three concrete examples (회사채, 우리자산운용, 스페이스X).
- Fix B: pick_natural_primary — when surface is Korean and llm_name is English and llm_name is NOT brand-shaped (single-token Latin <=16 chars), prefer Korean surface. English llm_name goes to aliases.

The brand heuristic is conservative: any Latin string with a SPACE in it is treated as a descriptive translation, not a brand. Single-token Latin tokens of 2-16 chars are presumed brand-like. This rejects "Woori Asset Management" (multi-word), keeps "SpaceX" / "OpenAI" / "KAIST" / "IBM" / "Toyota".

## Tests added
1. Unit: `test_pick_natural_primary_korean_surface_descriptive_english_llm_name_keeps_korean`
2. Unit: `test_looks_like_brand_*` (a few quick cases)
3. Unit: `test_resolve_entity_korean_surface_english_translation_creates_korean_primary` (defense at resolve_entity level)
4. Unit: `test_prompts_contains_korean_common_noun_rule` (pin the prompt clause)
5. Integration: `test_korean_common_noun_capture_preserves_korean_primary` in test_natural_spo_pipeline.py

Existing tests adjusted:
- test_korean_capture_with_english_llm_name_keeps_english_primary: stays as-is (SpaceX is brand-shaped, still wins). The test name's "english_primary" assertion remains correct because SpaceX is a brand.
