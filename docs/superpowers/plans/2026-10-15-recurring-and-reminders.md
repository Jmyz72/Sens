# Recurring and reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add schedules that repeat an income, expense, transfer, or card/BNPL payment on a Mac Calendar rule, posting automatically or waiting on Upcoming until the user posts or skips.

**Architecture:** Migration 015 adds `schedules` and `schedule_occurrences`. `recurrence.rs` expands a rule into dates. `schedules.rs` validates, stores, and runs the pass. Waiting rows are calculated. Only posted and skipped dates are stored. The mock uses the same date rules from `src/lib/recurrence.ts`. The Transactions screen lists schedules and due tap-to-post rows. The app shell runs the pass on open, on focus, and on one timer.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite + chrono), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-15-recurring-and-reminders-design.md`. Implement that behavior. Do not add a sound, a lead-time reminder, splits, reimbursements, adjustments, or opening balances as schedules, or a pass that runs after quit.
- Money is integer MYR sen. A posted schedule row is an ordinary transaction through `create_income`, `create_expense`, `create_transfer`, or `create_payment`. Balances stay the sum of postings. `excluded_from_reporting` is false.
- Migration 015 is append-only. Do not edit migrations 001–014. Do not rebuild `transactions`. No backfill. Do not edit `db/seed.rs` or `src/generated/seed-catalog.json`.
- A missing `transaction_time_enabled` key means on. Stored `"0"` means off. Stored `"1"` means on. Do not insert the key to record the default. Factory reset deletes settings, so a reset is on.
- The UI does not send the clock. Commands call `chrono::Local::now().naive_local()`. Tests pass a `NaiveDateTime`.
- The pass is idempotent. A second pass at the same time writes nothing new.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- Never hardcode colors. Use `useTheme()` tokens. Kind color stays paired with the existing sign and icon.
- A new schedule's mode is `tap`. Its time, when times are on, starts as the current local minute (`nowTimeHHMM()`).
- A week starts on Monday.
- Exact error text (Rust and mock match character for character):
  - `Amount must be greater than zero` — ValidationError (existing)
  - `A time is required` — ValidationError (existing)
  - `Time must be in HH:MM 24-hour format` — ValidationError (existing)
  - `The source account is archived` / `The destination account is archived` — Conflict (existing `ensure_active_account`)
  - `Repeat interval must be from 1 to 999.` — ValidationError
  - `Pick at least one weekday.` — ValidationError
  - `Pick at least one day of the month.` — ValidationError
  - `Pick at least one month.` — ValidationError
  - `End date must be on or after the first date.` — ValidationError
  - `End count must be at least 1.` — ValidationError
  - `That date is not due.` — ValidationError
  - `That date is not on this schedule.` — ValidationError
  - `That date was already posted or skipped.` — Conflict
  - `Schedule not found` — NotFound
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Keep `CHANGELOG.md` and `ROADMAP.md` current (Task 8).

---

## File Structure

Backend:
- `src-tauri/src/recurrence.rs` (new) — pure date expansion and `next_due`. No database.
- `src-tauri/src/schedules.rs` (new) — validate, store, pass, upcoming, post, skip.
- `src-tauri/src/db/migrations.rs` — `MIGRATION_015`.
- `src-tauri/src/db/mod.rs` — factory reset deletes the two new tables first.
- `src-tauri/src/models.rs` — `ScheduleWrite`, `Schedule`, `UpcomingOccurrence`, `SchedulePass`.
- `src-tauri/src/repo.rs` — SQL for the two tables, and `clear_occurrence_transaction`.
- `src-tauri/src/service.rs` — `time_enabled` treats a missing key as on. `delete_transaction` is unchanged; the FK clears `transaction_id`.
- `src-tauri/src/commands.rs` and `src-tauri/src/lib.rs` — register the commands. `mod recurrence; mod schedules;`.

Frontend:
- `src/lib/recurrence.ts` (new) — the same date rules, plus `ruleSummary`.
- `src/lib/__tests__/recurrence.test.ts` (new) — the same vectors as the Rust tests.
- `src/lib/useTimeSetting.ts`, `src/screens/Settings.tsx`, `src/client/mock.ts` — default on.
- `src/types.ts`, `src/client/index.ts` — types and wrappers.
- `src/lib/useScheduleEngine.ts` (new) — pass, timer, notice, upcoming count.
- `src/modals/ScheduleForm.tsx`, `src/modals/Schedules.tsx`, `src/modals/PostOccurrence.tsx`, `src/components/UpcomingList.tsx`, `src/components/AwayNotice.tsx` (new).
- `src/screens/Transactions.tsx`, `src/App.tsx` — Schedules button, Upcoming, badge, notice.
- `src/__tests__/mock-schedules.test.ts` (new).
- `docs/architecture/transactions.md`, `docs/architecture/backend.md`, `docs/architecture/frontend.md`.

---

### Task 1: Record transaction times defaults to on

**Files:**
- Modify: `src-tauri/src/service.rs` (`time_enabled`)
- Modify: `src-tauri/src/lib.rs` (test helper and the two time tests)
- Modify: `src/client/mock.ts` (`timeEnabled`)
- Modify: `src/lib/useTimeSetting.ts`
- Modify: `src/screens/Settings.tsx`
- Test: `src-tauri/src/lib.rs`, existing Vitest files that create a transaction

**Interfaces:**
- Consumes: `repo::get_setting`.
- Produces: `time_enabled` returns true when the key is missing. Mock `timeEnabled()` returns true when the key is missing. `useTimeSetting` starts at true and stays true unless the stored value is `"0"`.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/lib.rs` `mod tests`, add:

