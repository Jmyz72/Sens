# Budgets and savings goals

**Date:** 2026-10-14
**Status:** Approved — implemented per the plan

## Problem

Sens shows what was spent this month, rolled up to the parent category, and
what each account holds. It does not say whether that spending is inside an
amount you chose, and it does not say how far a savings account is from a
target.

This spec adds both. A monthly budget is an envelope on an expense category.
A savings goal is a named target on one cash account, measured by that
account's balance. They share a Plan screen and a short status on the
Dashboard.

There are no existing users. No backfill and no upgrade prompt. Both tables
start empty.

## Solution overview

- A budget is optional. Categories you leave blank stay unbudgeted. Their
  spending still appears in the Dashboard total and has no over or under.
- A parent holds the envelope. Subcategory amounts are slices of it. The
  slices together must be less than or equal to the parent. A subcategory
  cannot have an amount unless its parent has one.
- The amount you set applies to the current month and every later month. A
  finished month keeps the amount it had. Unspent money does not raise the
  next month, and going over does not lower it.
- Spent is the Dashboard spending figure. Saving a transaction never asks
  you to confirm and never blocks you. Plan shows when a category is over.
- A goal has a name, one eligible account, a target amount, and an optional
  date. Progress is the account's current balance. With a date, Plan shows
  the amount still to add each month. One account, one goal.

## Budgets

Expense categories only. Income categories and the system Adjustment
category cannot have a budget.

A parent with no slices is a single amount. Food at RM800 with Dining at
RM250 and Groceries at RM400 leaves RM150 not assigned to a subcategory.
That RM150 is shown so you can see what you have not sliced. It is not a
third cap. Spending on a subcategory with no slice counts only toward the
parent. Spending booked on the parent itself counts in the parent's spent
and in no slice.

Dining can show RM50 over while Food is still inside RM800. A slice is a
plan, not a lock on where the money goes.

**Versions.** Each stored row is a category, the month it starts
(`YYYY-MM`), and an amount in sen. The amount for a month is the latest
version whose start is on or before that month. A blank amount means no
budget from that month forward, so October can keep RM800 after Food is
cleared in November. A second edit in the same month replaces that month's
version. Amounts are zero or more. Zero is a real cap. Blank is not a cap.

Editing writes the real current month, the local calendar month from
`today()` (`YYYY-MM-DD` trimmed to `YYYY-MM`), which matches
`currentMonth()` in `src/lib/format.ts`. The month on screen does not
change which version is written. The form is available only when the month
on screen is that current month. A closed month can be opened and compared.
Its line reads that the month is closed and kept as it was.

November starts from the same amounts as October, with November's spending
at zero, until you edit in November.

**Spent.** For a subcategory, spent is that category's own net expenses for
the month: the same filters and the same reimbursement split as
`spending_breakdown`, taken before children are folded into the parent. The
parent's spent is the sum of those nets for itself and its children, which
is the number the Dashboard already shows for that parent. The Dashboard
query stays as it is. A later reimbursement can change a closed month's
spent. The closed month's budget amount stays fixed.

Transfers, card and BNPL payments, reimbursements, adjustments, opening
balances, and rows excluded from reporting stay out.

**Tree changes use the current category tree.** Amounts and spending stay
historical. Parent and child grouping follows the categories as they are
now, because category parentage is not versioned.

## Goals

A goal has a name, one account, a target in sen greater than zero, and an
optional calendar date (`YYYY-MM-DD`). The name is trimmed and must be
non-empty, the same rule as an account name. The account's subtype must be
`cash`, `ewallet`, `savings`, or `current`. That account can hold only one
goal. Progress is the account's live balance, opening balance included.
There is no per-month history. Changing the name, target, date, or account
updates the figure immediately. Deleting the goal leaves the account and
its transactions alone.

With no date, Plan shows the balance, the target, and the amount still
short. With a date, and while the balance is under the target and the date
has not passed, it also shows the amount to add each month.

**Months left** are the current month through the month before the target
month. On 14 October, a 1 June target in the following year is eight
months: October through May. A gap of RM5,800 is RM725 a month.

The monthly amount is integer sen, rounded up, so the months cover the gap.
A gap of 1,001 sen over 3 months is 334 sen a month (RM3.34), because
333 sen would sum to 999.

