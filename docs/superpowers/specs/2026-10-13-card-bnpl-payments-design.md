# Card and BNPL payments

**Date:** 2026-10-13
**Status:** Approved — ready for implementation plan

## Problem

Paying a credit card or BNPL from another Sens account is a movement of money
that was already spent. Sens can record that movement only as a transfer, so
the row is labeled Transfer and any account can sit on either side.

This spec adds a Payment type for that movement. Reimbursement pairing, loan
repayments, due dates, and interest stay later specs.

## Solution overview

A payment is a transaction kind, `payment`. It posts like a transfer: the
source balance goes down, the card or BNPL balance goes up by the same amount
(the debt shrinks), and the two legs sum to zero. Income, expense, spending,
and day-net totals skip it.

The destination decides the kind. A credit card or BNPL destination is a
payment, and the source must be cash, an e-wallet, savings, or a current
account. Any other destination is a transfer. The Add Transaction form uses
one transfer segment: its label reads Payment when the destination is a card
or BNPL, and Transfer otherwise.

Pay on a credit-card or BNPL account opens that form with the card selected
and the amount set to the full amount owed. The amount is editable. Any
amount above zero saves, including a partial payment and an overpayment that
leaves the card in credit.

There are no existing users. The migration does not relabel old rows. There
is no upgrade prompt and no backfill.

## Data model

**Migration 011** rebuilds `transactions` so the table CHECK can name
`payment`. A CHECK cannot be altered in place. `postings` and
`transaction_splits` reference `transactions` with `ON DELETE CASCADE`, so
dropping `transactions` alone would delete those rows. The migration copies
them first. Append-only: do not edit migrations 001–010. A fresh install
runs 001→011 and ends on this schema.

Steps, inside the migration's own transaction:

1. Create `transactions_new` with the current columns, including
   `transaction_time`, and the CHECK below.
2. Copy every `transactions` row unchanged.
3. Create `postings_new` with the current posting columns, with
   `transaction_id` referencing `transactions_new`. Copy every posting.
   Recreate `idx_postings_account` and `idx_postings_txn` on the new table.
4. Create `transaction_splits_new` the same way. Copy every split. Recreate
   `idx_splits_txn` and `idx_splits_cat`.
5. Drop `transaction_splits`, then `postings`, then `transactions`.
6. Rename the three new tables to `transaction_splits`, `postings`, and
   `transactions`. Recreate `idx_tx_date`, `idx_tx_account`,
   `idx_tx_to_account`, `idx_tx_category`, and `idx_tx_kind`.

```sql
kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment', 'opening', 'payment'))

CHECK (
  (kind IN ('income', 'expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
  (kind = 'transfer' AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
  (kind = 'payment'  AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
  (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0) OR
  (kind = 'opening' AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0)
)
```

`payment` rows store `excluded_from_reporting = 0`, `category_id` NULL, and
no split rows. `transaction_time` follows the transfer rule: when
`transaction_time_enabled` is on, a valid 24-hour `HH:MM` is required; when
it is off, create stores NULL and update preserves a stored time.

`TransactionKind` in `src/types.ts` and `KIND_PAYMENT` in `models.rs` gain
`"payment"`. Serialized shape is unchanged apart from `kind`.

Subtype limits are not in the CHECK. The service enforces them, and the mock
enforces the same rules.

### Postings

`service::postings_for` and `postingsFor` in `src/lib/kinds.ts` treat
`payment` like `transfer`:

- source leg: `-amount_cents` on `account_id`
- destination leg: `+amount_cents` on `to_account_id`

No system bucket. `signedFor` uses that same sign: negative on the source,
positive on the destination.

## Backend behavior

Payment source subtypes are exactly `cash`, `ewallet`, `savings`, and
`current`. Payment destination subtypes are exactly `credit-card` and
`bnpl`. Loans, borrowed money, investments, and every other subtype are
neither a payment source nor a payment destination.

Both accounts must exist and be active (`ensure_active_account`). An archived
account returns the existing conflict: `The source account is archived` or
`The destination account is archived`.

### `create_payment`

New command, same arguments as `create_transfer`: `fromAccountId`,
`toAccountId`, `amountCents`, `description`, `date`, `time`. Threaded through
`service::create_payment` → `commands::create_payment` →
`src/client/index.ts` `createPayment(...)` → the `create_payment` case in
`mock.ts`.

| Check | Result |
|---|---|
| Amount ≤ 0 | `ValidationError`: "Amount must be greater than zero." |
| Source and destination are the same id | `ValidationError`: "Cannot pay the same account." |
| Destination subtype is not `credit-card` or `bnpl` | `ValidationError`: "Payments can only pay a credit card or BNPL." |
| Source subtype is not `cash`, `ewallet`, `savings`, or `current` | `ValidationError`: "Payments can only come from cash, an e-wallet, savings, or a current account." |
| Otherwise | Insert `kind = 'payment'`, category NULL, `excluded_from_reporting = 0`, and materialize the two posting legs. |

### `create_transfer`

Unchanged, except a destination subtype of `credit-card` or `bnpl` is
`ValidationError`: "Pay a credit card or BNPL as a payment." The row is not
inserted. The mock rejects the same call.

### `update_transaction`

`payment` can be edited. The opening and adjustment guards stay as they are.
The form sends `kind: "payment"` or `kind: "transfer"` to match the
destination it is about to save.