```rust
#[test]
fn missing_time_setting_requires_a_time() {
    let c = open_in_memory().unwrap();
    let a = acct(&c, "Checking", 0);
    let err = service::create_expense(
        &c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", None, false, None,
    ).unwrap_err();
    assert_eq!(validation_message(err), "A time is required");
    let t = service::create_expense(
        &c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("09:00"), false, None,
    ).unwrap();
    assert_eq!(t.transaction_time.as_deref(), Some("09:00"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib missing_time_setting_requires_a_time`

Expected: FAIL because the expense is created with a null time.

- [ ] **Step 3: Flip the default and keep the old tests off**

In `service.rs`, replace `time_enabled`:

```rust
fn time_enabled(conn: &Connection) -> AppResult<bool> {
    Ok(repo::get_setting(conn, SETTING_TIME_ENABLED)?.as_deref() != Some("0"))
}
```

In `mod tests`, add this helper and use it for every existing `let c = open_in_memory().unwrap();` inside `mod tests` except `missing_time_setting_requires_a_time`:

```rust
fn test_db() -> rusqlite::Connection {
    let c = open_in_memory().unwrap();
    service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
    c
}
```

`time_ignored_when_setting_off` must run on `test_db()` so the key is `"0"` before the create. `time_required_when_setting_on` may use `test_db()` and then `enable_time`. Do not change `src-tauri/src/db/mod.rs` tests.

In `src/client/mock.ts`:

```ts
function timeEnabled(): boolean {
  return settings.get("transaction_time_enabled") !== "0";
}
```

`useTimeSetting` initial state is `true`. After `getSetting`, `setEnabled(v !== "0")`. On failure, leave it true.

`Settings.tsx` initial state is `true`. After load, `setTimeEnabled(v !== "0")`. The comment that says default off is replaced with default on.

Run `npm test`. Every mock test that creates a transaction on a fresh or reset mock and does not want a time must call `mockInvoke("set_setting", { key: "transaction_time_enabled", value: "0" })` before that create. Do not make `reset_app` insert `"0"`. A reset stays on.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib missing_time_setting_requires_a_time time_ignored_when_setting_off time_required_when_setting_on && cargo test --lib`

Then: `npm test`

Expected: both suites pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs src/client/mock.ts src/lib/useTimeSetting.ts src/screens/Settings.tsx src/__tests__
git commit -m "$(cat <<'EOF'
feat: record transaction times unless the setting is off

EOF
)"
```

---

### Task 2: Repeat-rule dates

**Files:**
- Create: `src-tauri/src/recurrence.rs`
- Modify: `src-tauri/src/lib.rs` (`mod recurrence;`)
- Test: `src-tauri/src/recurrence.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `recurrence::Rule`, `recurrence::dates_through(rule, through) -> Vec<NaiveDate>`, `recurrence::next_due(rule, after, time) -> Option<NaiveDateTime>`, `recurrence::validate_rule(rule) -> Result<(), String>`. Weekdays are `mon` `tue` `wed` `thu` `fri` `sat` `sun`. Ordinal is `first` `second` `third` `fourth` `fifth` `last`. Ordinal day adds `weekday` and `weekend`. Frequency is `daily` `weekly` `monthly` `yearly`. End is `never`, `after`, or `on`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/recurrence.rs` with `#[cfg(test)] mod tests` containing these cases. Add `mod recurrence;` to `lib.rs` so `cargo test` compiles the module. The tests call `dates_through` before it exists, so this step does not compile.

```rust
fn rule_daily(start: &str, interval: i32, end: End) -> Rule {
    Rule {
        start: NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap(),
        frequency: Freq::Daily,
        interval,
        weekdays: vec![],
        month_mode: MonthMode::Each,
        month_days: vec![],
        ordinal: Ordinal::First,
        ordinal_day: OrdinalDay::Weekday,
        months: vec![],
        day_of_month: 1,
        end,
    }
}

#[test]
fn daily_every_day_and_every_second_day() {
    let through = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
    let every = dates_through(&rule_daily("2026-10-01", 1, End::Never), through);
    assert_eq!(ymd(&every), vec!["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    let step = dates_through(&rule_daily("2026-10-01", 2, End::Never), through);
    assert_eq!(ymd(&step), vec!["2026-10-01", "2026-10-03", "2026-10-05"]);
}

#[test]
fn daily_end_on_is_inclusive_and_after_counts_dates() {
    let through = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap();
    let on = dates_through(&rule_daily("2026-10-01", 1, End::On(NaiveDate::from_ymd_opt(2026, 10, 3).unwrap())), through);
    assert_eq!(ymd(&on), vec!["2026-10-01", "2026-10-02", "2026-10-03"]);
    let after = dates_through(&rule_daily("2026-10-01", 1, End::After(3)), through);
    assert_eq!(after.len(), 3);
}
```

