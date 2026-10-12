# Credit limit for credit cards and BNPL

**Date:** 2026-10-12
**Status:** Approved — ready for implementation plan

## Problem

Credit cards and BNPL accounts are classified and their balances count in net
worth, but Sens does not know the limit on those accounts. There is no
utilization and no available credit.

This spec is the first slice of the roadmap's credit-and-debt phase. Loan
schedules, interest, guided repayments, and reimbursement pairing stay later
specs.

## Solution overview

A credit card (`credit-card`) or BNPL (`bnpl`) account stores one extra number:
the credit limit, in integer sen, greater than zero. Every other subtype leaves
it empty. The limit is not a balance and does not create a transaction.

Utilization and available credit are derived in the UI from that stored limit
and the signed balance the account already has. Charges past the limit are
still saved. Available credit never goes below zero and never rises above the
limit, including when the card is in credit.

There is no upgrade prompt. Creating or editing a card or BNPL account
requires a limit. There are no existing users to backfill.

## Data model

**Migration 010** (append-only, plain `ALTER TABLE` — not an accounts rebuild,
because `postings.account_id` references `accounts`):

```sql
ALTER TABLE accounts ADD COLUMN credit_limit_cents INTEGER
  CHECK (credit_limit_cents IS NULL OR credit_limit_cents > 0);
```

Existing rows get NULL. No backfill.

`Account` (Rust `models.rs`) gains `pub credit_limit_cents: Option<i64>`,
serialized `rename_all = "camelCase"` → `creditLimitCents`. `src/types.ts`
`Account` gains `creditLimitCents: number | null`. `repo.rs` row mapping reads
the column. `SELECT a.*` in the account queries already picks up a new accounts
column; the mapping must read it. `insert_account` writes it.
`update_account_fields` can set it or clear it to NULL.

`AccountBalance` and `DashboardSummary` do not gain the field.

The mock's in-memory account objects carry the same field. Demo seed accounts
are not cards, so they store `null`.

## Backend behavior

Limit subtypes are exactly `credit-card` and `bnpl`. Personal loans, mortgages,
car loans, borrowed money, and every `own` subtype are not limit subtypes.

### `create_account`

New trailing argument `credit_limit_cents: Option<i64>`, threaded through
`service::create_account` → `commands::create_account` (Tauri arg
`creditLimitCents`) → `src/client/index.ts`
`createAccount(name, subtype, openingBalanceCents, templateKey, creditLimitCents)`
→ the `create_account` case in `mock.ts`.

| Resulting subtype | `creditLimitCents` | Result |
|---|---|---|
| `credit-card` or `bnpl` | integer > 0 | Stored |
| `credit-card` or `bnpl` | missing, null, 0, or negative | `ValidationError`: missing/null → "Credit limit is required for this account."; 0 or negative → "Credit limit must be greater than zero." |
| any other subtype | null or omitted | Stored as NULL |
| any other subtype | a number | `ValidationError`: "Credit limit only applies to credit cards and BNPL." |

Opening balance is unchanged and independent of the limit. A new card can owe
RM 2,000 against a RM 10,000 limit (opening `-200000` sen, limit `1000000` sen).

Every existing `create_account` call site passes the new argument. Non-limit
fixtures pass `None` / `null`. The current credit-card fixtures in
`src-tauri/src/lib.rs` and `src/__tests__/mock-accounts.test.ts` pass a
positive limit.

### `update_account`

`UpdateAccountInput` gains `credit_limit_cents: Option<i64>` with
`#[serde(default)]`, so a missing key or JSON null deserializes as `None`
("no new number") and a JSON number deserializes as `Some`. The service then
applies the subtype **after** the save:

| Resulting subtype | Field | Result |
|---|---|---|
| limit subtype, account already has a limit | omitted | Keep the stored limit |
| limit subtype, account has no limit (switching in) | omitted | `ValidationError`: "Credit limit is required for this account." |
| limit subtype | integer > 0 | Replace the stored limit |
| limit subtype | 0 or negative | `ValidationError`: "Credit limit must be greater than zero." |
| any other subtype | omitted | Set the column to NULL |
| any other subtype | a number | `ValidationError`: "Credit limit only applies to credit cards and BNPL." |

Switching a card to savings clears the limit in that same save. Switching a
savings account to a card requires a limit in that same save. The mock applies
the same table.

Transactions, postings, balance correction, and dashboard aggregates do not
read the limit. An expense that pushes the card past the limit is saved.

## Readout

A pure helper in `src/lib/accounts.ts`, next to `balanceDisplay`. Call it only
when `creditLimitCents` is a positive number.

```
owed           = balanceCents < 0 ? -balanceCents : 0
availableCents = balanceCents < 0 ? max(0, creditLimitCents - owed) : creditLimitCents
usedPercent    = Math.round(owed * 100 / creditLimitCents)   // whole number
```

