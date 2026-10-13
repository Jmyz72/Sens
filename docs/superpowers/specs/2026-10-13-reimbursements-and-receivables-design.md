# Reimbursements, claims, and money owed to me

**Date:** 2026-10-13
**Status:** Approved — implemented per the plan

## Problem

Money often comes back for something already spent: an employer pays out a
claim, friends repay their share of a bill, a shop refunds a purchase. Sens
can only record that money as an `income` row flagged `excludedFromReporting`.
That keeps the money out of income, but the original expense still counts in
full in spending, nothing links the two rows, and there is no way to see what
is still owed to you.

Lending is the related case: you hand money to someone and they owe you. The
`lent` account subtype already holds that balance as an asset and transfers
already move money in and out of it, but nothing labels it as money owed to
you.

This spec adds reimbursement pairing and the "Owes you" reading for `lent`
accounts. Loan schedules, interest, and due dates stay out of scope.

## Solution overview

- A new transaction kind, `reimbursement`, records money coming back. It is
  never income. It must be fully allocated to one or more expenses it repays.
- Allocations are stored in a new table, so one reimbursement can cover many
  expenses and one expense can be repaid in several parts.
- An expense's **effective amount** is its amount minus its allocations.
  Reporting uses the effective amount, in the expense's original month and
  category ("true cost").
- An expense can be flagged **expecting reimbursement** with an expected
  amount. The outstanding amount drives a pending badge, a filter, and a
  dashboard tile.
- Lending uses the **existing** `lent` account subtype (type `receivable`,
  group `own`, seeded since migration 002). You lend by transferring into it
  and are repaid by transferring out. No new transaction kind and no new
  subtype; this spec only changes how the account reads.

There are no existing users. No backfill, no upgrade prompt, no relabeling of
old rows.

## Data model

**Migration 012** (append-only; do not edit 001–011). It rebuilds
`transactions` because the kind CHECK must name `reimbursement`. `postings`
and `transaction_splits` reference `transactions` with `ON DELETE CASCADE`,
so the migration copies them first, exactly as migration 011 does. A fresh
install runs 001→012 and ends on this schema.

Steps, inside the migration's own transaction:

1. Create `transactions_new` with the current columns plus
   `expected_reimbursement_cents INTEGER` and the CHECK below.
2. Copy every `transactions` row unchanged (`expected_reimbursement_cents`
   NULL).
3. Create `postings_new` and `transaction_splits_new` referencing
   `transactions_new`. Copy every row. Recreate their indexes.
4. Drop `transaction_splits`, `postings`, `transactions`, in that order.
5. Rename the three new tables. Recreate the `transactions` indexes.
6. Create `reimbursement_allocations` (below) and its indexes.

```sql
kind TEXT NOT NULL CHECK (kind IN ('income','expense','transfer','adjustment','opening','payment','reimbursement'))

CHECK (
  (kind IN ('income','expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
  (kind = 'transfer' AND ... unchanged ...) OR
  (kind = 'payment'  AND ... unchanged ...) OR
  (kind = 'reimbursement' AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0) OR
  (kind = 'adjustment' AND ... unchanged ...) OR
  (kind = 'opening' AND ... unchanged ...)
)

CHECK (expected_reimbursement_cents IS NULL OR
       (kind = 'expense' AND expected_reimbursement_cents > 0 AND expected_reimbursement_cents <= amount_cents))
```

```sql
CREATE TABLE reimbursement_allocations (
  id               TEXT PRIMARY KEY,
  reimbursement_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  expense_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at       TEXT NOT NULL,
  UNIQUE (reimbursement_id, expense_id)
);
```

The service enforces what a CHECK cannot:

- A reimbursement's allocations sum exactly to its `amount_cents`.
- An expense's allocations sum to at most its `amount_cents`.
- `expense_id` points at an `expense` that is not in a system category
  (balance corrections cannot be repaid).

`reimbursement` rows store `category_id` NULL, `to_account_id` NULL,
`excluded_from_reporting = 0`, and no split rows. `transaction_time` follows
the transfer rule: when `transaction_time_enabled` is on, a valid 24-hour
`HH:MM` is required; when off, create stores NULL and update preserves a
stored time.

`TransactionKind` in `src/types.ts` and `KIND_REIMBURSEMENT` in `models.rs`
gain `"reimbursement"`. `Transaction` gains
`expectedReimbursementCents: number | null`, `reimbursedCents` (sum of the
row's allocations, expenses only), and `allocations` (reimbursements only:
`{expenseId, amountCents}[]`).

### Postings