```rust
fn ymd(dates: &[NaiveDate]) -> Vec<String> {
    dates.iter().map(|d| d.format("%Y-%m-%d").to_string()).collect()
}
fn through(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

#[test]
fn weekly_friday_and_every_second_week_on_two_days() {
    let mut fri = rule_daily("2026-10-02", 1, End::Never);
    fri.frequency = Freq::Weekly;
    fri.weekdays = vec!["fri".into()];
    assert_eq!(
        ymd(&dates_through(&fri, through("2026-10-16"))),
        vec!["2026-10-02", "2026-10-09", "2026-10-16"]
    );
    let mut both = rule_daily("2026-10-02", 2, End::Never);
    both.frequency = Freq::Weekly;
    both.weekdays = vec!["mon".into(), "fri".into()];
    assert_eq!(
        ymd(&dates_through(&both, through("2026-10-20"))),
        vec!["2026-10-02", "2026-10-12", "2026-10-16"]
    );
    let mut later = rule_daily("2026-10-07", 1, End::Never);
    later.frequency = Freq::Weekly;
    later.weekdays = vec!["mon".into()];
    assert_eq!(
        ymd(&dates_through(&later, through("2026-10-20"))),
        vec!["2026-10-12", "2026-10-19"]
    );
}

#[test]
fn monthly_skips_missing_days_and_anchors_to_the_start_month() {
    let mut thirty_first = rule_daily("2026-01-01", 1, End::Never);
    thirty_first.frequency = Freq::Monthly;
    thirty_first.month_mode = MonthMode::Each;
    thirty_first.month_days = vec![31];
    assert_eq!(
        ymd(&dates_through(&thirty_first, through("2026-04-30"))),
        vec!["2026-01-31", "2026-03-31"]
    );
    let mut fifth = rule_daily("2026-10-15", 2, End::Never);
    fifth.frequency = Freq::Monthly;
    fifth.month_days = vec![5];
    assert_eq!(
        ymd(&dates_through(&fifth, through("2027-02-28"))),
        vec!["2026-12-05", "2027-02-05"]
    );
}

#[test]
fn monthly_on_the_fifth_friday_first_weekday_and_last_weekend() {
    let mut fifth = rule_daily("2026-01-01", 1, End::Never);
    fifth.frequency = Freq::Monthly;
    fifth.month_mode = MonthMode::OnThe;
    fifth.ordinal = Ordinal::Fifth;
    fifth.ordinal_day = OrdinalDay::WeekdayName("fri".into());
    assert_eq!(
        ymd(&dates_through(&fifth, through("2026-05-31"))),
        vec!["2026-01-30", "2026-05-29"]
    );
    let mut first = rule_daily("2026-10-01", 1, End::Never);
    first.frequency = Freq::Monthly;
    first.month_mode = MonthMode::OnThe;
    first.ordinal = Ordinal::First;
    first.ordinal_day = OrdinalDay::Weekday;
    assert_eq!(
        ymd(&dates_through(&first, through("2026-11-30"))),
        vec!["2026-10-01", "2026-11-02"]
    );
    let mut last = rule_daily("2026-09-01", 1, End::Never);
    last.frequency = Freq::Monthly;
    last.month_mode = MonthMode::OnThe;
    last.ordinal = Ordinal::Last;
    last.ordinal_day = OrdinalDay::Weekend;
    assert_eq!(
        ymd(&dates_through(&last, through("2026-10-31"))),
        vec!["2026-09-27", "2026-10-31"]
    );
}

#[test]
fn yearly_on_2_october() {
    let mut year = rule_daily("2026-10-02", 1, End::Never);
    year.frequency = Freq::Yearly;
    year.month_mode = MonthMode::Each;
    year.months = vec![10];
    year.day_of_month = 2;
    assert_eq!(
        ymd(&dates_through(&year, through("2028-10-02"))),
        vec!["2026-10-02", "2027-10-02", "2028-10-02"]
    );
}

#[test]
fn validate_rule_rejects_empty_patterns_and_a_bad_end() {
    let mut weekly = rule_daily("2026-10-02", 1, End::Never);
    weekly.frequency = Freq::Weekly;
    assert_eq!(validate_rule(&weekly).unwrap_err(), "Pick at least one weekday.");
    let mut monthly = rule_daily("2026-10-02", 1, End::Never);
    monthly.frequency = Freq::Monthly;
    monthly.month_days = vec![];
    assert_eq!(validate_rule(&monthly).unwrap_err(), "Pick at least one day of the month.");
    let mut yearly = rule_daily("2026-10-02", 1, End::Never);
    yearly.frequency = Freq::Yearly;
    yearly.months = vec![];
    assert_eq!(validate_rule(&yearly).unwrap_err(), "Pick at least one month.");
    assert_eq!(validate_rule(&rule_daily("2026-10-02", 0, End::Never)).unwrap_err(), "Repeat interval must be from 1 to 999.");
    assert_eq!(validate_rule(&rule_daily("2026-10-02", 1000, End::Never)).unwrap_err(), "Repeat interval must be from 1 to 999.");
    assert_eq!(
        validate_rule(&rule_daily("2026-10-02", 1, End::On(through("2026-10-01")))).unwrap_err(),
        "End date must be on or after the first date."
    );
    assert_eq!(validate_rule(&rule_daily("2026-10-02", 1, End::After(0))).unwrap_err(), "End count must be at least 1.");
}

#[test]
fn next_due_waits_for_the_time_then_moves_to_the_next_date() {
    let rule = rule_daily("2026-10-01", 1, End::Never);
    let morning = NaiveDateTime::parse_from_str("2026-10-25T08:00", "%Y-%m-%dT%H:%M").unwrap();
    let at_nine = NaiveDateTime::parse_from_str("2026-10-25T09:00", "%Y-%m-%dT%H:%M").unwrap();
    let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    assert_eq!(next_due(&rule, morning, nine).unwrap(), at_nine);
    assert_eq!(
        next_due(&rule, at_nine, nine).unwrap(),
        NaiveDateTime::parse_from_str("2026-10-26T09:00", "%Y-%m-%dT%H:%M").unwrap()
    );
}
```

