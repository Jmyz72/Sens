# Backend, migrations & the mock seam

Layering conventions, errors, migrations, seeding, factory reset, and how the browser mock stays in sync.
Read this before adding a command, a migration, or changing seed data.

**Key files:** `src-tauri/src/{commands,service,repo}.rs` · `src-tauri/src/db/{migrations,seed,mod}.rs` ·
`src/client/{index,invoke,mock}.ts` · `src/generated/seed-catalog.json`

## Contents

- [Layering](#layering)
- [The Tauri / mock seam](#the-tauri--mock-seam)
- [Conventions](#conventions)
- [Migrations](#migrations)
- [Default categories and backfill](#default-categories-and-backfill)
- [Factory reset](#factory-reset)

## Layering

```
React UI (src/screens, src/modals, src/components)
  → typed client (src/client/index.ts)        one wrapper fn per command
    → dispatch seam (src/client/invoke.ts)     Tauri OR mock
      → Tauri commands (src-tauri/src/commands.rs)   thin, action-oriented
        → services (src-tauri/src/service.rs)        ALL business rules/validation
          → repositories (src-tauri/src/repo.rs)     ALL SQL + row→struct mapping
            → SQLite (src-tauri/src/db/)             migrations + idempotent seeds
```

The UI never touches SQL.

## The Tauri / mock seam

`src/client/invoke.ts` checks for `window.__TAURI_INTERNALS__`.

- **In Tauri:** calls the real Rust commands.
- **In a plain browser:** routes to **`src/client/mock.ts`**, an in-memory backend that mirrors the Rust
  logic (seeds, balance math, validation, errors). It is dev-only and never ships.

> ⚠ **Any change to a command's behavior, signature, or args must be made in BOTH the Rust chain
> and the mock**, or browser-dev and the packaged app diverge.

**Seed data is the exception.** It is generated, not hand-mirrored:

1. The mock's account subtypes, provider templates, and category tree come from the Rust source.
2. A `#[cfg(test)]` generator in `src-tauri/src/lib.rs` dumps a migrated + seeded in-memory DB
   into `src/generated/seed-catalog.json`.
3. `src/client/mock.ts` and `src/lib/providers.ts` consume that JSON.
4. After editing the Rust seed (`db/seed.rs`, or a migration that changes subtypes), run
   `npm run gen:seed-catalog` and **commit the regenerated JSON**.
5. The `seed_catalog_json_is_fresh` test fails CI (via `cargo test --lib`) if the JSON is stale.

## Conventions

- **UUIDs and timestamps** are generated in Rust by the backend and never sent from the frontend.
- Structs serialize `rename_all = "camelCase"` to match the TS types in `src/types.ts`.
- **Errors:** `AppError` (`ValidationError | NotFound | Conflict | DatabaseError`) serializes to
  `{code, message}`.
  - The TS `AppError` and the mock throw the same shape.
  - Surface errors via toast (page-level) or inline (form-level).
- The DB lives in the Tauri app-data dir. Every connection sets `PRAGMA foreign_keys = ON`.

## Migrations

- **Append-only** in `db/migrations.rs`.
- Each migration runs in its own transaction: the runner sets `PRAGMA foreign_keys = ON`, then wraps
  the migration in `BEGIN…COMMIT`.
- First-run seeding and the `seeded` flag commit atomically.
- The runner applies migrations **cumulatively**, so a DB at any earlier version is carried forward.
  Fresh installs run **001 → 015** and reach the same end schema.
- There are no existing users, so don't add backfill or conversion for a prior user base. Keep
  migrations append-only so a local dev DB and a fresh install match.

| Migration | What it does | Why it matters |
|---|---|---|
| 002 | Creates and seeds `account_subtypes` | Source of the subtype → type → group mapping |
| 003 | Adds `categories.parent_id` | Two-level categories |
| 004 | Drops `is_system` | Reintroduced by 008 |
| 005 | **Rebuilds `transactions`**, backfills one `opening` row per account, then drops `accounts.opening_balance_cents` | Order matters: rebuild → backfill → drop. The rebuild adds the `opening` kind and `excluded_from_reporting`. It is FK-safe only because nothing referenced `transactions` yet. |
| 006 | Adds `postings` (double-entry ledger) | Two legs backfilled per existing transaction |
| 007 | `ALTER TABLE transactions ADD COLUMN transaction_time TEXT` | **Plain ALTER, not a rebuild** (existing rows get NULL) |
| 008 | Reintroduces `is_system`, seeds the two "Adjustment" categories | Used by income/expense balance corrections |
| 009 | `CREATE TABLE transaction_splits` | **Plain CREATE, not a rebuild** |
| 010 | Adds `credit_limit_cents` | Credit-card and BNPL limits |
| 011 | **Rebuilds `transactions`** to add the `payment` kind to the CHECK, copying `postings` and `transaction_splits` first | Safe because the cascading child tables are copied before the swap |
| 012 | **Rebuilds `transactions`** to add the `reimbursement` kind and the nullable `expected_reimbursement_cents`, then creates `reimbursement_allocations` | Copies `postings` and `transaction_splits` first (like 011); the allocations table is created after the swap |
| 013 | Creates `category_budgets` and `savings_goals` | Versioned monthly amounts per expense category; named savings targets on one account each |
| 014 | Adds `gain_category_id` and `loss_category_id` on `accounts` | Optional categories for Update Net Worth |
| 015 | Creates `schedules` and `schedule_occurrences` | Recurring templates and posted or skipped dates. New tables, not a rebuild of `transactions` |

Plan commands (mirrored in `mock.ts`): `get_plan`, `set_budgets`, `create_goal`, `update_goal`, `delete_goal`.

Schedule commands (mirrored in `mock.ts`): `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`, `list_upcoming`, `post_occurrence`, `skip_occurrence`, `run_schedule_pass`.

> ⚠ After migration 006, **a naive rebuild of `transactions` deletes every posting and split**
> (`ON DELETE CASCADE`). Prefer `ALTER … ADD COLUMN` or a new table (as 007 and 009 do). If a table
> CHECK must change, copy `postings` and `transaction_splits` before the swap (as 011 and 012 do).

## Default categories and backfill

- Default categories and subcategories **seed once** on first run.
- Existing users receive additions through **gated, idempotent backfill**:
  - One `backfill_gate` per flag in `BACKFILL_GATES`: `defaults_v2_seeded`, `defaults_v3_seeded`
    (plus `defaults_v4_seeded` for the system categories; see [categories.md](./categories.md#system-categories)).
  - Backfill uses `INSERT OR IGNORE`, so defaults a user deleted do **not** resurrect once the gate has run.
- The default lists in `db/seed.rs` are **append-only by convention**.
  - Backfill can INSERT but never rename or delete.
  - Renaming a default would leave existing users with both rows.
  - A removed default (e.g. the dropped `Investments` income category) simply stops seeding for new
    users and resets; existing users keep theirs.
- **Bump a new `defaults_vN_seeded` gate whenever you enrich the default tree**, so existing users
  pick up the additions. A single later gate also covers users who never hit an earlier one, because
  `seed_categories` always seeds the current full tree.
- Saving/investing, loans & debt, reimbursements/claims (the `reimbursement` kind), and card payments are intentionally
  **not categories**. They are money movement, handled by their own transaction kinds and later-phase features (see [`ROADMAP.md`](../../ROADMAP.md)).
- All defaults are normal (non-system) rows that users can archive or delete.
- Top-level categories are deduped by the partial unique index `idx_categories_top_kind_name`
  on `(kind, name) WHERE parent_id IS NULL`.

## Factory reset

The `reset_app` command (`service::reset_app` → `db::reset_to_defaults`):

- Wipes `schedule_occurrences` and `schedules` first, then `savings_goals` and `category_budgets`, `reimbursement_allocations` (its `expense_id` FK is `RESTRICT`), `postings`, `transactions`, `categories`, `accounts`, and `app_settings` in **one transaction**.
- Re-runs the idempotent seed, re-setting the `seeded` flag and all `defaults_v*_seeded` flags.
- Mirrored by `resetApp()` in `mock.ts`.
- Exposed in Settings → Danger zone (type `RESET` to confirm).
