# Update Net Worth

**Date:** 2026-10-14
**Status:** Approved

## Problem

A fixed deposit, investment, unit trust, or crypto account has one balance:
whatever was entered and whatever was later transferred in or out. When the
holding is worth a different amount, the only tools are Correct balance
(rewrite the opening row, or post a neutral adjustment) and a hand-typed
income or expense.

Correct balance stays for those two jobs. This spec adds a separate action,
Update Net Worth, that sets what the account is worth now and records the
gap as income or expense.

## Solution overview

- The action is available on `fixed-deposit`, `investment`, `unit-trust`,
  and `crypto` only.
- The user types the new balance. The backend subtracts the current balance.
  A rise is an income. A drop is an expense. An unchanged balance writes
  nothing.
- The account may store an income category for a rise and an expense
  category for a drop. Both are optional. A saved category is used. When
  the one needed for this update is empty, the form asks for a category
  for this row only and does not save that choice.
- The row is an ordinary income or expense. It counts as income or as
  spending, and against a budget when that expense category has one. The
  account balance becomes the typed number, so net worth follows.
- Transfers are unchanged. Money moved in or out is recorded on its own,
  before this action.
- Correct balance is unchanged.

No maturity date, interest rate, holdings, ticker, or market price. No
second stored cost figure. A gain or loss does not stay off income and
spending.

## Behavior

The user types what the account is worth now. `diff` is that amount minus
the current balance, in sen.

| `diff` | What is written |
|---|---|
| Greater than zero | One `income` for `diff`, in an income category |
| Less than zero | One `expense` for the positive size of `diff`, in an expense category |
| Zero | No row |