The TypeScript tests in Task 3 use these same inputs and these same expected arrays. `ruleSummary` cases live only in the TypeScript file:

- `{ frequency: "monthly", interval: 1, monthMode: "each", monthDays: [5] }` → `Every month on the 5th`
- `{ frequency: "weekly", interval: 1, weekdays: ["mon", "fri"] }` → `Every week on Monday and Friday`
- `{ frequency: "weekly", interval: 2, weekdays: ["fri"] }` → `Every 2 weeks on Friday`
- `{ frequency: "daily", interval: 1 }` → `Every day`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib daily_every_day_and_every_second_day`

Expected: FAIL to compile (`dates_through` missing).

- [ ] **Step 3: Implement the expander**

`dates_through` returns dates from the anchor through `through`, inclusive, in order, stopping at the end rule. One date per calendar day.

- **Daily.** Start on `start`, then add `interval` days.
- **Weekly.** Week 0 is the Monday-start week that contains `start`. Keep weeks whose index is divisible by `interval`. On each kept week emit the selected weekdays in Monday-first order. Drop a weekday before `start`.
- **Monthly.** Month 0 is the month of `start`. Keep months whose index is divisible by `interval`. **Each** emits the selected day numbers that exist in that month, skipping 31 in February and a fifth Friday when the month has four. **On the** emits one date: walk the month for `weekday` (Monday–Friday), `weekend` (Saturday or Sunday), or a single weekday, then pick first through fifth or last. Last always exists when any match exists. Fifth is absent when there are only four.
- **Yearly.** Year 0 is the year of `start`. Keep years whose index is divisible by `interval`. **Each** uses `day_of_month` in each selected month, skipping a month that lacks that day. **On the** uses the ordinal day in each selected month.
- A selected day in the anchor month or week that is before `start` is not a date. The next kept period still is.
- **End After N** stops after N dates. **End On** keeps a date equal to that date and drops later ones.

`next_due` walks the same series until it finds a date whose `time` (00:00 when the caller passes midnight) is strictly after `after`. The search bound is one period past `after`: `interval` days, weeks, months, or years, plus 7 days so a weekday later in the period is visible. Return `None` when the end rule has no such date.

`validate_rule` returns the exact strings in Global Constraints and `Ok(())` otherwise. Daily ignores weekday and month fields. Weekly requires at least one weekday. Monthly Each requires at least one day in 1..=31. Monthly On the requires an ordinal and an ordinal day. Yearly Each requires at least one month in 1..=12 and a `day_of_month` in 1..=31. Yearly On the requires months, an ordinal, and an ordinal day.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib -- recurrence::`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/recurrence.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: expand a schedule into calendar dates

EOF
)"
```

---

### Task 3: The same dates in TypeScript

**Files:**
- Create: `src/lib/recurrence.ts`
- Create: `src/lib/__tests__/recurrence.test.ts`
- Test: `src/lib/__tests__/recurrence.test.ts`

**Interfaces:**
- Consumes: the vectors from Task 2.
- Produces: `datesThrough(rule, through: string): string[]`, `nextDue(rule, after: string, time: string | null): string | null`, `validateRule(rule): string | null`, `ruleSummary(rule): string`. `after` is `YYYY-MM-DDTHH:MM` with no timezone. `time` null means `00:00`. `nextDue` returns `YYYY-MM-DDTHH:MM` or null.

- [ ] **Step 1: Write the failing tests**

Port each Rust test in Task 2 into `recurrence.test.ts` with the same dates and the same expected arrays. Add the four `ruleSummary` assertions listed at the end of Task 2. The file must fail to import until Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/recurrence.test.ts`

