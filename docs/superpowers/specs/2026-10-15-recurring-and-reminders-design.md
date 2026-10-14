# Recurring and reminders

**Date:** 2026-10-15
**Status:** Approved

## Problem

Every income, expense, transfer, and payment is entered by hand. Rent, salary,
a weekly cleaner, and a card payment come around again, and Sens has no way to
remember them.

This spec adds a schedule. Each schedule repeats one transaction on a Mac
Calendar rule. The user chooses whether Sens posts it, or whether it waits
until they tap. The Upcoming list is the reminder.

There are no existing users. No backfill and no upgrade prompt.

## Solution overview

- A schedule is a saved transaction plus a repeat rule and a mode, Auto or
  Tap to post.
- Auto writes the saved amount when the date and time arrive. Tap to post
  shows a row. The user can change the amount, then post it, or skip that
  date.
- Waiting rows are calculated from the current schedule. Sens stores a date
  only after it is posted or skipped.
- Any edit to a schedule applies to every date that is not posted and not
  skipped. Posted transactions stay as they were.
- Upcoming lists due and overdue tap-to-post dates only. Auto dates never
  sit there. There is no separate alert.
- The pass that writes auto transactions also runs while Sens stays open. It
  wakes at the next due time. It does not refresh every minute.
- **Record transaction times** defaults to on. While it is on, a schedule has
  a time, that time is when the occurrence becomes due, and that time is
  saved on the transaction.

## Schedules

A schedule is one of `income`, `expense`, `transfer`, or `payment`. It uses
the same account, category, amount, and description rules as Add Transaction
for that kind.

| Kind | What it stores |
|---|---|
| `income`, `expense` | One account, a category, an amount, a description |
| `transfer` | Two accounts, an amount, a description |
| `payment` | A cash, e-wallet, savings, or current account, a credit-card or BNPL account, an amount, a description |

The amount is a positive number of sen. The description may be empty. A new
schedule starts as Tap to post. The user can switch it to Auto.

The posted row is an ordinary transaction of that kind. It counts in
balances, income, spending, and budgets, in the month of its date. The
schedule does not set `excludedFromReporting`. After it is posted, the user
can edit that transaction the same way as any other row.

Splits, reimbursements, adjustments, and opening balances cannot be
schedules.

## Repeat rule

The user picks the first date on a calendar, then how it repeats. The presets
are Every Day, Every Week, Every Month, and Every Year. Custom opens the full
rule. The picker shows Monday through Sunday, and a week starts on Monday.

The first date is the earliest an occurrence may fall. Dates before it are
not generated. The pattern is stored on its own. Choosing Every Week fills
the weekday from that first date. Choosing Every Month fills the day of the
month from it. Choosing Every Year fills the month and the day of the month
from it. A later edit to the first date does not rewrite those pattern
fields. A later edit to the pattern does not move the first date.

| Frequency | What the user sets |
|---|---|
| Daily | Every N days, from 1 to 999 |
| Weekly | Every N weeks, on one or more weekdays. At least one weekday is required |
| Monthly | Every N months. **Each** is one or more days of the month, such as the 2nd, or the 1st and the 15th. **On the** is a position and a day: first, second, third, fourth, fifth, or last, then Sunday–Saturday, weekday, or weekend day |
| Yearly | Every N years. **Each** is one or more months, using the stored day of the month. **On the** is a position, a day, and one or more months |

Weekday means Monday–Friday. Weekend day means Saturday or Sunday. The first
weekday of a month is the first Monday–Friday. The last weekend day is the
last Saturday or Sunday.

A day number that a month does not have is skipped. The 31st occurs in
months that have a 31st. February does not gain a 31st. The fifth Friday is
skipped in a month that has only four. Last always lands.

**End.** Never, after a count, or on a date. Never is the default. After 10
means ten dates on the calendar, counting from the first date the rule
produces on or after the first date. A skipped date still uses one of the
ten. An end date includes an occurrence that lands on it, and excludes later
ones. The end date is on or after the first date. The count is at least 1.

The repeat is anchored to the first date.

- Daily: the first date, then every N days after it.
- Weekly: weeks are counted from the week of the first date. Every 2 weeks
  on Monday and Friday lands on those two weekdays in that week, skips the
  next week, and repeats. A weekday in the first week that falls before the
  first date is not an occurrence.
- Monthly: months are counted from the month of the first date. A selected
  day in that month that falls before the first date is not an occurrence.
  The next one is N months later.
- Yearly: years are counted from the year of the first date, in the same way.

Each, On the, and the selected months need at least one choice. One schedule
produces at most one occurrence on a calendar date. Monday and Friday are
two dates. The 1st and the 15th are two dates.

## The pass