`service::postings_for` and `postingsFor` (`src/lib/kinds.ts`) post a
reimbursement as:

- `+amount_cents` on `account_id`
- `-amount_cents` on the `expense` system bucket

The two legs sum to zero. The counter-leg on the expense bucket is the
ledger's view of spending shrinking. `signedFor` returns `+amount_cents` for
the receiving account.

### Receivable accounts

No schema or seed change. The `lent` subtype ("Lent to someone (IOU)",
type `receivable`, group `own`) already exists and behaves as a signed asset:
a positive balance means someone owes you. Lending and repayment use
`create_transfer`. `lent` has no credit limit and is neither a payment source
nor a payment destination. `seed-catalog.json` does not change.

## Reporting

An expense's **effective amount** = `amount_cents` − Σ its allocations. It
stays in its original month and category.

- `sum_kind_in_range('expense')` and `spending_breakdown` use effective
  amounts. Income, transfers, payments, and reimbursements are never summed
  into income.
- Because the offset lands on the original month, a month's net spending can
  drop after the month closes, and its net cashflow rises with it. This is
  intended; document it in `transactions.md`.
- **Split expenses:** the offset is spread across the split lines in
  proportion to each line's amount using the largest-remainder method
  (whole cents; ties go to the earliest line). No line can go negative. A
  rule such as "give the rounding cents to the first line" is not safe: three
  1-sen lines with a 2-sen offset would push the first line to −1.
- **Excluded expenses:** an expense with `excludedFromReporting` is skipped by
  reporting, and so are its allocations. Nothing is subtracted twice.
- Net worth and balances follow postings, so a reimbursement raises the
  receiving account's balance as usual.
- A reimbursement is ignored by day-net subtotals and list income/expense
  totals, the same as a transfer or payment.

## Backend behavior

### New commands

| Command | Purpose |
|---|---|
| `create_reimbursement` | `accountId`, `amountCents`, `description`, `date`, `time`, `allocations: [{expenseId, amountCents}]` |
| `update_reimbursement` | `id` plus the same fields. Replaces the amount, account, date, note, time, and all allocations in one DB transaction |
| `set_expected_reimbursement` | `expenseId`, `expectedCents` (null clears). The only way to set or change the expectation |
| `get_awaiting_reimbursement` | `{ count, totalCents }` of expenses whose `expected > reimbursed`, for the dashboard tile |

`create_income` / `create_expense` / `update_transaction` keep their
signatures. The Transactions-screen "Awaiting reimbursement" filter is
client-side, from `expectedReimbursementCents` and `reimbursedCents` on each
row. `update_transaction` rejects a `reimbursement` kind with "Edit a
reimbursement from its own form." Each command is threaded through
`service.rs` → `commands.rs` → `src/client/index.ts` → `mock.ts`.

### Validation (`create_reimbursement`)

| Check | Result |
|---|---|
| Amount ≤ 0 | `ValidationError`: "Amount must be greater than zero" (existing `validate_positive`, no trailing period) |
| No allocations | `ValidationError`: "Pick at least one expense to reimburse." |
| An allocation amount ≤ 0 | `ValidationError`: "Each allocation must be greater than zero." |
| Allocations do not sum to the amount | `ValidationError`: "Allocations must add up to the reimbursement amount." |
| The same expense listed twice | `ValidationError`: "An expense can only be listed once." |
| `expenseId` is not an expense, or is a system-category expense | `ValidationError`: "Only expenses can be reimbursed." |
| An allocation exceeds the expense's remaining amount | `ValidationError`: "Allocation exceeds what's left on that expense." |
| Receiving account archived | Existing conflict: "The selected account is archived" |
| Otherwise | Insert the row, the allocations, and the two posting legs in one DB transaction. |

The receiving account can be any active account, including the credit card
that was charged (the merchant-refund case; a card is an `owe`-group account,
so the rule must not require `own`). Money landing on a card shrinks the
debt, the same sign as a payment.

### Guards

- **Delete a reimbursement:** removes the row, its allocations (cascade), and
  its postings. Each expense's outstanding amount returns.
- **Delete an expense with allocations:** `ConflictError`: "This expense has
  been reimbursed. Edit or delete the reimbursement first."
- **Edit an expense's amount** below its allocated total: `ValidationError`:
  "Amount can't go below what's already been reimbursed."
- **Edit an expense's kind or category** to something that is no longer a
  plain expense, while allocations exist: same conflict as delete.
- **Expected amount:** must be ≤ the expense amount. `outstanding =
  max(expected − reimbursed, 0)`; over-reimbursing counts as settled.
