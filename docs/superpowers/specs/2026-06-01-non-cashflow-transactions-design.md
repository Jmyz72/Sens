# v0.5.0 — Non-cashflow transactions

**Status:** Design approved · **Target release:** `v0.5.0` · **Date:** 2026-06-01

## Summary

v0.5.0 makes Sens distinguish **money movement** from **real income/expense**. Some
rows change an account's balance but are not new income or spending — they must be
excluded from the dashboard's income / expense / net-cashflow / spending-breakdown,
exactly as `transfer` and `adjustment` already are.

This phase has **two pillars**:

1. **Opening balance becomes a transaction** (foundational refactor / bug fix). Today
   an account's starting balance lives in the `accounts.opening_balance_cents`
   **column**, so an account's balance never reconciles against its visible
   transaction history — the starting money has no row. We introduce a structural
   **`opening` transaction kind**: exactly one per account, the first row in its
   history. This is the first *non-cashflow kind* and the groundwork the rest of the
   phase builds on.

2. **A non-cashflow flag on income/expense** (the roadmap headline). A normal
   `income`/`expense` transaction can be flagged **`excludedFromReporting`** — it
   keeps its category, sign, and balance effect, but the dashboard skips it. This
   covers reimbursements/claims (money back, not new income) and repayments to an
   external party (money out, not a new expense). It is the groundwork **v0.6.0**
   (credit & debt behavior) leans on.

> **Breaking change — no upgrade path.** This phase changes the database schema and
> **does not migrate data from older versions**. The `accounts.opening_balance_cents`
> column is removed and the `transactions` `kind` CHECK changes. Anyone on a pre-v0.5.0
> local database must start fresh: **delete the app-data database file** (an in-app
> factory reset is *not* sufficient — `reset_to_defaults` only deletes rows, it does
> not reshape tables). This is acceptable because the project is pre-1.0 with no
> production users.

## Why a flag, not new kinds (decision record)

- **Opening** is a real `kind` because it is *structural*: exactly one per account,
  never user-created, never deleted, signed (negative for `owe` accounts). It earns a
  place in the `kind` vocabulary.
- **Repayments / reimbursements** are *not* structural — they look like ordinary
  income/expense, carry a normal category, and vary case by case. Modeling them as a
  **boolean flag** on `income`/`expense` keeps the `kind` vocabulary small and gives
  the feature full flexibility, instead of multiplying kinds (`repayment`,
  `reimbursement`, …) — each of which would add `kind` match arms, CHECK clauses,
  colors, and mock branches.
- **Already handled by `transfer`:** a credit-card payment or loan repayment **between
  two of your own accounts** is an own→owe `transfer`, which the dashboard *already*
  excludes. The flag is for cases that genuinely *look* like income/expense but
  shouldn't count — a reimbursement landing in your bank, or paying an external party.

So the model is a **hybrid**: structural `opening` kind + an `excludedFromReporting`
flag on income/expense.

---

## Pillar 1 — Opening balance as a transaction

### Data model

`transactions.kind` gains `'opening'`. The new `kind` CHECK (rewritten in migration
001 — see *Migration*):

```sql
CHECK (
  (kind IN ('income','expense') AND amount_cents > 0  AND to_account_id IS NULL     AND category_id IS NOT NULL) OR
  (kind = 'transfer'   AND amount_cents > 0  AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
  (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0) OR
  (kind = 'opening'    AND                       to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0)
)
```

- `opening.amount_cents` may be **any** value — positive, `0`, or negative (an `owe`
  account opens with a negative opening balance, matching signed-liabilities).
- The `accounts.opening_balance_cents` **column is removed** from the table.

### Lifecycle (always-present, never-deletable)

- **Exactly one `opening` transaction per account.** Created atomically with the
  account in `create_account`, dated the account's creation date, with `created_at`
  set so it sorts **first** in the account's history (it is inserted before any other
  row can exist).
- **Never deletable** and **not freely creatable** via Add Transaction — it is
  structural, special-cased like `adjustment`. Its *amount* is the only mutable part,
  changed only through the account's opening-balance field (Edit Account) or the
  fresh-account branch of balance correction (below).

### `Account.openingBalanceCents` stays — as a derived read

The serialized `Account` keeps `openingBalanceCents` so AddAccount/EditAccount need no
API reshaping — but it is **derived from the opening transaction**, not a stored
column:

```sql
COALESCE((SELECT amount_cents FROM transactions
          WHERE account_id = a.id AND kind = 'opening' LIMIT 1), 0) AS opening_balance_cents
```