Sens asks the backend to run a pass when the app opens, when the window
becomes active, and when a timer fires. Saving, editing, or deleting a
schedule also runs a pass. The backend uses the machine's local time. Tests
hand it a fixed time. The screen does not send the clock.

The pass lists every schedule's dates from its first date through local now.
A date that already has a posted or skipped record is left alone. Running
the pass twice writes nothing the second time.

A date is due when local now has reached that date and, when the schedule
has a time, that time. With no time, it is due at the start of that local
date.

**Auto.** Each due date with no record is written as a transaction, then
marked posted. The amount, accounts, category, description, date, and time
come from the schedule as it is now.

**Tap to post.** A due date with no record is an Upcoming row. The pass does
not write a transaction.

The timer is a single wake-up for the soonest moment any schedule becomes
due. Two schedules due at 09:00 share one pass. After the pass, Sens sets
the timer for the next moment still ahead. When nothing is still ahead,
there is no timer. Opening Sens or activating the window still runs one
pass. A timer does not fire while the machine is asleep. The next
activation runs one pass and catches every auto date whose time has already
passed.

Quit stops the engine. The next open catches up.

While Sens stays open, the same pass is the whole engine. A salary set to
09:00 on the 25th does nothing at 08:00. At 09:00 it writes. If the laptop
sleeps through 09:00 and wakes on the 28th with Sens still open, that wake
writes the 25th at 09:00 if it is not already posted.

## Time

`transaction_time_enabled` defaults to on. A missing key means on. A stored
`"0"` stays off. A stored `"1"` stays on. Nothing writes the key just to
record the default. Factory reset deletes settings, so a reset returns to
on.

While the setting is on, Add Transaction and the schedule form show a time
and require a valid 24-hour `HH:MM`. A new schedule's time starts as the
current local minute. The user can change it. The posted transaction stores
that schedule time, including when the user posts a tap-to-post row later
in the day.

While the setting is off, schedules store no time, the pass uses the date
only, and new transactions store `transactionTime` null. Transactions that
already have a time keep it.

Opening balances and adjustments still never carry a time.

## Upcoming, post, and skip

Upcoming is the reminder. It lists tap-to-post dates that are due or
overdue and have no record. Auto dates are absent. Future dates are absent.
Several missed months are several rows, each with its own date. Oldest due
date first. A tie breaks by description, then schedule id.

Each row shows the kind, the description, the date and time, the amount, and
the account. An empty description shows the category name, or "Transfer", or
"Payment".

**Post** writes one ordinary transaction for that date. The user can change
the amount first. The account, category, description, date, and time stay as
the schedule has them. That amount applies to this transaction only. The
date is marked posted and points at the transaction. Deleting the
transaction afterward leaves the date posted, so the pass does not write it
again.

**Skip** marks that date skipped. It never becomes a transaction. A later
edit does not bring it back. Skip is allowed on a due date even when the
schedule cannot currently post.

Post and skip reject a date that is not due, a date the current rule does
not produce, and a date that already has a record.

## Away notice

The notice appears after a pass that wrote at least one auto transaction. It
lists each one written by that pass: description, date and time, amount, and
account. Dismiss closes it. There is nothing on it to confirm, skip, or
edit.

Tap-to-post rows are not listed. A pass that wrote nothing shows no notice.
A pass that only failed to write shows no notice. The failure is on the
schedule, described below.

## Editing and deleting

Every setting on a tap-to-post schedule updates rows that are not posted and
not skipped: amount, accounts, category, description, time, mode, first date,
repeat rule, and end. The same settings on an auto schedule are what the next
pass writes for dates that are not yet posted or skipped.

Posted transactions stay as they were. A skipped date stays skipped when that
calendar date is still produced by the new rule. A skipped or posted date
that the new rule no longer produces stays in the ledger or stays skipped,
and the new dates are calculated fresh.

Rent on the 1st, with 1 March and 1 April still waiting, edited to the 5th,
then shows 5 March and 5 April. If 1 March was already posted, that
transaction stays, and 5 March is a new unposted date.

Switching Tap to post to Auto posts the waiting due dates on the next pass,
using the current settings. Switching Auto to Tap leaves posted transactions
posted. Later dates wait on Upcoming when they become due.

Deleting a schedule leaves its posted transactions in the ledger. Its
occurrence records go away with it. Nothing further is generated.

## When a date cannot be posted

The pass uses the same checks as Add Transaction. An archived account, a
missing category, or a payment whose accounts no longer qualify means that
date is not written and no record is stored. The next pass tries again after
the schedule is fixed.

The schedule shows the reason. Its due tap-to-post rows still appear, Post
is refused with that reason, and Skip still works. Other schedules in the
same pass are unaffected. A failure does not appear on the away notice.

## Data model

Migration 015 adds two tables. It does not rebuild `transactions`.

