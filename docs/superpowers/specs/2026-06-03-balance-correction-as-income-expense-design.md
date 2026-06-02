# Balance correction as income / expense

**Date:** 2026-06-03
**Status:** Approved — ready for implementation plan

## Problem

Today, **Correct balance** (`set_account_balance`) records a neutral `adjustment`
transaction for the difference between an account's real balance and its computed
balance (when the account already has non-opening activity). Adjustments are
**excluded from dashboard reporting** (income, expense, net cashflow, spending
breakdown) — they affect balances only.

Sometimes that difference is *real money the user forgot to log*: bank interest is
income, a bank fee or unrecorded purchase is an expense. The user wants the option
to book a correction as a **real income or expense** so it counts in their
reporting totals, instead of being hidden as a neutral adjustment.

## Solution overview

Add an opt-in checkbox **"Record as income/expense"** to the Correct balance modal.
When checked, the correction's difference is booked as an `income` (diff > 0) or
`expense` (diff < 0) transaction — the **sign decides**, so there are no invalid
combinations. These corrections are auto-assigned to a new **protected "Adjustment"
category** (one income, one expense) that the user cannot delete, rename, archive,
reparent, hand-assign to other transactions, or change away from on a correction.
The category is hidden from the Categories management screen and the
Add/Edit Transaction picker, but still appears in dashboard reporting (so the
correction counts in income/expense totals and the spending breakdown).

When **unchecked** (the default), behavior is unchanged: a neutral `adjustment` is
recorded.

## Reintroducing protected categories

v0.4.1 dropped the `is_system` category flag (migration 004). This design
**reintroduces a dedicated `is_system` boolean column** rather than matching a
magic category name — it is explicit, robust against a user already owning a plain
"Adjustment" category, and easy to extend to future system categories.

## Data model & seeding

- **Migration 008** (append-only, data-preserving):
  `ALTER TABLE categories ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;`
  Existing rows get `0`. A plain add-column — **not** a table rebuild.
- `Category` (Rust `models.rs`) gains `pub is_system: bool`, serialized
  `rename_all = "camelCase"` → `isSystem`. `src/types.ts` `Category` gains
  `isSystem: boolean`. Row → struct mapping in `repo.rs` reads the new column;
  all category `SELECT`s must include `is_system`.
- **Seed (`db/seed.rs` `seed_categories`)**: insert two protected top-level
  categories — income **"Adjustment"** and expense **"Adjustment"**,
  `is_system = 1`, with a distinct emoji/color (⚖️). Use `INSERT OR IGNORE`
  **then promote**: run `UPDATE categories SET is_system = 1 WHERE kind = ?
  AND name = 'Adjustment' AND parent_id IS NULL` so that, even if a user already
  owns a plain top-level "Adjustment" category (the `idx_categories_top_kind_name`
  unique index blocks a second), exactly one system row exists per side. The
  promote step adopts a pre-existing "Adjustment" as the system row.
- **Backfill**: add a new gate **`defaults_v4_seeded`** to `BACKFILL_GATES`
  (`db/mod.rs`) so existing users pick up the two Adjustment rows. `seed_categories`
  always seeds the current full tree, so this gate also covers users who never hit
  an earlier gate. Idempotent.
- **Mock (`src/client/mock.ts`)**: `seedCategories` adds `isSystem` to existing
  rows (all `false`) and seeds the two Adjustment system rows (`isSystem: true`).

## Backend behavior

### `set_account_balance` signature change

New trailing param `record_as_income_expense: bool`, threaded through the whole
chain: `service::set_account_balance` → `commands::set_account_balance`
(Tauri arg `recordAsIncomeExpense`) → `src/client/index.ts`
`setAccountBalance(accountId, realBalanceCents, recordAsIncomeExpense)` →
`mock.ts` `set_account_balance` case. The mock and Rust must stay in lockstep.

Behavior matrix (account is not archived):

| Condition | Behavior |
|---|---|
| No non-opening activity (only the opening row) | Edit the opening row to equal the target. **Flag ignored.** (unchanged) |
| Has activity, `diff == 0` | No change. (unchanged) |
| Has activity, `diff != 0`, flag = **false** | Insert a neutral `adjustment` for `diff`, dated today. (unchanged) |
| Has activity, `diff != 0`, flag = **true** | Insert an `income` (diff > 0) or `expense` (diff < 0) transaction for `|diff|`, `category_id` = the system Adjustment category for that side, description "Balance adjustment", dated today, `transaction_time` NULL, `excluded_from_reporting = 0`. |