This is added to `map_account` / the account list + get queries.

### Balance engine simplifies

`balance_expr` (`repo.rs`) drops its `opening_balance_cents` column term; opening is
now just the first signed row. The expression becomes a pure sum of signed history,
adding the new kind to the account-side sum:

```
  COALESCE(SUM amount WHERE kind='income'     AND account_id    = a.id)
+ COALESCE(SUM amount WHERE kind='opening'    AND account_id    = a.id)   -- already signed
+ COALESCE(SUM amount WHERE kind='transfer'   AND to_account_id = a.id)
+ COALESCE(SUM amount WHERE kind='adjustment' AND account_id    = a.id)
- COALESCE(SUM amount WHERE kind='expense'    AND account_id    = a.id)
- COALESCE(SUM amount WHERE kind='transfer'   AND account_id    = a.id)
```

Mirror in `mock.ts` `balanceOf`: start the accumulator at **0** (not
`a.openingBalanceCents`) and include `opening` rows in the account-side sum.

`computeRunningBalances` (`src/lib/kinds.ts`) **loses its `openingBalanceCents`
parameter** and starts the running total at **0**; the opening transaction is now part
of the passed-in list and provides the base. `signedFor` treats `opening` like
`adjustment` — the amount is already signed, return it as-is. Callers
(Transactions/Accounts "balance after" column) pass the full list including opening.

### `create_account` and editing the opening balance

- `create_account(name, subtype, openingBalanceCents, templateKey?)` **keeps its
  signature.** It inserts the account row, then inserts the single `opening`
  transaction with `amount_cents = openingBalanceCents`, in one transaction.
- **Edit Account → opening balance field:** `update_account` / `update_account_fields`
  no longer writes a column; when `openingBalanceCents` is provided it **UPDATEs the
  account's opening transaction's `amount_cents`** (a new `repo::set_opening_amount`).

### `set_account_balance` redesign

Detection changes from "has any transactions" to "has **non-opening activity**"
(every account now has ≥1 row — the opening). New helper
`repo::account_has_nonopening_activity` (a row where `kind <> 'opening'` touching the
account via `account_id` *or* `to_account_id`).

- **No non-opening activity** (only the opening row exists) → **edit the opening
  transaction's amount** so the balance equals the target. No noisy adjustment row —
  preserves today's "fresh account → edit opening" intent.
- **Has non-opening activity** → insert a signed `adjustment` for the difference
  (unchanged from today).

Mirror both branches in `mock.ts`.

### Presentation

- New `TransactionKind` member `'opening'` in `src/types.ts`. `CategoryKind` is
  unchanged (opening has no category).
- **New dedicated theme token** `opening` — a neutral **slate** — added to both dark
  and light maps in `src/theme/tokens.ts`. A new **`flag`** icon is added to the
  `IconName` union in `src/components/Icon.tsx` (the existing set has no
  start/opening glyph). `KIND_META.opening = { label: "Opening
  balance", icon: "flag", colorKey: "opening", sign: 0 }`. Wire the token
  through `kindColor`. Color is never the only cue — the row also carries the icon and
  a signed amount, per the existing UI rule.
- `KIND_FILTERS` in `src/screens/Transactions.tsx` gains `"opening"` so it is
  filterable. The opening row renders read-only (no edit/delete), matching the
  adjustment treatment.

---

## Pillar 2 — Non-cashflow flag on income/expense

### Data model

`transactions` gains:

```sql
excluded_from_reporting INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_reporting IN (0,1))
```

The flag may be `1` **only on `income`/`expense`** rows — enforced by the per-kind
CHECK above (`transfer`/`adjustment`/`opening` clauses pin it to `0`) and re-validated
in the service layer. For all non-income/expense kinds it is always `0` (they are
already excluded by kind).

Serialized on `Transaction` as `excludedFromReporting: boolean` (Rust `bool`). Add to
the create/update transaction command inputs (`UpdateTransactionInput` and the add
path).

### Service rules

- On create/update of an `income`/`expense` transaction, accept and persist the flag.
- Reject (`ValidationError`) any attempt to set the flag on a non-income/expense kind.
- Editing the flag follows the existing income/expense edit path (adjustments/opening
  remain non-editable).

### Dashboard exclusion

The dashboard already excludes by kind; extend it to also skip flagged rows:

- `sum_kind_in_range` (used for `income` and `expense`) — add
  `AND excluded_from_reporting = 0`.
