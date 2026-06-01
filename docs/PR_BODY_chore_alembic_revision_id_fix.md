# chore/lucid-alembic-revision-id-fix — restore the broken 0011→0012 chain

Off `main` (commit 3f6e36b). Tiny follow-up branch addressing the broken Alembic chain Walking Skeleton Iteration 1 surfaced.

## Root cause

PR-3-2 (0012), DR-066 track A (0013), and PR-4B-1 (0014) all used **short-form** revision IDs:

```python
revision = "0012"
down_revision = "0011"
```

But 0001-0011 use **long-form** revisions like:

```python
revision: str = "0010_extracted_content"
down_revision: str | None = "0009_source_jobs"
```

So 0012's `down_revision = "0011"` pointed at a revision that doesn't exist — 0011's actual `revision` is `"0011_source_status_structure"`. `ScriptDirectory.walk_revisions()` raised `KeyError: '0011'`, so `alembic upgrade head` failed on any fresh database.

PO had been sed-patching 0011 down to `"0011"` locally to work around this; that fix is brittle (it kept reappearing as a stray diff during PR-2A-2 walking-skeleton verification) and would also require a manual `UPDATE alembic_version` on any database that already applied 0010 with the long-form revision.

## Fix

Align 0012/0013/0014 to the long-form convention. This:
- restores the chain without touching 0001-0011
- doesn't touch any already-applied row in `alembic_version`
- keeps the type annotations consistent with the other ten migrations

```python
# 0012_structure_metrics_logs.py
revision: str = "0012_structure_metrics_logs"
down_revision: str | None = "0011_source_status_structure"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None

# 0013_understanding_depth_logs.py
revision: str = "0013_understanding_depth_logs"
down_revision: str | None = "0012_structure_metrics_logs"
...

# 0014_validation_logs.py
revision: str = "0014_validation_logs"
down_revision: str | None = "0013_understanding_depth_logs"
...
```

Also added the typed annotations on `branch_labels` / `depends_on` (the new files were using untyped assignments).

## Why not normalise 0001-0011 to short-form instead?

- 0001-0011 is 11 files vs 0012-0014's 3
- Any database that already applied 0010 has `alembic_version.version_num = '0010_extracted_content'`; switching to short-form would require a manual `UPDATE alembic_version SET version_num = '0010' WHERE version_num LIKE '%_%'` per environment
- The long-form is more descriptive when reading the migration log

## DoD

| Check | Result |
|-------|--------|
| `ScriptDirectory.walk_revisions()` | 14 revisions, single head (`0014_validation_logs`) |
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in 90 source files |
| `pytest tests/unit -q` | **215 passed** — backend untouched apart from the three migrations |
| `alembic upgrade head` (PO docker) | should succeed without the manual sed patch |

## Commit

```
6ecb2de  chore(alembic): align 0012/0013/0014 revisions to long-form convention
```

## What this PR does NOT do

- Does NOT touch 0001-0011 — they were correct
- Does NOT change any `upgrade()` / `downgrade()` body — only the metadata block
- Does NOT introduce a test for the chain integrity — the integration test `tests/integration/test_postgres_migrations.py` already runs `alembic upgrade head` on a clean Postgres in CI / docker

## Test plan

- [ ] `cd backend && python -c "from alembic.script import ScriptDirectory; from alembic.config import Config; print(len(list(ScriptDirectory.from_config(Config('alembic.ini')).walk_revisions())))"` → 14
- [ ] PO docker: `alembic upgrade head` succeeds without any sed patches
- [ ] `pytest tests/integration/test_postgres_migrations.py` → green