- Reimbursements cannot be split, flagged excluded, or re-categorized. Bulk
  actions treat them like transfers: delete only.
- No date-ordering rule between a reimbursement and its expense.

## Frontend

**Kinds.** `KIND_META.reimbursement` is `{ label: "Reimbursement", icon:
"reimburse", colorKey: "transfer", sign: 0 }`. Add an `IconName` `reimburse`
in `src/components/Icon.tsx`. Color is never the only cue: the label and icon
carry the meaning. `FORM_KINDS` gains a fourth segment, `reimbursement`.
`KIND_FILTERS` includes it.

**Reimbursement form** (Add Transaction, fourth segment). Receiving account,
amount, date, note, time (when enabled), and an **Applies to** picker.

- The picker lists expenses with an outstanding amount first, then a search
  over the rest. Each picked expense shows an editable allocation, defaulting
  to its outstanding amount (or its remaining amount when no expectation is
  set).
- A footer reads "Allocated RM150.00 of RM150.00". Save is disabled until the
  two match.
- Picking a single expense while the amount is empty fills the amount.
- Helper: `src/lib/reimbursements.ts` (allocation math, defaults, effective
  amounts).

**Expense form.** An optional "Expecting reimbursement" toggle with an
amount, defaulting to the full amount.

**Quick entry.** A "Record reimbursement" action on an expense row and in
`TxnDetailPanel` opens the form with the expense picked and its outstanding
amount filled in.

**Display.**

- Expense rows get a badge: "RM150.00 pending" or "Reimbursed".
- `TxnDetailPanel` shows "Reimbursed RM150.00 of RM200.00, net RM50.00" with
  links to the reimbursements. A reimbursement's panel lists its expenses and
  amounts.
- The Transactions toolbar gets an **Awaiting reimbursement** filter.
- The Dashboard gets a tile: "Awaiting reimbursement: RM X across N
  expenses". It is not part of net worth.

**Receivables.** The Accounts row for a `lent` account shows the label
"Owes you" above the balance, in the slot owe accounts use for "You owe". The
New Account modal already offers `lent`. Lending and repayment use the
existing Transfer form. There is no dedicated form.

## Testing

- **Rust (`src-tauri/src/lib.rs` `#[cfg(test)]`):**
  - Create a reimbursement allocated to one expense. The account balance
    rises by the amount, postings sum to zero, and the expense's effective
    amount drops by the amount in `sum_kind_in_range` and
    `spending_breakdown`.
  - Partial reimbursements from two payers on one expense; one reimbursement
    across several expenses; the same-card refund case.
  - A split expense: the offset spreads across lines proportionally and
    rounding cents follow the largest-remainder rule (three 1-sen lines with
    a 2-sen offset leave no line negative).
  - An `excludedFromReporting` expense with allocations is not double
    subtracted.
  - Reject each row of the validation table.
  - Delete a reimbursement restores outstanding and effective amounts.
    Deleting or shrinking an expense below its allocations is rejected.
  - `get_awaiting_reimbursement` returns the right count and total, with
    over-reimbursed and fully reimbursed expenses omitted.
  - The dashboard income total is unchanged by a reimbursement, and net
    worth rises only through the receiving account's balance.
  - Migration 012 preserves existing transfer, payment, and income-with-splits
    rows with their postings and splits, adds the new column as NULL, and
    creates the allocations table.
  - A `lent` account transfer in and out: balance moves, net worth includes
    it, reporting excludes it.
- **Vitest:** `postingsFor` / `signedFor` for `reimbursement`;
  `reimbursements.ts` helpers; `mock.test.ts` mirrors every Rust case above.
- **Gate:** `npm run build`, `npm test`, `cd src-tauri && cargo test --lib`,
  and the seed-catalog freshness test stay clean.

## Out of scope

- Loan schedules, interest, due dates, and reminders on claims.
- A dedicated "lend" or "repaid" form; transfers cover it.
- Counting pending claims in net worth.
- Auto-matching an incoming deposit to an expense.
- Reimbursements to or from accounts Sens does not track.
- A setting to switch between "true cost" and "as it happened" reporting.

## Documentation

On implementation, update `AGENTS.md` (hard rule 6 cites migration 012 next
to 011; there is no kind list there), `docs/architecture/transactions.md` (reimbursements, the retroactive
reporting rule), `accounts.md` (the `lent` "Owes you" label), `backend.md`
(the four new commands), and `frontend.md` (the form and badges). Add a `CHANGELOG.md` `[Unreleased]` entry. In `ROADMAP.md`, tick
the reimbursements item and refresh the status block.