- `spending_breakdown` — add `AND t.excluded_from_reporting = 0`.
- `opening` is excluded automatically: the income/expense sums name their kinds
  explicitly, transfers/adjustments were already excluded, and `opening` is never
  summed into income/expense or the spending breakdown.

Mirror all of the above in `mock.ts`'s dashboard computation.

### Presentation

- **Add/Edit Transaction modal** (`src/modals/AddTransaction.tsx`): when kind is
  `income` or `expense`, show a toggle — **"Money movement (exclude from reports)"** —
  bound to `excludedFromReporting`. Hidden for transfer/adjustment. Copy clarifies it
  still affects balances.
- **Transactions screen / `TxnRow`**: flagged rows show a small **"Excluded"** badge
  (text + an icon, not color-only) so the exclusion is visible in the log.

---

## Migration (breaking, no data preserved)

The migration runner (`db::run_migrations`) applies any `MIGRATIONS` entry whose
version exceeds the max recorded in `schema_migrations`, with **no checksums**. Because
we have no users to preserve and an in-app factory reset cannot reshape tables, we make
the change by **editing the base schema in migration 001 directly**:

1. Remove `opening_balance_cents` from the `accounts` `CREATE TABLE`.
2. Add the `excluded_from_reporting` column to the `transactions` `CREATE TABLE`.
3. Replace the `transactions` `kind` CHECK with the four-clause version above
   (adds `opening`, pins the flag to `0` on non-income/expense).

This **deliberately overrides the "append-only — never edit a shipped migration"
convention** in `migrations.rs`. It is safe *only because* this is a declared breaking
change with no real users; the convention exists to protect shipped data, which we
have agreed does not exist. A fresh install builds the clean schema in one shot; an old
local DB is unsupported and must be deleted.

No migration 005 is added. (The alternative — a table-rebuild migration 005 that
backfills opening transactions and drops the column — is rejected: it is more SQL and
exists solely to protect users we have agreed don't exist.)

Update the test/seed inserts that reference the dropped column:
`src-tauri/src/lib.rs:469`, `src-tauri/src/db/mod.rs:221`, and any `#[cfg(test)]`
account inserts.

## The Tauri/mock seam — parity checklist

Every backend change above must land in **both** the Rust chain and `src/client/mock.ts`:

- [ ] `opening` kind in balance math (`balanceOf` starts at 0, includes opening)
- [ ] `createAccount` inserts an opening transaction
- [ ] `setAccountBalance` two-branch logic (edit opening vs insert adjustment)
- [ ] derived `openingBalanceCents` on the mock `Account`
- [ ] edit-opening-balance updates the opening transaction
- [ ] `excludedFromReporting` accepted on add/update; rejected on non-income/expense
- [ ] dashboard skips flagged income/expense and never counts `opening`

## Testing

**Rust (`cargo test --lib`):**
- create_account produces exactly one `opening` transaction with the given (signed)
  amount; account balance equals it.
- `owe`-account opening is negative; balance and net worth match.
- editing the opening balance (Edit Account) moves the balance and rewrites the opening
  row, not a new row.
- `set_account_balance`: fresh account edits opening; account with activity inserts an
  adjustment.
- dashboard excludes a flagged income and a flagged expense from
  income/expense/net-cashflow/spending; opening never appears in any of them.
- CHECK rejects: `excluded_from_reporting = 1` on a transfer/adjustment/opening; a
  second `opening` row guard at the service layer; opening with a `category_id` or
  `to_account_id`.

**Frontend (`vitest`):**
- `signedFor("opening", …)` returns the signed amount as-is.
- `computeRunningBalances` starts at 0 and reconciles to the account balance with the
  opening row included.
- mock parity tests for the seam checklist items.

## Out of scope (deferred)

- Credit limits / utilization, installment & payoff schedules, interest — **v0.6.0**,
  which builds on this phase's flag.
- Investment cost-vs-value — **v0.7.0**.
- Auto-linking a reimbursement to the specific original expense it offsets (here it is
  simply excluded from income; offset-pairing is a later enhancement).
- The balance-engine performance rewrite (single `GROUP BY` vs correlated subqueries)
  remains a separate technical-health item.

## Documentation to update on completion

- `CLAUDE.md` — the money/balances section (opening is now a transaction; the new
  `opening` kind; `excludedFromReporting`; dashboard exclusion now also honors the
  flag).
- `ROADMAP.md` — flip `v0.5.0` to 🟢, record the tag, link this spec.
- `CHANGELOG.md` — feature entry **plus** a prominent breaking-change note (delete the
  local DB when upgrading from a pre-v0.5.0 build).