`schedules` holds the template and the rule: id, mode (`auto` or `tap`),
kind, `amount_cents`, `account_id`, `to_account_id`, `category_id`,
description, `start_date`, `time`, frequency (`daily`, `weekly`, `monthly`,
`yearly`), `interval`, the weekly days, the monthly or yearly each-or-on-the
fields, the selected months, `end_mode` (`never`, `after`, `on`),
`end_count`, `end_date`, `created_at`, and `updated_at`. The backend
generates the id and the timestamps.

`schedule_occurrences` holds one row per settled date: `schedule_id`,
`occurrence_date`, status (`posted` or `skipped`), and `transaction_id`.
The date is unique per schedule. `transaction_id` is set for a posted date
and null for a skipped date. Deleting the transaction sets `transaction_id`
to null and leaves the status `posted`. Deleting the transaction does not
delete the occurrence row.

Waiting rows are not stored. They are the dates the rule produces through
local now that have no occurrence row.

Factory reset deletes occurrence rows and schedules before it deletes
accounts, and leaves both tables empty.

The block reason is computed when schedules are read and when the pass runs.
It is not stored.

## Commands

The UI calls the typed client. The mock mirrors every command.

| Command | What it does |
|---|---|
| `list_schedules` | Every schedule, including the computed block reason |
| `create_schedule` | Validates, stores, runs a pass |
| `update_schedule` | Replaces the template and the rule, runs a pass |
| `delete_schedule` | Removes the schedule and its occurrence rows, leaves transactions |
| `list_upcoming` | The calculated due tap-to-post rows |
| `post_schedule_occurrence` | Posts one due date at the given amount |
| `skip_schedule_occurrence` | Skips one due date |
| `run_schedule_pass` | Runs the pass and returns the auto transactions it wrote |

`run_schedule_pass` takes no clock from the UI. Tests call the service with
a fixed time.

## Screens

Schedules and Upcoming live on Transactions.

The toolbar gains **Schedules**. That list is where a schedule is added,
edited, and deleted. The form has the Add Transaction fields for the kind,
Auto or Tap to post, the first date, the repeat rule, the end, and the time
while times are on. The form shows a readable summary of the rule, such as
"Every month on the 5th" or "Every week on Monday and Friday".

Upcoming sits at the top of the transaction list when at least one row is
due. Each row has Post and Skip. The Transactions sidebar badge is the
number of waiting rows. The badge is omitted at zero.

The away notice is a dialog. Theme tokens only. Kind color is paired with
the existing sign and icon.

## Testing

Rust service tests, and the same cases in the mock:

- Before 09:00 on the due date, a pass writes nothing and Upcoming is empty.
  At 09:00, auto writes one transaction dated that day at 09:00, and a second
  pass writes nothing. Tap to post only appears on Upcoming.
- Three missed auto months post as three transactions on those dates. Three
  missed tap-to-post months are three Upcoming rows.
- The wake-up case: the fixed clock jumps from before the time to days
  later, and the missed auto date posts once, at its original date and time.
- Skip, then edit the amount, and that date stays absent. A later date uses
  the new amount. Changing the 1st to the 5th replaces waiting rows and
  leaves an already posted 1st in the ledger.
- Posting with a different amount writes that amount and leaves the schedule
  amount unchanged. Deleting the transaction leaves the date posted.
- After 10 with two skips produces ten dates, not twelve. The 31st does not
  appear in February. A fifth Friday is skipped when the month has four.
- An archived account leaves the date unposted, Upcoming still lists a
  tap-to-post row, Post is refused, and Skip works. A missing key for
  `transaction_time_enabled` means times are on. A stored `"0"` means off,
  and a new auto row then has a null time.
- Factory reset leaves both tables empty.
- A transfer or payment schedule posts balanced postings through the
  existing rules. An expense counts in the month of its date.

`npm run build`, `npm test`, and `cargo test --lib` stay the gates. There
is no new React component-test harness.

## Out of scope

- A sound, or an alert besides the Upcoming list, its sidebar count, and
  the away notice.
- Running the pass after Sens has quit.
- Posting or skipping a date before it is due.
- Changing the account, category, description, date, or time at post time.
- Splits, reimbursements, adjustments, and opening balances as schedules.
- A second reminder lead time, such as three days before the date.
- Editing a posted transaction when the schedule changes.
- Bringing a skipped date back.
- Loan installment schedules and interest.

## Documentation

On implementation, update `docs/architecture/transactions.md` (schedules, the
pass, Upcoming, and the time default), `docs/architecture/backend.md`
(migration 015 and the commands), and `docs/architecture/frontend.md` (the
Transactions toolbar, Upcoming, and the away notice). Add a `CHANGELOG.md`
`[Unreleased]` entry for the feature and for the time default. In
`ROADMAP.md`, tick the three recurring items, link this spec from the
shipped section when the phase ships, and refresh the status block.