`availableCents` is exact sen. Do not compute it as `creditLimitCents + balanceCents`:
that formula raises available credit above the limit when the balance is in
credit, which this spec forbids.

| Balance | Limit | Available | Used |
|---|---|---|---|
| −RM 4,000 | RM 10,000 | RM 6,000 | 40% |
| RM 0 | RM 10,000 | RM 10,000 | 0% |
| +RM 200 (in credit) | RM 10,000 | RM 10,000 | 0% |
| −RM 10,000 | RM 10,000 | RM 0 | 100% |
| −RM 12,000 | RM 10,000 | RM 0 | 120% |

Exactly 100% is not over the limit: the row shows the available amount and
`100%`. The "Over limit" wording starts at 101%.

The helper returns `{ availableCents, usedPercent, overLimit }` where
`overLimit` is `usedPercent > 100`. Exactly 100% is not over the limit.

## Frontend

- **New account, step 2** (`src/modals/AddAccount.tsx`). When the chosen subtype
  is `credit-card` or `bnpl`, show a required "Credit limit (RM)" field under
  Amount owed. The input accepts digits and a decimal point, same as the
  opening-balance field, and is parsed with `parseAmountToCents`. A blank or
  non-positive value blocks submit with "Credit limit is required for this
  account." Other subtypes hide the field and send null.
- **Edit account** (`src/modals/EditAccount.tsx`). The same field, prefilled
  from `creditLimitCents`, shown only while the chosen subtype is a limit
  subtype. Saving a limit subtype always sends the parsed number. Saving any
  other subtype omits the field so the service clears it.
- **Accounts row** (`src/screens/Accounts.tsx`). When `creditLimitCents` is a
  positive number, under the balance: available amount formatted with
  `fmtMoney` (sen shown, same as other money) and the percent, e.g.
  `RM 6,000.00 available · 40%`, in `t.dim`. When `overLimit` is true, the
  line is `Over limit · 120%` in the expense color. The words "Over limit"
  carry the meaning; color is not the only cue. A null limit draws nothing.
  At exactly 100% the line keeps the available amount and `100%`.
- **Expanded account.** Above the In / Out / Net tiles, a bar whose fill width
  is `min(usedPercent, 100)` percent of the track, plus the available amount
  and the percent. The label still shows 120% when `usedPercent` is 120; only
  the bar fill caps at full. The track is shown whenever a limit is set,
  including at 0% used.

Validation errors from the service render in the existing inline error on the
account form.

The dashboard, net worth, sidebar totals, and the transaction form are
unchanged.

## Testing

- **Rust (`src-tauri/src/lib.rs` `#[cfg(test)]`):**
  - Create `credit-card` and `bnpl` with a positive limit; the account
    round-trips `creditLimitCents`.
  - Create either limit subtype with the limit missing, null, 0, or negative;
    each is `ValidationError` with the message in the table above.
  - Create `savings` with a limit; `ValidationError`. Create `savings` with
    null; `creditLimitCents` is null.
  - Update a card's limit to a new positive number.
  - Update a card to `savings` with the field omitted; the column becomes null.
  - Update `savings` to `credit-card` with the field omitted; `ValidationError`.
    With a positive limit; the limit is stored.
  - An expense that makes the owed amount exceed the limit still commits, and
    the balance moves. The limit column is unchanged.
  - Existing credit-card fixtures pass a positive limit so they keep compiling.
- **Vitest:**
  - `src/lib/__tests__/creditLimit.test.ts` for the helper: every row in the
    readout table. Exactly 100% has available credit RM 0, `usedPercent` 100,
    and `overLimit` false. The RM 12,000 row has available credit RM 0,
    `usedPercent` 120, and `overLimit` true. Zero and in-credit rows have
    available credit equal to the limit, `usedPercent` 0, and `overLimit`
    false.
  - `src/__tests__/mock-accounts.test.ts`: the same create/update validation
    table as the Rust tests. The existing credit-card create in that file
    passes a positive limit.
- **Frontend gate:** `npm run build` and `npm test` stay clean;
  `cd src-tauri && cargo test --lib` passes.

## Out of scope

- Statement close dates, billing cycles, APR, minimum payments, and
  installment schedules.
- Credit limits on loans or on any subtype other than `credit-card` and `bnpl`.
- Refusing a transaction that would pass the limit.
- A dashboard or sidebar utilization total.
- A first-launch screen that demands limits for accounts already in the
  database.

## Documentation

On implementation, update `CLAUDE.md` and `AGENTS.md` (account taxonomy:
credit cards and BNPL store a required credit limit; utilization is derived in
the UI), `CHANGELOG.md` `[Unreleased]`, and `ROADMAP.md` so this slice is
recorded without marking the rest of credit-and-debt as shipped.