- `diff = real_balance_cents - acc.balance_cents` (signed). The sign chooses income
  vs expense; there is no separate income/expense toggle and no invalid combo.
- The correction inserts the transaction **directly via the repo** (then
  `materialize_postings`), bypassing the manual-create validation that rejects
  system categories (see guards below).
- A repo helper looks up the system Adjustment category id by
  `is_system = 1 AND kind = ? AND parent_id IS NULL`. The seed guarantees it exists.
- **Owe (liability) accounts**: the same signed-diff rule applies (reducing debt →
  income, increasing debt → expense). Mechanically identical (the posting engine
  handles income/expense for any account); the checkbox is available there too.

### Protection guards (service layer; mirrored in mock)

A "system category" is any category with `is_system = true`.

- `delete_category` → reject system categories (`Conflict`/`Validation`).
- `update_category` (rename / emoji / color / archive) → reject system categories.
- `set_categories_archived` / `set_children_archived` → skip or reject system rows.
- `set_category_parent` (reparent) → reject system categories.
- `reorder_categories` → system rows are never shown, so excluded naturally; no
  ordering operation should touch them.
- `validate_category_for` (used by manual create/update transaction) → **reject** a
  system category, so users cannot hand-assign "Adjustment" to a normal transaction.
- `update_transaction` → reject editing any transaction whose **existing category is
  a system category**, with the same treatment as `adjustment`:
  *"Balance corrections can't be edited — delete and reconcile again."* This
  enforces "can't change a correction to another category." **Deleting** such a
  correction remains allowed (normal income/expense delete path).

## Frontend

- **SetBalance modal (`src/modals/SetBalance.tsx`)**: add a checkbox **"Record as
  income/expense"** (default off), shown **only when `hasTransactions` is true**
  (hidden in the opening-balance case, per design Q4). When checked, the info box
  previews *"Records RM X.XX as **income**"* (diff > 0) or *"…as **expense**"*
  (diff < 0), dated today and counted in reporting — replacing the adjustment line.
  Pass the flag as the third arg to `client.setAccountBalance`.
- **Categories screen (`src/screens/Categories.tsx`)**: filter out `isSystem` rows
  everywhere — the master list, active/archived counts, and drag-reorder source.
- **Add/Edit Transaction picker (`src/lib/categories.ts`)**: `categoryTree` /
  `categoryPickerItems` exclude `isSystem` categories so they never appear in the
  transaction category picker.
- **Dashboard**: no change required. Corrections booked this way are ordinary
  `income`/`expense` rows, so income / net-cashflow and the spending breakdown
  pick them up automatically (the expense "Adjustment" surfaces in the breakdown,
  rolled up like any top-level category).

## Testing

- **Rust (`src-tauri/src/lib.rs` `#[cfg(test)]`):**
  - `set_account_balance(..., true)` with diff > 0 inserts an `income` row tagged
    the income Adjustment category; diff < 0 inserts an `expense` row; balance ends
    at the target; postings stay balanced.
  - `set_account_balance(..., true)` with no non-opening activity edits the opening
    row (flag ignored).
  - System Adjustment categories cannot be deleted / renamed / archived / reparented.
  - `validate_category_for` rejects a system category for manual create/update.
  - `update_transaction` rejects editing a correction (system-category) transaction;
    delete still works.
  - Migration 008 + `defaults_v4_seeded` backfill seeds exactly one system row per
    side, including when a plain "Adjustment" pre-exists (promotion path).
- **Vitest (`src/__tests__/mock.test.ts`):** mirror the above against the mock —
  income/expense by sign, protection guards, picker/screen exclusion, seeding.
- **Frontend gate:** `npm run build` (strict TS) and `npm test` stay clean;
  `cd src-tauri && cargo test --lib` passes.

## Out of scope

- No change to the neutral-adjustment default behavior or the opening-balance path.
- No per-correction category choice — corrections are always the locked Adjustment
  category; the only choice is adjustment vs income/expense.
- No new dashboard widget for corrections — they flow through existing reporting.

## Documentation

On implementation, update `CLAUDE.md` (balance-correction and categories sections),
`CHANGELOG.md` `[Unreleased]`, and any roadmap notes.
