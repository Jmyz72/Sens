# Backend, migrations & the mock seam

Layering conventions, errors, migrations, seeding, factory reset, and how the browser mock stays in sync.
Read this before adding a command, a migration, or changing seed data.
The agent (MCP) server has its own topic: [`mcp.md`](mcp.md).

**Key files:** `src-tauri/src/{commands,service,repo}.rs` · `src-tauri/src/db/{migrations,seed,mod}.rs` ·
`src-tauri/src/{drafts,ai,ocr}.rs` · `src/client/{index,invoke,mock}.ts` · `src/generated/seed-catalog.json`

## Contents

- [Layering](#layering)
- [The Tauri / mock seam](#the-tauri--mock-seam)
- [Conventions](#conventions)
- [Migrations](#migrations)
- [Photo import (Drafts)](#photo-import-drafts)
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
  - `AppError::Ai(code, message)` carries its own stable code for photo import: `ocr_unavailable`,
    `ocr_empty`, `ai_not_configured`, `ai_unreachable`, `ai_auth`, `ai_bad_response`. Messages never
    include the API key (request errors are reported `without_url()`).
  - The TS `AppError` and the mock throw the same shape.
  - Surface errors via toast (page-level) or inline (form-level).
- The DB lives in the Tauri app-data dir. Every connection sets `PRAGMA foreign_keys = ON`.

## Migrations

- **Append-only** in `db/migrations.rs`.
- Each migration runs in its own transaction: the runner sets `PRAGMA foreign_keys = ON`, then wraps
  the migration in `BEGIN…COMMIT`.
- First-run seeding and the `seeded` flag commit atomically.
- The runner applies migrations **cumulatively**, so a DB at any earlier version is carried forward.
  Fresh installs run **001 → 016** and reach the same end schema.
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
| 016 | Creates `import_drafts` (`id`, `source_name`, `payload` JSON, `created_at`, `updated_at`) | Photo-import drafts awaiting review. Not transactions: no postings, no balance effect, no foreign keys |
| 017 | Creates `ai_providers` and deletes the old `ai_base_url` / `ai_model` / `ai_api_key` settings | Ordered AI provider list (see Photo import) |
| 018 | Creates `mcp_audit_log` and `idx_mcp_audit_log_at` | One row per agent write call. New table; cleared by factory reset. See [`mcp.md`](mcp.md) |

MCP commands (stubbed in `mock.ts`; the server is Rust-only): `get_mcp_status`, `set_mcp_enabled`,
`rotate_mcp_token`, `list_mcp_audit`. `get_setting` / `set_setting` reject keys starting with `mcp_`.
Details in [`mcp.md`](mcp.md).

Plan commands (mirrored in `mock.ts`): `get_plan`, `set_budgets`, `create_goal`, `update_goal`, `delete_goal`.

Schedule commands (mirrored in `mock.ts`): `list_schedules`, `create_schedule`, `update_schedule`,
`delete_schedule`, `list_upcoming`, `post_occurrence`, `skip_occurrence`, `run_schedule_pass`. Client
wrappers: `client.postScheduleOccurrence` and `client.skipScheduleOccurrence` (plus the other schedule
helpers in `src/client/index.ts`).

- **`create_schedule` / `update_schedule` / `delete_schedule`** only change `schedules` (and
  `delete_schedule` cascades occurrence rows). They do **not** run the pass.
- `schedules.account_id`, `to_account_id`, and `category_id` have **no foreign keys**. A missing target
  shows as a block reason instead of failing the save.
- **`run_schedule_pass`** (`schedules::run_pass`) uses **`local_now()`**, auto-posts every due **auto**
  schedule, returns `{ posted, nextWakeAt }`, and is what drives catch-up while Sens was closed or asleep.
- **`list_upcoming`** is computed from tap schedules and the clock; **`post_occurrence`** /
  **`skip_occurrence`** write `schedule_occurrences` and enforce open dates (settled dates →
  **`ValidationError`**).
- The React app invokes **`run_schedule_pass`** after every schedule save or delete and on open, focus,
  and the next wake (`src/lib/useScheduleEngine.ts`).

> ⚠ After migration 006, **a naive rebuild of `transactions` deletes every posting and split**
> (`ON DELETE CASCADE`). Prefer `ALTER … ADD COLUMN` or a new table (as 007 and 009 do). If a table
> CHECK must change, copy `postings` and `transaction_splits` before the swap (as 011 and 012 do).

## Photo import (Drafts)

Spec: `docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md`; the provider list and
fallback: `docs/superpowers/specs/2026-10-21-ai-provider-fallback-design.md`.
The image is read by the OS, only the text goes to an OpenAI-compatible LLM, and the result is stored
as drafts the user confirms one by one.

| Module | Role |
|---|---|
| `src-tauri/src/ocr.rs` | `recognize(bytes)`: Apple Vision on macOS (`objc2-vision`), `Windows.Media.Ocr` on Windows (`windows` crate), and an `ocr_unavailable` stub elsewhere. Empty text → `ocr_empty`. The image is never stored. |
| `src-tauri/src/ai.rs` | Prompt builder (today's date, active account names, the expense/income category tree, OCR text capped at 20,000 chars), reply parsing, and the `reqwest` client for `POST {base_url}/chat/completions`. Asks for JSON mode and repeats once without it on a 400; a reply that fails to parse gets one retry with the error. `extract_with_fallback` tries each provider in order and moves on after any error. No DB access. |
| `src-tauri/src/drafts.rs` | Service-layer module (like `schedules.rs`): amount text → cents, name → ID matching (normalised exact match, then a unique prefix; ambiguous stays empty), hints, blocking problems, draft CRUD, confirm, and the AI provider list. SQL stays in `repo.rs`. |

**Commands** (all mirrored in `mock.ts`):

- **`ocr_image`** takes the image as a **raw IPC body**, not JSON args (`dispatchRaw` in
  `src/client/invoke.ts`, `client.ocrImage`), so a photo is not sent as a JSON number array. OCR runs in
  `spawn_blocking`. The mock ignores the bytes and returns canned receipt text.
- **`extract_drafts(sourceName, text)`** reads the enabled providers and lookups under one short lock,
  calls `ai::extract_with_fallback` **without holding the DB lock**, then stores the rows. It returns
  `ExtractResult { drafts, provider, skipped }`: the provider that answered and the earlier ones that
  failed, with their reasons. No enabled provider → `ai_not_configured`; every provider failed →
  `ai_all_failed`, whose message lists `name: reason` in order. The mock skips the LLM, reports the first
  enabled provider, and returns one expense (plus a transfer when there are two accounts).
- **`list_import_drafts`**, **`update_import_draft(id, fields)`**, **`discard_import_drafts(ids)`**,
  **`confirm_import_drafts(ids)`**.
- **`list_ai_providers`**, **`create_ai_provider(input)`**, **`update_ai_provider(id, input)`**,
  **`set_ai_provider_enabled(id, enabled)`**, **`delete_ai_provider(id)`**, **`reorder_ai_providers(ids)`**
  (the full id list, like `reorder_categories`), **`test_ai_provider(id)`** (that provider only, no
  fallback, ignores the switch).

**Drafts**

- `payload` holds `DraftFields` (kind, date, time, amount cents, account, to-account, category, note,
  `hints`). `problems` are recomputed on every read and are not stored.
- **Hints** are advisory: `low_confidence` (below 0.6), `date_assumed` (today), `time_assumed`,
  `kind_assumed` (expense), `future_date`, `non_myr`, `unmatched_account`, `unmatched_category`. Any edit
  clears them.
- **Problems** block confirm: `amount`, `date`, `time` (only while times are on), `account`, `to_account`
  (missing or same as `account`), `category` (income/expense), `kind`.
- With **Record transaction times** on, a row with no time gets `00:00` and the `time_assumed` hint
  instead of a `time` problem.
- **Confirm** posts each draft independently through `service::create_expense` / `create_income` /
  `create_transfer` and deletes the draft in the same transaction. A failure (problems left, or a
  service error such as an archived account) leaves that draft in place and is returned in
  `ConfirmResult.failed`; the other drafts still post. A transfer draft whose destination is a credit
  card or BNPL account is confirmed as a payment (`service::create_payment`).

**AI providers** live in the `ai_providers` table (migration 017): name (unique ignoring case), base URL
(must start with `http://` or `https://`; trailing `/` trimmed), model, optional key, an enabled flag and
a dense `position` (0 is tried first). Migration 017 deleted the old `ai_base_url` / `ai_model` /
`ai_api_key` settings rows. Factory reset empties the table.

- The key is **write-only from the frontend**: every command returns `hasKey`, never the key.
- In `update_ai_provider`, `apiKey: null` keeps the saved key and `""` clears it.
- The key is stored unencrypted in the local database (no OS keychain). The Settings card says so.

**Dependencies:** `reqwest` 0.13 (`json`, `rustls-no-provider`) with `rustls` + `ring` installed as the
crypto provider once per process; `objc2`, `objc2-foundation`, `objc2-vision` on macOS; `windows` 0.61
(`Media_Ocr`, `Graphics_Imaging`, `Storage_Streams`, …) on Windows.

> ⚠ CI runs on Ubuntu, so it compiles only the stub OCR backend. The macOS backend is built locally;
> the **Windows backend is only compiled by the release workflow** and has not been run on Windows.
> The `ai.rs` tests drive the HTTP client against a local stub server; no test calls a real provider.

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

- Wipes `import_drafts`, `mcp_audit_log`, `schedule_occurrences` and `schedules` first, then `savings_goals` and `category_budgets`, `reimbursement_allocations` (its `expense_id` FK is `RESTRICT`), `postings`, `transactions`, `categories`, `accounts`, and `app_settings` in **one transaction**.
- Re-runs the idempotent seed, re-setting the `seeded` flag and all `defaults_v*_seeded` flags.
- The Tauri command goes through `McpHandle::reset_with`, which also stops the agent server and clears the live token (the `mcp_*` settings go with `app_settings`).
- Mirrored by `resetApp()` in `mock.ts`.
- Exposed in Settings → Danger zone (type `RESET` to confirm).