When the target date falls in the current month, months left is 1 and the
whole gap is this month's amount. On the target date itself the date has
not passed. The date has passed when the local calendar date is after
`target_date`. A passed date with the balance still short shows the
shortfall and that the date has passed, with no monthly figure.

Once the balance is greater than or equal to the target, the goal is
reached, whether or not a date was set and whether or not that date has
passed. Plan shows "Reached" and the balance against the target. No monthly
figure. A negative balance widens the gap: the gap is target minus balance.

The account you move a goal to must be eligible, active, and free of a
goal. An account that has a goal cannot change to a card, loan, receivable,
or investment subtype until the goal is deleted. Archiving the account
hides the goal. Restoring the account shows it again.

## Data model

**Migration 013** (append-only; do not edit 001–012). New tables only. It
does not rebuild `transactions`.

```sql
CREATE TABLE category_budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL,          -- YYYY-MM
  amount_cents INTEGER,                   -- NULL = no budget from this month on
  created_at TEXT NOT NULL,
  CHECK (amount_cents IS NULL OR amount_cents >= 0),
  UNIQUE (category_id, effective_month)
);

CREATE TABLE savings_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  target_date TEXT,                       -- YYYY-MM-DD or NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The backend generates ids and timestamps. Money is integer sen. Balances
and spending stay computed.

`ON DELETE CASCADE` removes a category's versions when the category is
deleted, and a goal when its account is deleted. Factory reset still
deletes `savings_goals` and `category_budgets` explicitly, before accounts
and categories, then reseeds as it does today.

## Commands

Thin Tauri commands, rules in `service.rs`, SQL in `repo.rs`, the same
behavior in `src/client/mock.ts`. The client gains one wrapper per command.

`get_plan(month)` reads one `YYYY-MM` month. It returns the budget rows
whose resolved amount for that month is non-null, each with category id,
parent id, name, emoji, archived flag, amount, and spent. It returns every
goal whose account is not archived, with id, name, account id, account
name, balance, target, optional date, and the monthly amount or null.
A malformed month is `ValidationError`.

`set_budgets(items)` writes the current month. Each item is a category id
and an amount or null. Categories absent from the batch are left unchanged.
The service applies the batch, resolves the current month's tree, and
checks the rules below. The write is one transaction. A failure saves
nothing. An empty batch is a no-op.

`create_goal`, `update_goal`, and `delete_goal` manage one goal.
`update_goal` may set the date back to null.

After a successful write the screen calls the existing `reload()`, so the
version bump refreshes Plan and the Dashboard.

### Budget validation

`set_budgets` returns `ValidationError` for a negative amount, an unknown
category, an income category, or the system Adjustment category.

It returns `Conflict` when an archived category that is unbudgeted in the
current month is given an amount, when a slice's parent has no amount, or
when the slices of a parent sum to more than the parent. Zero is kept.

An archived category that already has a current amount can be changed or
cleared.

### Category moves

`set_category_parent` is rejected with `Conflict` when the current month's
resolved budgets would no longer fit.

- A slice moved under a parent with no current budget is rejected.
- A slice moved under a parent whose remaining amount cannot hold it is
  rejected.
- Promoting a slice to its own parent is allowed. Its amount goes with it.
- Demoting a budgeted top-level category uses the existing childless rule,
  then the same "parent has room" check.

### Goal validation

`ValidationError`: empty name, target of zero or less, a date that is not a
real `YYYY-MM-DD`.

`NotFound`: missing goal or account.

`Conflict`: archived account, ineligible subtype, or an account that
already has a goal. `update_account` returns `Conflict` when the resulting
subtype is ineligible and a goal is still attached.

## Frontend

**Navigation.** `ScreenId` gains `"plan"`. Overview in the sidebar becomes
Dashboard, then Plan. Label "Plan", subtitle "Budgets and savings goals".
Add an `IconName` `plan`: a target, an outer circle and an inner dot.
`src/screens/Plan.tsx` renders the screen.

**Month.** Plan uses the app's existing selected month, including
`remember_month` and `dashboard_month`. The top bar shows the month control
on Plan as well as on the Dashboard.

**Budgets card.** Each budgeted parent is a row: emoji, name, spent,
amount, and what is left ("RM200 left" or "RM50 over"). A bar shows the
fill. Over uses the expense color and the word "Over", so color is not the
only cue. The bar treats a zero amount as empty when spent is zero and full
when spent is above zero. Expanding a parent shows its slices and, when the
parent has subcategories, a line for the sen not assigned to any slice,
including zero. The card total adds parent amounts and parent spent only,
labeled "Budgeted categories only". An empty month says no budgets are set
and offers to add one. Archived budgeted categories stay in the list,
labeled archived.

**Budget form** (`src/modals/BudgetForm.tsx`). Add and edit use one modal
and one `set_budgets` call. Add asks for a parent that is not already
budgeted this month. Edit opens that parent's amounts. The modal shows the
parent amount and a field for each active subcategory, plus any archived
subcategory that already has a current amount so it can be cleared. A blank
subcategory field sends null. The parent picker lists active expense
categories, skipping income, the system Adjustment category, and archived
categories. On a closed month the form is absent.

**Goals card.** Each goal is a row: name, account, balance, target, and a
bar (`balance / target`, empty when the balance is negative, full when
reached). A date adds the monthly amount and the date. A reached goal says
"Reached". A passed date that is still short says the date has passed and
the amount still short.

**Goal form** (`src/modals/GoalForm.tsx`). Name, eligible account, target,
and an optional date. The account list is active `cash`, `ewallet`,
`savings`, and `current` accounts that have no goal. While editing, the
goal's current account stays in the list. Delete on the form removes the
goal, with no extra confirmation, matching the transaction detail delete.

**Dashboard.** Under the spending card, a Plan card lists every parent and
every slice that is over for the selected month, then goals that are not yet
reached. A parent and one of its slices can both appear. Goals always use the live balance, including when the selected
month is in the past. When at least one budget exists and none are over,
one line says all budgets are within their amounts. When there are no
budgets and no goals, the card is not shown. The card opens Plan.

Amounts are formatted at the edge with the existing `Money` component.
Theme tokens only. No hardcoded colors.

## Testing

Rust service tests in `src-tauri/src/lib.rs`, and the same cases in the
mock (`src/__tests__/`):

- October keeps RM800 when November is set to RM1,000. A second edit in
  October replaces October. Clearing Food in November leaves October at
  RM800 and leaves November with no Food budget.
- Slices that exceed the parent roll back the whole batch. A slice whose
  parent has no amount is rejected. Zero is stored.
- A subcategory's spent is its own net. The parent's spent matches
  `spending_breakdown`. A later reimbursement lowers the original month. A
  transfer, a payment, and an excluded expense do not count.
- Moving a category that breaks the current month's envelopes is rejected.
  Deleting a category removes its versions.
- One goal per account. An ineligible account is rejected. Changing the
  subtype to a card while a goal exists is rejected. An archived account's
  goal is absent from `get_plan`. Factory reset leaves both tables empty.
- On 14 October, a 1 June target with RM5,800 left is eight months and
  RM725. A 1,001-sen gap over 3 months is 334 sen. No date means no monthly
  figure. Balance at or above the target is reached, including when the
  date has passed. A passed date with a shortfall has no monthly figure.

`npm run build`, `npm test`, and `cargo test --lib` stay the gates. There
is no new React component-test harness. The UI displays the monthly amount
from `get_plan` and does not recompute it.

## Out of scope

- Carrying unspent money or overspend into the next month.
- A budget change that starts in a future month and leaves the current
  month alone.
- Refusing or confirming a transaction that crosses a budget.
- Budgets on income categories, or a requirement that every expense
  category have one.
- More than one goal on an account, or a goal on a card, loan, receivable,
  or investment.
- A pace computed from how fast the balance has grown.
- A required date on a goal.
- Moving money between slices when spending crosses one of them.

## Documentation

On implementation, update `docs/architecture/frontend.md` (Plan screen, the
shared month control, the Dashboard card), `docs/architecture/backend.md`
(migration 013 and the commands), and `docs/architecture/categories.md`
(the move guard and cascade). Add a `CHANGELOG.md` `[Unreleased]` entry.
In `ROADMAP.md`, tick the three budgets-and-goals items, link this spec,
and refresh the status block.
