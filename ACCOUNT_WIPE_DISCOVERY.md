# Account Data Wipe — Discovery

PR: `feat/account-data-wipe`
Branch base: `db5a11a` (origin/main)
Script: `backend/scripts/wipe_account_knowledge.py`
Tests: `backend/tests/integration/test_account_data_wipe.py`

## Goal

Clean-slate the PO account (`kihpark85@gmail.com`) so dogfood can start
from a verified empty state — WITHOUT dropping the user row, the
admin flag, OPL seed data, the global taxonomy, or any other user's
data. Schema/migrations are untouched.

The procedure is a **data operation**, not a code change: the backend
does not need to restart and no migration is touched.

## Knowledge-space deletion: choice (a)

Two interpretations of "clean-slate" were considered:

  (a) **Keep the PO's `knowledge_spaces` rows**; wipe everything
      INSIDE them. After a wipe, the PO's KS shells still exist and
      every capture/recall code path that assumes "user has at least
      one personal space" continues to work.

  (b) Delete the `knowledge_spaces` rows too and rely on the login
      / first-capture path to lazily create a fresh personal space.

The spec wording is "처음부터 dogfood 가능한 clean-slate" alongside
"스키마·OPL seed·계정 자체 보존". Choice **(a)** preserves more
account-shell state without changing the meaning of the wipe (every
piece of *content* is gone). It is also strictly safer: we did not
exhaustively verify that every read path (recall, settings, capture
intake) auto-creates a missing KS, and the cost of being wrong is a
broken login on a fresh dogfood start. Choosing (a) eliminates that
risk.

## Tables wiped (Postgres)

Every delete is scoped — `WHERE user_id = <PO_user_id>` for the
user-keyed tables, and `WHERE from_fact_uid IN <PO fact_uids> OR
to_fact_uid IN <PO fact_uids>` for the only fact-keyed table.

  - `source_jobs`              user_id (CASCADE) — captures / extraction
  - `structure_metrics_logs`   user_id (also cascades from source_jobs)
  - `validation_logs`          user_id (source_job_id SET NULL)
  - `graph_notes`              user_id — review-mode notes on facts
  - `disambiguation_logs`      user_id — telemetry referencing fact_uids
  - `precision_logs`           user_id — telemetry
  - `negation_logs`            user_id — telemetry
  - `contradiction_logs`       user_id — telemetry
  - `understanding_depth_logs` user_id — aggregate per-KS telemetry
  - `fact_relations`           by from_fact_uid OR to_fact_uid IN
                               PO's fact_uids (collected from ES BEFORE
                               the ES wipe). Schema-only in current
                               migrations but defended for forward
                               compatibility.

## Tables preserved (Postgres)

  - `users`                    PO's own row, with `is_admin` intact
  - `knowledge_spaces`         PO's KS shells (choice (a))
  - `user_settings`            validation_mode + surface_on_by_default
  - `source_policies`          per-domain Trusted/Careful policy
  - `archetype_surveys`        onboarding 5-dim wedge survey
  - `sessions`                 auth tokens (PO stays logged in)
  - `predicates`               OPL controlled vocabulary (global)
  - `tags`                     hashtag taxonomy (global)
  - all other users            strictly user-scoped delete

## ES indices wiped

Every `delete_by_query` carries a `terms.knowledge_space_id` filter
with the PO's KS ids. If the PO has no KS ids (defensive), the call
is SKIPPED — there is no `match_all` code path.

  - `lucid_facts`         `terms.knowledge_space_id IN <PO KS ids>`
  - `lucid_objects`       `terms.knowledge_space_id IN <PO KS ids>`
  - `lucid_sources`       `terms.knowledge_space_id IN <PO KS ids>`

## ES indices preserved

  - `lucid_applications`  landing intake — pre-account, public, never
                          scoped to a user; not the PO's data

## Safety properties

  - Every PG delete has a `WHERE` clause scoped to `user.id` or to
    PO fact_uids; never an unconditional `DELETE FROM table`.
  - Every ES delete has a `terms.knowledge_space_id` filter; never
    `match_all`. If the filter list would be empty, the call is
    skipped.
  - Dry-run (default, no `--apply`) only runs `SELECT count(*)` and
    `client.count()` — zero writes.
  - Idempotent: the second `--apply` returns zero counts because the
    first wipe deleted everything in scope.
  - Verification: after `--apply`, the script re-runs the same count
    queries and prints a check/cross per row, plus confirms the user
    row is present and `is_admin` is unchanged.

## FK scoping

Order of deletes (children -> parents -> root) guarantees no FK
violation even though the CASCADE chain would also do the right thing:

  1. ES delete_by_query (must precede `fact_relations` because the
     ES scan is what supplies the fact_uid list — but we collect the
     fact_uid list FIRST, then ES delete, then PG)
  2. `fact_relations`           (by from_/to_fact_uid)
  3. `structure_metrics_logs`   (FK to source_jobs + user_id)
  4. `validation_logs`          (FK to source_jobs SET NULL + user_id)
  5. `source_jobs`              (FK to users + knowledge_spaces)
  6. `graph_notes`
  7. `disambiguation_logs`, `precision_logs`, `negation_logs`,
     `contradiction_logs`
  8. `understanding_depth_logs`
  9. `session.commit()`

The explicit per-table delete is safer than relying on CASCADE for
two reasons: (i) we want pre/post counts per table for the
verification table, and (ii) `validation_logs.source_job_id` is
`SET NULL` not `CASCADE`, so dropping the source_jobs row without
the parallel `validation_logs` delete would leave orphan log rows
on the PO's `user_id` — still wiped by our `validation_logs` delete
because that delete is also scoped to `user_id`.

## Usage

```bash
# Dry-run (prints pre-counts, NO writes)
docker compose exec backend python -m scripts.wipe_account_knowledge \
    --email kihpark85@gmail.com

# Apply (deletes + prints post-verification table)
docker compose exec backend python -m scripts.wipe_account_knowledge \
    --email kihpark85@gmail.com --apply
```