- `kind = "payment"` runs the `create_payment` checks, then writes the row
  with category NULL, no splits, and `excluded_from_reporting = 0`.
- `kind = "transfer"` keeps today's transfer checks, and rejects a
  `credit-card` or `bnpl` destination with "Pay a credit card or BNPL as a
  payment."
- A stored payment edited onto a non-card destination is saved as
  `transfer`. A stored transfer edited onto a card or BNPL is saved as
  `payment`, subject to the payment checks.
- `excludedFromReporting` on a payment is stored as false. Splits on a
  payment are rejected with `ValidationError`: "Payments can't be split."

Postings are rewritten from the saved header, as they are today.

### `delete_transaction`

A payment can be deleted. Deleting it removes the row and its postings, so
both balances return to where they were. Opening remains the only kind
`delete_transaction` refuses.

### Reporting

`sum_kind_in_range` and `spending_breakdown` keep summing `income` and
`expense` only. A payment changes account balances and therefore net worth.
It does not change income, expense, net cashflow, or the spending breakdown.

## Frontend

`KIND_META.payment` is `{ label: "Payment", icon: "card", colorKey: "transfer", sign: 0 }`.
Add an `IconName` `card` (a card outline) in `src/components/Icon.tsx`.
Transfer keeps `swap`. Payment uses the transfer color token, and the label
plus the card icon carry the distinction.

`FORM_KINDS` stays `expense`, `income`, `transfer`. There is no fourth
segment. The transfer segment's label is Payment while the selected
destination's subtype is `credit-card` or `bnpl`, and Transfer otherwise.
Saving in the Payment label calls `createPayment`. Saving in the Transfer
label calls `createTransfer`.

The source list in the Payment label contains active accounts whose subtype
is `cash`, `ewallet`, `savings`, or `current`. Switching from Transfer to
Payment clears a source that is not in that list. Switching back restores
the transfer source list.

The destination list is unchanged and still includes cards and BNPL.
Selecting one flips the label to Payment.

**Pay.** Each `credit-card` and `bnpl` row on the Accounts screen has a Pay
button. It opens Add Transaction on the transfer segment with that account
already selected as the destination, so the label reads Payment. The amount
starts as the full amount owed when `balanceCents < 0`
(`(-balanceCents / 100).toFixed(2)`). When `balanceCents >= 0` the amount
starts empty. The user can change the amount, the source, the destination,
the date, the note, and the time. Changing the destination off a card or
BNPL flips the label to Transfer before save.

**Edit.** Editing a payment opens the same form with the segment labeled
Payment. The editable fields are amount, date, note, time (when the setting
is on), source, and destination. Kind follows the destination on save.

**Lists.** A payment row shows the Payment label and card icon in the
transaction list, the transaction detail, and both accounts' activity.
`KIND_FILTERS` on the Transactions screen includes `payment`. Day-net
subtotals and the list income/expense totals ignore payments, the same way
they ignore transfers. Bulk actions treat a payment like a transfer: it can
be deleted, and it cannot be re-categorized or excluded from reporting.

The dashboard hero and spending breakdown are unchanged.

## Testing

- **Rust (`src-tauri/src/lib.rs` `#[cfg(test)]`):**
  - Create a payment from savings onto a credit card. Source balance
    decreases by the amount, card balance increases by the amount (debt
    shrinks), and the two postings sum to zero.
  - The same for `bnpl`, and for each allowed source subtype (`cash`,
    `ewallet`, `savings`, `current`).
  - A partial payment leaves a remaining negative card balance.
  - An overpayment leaves the card balance positive.
  - Reject amount ≤ 0, the same account on both sides, an investment or
    credit-card source, and a savings or loan destination, with the messages
    in the table above.
  - `create_transfer` onto a credit card or BNPL returns "Pay a credit card
    or BNPL as a payment." and inserts nothing.
  - Update a payment's amount and source. Both balances match the new
    postings.
  - Update a payment's destination to a savings account. The stored kind
    becomes `transfer`.
  - Update a transfer's destination to a credit card, with an allowed
    source. The stored kind becomes `payment`.
  - The same destination change with an investment source is
    `ValidationError` and the stored row is unchanged.
  - Delete a payment. Both balances return to their pre-payment values.
  - A dashboard summary for that month is unchanged in income, expense, and
    spending when the only new row is a payment.
  - Migration 011 copies an existing transfer and its two postings, and an
    income row with its split lines, without changing any `kind`.
- **Vitest:**
  - `signedFor("payment", …)` and `postingsFor` for `payment` match the
    transfer signs.
  - `src/__tests__/mock.test.ts` (or the accounts mock file): the same
    create, reject, edit-flip, delete, and dashboard cases as the Rust
    tests.
- **Frontend gate:** `npm run build` and `npm test` stay clean;
  `cd src-tauri && cargo test --lib` passes.

## Out of scope

- Reimbursements and claims, including pairing money back to an original
  expense.
- Loan, mortgage, car-loan, borrowed, and other-debt repayments.
- Paying a card from an account Sens does not track.
- Due dates, minimum payments, installments, and interest.
- A new dashboard total for payments.

## Documentation

On implementation, update `CLAUDE.md` and `AGENTS.md` (the kind list includes
`payment`; a payment posts like a transfer, only from cash, e-wallet,
savings, or current, only onto a credit card or BNPL). Update `CHANGELOG.md`
`[Unreleased]`. Check off the payments item in `ROADMAP.md` when the
behavior ships. Leave the reimbursements item open.