Expected: FAIL to import `datesThrough`.

- [ ] **Step 3: Port the rules**

Implement the same branches as `recurrence.rs`. Do not call `Date` for the calendar math; parse `YYYY-MM-DD` into year, month, day and use UTC date objects only as a day counter (`Date.UTC`) so a local timezone cannot shift the day. `ruleSummary` uses the four strings above and the same shape for yearly (`Every year on 2 October`, `Every year on the first Friday of October`).

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/recurrence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recurrence.ts src/lib/__tests__/recurrence.test.ts
git commit -m "$(cat <<'EOF'
feat: match schedule dates in the browser

EOF
)"
```

---

### Task 4: Migration 015 and schedule rows

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/repo.rs`
- Modify: `src/types.ts`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing from Tasks 2–3 yet.
- Produces: tables `schedules` and `schedule_occurrences`. `repo::insert_schedule`, `repo::update_schedule`, `repo::delete_schedule`, `repo::list_schedules`, `repo::get_schedule`, `repo::list_occurrences`, `repo::insert_occurrence`, `repo::occurrence_status`. Deleting a schedule deletes its occurrence rows (`ON DELETE CASCADE`). Deleting a transaction sets `transaction_id` to null and leaves `status` as `posted`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn migration_015_creates_schedule_tables() {
    let c = test_db();
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('schedules', 'schedule_occurrences')",
        [], |r| r.get(0),
    ).unwrap();
    assert_eq!(n, 2);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_015_creates_schedule_tables`

Expected: FAIL, count is 0.

- [ ] **Step 3: Add the tables**

Append `(15, MIGRATION_015)` and:

```sql
CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('auto', 'tap')),
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'payment')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    account_id TEXT NOT NULL,
    to_account_id TEXT,
    category_id TEXT,
    description TEXT,
    start_date TEXT NOT NULL,
    time TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    interval INTEGER NOT NULL CHECK (interval BETWEEN 1 AND 999),
    weekdays TEXT NOT NULL DEFAULT '',
    month_mode TEXT,
    month_days TEXT NOT NULL DEFAULT '',
    ordinal TEXT,
    ordinal_day TEXT,
    months TEXT NOT NULL DEFAULT '',
    day_of_month INTEGER,
    end_mode TEXT NOT NULL CHECK (end_mode IN ('never', 'after', 'on')),
    end_count INTEGER,
    end_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE schedule_occurrences (
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('posted', 'skipped')),
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    PRIMARY KEY (schedule_id, occurrence_date)
);
```

List columns are comma-separated (`mon,fri`, `1,15`, `10`). Map them in `repo.rs` to `Vec` fields on `Schedule`.

In `reset_to_defaults`, before `DELETE FROM savings_goals`:

```rust
conn.execute("DELETE FROM schedule_occurrences", [])?;
conn.execute("DELETE FROM schedules", [])?;
```

Add the camelCase structs on both sides. `Schedule` includes `block_reason: Option<String>`, always `None` from the repo. `UpcomingOccurrence` and `SchedulePass` (`posted`, `next_wake_at: Option<String>`) exist as types even though no command returns them yet.

- [ ] **Step 4: Run the test**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_015_creates_schedule_tables && npm run build`

Expected: the Rust test passes and `tsc` is clean. `Schedule` fields on the TypeScript type may be unused until Task 7; export them and do not reference them from a component yet. If `noUnusedLocals` fails on a type-only export, that is fine — types do not count as unused. Do not add a dummy component.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs src-tauri/src/models.rs src-tauri/src/repo.rs src/types.ts
git commit -m "$(cat <<'EOF'
feat: add tables for schedules and settled dates

