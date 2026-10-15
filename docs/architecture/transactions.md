# Transactions, balances & reporting

Money model, transaction kinds, the double-entry ledger, and what the dashboard counts.
Read this before changing balance math, transaction validation, or dashboard totals.

**Key files:** `src-tauri/src/service.rs` (rules) · `src-tauri/src/repo.rs` (SQL) ·
`src/lib/kinds.ts` · `src/client/mock.ts` · `src/lib/txnBuilder.ts`

> ⚠ Every rule here exists twice: in the Rust chain **and** in `mock.ts`. Change both.

## Contents

- [Money](#money)
- [Transaction kinds](#transaction-kinds)
- [Double-entry ledger](#double-entry-ledger)
- [Opening balance](#opening-balance)
- [Excluded from reporting](#excluded-from-reporting)
- [Transaction time](#transaction-time)
- [Balance correction](#balance-correction)
- [Update Net Worth](#update-net-worth)
- [Schedules](#schedules)
- [Category splits](#category-splits)
- [Card and BNPL payments](#card-and-bnpl-payments)
- [Reimbursements](#reimbursements)
- [Dashboard & reporting rules](#dashboard--reporting-rules)

## Money

- All money is **integer MYR cents**, end to end.
- Format only at the UI edge, via `src/lib/format.ts` (`fmtMoney`, `parseAmountToCents`).

## Transaction kinds

`kind` ∈ `income | expense | transfer | payment | reimbursement | adjustment | opening`

| Kind | Amount sign | Notes |
|---|---|---|
| `income` | positive | Needs a category. Table CHECK enforces the sign. |
| `expense` | positive | Needs a category. Table CHECK enforces the sign. |
| `transfer` | positive | `−amount` on source, `+amount` on destination. |
| `payment` | positive | Card/BNPL repayment. Posts like a transfer. See [Card and BNPL payments](#card-and-bnpl-payments). |
| `reimbursement` | positive | Money back for expenses already booked. No category. Posts `+amount` to the account and `−amount` to the `expense` bucket. See [Reimbursements](#reimbursements). |
| `adjustment` | **signed** | Neutral balance correction. Not editable. |
| `opening` | **signed** | Structural, one per account. See [Opening balance](#opening-balance). |

## Double-entry ledger

- Balances are **never stored.** An account's balance is computed on read as the
  **sum of its postings**.
  - `balance_expr` in `repo.rs` = `SUM(amount_cents) FROM postings WHERE account_id = X`.
- Each transaction materializes **balanced legs** through `service::postings_for`
  (the single sign rule).
  - Legs = real-account leg(s) plus a nominal counter leg tagged
    `system_bucket` ∈ `income | expense | equity`.
  - Every transaction's legs sum to zero.
- Legs live in the `postings` table (migration 006).
  - Data-preserving: two legs were backfilled per existing transaction.
  - A CHECK ensures exactly one of `account_id` / `system_bucket` is set per row.
- The `transactions` / `accounts` schema and all Tauri commands are unchanged by the ledger.
- Mock mirror: `postingsFor` (`src/lib/kinds.ts`), used by `balanceOf` in `mock.ts`.
- `computeRunningBalances` / `signedFor` (the "balance after" column in the Transactions
  view) still read transaction headers, not postings.

> ⚠ **Be careful rebuilding the `transactions` table.** `postings.transaction_id` and
> `transaction_splits.transaction_id` are `ON DELETE CASCADE`, so a naive rebuild deletes every posting
> and split. Prefer plain `ALTER TABLE … ADD COLUMN` / `CREATE TABLE` (migrations 007 and 009 do).
> If a table CHECK must change, copy `postings` and `transaction_splits` **before** swapping the table,
> as migrations 011 and 012 do.

## Opening balance

Every account has **exactly one `opening` transaction**.

- Created atomically with the account (`service::create_account` wraps both writes in one DB transaction).
- Signed (negative for `owe` accounts) and dated the account's creation day.
- There is **no `accounts.opening_balance_cents` column** (dropped in migration 005).
  - `Account.openingBalanceCents` is a **derived read** from the opening row
    (`SELECT … kind='opening' LIMIT 1`, aliased in the account queries).
  - Mock mirror: `openingOf`.
- The opening row is **structural**:
  - It cannot be created via Add Transaction.
  - `update_transaction` / `delete_transaction` reject editing or deleting it (`KIND_OPENING` guard).
  - Its amount changes only via the account's opening-balance field
    (`update_account` updates the opening row) or the fresh-account branch of
    [balance correction](#balance-correction).

## Excluded from reporting

An `income` / `expense` row can be flagged **`excludedFromReporting`**.

- Bool column on `transactions`.
- Settable **only** on income/expense. The table CHECK pins it to `0` for
  transfer / adjustment / opening, and the service re-validates.
- Flagged rows **still affect balances** but are left out of dashboard reporting.
- Use cases:
  - Reimbursements / claims you did not pair to an expense: money back, not new income. (Prefer the reimbursement kind; it also lowers the original expense.)
  - Repayments to an external party: money out, not a new expense.

## Transaction time

Optional. A nullable `transaction_time TEXT` column holds 24-hour `"HH:MM"` or NULL.

- Added by **migration 007** as a plain `ALTER TABLE … ADD COLUMN` (not a rebuild; see the ledger warning above).
- Gated by the **`transaction_time_enabled`** setting (default **on**; a missing key means on, `"0"` means off).

| Setting | Add/Edit modal | Create | Update |
|---|---|---|---|
| **on** | time field shown and **required**, pre-filled with `nowTimeHHMM` | stores time | stores time |
| **off** | time field hidden | **ignores** any supplied time (stores NULL) | **preserves** an already-stored time |

- Validation: `validate_hhmm` in the service, mirrored by `isHHMM` in the mock.
- `opening` / `adjustment` rows **always** carry NULL time.
- Sorting honors time everywhere:
  - SQL: `ORDER BY transaction_date DESC, transaction_time DESC NULLS LAST, created_at DESC` (`repo::list_transactions`).
  - Frontend: single sort key `txnSortKey` = `transactionDate + "\x00" + (transactionTime ?? "") + "\x00" + createdAt`.
- Stored 24h, displayed 12h ("h:mm am/pm") via `fmtTime` (`src/lib/format.ts`).
- Time appears in the Add/Edit modal, `TxnDetailPanel`, and `TxnRow` (whenever a row has one).
- The Settings toggle "Record transaction times" drives the setting (read via `useTimeSetting`).
- Mock mirror: `timeEnabled` / `resolveTime`.
- A new schedule's time starts as the current minute while the setting is on. While it is off, schedules store no time.

## Balance correction

`set_account_balance` takes a **signed** target. The frontend negates the "Amount owed"
input for `owe` accounts.

| Account state | Result |
|---|---|
| No **non-opening** activity (only the opening row) | Edits the opening transaction's amount. |
| Has real transactions | Inserts a signed `adjustment` dated today. |
| Has transactions **and** diff ≠ 0, with `record_as_income_expense` on | Books a real **income** (diff > 0) or **expense** (diff < 0) instead. |

Income/expense corrections:

- Tagged with the protected "Adjustment" system category (see [categories](./categories.md#system-categories)).
- Counted in dashboard reporting.
- The sign of the diff picks income vs expense automatically.
- Flag name: `record_as_income_expense` (Tauri arg `recordAsIncomeExpense`; client
  `setAccountBalance(accountId, realBalanceCents, recordAsIncomeExpense = false)`).
- The neutral `adjustment` stays the default.
- The no-activity (opening-edit) path and the diff == 0 path ignore the flag.
- A correction row in a system category **cannot be edited** via `update_transaction`
  ("Balance corrections can't be edited; delete it and reconcile again"). Deleting is allowed.

## Update Net Worth

`update_net_worth` writes **one ordinary income or expense** for the worth change. It does **not**
rewrite the opening row. When **`diff == 0`**, nothing is written. A **saved category** on the account
wins for that direction; otherwise the UI asks once and does not persist the pick. The row is **editable**
because it is ordinary income or expense. Reporting and budgets already count it.

## Schedules

A schedule is a saved income, expense, transfer, or payment plus a repeat rule. **Migration 015** adds
`schedules` (the template) and `schedule_occurrences` (posted or skipped dates only). Waiting tap-to-post
rows are **calculated** from the rule and `now`; they are not stored until Post or Skip.

- **Auto** posts each due date through **`run_schedule_pass`**. **Tap to post** leaves due dates on
  **Upcoming** until Post or Skip.
- **`create_schedule`** and **`update_schedule`** persist the template only; they do **not** run the pass.
  The frontend calls **`run_schedule_pass`** after create, update, and delete, and also on app open, on
  window focus, and when the wake timer fires (`useScheduleEngine` in `src/lib/useScheduleEngine.ts`).
- The pass and due-date math use **local wall time**. **`transaction_time_enabled`** defaults **on**
  (missing key = on; stored `"0"` = off); when off, schedules ignore stored times for due checks.
- Auto-posted and tap-posted rows are **ordinary transactions** (same kinds and ledger rules as manual
  entry). Deleting the schedule or the transaction does not reopen a settled date.
- **`list_upcoming`** returns due and overdue tap-to-post dates only. Post can override the amount for
  that one row (`client.postScheduleOccurrence`); Skip records a skipped occurrence with no transaction
  (`client.skipScheduleOccurrence`). A date already posted or skipped returns **`ValidationError`**.
- **`recurrence::next_due`** walks forward to the next real occurrence; it does not stop after one empty
  month. Editing a schedule moves unposted, unskipped future dates; posted and skipped dates stay settled.
- An archived account blocks Post but still allows Skip. Factory reset clears both tables.

Spec: `docs/superpowers/specs/2026-10-15-recurring-and-reminders-design.md`.

## Category splits

An `income` / `expense` transaction may **divide its amount across ≥ 2 categories**.
Spec: `docs/superpowers/specs/2026-06-06-category-splits-and-add-transaction-redesign-design.md`.

**Storage**

- Rows in `transaction_splits`: `(id, transaction_id, category_id, amount_cents, sort_order, created_at)`.
- Migration 009: plain `CREATE TABLE`, not a `transactions` rebuild.
- "Is a split" simply means the transaction **has split rows**.
- Validation: `service::validate_splits`, mirrored by `validateSplits` in `mock.ts`.
  - ≥ 2 lines, each positive.
  - Each in a non-system category matching the kind.
  - Lines sum exactly to the header total.
- The header `category_id` **stays NON-NULL**, set to the first split's category.
  - The `transactions` CHECK requires income/expense to carry a category, and rebuilding is unsafe.
  - It is a label-of-record, not the source of breakdown attribution.

**Effect on the rest of the system**

- Splits **never touch postings or balances.** The ledger sees one transaction with one whole amount.
- `sum_kind_in_range` (income / expense / net cashflow) is **unchanged**.
- `spending_breakdown` is a **UNION** of:
  - non-split headers (`NOT EXISTS (SELECT 1 FROM transaction_splits …)`), and
  - split lines (`transaction_splits JOIN transactions`),
  - both rolled up to the parent (`COALESCE(parent_id, id)`), so each category gets its own slice.
- The category **delete-guard** counts split references.
- The Transactions category filter matches the header `category_id` **or** any split line
  (`id IN (SELECT transaction_id FROM transaction_splits WHERE category_id = ?)`).
- `Transaction.splits` is read back per row. Mocked end to end in `mock.ts`.

UI: see the itemized builder in [frontend.md](./frontend.md#itemized-add-transaction-builder).

## Card and BNPL payments

A `payment` repays a credit card or BNPL account.

- **Posting:** like a transfer. `−amount` on the source, `+amount` on the destination, **no system bucket**.
- **Reporting:** stays out of income, spending, and net cashflow.
- **Destination:** only a `credit-card` or `bnpl` account.
- **Source:** must be `cash`, `ewallet`, `savings`, or `current`.
- **Pay button** on the account opens Add Transaction with the amount owed filled in.
- **Transfer slot:** choosing a card or BNPL destination saves a `payment`, and the slot's label
  switches to "Payment".
- `create_transfer` **rejects** card/BNPL destinations.
- **Schema:** migration 011 rebuilds `transactions` so the table CHECK accepts the kind. It copies
  `postings` and `transaction_splits` first (both `ON DELETE CASCADE`).
- Helper on the frontend: `src/lib/payments.ts`.

Spec: `docs/superpowers/specs/2026-10-13-card-bnpl-payments-design.md`.

## Reimbursements

A `reimbursement` records money that came back for expenses you already booked: an employer claim,
a friend's share of a bill, a shop refund. It is never income.

- **Posting:** `+amount` on the receiving account, `−amount` on the `expense` system bucket. The
  receiving account can be any active account, including the card that was charged.
- **Allocations:** the table `reimbursement_allocations(reimbursement_id, expense_id, amount_cents)`
  (migration 012) pairs a reimbursement with the expenses it repays.
  - A reimbursement's allocations sum exactly to its amount.
  - An expense's allocations sum to at most its amount.
  - Only a plain expense (not a system-category balance correction) can be repaid.
  - The same expense appears once per reimbursement; one expense can take several reimbursements.
- **Expectation:** `transactions.expected_reimbursement_cents` (expenses only, `0 < n ≤ amount`) marks an
  expense as expecting money back. `outstanding = max(expected − reimbursed, 0)`. Set it only through
  `set_expected_reimbursement`; `update_transaction` clamps it to a reduced amount and clears it when the
  row stops being an expense.
- **True-cost reporting.** An expense's effective amount is its amount minus its allocations, counted in
  **its own month and category**, so a closed month's spending can fall (and its net cashflow rise) when
  money arrives later. Excluded expenses are skipped along with their allocations.
  - A split expense's offset is spread across its lines by largest remainder (`apportion` in
    `src-tauri/src/apportion.rs` and `src/lib/reimbursements.ts`); no line goes negative.
  - `spending_breakdown` sorts by total descending, then by name.
- **Guards:** an expense with allocations cannot be deleted, retyped, or reduced below its reimbursed
  total; delete or edit the reimbursement first. A reimbursement is edited only through
  `update_reimbursement` (`update_transaction` rejects the kind) and deleting it removes its allocations.
- **Dashboard:** `get_awaiting_reimbursement` returns `{count, totalCents}` for the tile. It counts every
  expense with an outstanding expectation, **including ones excluded from reporting**. Pending claims
  are not part of net worth.
- **Mock mirror:** `allocs` + `syncDerived` in `src/client/mock.ts`.

Spec: `docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md`.

## Dashboard & reporting rules

**Excluded** from income / expense / net cashflow / spending breakdown (balances only):

- transfers, card/BNPL payments, and reimbursements
- expenses count **net of their reimbursements** (see [Reimbursements](#reimbursements))
- adjustments
- `opening` rows
- any `excludedFromReporting` income/expense

Implementation: `sum_kind_in_range` and `spending_breakdown` add `excluded_from_reporting = 0`.
`opening` is simply never summed into income/expense.

**Net worth** = assets + liabilities:

| Field | Meaning |
|---|---|
| `assetsCents` | Σ balances of `own`-group accounts |
| `liabilitiesCents` | Σ balances of `owe`-group accounts (already negative) |
| `netWorthCents` | `assetsCents + liabilitiesCents` |

All totals exclude archived accounts.