The row is dated today (the backend's `today()`), described **Value update**,
included in reporting, and has no splits. If Record transaction times is
on, the form asks for a time, starting from the current time, and the row
stores that `HH:MM`. If the setting is off, the row has no time.

The opening row is never rewritten by this action, including when it is
the account's only row.

Afterward the row can be edited or deleted like any other income or
expense, including by bulk actions. Deleting it restores the previous
balance. Changing the amount changes the balance. Nothing on the row marks
it as coming from this action. The description is ordinary text.

A saved pair of categories can be changed later. Rows already written keep
the category they were given. Changing the account to any other subtype
clears both saved categories.

The new balance is zero or more. These four subtypes are asset accounts.
The form does not accept a leading minus. The command rejects a negative
target.

## Data model

Migration **014** adds two nullable columns to `accounts`. No foreign key
and no check, matching `credit_limit_cents`. Existing rows get NULL. No
backfill and no seed change.

| Column | Meaning |
|---|---|
| `gain_category_id` | Income category used for a rise, or NULL |
| `loss_category_id` | Expense category used for a drop, or NULL |

The columns are kept only when `subtype` is `fixed-deposit`, `investment`,
`unit-trust`, or `crypto`.

`Account` (Rust and `src/types.ts`) gains `gainCategoryId` and
`lossCategoryId`, each `string | null`. Every account read returns them.
The mock stores the same fields.

**Create.** `create_account` takes two optional category ids at the end.
On one of the four subtypes, each may be an id or null. On any other
subtype, a non-null id is rejected and both columns stay null.

**Edit.** `update_account` takes an optional `valueCategories` object,
`{ gainCategoryId, lossCategoryId }`, each id or null.

- The object is omitted: leave both columns as they are, then apply the
  subtype rule below.
- The object is present and the subtype is one of the four: write both
  fields. Null clears that field.
- The resulting subtype is not one of the four: both columns become null.
  A non-null id in the object is rejected.

A gain id must be an existing income category and not a system category.
A loss id must be an existing expense category and not a system category.
A subcategory is allowed. An archived category is allowed. The locked
Adjustment categories are system categories, so they cannot be saved.

**Delete category.** `delete_category` already refuses a category that any
transaction uses, and that check still runs first, so a value-update row
still blocks the delete and the account columns stay. When the delete
proceeds, the same transaction sets `gain_category_id` and
`loss_category_id` to NULL wherever they equal that id, then deletes the
category. A failed delete rolls the clear back.

There is no new transaction kind and no new table.

## Command

`update_net_worth(account_id, balance_cents, category_id, time) -> Account`

The client method is `updateNetWorth(accountId, balanceCents, categoryId, time)`.
`categoryId` and `time` are null when unused. The date is not an argument.
The mock implements the same command with the same errors.

The command loads the account and then:

1. A missing account is the existing not-found error. Reject an archived account: conflict, `Cannot update an archived account`.
2. Reject any other subtype: validation, `Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.`
3. Reject `balance_cents < 0`: validation, `Balance must be zero or more.`
4. If `diff` is zero, return the account. Do not validate the category or
   the time. Write nothing.
5. Choose the category. A rise uses `gain_category_id`. A drop uses
   `loss_category_id`. When that column is set, it wins and `category_id`
   is ignored. When it is null, `category_id` is required or the command
   returns validation `Pick a category for this update.` The passed id is
   written on the row only. It is not saved on the account.
6. Validate that category with the existing income/expense rules. A missing
   id is the existing not-found error. A found category must match the kind
   and must not be a system category. The existing messages are kept
   (`That category can't be selected.` and the kind mismatch message).
7. Resolve the time with the existing rule. When Record transaction times
   is on, a missing time is `A time is required.` When it is off, the
   stored time is null.
8. Insert one ordinary income or expense for the positive size of `diff`
   through the same posting path as `create_income` / `create_expense`:
   description `Value update`, date today, `excluded_from_reporting` false,
   no splits. Then return the account. Its balance equals `balance_cents`.

The command does not call `set_account_balance`.

Saving a category of the wrong kind returns `Gain category must be an income category.` or `Loss category must be an expense category.` Saving either category on any other subtype returns `Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.`

## Frontend

On the expanded account, an outline button labeled **Update Net Worth**
is placed immediately after Correct balance and before Edit. It is shown
only for the four subtypes, and hidden when the account is archived. No other screen adds a button, a tile,
or a badge. The new row appears in the transaction list and in dashboard
income or spending as a normal income or expense.

The modal matches Correct balance in size.

- It shows the account name and the current balance.
- **Worth now (RM)** starts filled with the current balance, formatted as
  ringgit. Zero is allowed. A leading minus is not accepted.
- A line under the field previews the result. The amount uses the app's
  usual ringgit formatting.
  - Rise, category known: `Records RM X.XX as income in {name}`.
  - Drop, category known: `Records RM X.XX as expense in {name}`.
  - Same balance: `Already at this balance`.
- The category picker and the time field are shown only when the typed
  balance differs from the current one.
- When the matching category is saved, the preview names it and no picker
  is shown. An archived saved category is still used, and the preview
  shows its name.
- When it is not saved, the picker is `categoryPickerItems` for `income`
  on a rise and `expense` on a drop. System categories stay out of that
  list. The choice is not written onto the account.
- When Record transaction times is on and the balance differs, a time
  field is shown, prefilled with the current local `HH:MM`.
- Save stays disabled until the amount is valid. When the balance differs,
  a category must be known as well. When the typed balance equals the
  current balance, Save is enabled and closes without calling the command.
  A server error is shown in the modal.

Add account and Edit account show two optional pickers for those four
subtypes only: **Gain category** (income) and **Loss category** (expense).
Each includes an empty choice, **Ask each time**. The edit form sends
`valueCategories` when the subtype is one of the four, including nulls for
Ask each time. Omitting the object on any other edit leaves a saved pair
in place. The service clears the pair when the resulting subtype is not
one of the four.

## Testing

The same cases run in the Rust service tests and in the browser mock.

- A rise writes an income in the saved gain category. A drop writes an
  expense in the saved loss category. The balance equals the target. The
  opening amount is unchanged, including when it was the only row. The row
  is dated today, described `Value update`, included in reporting, and its
  postings balance.
- A difference of zero writes nothing and does not require a category or
  a time.
- With nothing saved, the passed category is used and the account columns
  stay null. A saved category is used even when another id is passed.
- Reject: missing category, wrong kind, system category, negative balance,
  missing time while the setting is on, archived account, any other
  subtype. With the setting off, the row's time is null.
- Create and edit can save either category, leave either empty, or clear
  one. A category on a savings account is rejected. Changing one of the
  four to another subtype clears both. An omitted `valueCategories` on an
  edit that keeps the subtype leaves the pair in place.
- Deleting a category that is only saved on the account clears that
  column. Deleting a category that a value update uses returns the
  existing in-use conflict and leaves the column set.
- Correct balance is unchanged: only an opening row rewrites that opening,
  and other activity records an adjustment.

`npm run build` stays clean. There is no new screen test.

## Documentation

On implementation, add an `[Unreleased]` changelog entry for the feature,
and describe the command in `docs/architecture/accounts.md` and
`docs/architecture/transactions.md`.

The roadmap phase is Update Net Worth, specified here, and stays unshipped
until the command exists. Fixed-deposit maturity moves to Later /
unscheduled. A separate stored cost, and a gain or loss kept out of income
and spending, are not scheduled.

## Out of scope

- Maturity dates, interest rates, and deposit schedules.
- Holdings, units, tickers, and prices.
- A stored cost basis beside the balance.
- Keeping the value change out of income, spending, or budgets.
- Changing Correct balance, transfers, or the Adjustment categories.