EOF
)"
```

---

### Task 5: Save, pass, post, and skip

**Files:**
- Create: `src-tauri/src/schedules.rs`
- Modify: `src-tauri/src/lib.rs` (`mod schedules;`, command list)
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `recurrence::dates_through`, `recurrence::next_due`, `recurrence::validate_rule`, `repo` schedule functions, `service::create_income`, `service::create_expense`, `service::create_transfer`, `service::create_payment`, `service::time_enabled` (crate-visible; change `fn time_enabled` to `pub(crate)`).
- Produces:
  - `schedules::create_schedule(conn, input, now) -> AppResult<Schedule>`
  - `schedules::update_schedule(conn, id, input, now) -> AppResult<Schedule>`
  - `schedules::delete_schedule(conn, id) -> AppResult<()>`
  - `schedules::list_schedules(conn, now) -> AppResult<Vec<Schedule>>`
  - `schedules::list_upcoming(conn, now) -> AppResult<Vec<UpcomingOccurrence>>`
  - `schedules::post_occurrence(conn, schedule_id, date, amount_cents, now) -> AppResult<Transaction>`
  - `schedules::skip_occurrence(conn, schedule_id, date, now) -> AppResult<()>`
  - `schedules::run_pass(conn, now) -> AppResult<SchedulePass>`
  - Commands of the same names with no `now` argument. They use `Local::now().naive_local()`. `run_schedule_pass` returns `SchedulePass`.

- [ ] **Step 1: Write the failing tests**

Use `test_db()` so times are off unless a test calls `enable_time`. Fixed `now` values are `NaiveDateTime::parse_from_str(..., "%Y-%m-%dT%H:%M")`. The first test is:

```rust
#[test]
fn auto_posts_at_the_schedule_time() {
    let c = open_in_memory().unwrap();
    let a = acct(&c, "Salary", 0);
    let cat = income_cat(&c);
    let input = salary_schedule(&a.id, &cat);
    let early = NaiveDateTime::parse_from_str("2026-10-25T08:00", "%Y-%m-%dT%H:%M").unwrap();
    schedules::create_schedule(&c, input.clone(), early).unwrap();
    assert!(schedules::run_pass(&c, early).unwrap().posted.is_empty());
    let due = NaiveDateTime::parse_from_str("2026-10-25T09:00", "%Y-%m-%dT%H:%M").unwrap();
    let pass = schedules::run_pass(&c, due).unwrap();
    assert_eq!(pass.posted.len(), 1);
    assert_eq!(pass.posted[0].transaction_date, "2026-10-25");
    assert_eq!(pass.posted[0].transaction_time.as_deref(), Some("09:00"));
    assert_eq!(pass.posted[0].amount_cents, 500_000);
    assert!(schedules::run_pass(&c, due).unwrap().posted.is_empty());
}
```

`salary_schedule` is a local helper: mode `auto`, kind `income`, amount `500_000`, start `2026-10-25`, time `Some("09:00")`, frequency `monthly`, interval `1`, month mode `each`, month days `[25]`, end `never`. This test uses `open_in_memory` because the time setting must be on.

Write the rest of the tests in the same style:

- At `2026-10-25T08:00`, an auto salary at 09:00 on the 25th writes nothing and upcoming is empty. At `2026-10-25T09:00` it writes one income dated `2026-10-25` with time `09:00`. A second pass writes nothing.
- The same schedule as tap does not write. `list_upcoming` has one row. `post_occurrence` with a different amount writes that amount and leaves the schedule amount unchanged. Deleting that transaction leaves upcoming empty and a further pass does not write it again.
- Three missed auto months (`2026-01-01`, `2026-02-01`, `2026-03-01`) at `2026-03-15T12:00` are three transactions on those dates. Three missed tap months are three upcoming rows, oldest first.
- Clock jump from `2026-10-24T22:00` to `2026-10-28T08:00` posts the 25th once at 09:00.
- Skip 1 March, then update the amount. 1 March stays absent. 1 April uses the new amount. Update the day from the 1st to the 5th while March 1 and April 1 are waiting: upcoming shows March 5 and April 5. If March 1 was already posted, that transaction remains and March 5 is a new row.
- After 10 daily dates with two of them skipped still produces ten dates in `dates_through`, and `list_upcoming` plus posted plus skipped equals 10 once `now` is past the tenth date. Do not get an 11th.
- An archived source account: the pass writes nothing, upcoming still lists the tap row, `post_occurrence` returns the existing archived-account Conflict, `skip_occurrence` succeeds. `list_schedules` sets `block_reason` to that same message.
- A missing time key (`open_in_memory`, not `test_db`) rejects `create_schedule` without a time. With `09:00` it stores `09:00`. On `test_db()` a schedule sent with `09:00` stores `time: None`, and the pass posts at the start of the date.
- `delete_schedule` leaves the posted transaction and removes upcoming rows.
- A transfer posts two postings that sum to 0. A payment onto a credit card does too. An expense dated in January is inside `get_dashboard_summary` for `2026-01` and absent from `2026-02`.
- Factory reset leaves both tables empty.
- `post_occurrence` and `skip_occurrence` reject a future date with `That date is not due.`, a date the rule does not produce with `That date is not on this schedule.`, and a settled date with `That date was already posted or skipped.`
- Switching mode from `tap` to `auto` on the next pass posts the waiting due dates at the current amount. Switching `auto` to `tap` does not delete posted rows.

- [ ] **Step 2: Run one test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib auto_posts_at_the_schedule_time`

Expected: FAIL to compile (`schedules::create_schedule` missing). Name the 09:00 test `auto_posts_at_the_schedule_time`.

- [ ] **Step 3: Implement the service and the commands**

`create_schedule` and `update_schedule` validate the rule, the amount, and the accounts and category by the same checks Add Transaction uses for that kind. While times are on, `time` is required and must be `HH:MM`. While off, store null. Then run `run_pass` with the same `now`.

`run_pass` for each schedule:

- Build the rule and call `dates_through` with `now.date()`.
- Drop today when the schedule has a time and `now.time() < that time`. When the setting is off, ignore a stored time and treat the date as due from 00:00.
- Skip dates that already have an occurrence row.
- Auto: call the existing create for the kind with the schedule's current amount, accounts, category, description, that date, and the time (null when the setting is off). Insert a `posted` occurrence pointing at the transaction. On `Err`, append nothing and set `block_reason` from `err.to_string()` for `list_schedules` and for that upcoming row. Continue with the next schedule.
- Tap: do not write.
- `next_wake_at` is the minimum `next_due` across schedules, formatted `YYYY-MM-DDTHH:MM`, or null when none is strictly after `now`. A blocked overdue schedule does not schedule a wake in the past.
- Return the transactions this call wrote, in date order.

`list_upcoming` is the tap dates that survived the same filter and have no occurrence row. Sort by date, then label, then schedule id. Label is the description, or the category name, or `Transfer`, or `Payment`.

`post_occurrence` checks the date is in that upcoming set, then creates the transaction at `amount_cents` (still `> 0`) and inserts `posted`. `skip_occurrence` inserts `skipped` for a date in that set, including when `block_reason` is set.

Commands in `commands.rs` take no clock. Register them in `generate_handler!`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/schedules.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/service.rs
git commit -m "$(cat <<'EOF'
feat: post or hold each date a schedule produces

EOF
)"
```

---

### Task 6: Mirror the commands in the mock

**Files:**
- Modify: `src/client/mock.ts`
- Modify: `src/client/index.ts`
- Create: `src/__tests__/mock-schedules.test.ts`
- Test: `src/__tests__/mock-schedules.test.ts`

**Interfaces:**
- Consumes: `datesThrough` and `nextDue` from `src/lib/recurrence.ts`. The Rust command names and camelCase JSON from Task 5.
- Produces: `client.listSchedules`, `client.createSchedule`, `client.updateSchedule`, `client.deleteSchedule`, `client.listUpcoming`, `client.postScheduleOccurrence`, `client.skipScheduleOccurrence`, `client.runSchedulePass`. Test-only `setMockNow(local: string | null)` in `mock.ts`. `null` returns to `new Date()`. A string `YYYY-MM-DDTHH:MM` is local wall time, not UTC.

- [ ] **Step 1: Write the failing tests**

`beforeEach`: `reset_app`, then leave the time setting missing so it is on, then `setMockNow`. Repeat the Task 5 cases that do not need SQL: the 09:00 auto post and the second pass, tap upcoming, post with a changed amount, delete transaction does not reopen the date, three missed months, skip then edit, 1st moved to the 5th, archived account, time stored only while the setting is on, delete schedule, transfer postings sum to 0, future post rejected. Read postings through the account balance: a transfer of 1000 sen from A to B changes A by −1000 and B by +1000.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/mock-schedules.test.ts`

Expected: FAIL, command not handled.

- [ ] **Step 3: Mirror the rules**

Handle the eight commands in `mockInvoke`. Use `datesThrough` and `nextDue`. Store schedules and occurrences in module-level arrays. `reset_app` clears both. Creating a transaction from the pass uses the existing mock insert path so postings and dashboard totals stay shared. `delete_transaction` nulls `transactionId` on the occurrence and leaves `status` as `posted`.

`runSchedulePass` reads `setMockNow` when set, otherwise the real local time.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/__tests__/mock-schedules.test.ts && npm test && npm run build`

Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add src/client/mock.ts src/client/index.ts src/__tests__/mock-schedules.test.ts
git commit -m "$(cat <<'EOF'
feat: mirror schedules in the browser mock

EOF
)"
```

---

### Task 7: Schedules, Upcoming, and the away notice

**Files:**
- Create: `src/lib/useScheduleEngine.ts`
- Create: `src/modals/ScheduleForm.tsx`
- Create: `src/modals/Schedules.tsx`
- Create: `src/modals/PostOccurrence.tsx`
- Create: `src/components/UpcomingList.tsx`
- Create: `src/components/AwayNotice.tsx`
- Modify: `src/screens/Transactions.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: the client methods from Task 6, `ruleSummary`, `useTimeSetting`, `nowTimeHHMM`, `KIND_META`, `kindColor`.
- Produces: a Schedules button on the Transactions filter row, Upcoming above the transaction groups, a sidebar count on Transactions, and the away notice.

- [ ] **Step 1: Add the engine hook**

`useScheduleEngine()` in `App.tsx`:

- Call `client.runSchedulePass()` on mount and on `window` `focus`.
- If `posted.length > 0`, keep those transactions for the notice and call `reload()`.
- Set one `setTimeout` for `nextWakeAt`. Parse it as local `YYYY-MM-DDTHH:MM`. If it is not strictly after now, set no timer. On fire, run the pass again. Clear the timer on unmount.
- Load `client.listUpcoming()` after each pass and whenever `version` changes. Expose `upcomingCount`.

`navCount("transactions")` returns that count when it is greater than 0, and null when it is 0.

- [ ] **Step 2: Add Upcoming and the notice**

`UpcomingList` renders nothing when there are no rows. Otherwise it sits above the date groups in `Transactions.tsx`. Each row shows the kind icon and `kindColor`, the label, the date, the time when present, the amount via `Money`, and the account name. **Post** opens `PostOccurrence`. **Skip** calls `client.skipScheduleOccurrence` and then `reload()`. A row with `blockReason` still shows Skip. Post shows that message and does not call the command until the schedule is fixed.

`PostOccurrence` is a 400-wide modal in the same shell as `UpdateNetWorth`. The amount starts as the row's ringgit value. Save parses with `parseAmountToCents`. It calls `client.postScheduleOccurrence(scheduleId, occurrenceDate, cents)` and then `onDone`.

`AwayNotice` is a dialog titled `While you were away`. It lists each posted transaction's label, date, time, amount, and account. **Dismiss** clears it. There is no other button.

- [ ] **Step 3: Add the schedule list and form**

On the Transactions filter row, after the density button, add **Schedules**. It opens `Schedules.tsx`, a list of `client.listSchedules()`. Each row shows the summary from `ruleSummary`, the mode, the amount, and `blockReason` when set. **Add** and **Edit** open `ScheduleForm`. **Delete** calls `client.deleteSchedule` with no extra confirmation.

`ScheduleForm` fields:

- Kind: income, expense, transfer, payment. Same account and category fields as Add Transaction for that kind. No splits. No excluded-from-reporting control.
- Amount.
- Description, optional.
- Mode: Tap to post (initial) or Auto.
- First date, `<input type="date">`.
- Repeat: Every Day, Every Week, Every Month, Every Year, and Custom. Choosing a preset fills the rule from the first date and does not keep editing the pattern. Custom edits the pattern without changing the first date. Weekly uses Monday–Sunday toggles, more than one allowed. Monthly offers Each (day numbers) or On the (position, day, including weekday and weekend day). Yearly offers Each (months plus the stored day of the month) or On the (position, day, months). Interval is 1 to 999.
- End: Never (initial), After a count, or On a date.
- Time, only when `useTimeSetting()` is true. It starts as `nowTimeHHMM()`.

Under the controls, show `ruleSummary(rule)`. Save calls create or update, then `onDone`. `onDone` closes the form and `reload()`s. Show `e.message` in the form.

- [ ] **Step 4: Verify the build**

Run: `npm run build`

Expected: exit 0. There is no new React component test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/useScheduleEngine.ts src/modals/ScheduleForm.tsx src/modals/Schedules.tsx src/modals/PostOccurrence.tsx src/components/UpcomingList.tsx src/components/AwayNotice.tsx src/screens/Transactions.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat: show schedules and post due items from Upcoming

EOF
)"
```

---

### Task 8: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify: `docs/architecture/transactions.md`
- Modify: `docs/architecture/backend.md`
- Modify: `docs/architecture/frontend.md`

**Interfaces:**
- Consumes: Tasks 1 and 5–7.
- Produces: the notes a later change will rely on.

- [ ] **Step 1: Write the notes**

Under `CHANGELOG.md` `[Unreleased]` **Added**:

> **Schedules.** An income, expense, transfer, or card/BNPL payment can repeat on a daily, weekly, monthly, or yearly rule. Auto posts the saved amount when the date and time arrive, including dates missed while Sens was closed or asleep, and a notice lists what was posted. Tap to post waits on Upcoming at the top of Transactions until you post it, with a different amount if you want, or skip that date. Editing a schedule updates dates that are not posted and not skipped.

Under **Changed**:

> **Record transaction times** is on until you turn it off. A fresh install and a factory reset ask for a time on new transactions.

In `ROADMAP.md`, tick the three Recurring & reminders checklist items. Leave the phase ⚪. Do not move it into Shipped and do not change **Last shipped** or **Next up**.

In `docs/architecture/transactions.md`, add **Schedules** after **Update Net Worth**. State the two tables, that waiting rows are calculated, that the pass uses local time, that a missing time setting means on, and that posted rows are ordinary transactions. Name `run_schedule_pass`.

In `docs/architecture/backend.md`, add migration 015 and the eight commands.

In `docs/architecture/frontend.md`, add the Transactions Schedules button, Upcoming, the sidebar count, and the away notice. Note the time toggle's default.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md ROADMAP.md docs/architecture/transactions.md docs/architecture/backend.md docs/architecture/frontend.md
git commit -m "$(cat <<'EOF'
docs: describe schedules and Upcoming

EOF
)"
```

---

## Self-review notes

Spec coverage: modes and kinds (Task 5–7), Mac Calendar rule including Monday weeks, short months, fifth, last, end after/on (Task 2–3), catch-up and the open-app timer (Task 5 and Task 7), time default (Task 1), upcoming only due tap rows (Task 5), skip stays skipped and edits move unposted dates (Task 5), away notice lists only what that pass wrote (Task 7), archived account (Task 5), delete transaction does not reopen (Task 5), factory reset (Task 4–5), mock parity (Task 6), docs (Task 8).

The notice is not limited to the next launch. Any pass that returns `posted.length > 0` shows it, including a 09:00 fire while the window stays open. That matches the approved engine.
