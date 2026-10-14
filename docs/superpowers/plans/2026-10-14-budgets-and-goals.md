# Budgets and Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone set a monthly envelope on expense categories and a named savings target on one cash account, then see budget-versus-actual and goal progress on a Plan screen and a short Dashboard card.

**Architecture:** Migration 013 adds `category_budgets` (one version per category per start month) and `savings_goals` (one row per account). `set_budgets` writes only the local current month and checks the envelope on the resolved tree inside one transaction. Spent reuses the Dashboard's expense nets before the parent rollup; the parent row's spent is that rollup. Goal progress is the live account balance. A pure monthly-amount function lives in Rust and, mirrored, in `src/lib/plan.ts`. Plan and the Dashboard both call `get_plan`. The mock mirrors every rule.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-14-budgets-and-goals-design.md`. Where this plan and the spec differ, this plan wins.
- Money is integer MYR sen. Balances stay the sum of postings. Budgets and goals never write postings.
- No backfill, no upgrade prompt, no seed rows. Both tables start empty. Do not edit `db/seed.rs` or `src/generated/seed-catalog.json`.
- Migration 013 is append-only. Do not edit migrations 001–012. Do not rebuild `transactions`.
- A budget version is `(category_id, effective_month YYYY-MM, amount_cents)`. `amount_cents` null means no budget from that month forward. Zero is a real cap. The amount for a month is the latest version with `effective_month <= month`.
- `set_budgets` writes the local current month from `crate::today()` (`YYYY-MM-DD`, first 7 characters). It does not accept a month argument.
- Envelope: slices of a parent sum to `<=` the parent's resolved amount. A subcategory amount requires a parent amount. Check the tree after the whole batch, then commit. A failure leaves the previous versions.
- Spent for a subcategory is its own net expenses for the month (same filters and reimbursement apportion as `spending_breakdown`, before the parent rollup). A parent's spent is its own net plus its children's nets. That parent total must match `spending_breakdown`.
- Eligible goal subtypes, exact keys: `cash`, `ewallet`, `savings`, `current`.
- Goal progress is the account's current `balance_cents`, opening balance included. One goal per account.
- Monthly sen is `ceil(gap / months)` with integer math `(gap + months - 1) / months`. Months left are the current month through the month before the target month; the same month counts as 1. No date, a passed date (`target_date < today`), or `balance >= target` yields no monthly figure. Reached wins over a passed date.
- The UI displays `monthlyCents` from `get_plan`. It does not recompute it.
- Never hardcode colors. Use `useTheme()` tokens. Over is the word "Over" plus `t.expense`.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- Exact error text (Rust and mock match character for character):
  - `A budget can't be negative.` — ValidationError
  - `Income categories can't have a budget.` — ValidationError
  - `The Adjustment category can't have a budget.` — ValidationError
  - `A category can only be listed once.` — ValidationError
  - `Archived categories can't be given a new budget.` — Conflict
  - `Set a budget on the parent category first.` — Conflict
  - `Subcategory budgets add up to more than the parent.` — Conflict
  - `This move would leave subcategory budgets that don't fit. Clear or lower them first.` — Conflict
  - `Goal name cannot be empty` — ValidationError, from `require_nonempty("Goal name", ...)`
  - `Target must be greater than zero.` — ValidationError
  - `Date must be a real YYYY-MM-DD.` — ValidationError
  - `Goals can only sit on cash, an e-wallet, savings, or a current account.` — Conflict
  - `This account already has a goal.` — Conflict
  - `The selected account is archived` — Conflict, from `ensure_active_account(..., "selected")`
  - `Delete this account's goal before changing its type.` — Conflict
  - `Goal not found` — NotFound
  - `Category not found` — NotFound (existing)
  - `Account not found` — NotFound (existing)
  - `Month must be in YYYY-MM format` — ValidationError (existing `month_range`)
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Keep `CHANGELOG.md` and `ROADMAP.md` current (Task 9).

---

## File Structure

Backend:
- `src-tauri/src/db/migrations.rs` — `MIGRATION_013`.
- `src-tauri/src/db/mod.rs` — factory reset deletes the two tables; migration test.
- `src-tauri/src/models.rs` — `BudgetWrite`, `GoalWrite`, `Plan`, `PlanBudget`, `PlanGoal`.
- `src-tauri/src/repo.rs` — budget upsert, version list, goal CRUD, `category_spend_nets`. `spending_breakdown` rolls up those nets.
- `src-tauri/src/service.rs` — `set_budgets`, `get_plan`, goal commands, `monthly_required`, envelope check, move guard, subtype guard.
- `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` — five commands registered; `plan_tests` module.

Frontend:
- `src/lib/plan.ts` (new) — `resolveAmount`, `monthlyRequired`. Tests in `src/lib/__tests__/plan.test.ts`.
- `src/types.ts`, `src/client/index.ts`, `src/client/mock.ts` — types, wrappers, mirrored rules. Tests in `src/__tests__/mock-plan.test.ts`.
- `src/nav.ts`, `src/components/Icon.tsx`, `src/App.tsx`, `src/components/TopBar.tsx` — Plan screen and the shared month control.
- `src/screens/Plan.tsx` (new), `src/modals/BudgetForm.tsx` (new), `src/modals/GoalForm.tsx` (new).
- `src/screens/Dashboard.tsx` — Plan card.
- `docs/architecture/backend.md`, `categories.md`, `frontend.md`, `CHANGELOG.md`, `ROADMAP.md`.

---

### Task 1: Migration 013, models, repo, factory reset

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/repo.rs`
- Test: `src-tauri/src/db/mod.rs`

**Interfaces:**
- Consumes: migrations 001–012 unchanged. `categories(id)`, `accounts(id)`.
- Produces:
  - `MIGRATIONS` includes `(13, MIGRATION_013)`.
  - `models::BudgetWrite { category_id: String, amount_cents: Option<i64> }` (Deserialize, camelCase).
  - `models::GoalWrite { id: Option<String>, name: String, account_id: String, target_cents: i64, target_date: Option<String> }` (Deserialize, camelCase). `id` is `#[serde(default)]` so create can omit it. Update requires it in the service, which returns `Goal not found` when it is missing.
  - `models::PlanBudget { category_id, parent_id: Option<String>, name, emoji, sort_order: i64, is_archived: bool, amount_cents: i64, spent_cents: i64 }` (Serialize, camelCase).
  - `models::PlanGoal { id, name, account_id, account_name, balance_cents: i64, target_cents: i64, target_date: Option<String>, monthly_cents: Option<i64> }` (Serialize, camelCase).
  - `models::Plan { month: String, budgets: Vec<PlanBudget>, goals: Vec<PlanGoal> }` (Serialize, camelCase).
  - `repo::upsert_budget(conn, id, category_id, effective_month, amount_cents: Option<i64>, now) -> AppResult<()>`
  - `repo::list_budget_versions(conn) -> AppResult<Vec<(String, String, Option<i64>)>>` as `(category_id, effective_month, amount_cents)`.
  - `repo::insert_goal`, `repo::update_goal`, `repo::delete_goal`, `repo::get_goal`, `repo::goal_for_account -> Option<GoalRow>`.
  - `GoalRow { id, name, account_id, target_cents, target_date, created_at, updated_at }` in `repo.rs` (not serialized to the client; `PlanGoal` is the wire type).

- [ ] **Step 1: Write the failing migration test**

Append inside `mod migration_tests` in `src-tauri/src/db/mod.rs`:

```rust
    #[test]
    fn migration_013_creates_budgets_and_goals() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..12 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('sav', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('food', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        );
        apply(MIGRATIONS[12].1);

        conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b1', 'food', '2026-10', 80000, '2026-10-01T00:00:00+00:00')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g1', 'Emergency', 'sav', 1000000, '2027-06-01', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).unwrap();
        assert!(conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b2', 'food', '2026-10', 1, '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "one version per category per month");
        assert!(conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b3', 'food', '2026-11', -1, '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "amount cannot be negative");
        assert!(conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g2', 'Other', 'sav', 1, NULL, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "one goal per account");
        assert!(conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g3', 'Zero', 'sav', 0, NULL, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "target must be > 0");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib migration_013_creates_budgets_and_goals -- --nocapture`

Expected: FAIL. `MIGRATIONS[12]` is out of range, or the tables do not exist.

- [ ] **Step 3: Add the migration, models, repo, and factory reset**

In `migrations.rs`, append to the `MIGRATIONS` array:

```rust
(12, MIGRATION_012), (13, MIGRATION_013),
```

and add:

```rust
const MIGRATION_013: &str = r#"
CREATE TABLE category_budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL,
  amount_cents INTEGER,
  created_at TEXT NOT NULL,
  CHECK (amount_cents IS NULL OR amount_cents >= 0),
  UNIQUE (category_id, effective_month)
);
CREATE INDEX idx_category_budgets_category ON category_budgets(category_id, effective_month);

CREATE TABLE savings_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
```

In `db/mod.rs` `reset_to_defaults`, before `DELETE FROM reimbursement_allocations`:

```rust
conn.execute("DELETE FROM savings_goals", [])?;
conn.execute("DELETE FROM category_budgets", [])?;
```

Add the five model structs to `models.rs` with `#[derive(Debug, Clone, Serialize)]` or `Deserialize` as listed in Interfaces, and `#[serde(rename_all = "camelCase")]`.

Add the repo functions. `upsert_budget` is:

```rust
pub fn upsert_budget(
    conn: &Connection,
    id: &str,
    category_id: &str,
    effective_month: &str,
    amount_cents: Option<i64>,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents",
        params![id, category_id, effective_month, amount_cents, now],
    )?;
    Ok(())
}
```

`list_budget_versions` selects `category_id, effective_month, amount_cents`. Goal helpers use plain INSERT / UPDATE / DELETE / SELECT. `goal_for_account` returns `Ok(None)` when the row is missing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib migration_013_creates_budgets_and_goals -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs src-tauri/src/models.rs src-tauri/src/repo.rs
git commit -m "feat: add budget and savings-goal tables"
```

---

### Task 2: Budget versions and the envelope

**Files:**
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (`mod plan_tests`)

**Interfaces:**
- Consumes: `repo::upsert_budget`, `repo::list_budget_versions`, `repo::get_category`, `crate::today`, `service::new_id`, `service::require_nonempty` is not used here.
- Produces:
  - `service::set_budgets(conn, items: &[BudgetWrite]) -> AppResult<()>`
  - `service::resolve_amount(versions: &[(String, Option<i64>)], month: &str) -> Option<i64>` where each tuple is `(effective_month, amount_cents)`.
  - `service::shift_month(month: &str, delta: i32) -> String` for `YYYY-MM`.

- [ ] **Step 1: Write the failing tests**

At the end of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod plan_tests {
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::models::*;
    use crate::service::{self, resolve_amount, shift_month};

    fn msg(err: AppError) -> String {
        err.to_string()
    }

    fn parent_and_child(conn: &rusqlite::Connection) -> (String, String) {
        let food = service::create_category(conn, "Food", "expense", "🍜", None, None).unwrap();
        let dining = service::create_category(conn, "Dining", "expense", "🍽️", None, Some(&food.id)).unwrap();
        (food.id, dining.id)
    }

    #[test]
    fn resolve_amount_uses_the_latest_version_on_or_before_the_month() {
        let versions = vec![
            ("2026-10".into(), Some(80_000)),
            ("2026-11".into(), None),
        ];
        assert_eq!(resolve_amount(&versions, "2026-09"), None);
        assert_eq!(resolve_amount(&versions, "2026-10"), Some(80_000));
        assert_eq!(resolve_amount(&versions, "2026-11"), None);
        assert_eq!(resolve_amount(&versions, "2026-12"), None);
    }

    #[test]
    fn set_budgets_versions_follow_the_current_month() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let today = crate::today();
        let current = &today[..7];
        let prev = shift_month(current, -1);
        let next = shift_month(current, 1);
        crate::repo::upsert_budget(&conn, "old", &food, &prev, Some(80_000), "t").unwrap();

        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(100_000) }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &prev), Some(80_000));
        assert_eq!(resolve_amount(&food_versions, current), Some(100_000));
        assert_eq!(resolve_amount(&food_versions, &next), Some(100_000));

        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(90_000) }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, current), Some(90_000), "a second edit replaces this month");

        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: None },
            BudgetWrite { category_id: dining, amount_cents: None },
        ]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &prev), Some(80_000));
        assert_eq!(resolve_amount(&food_versions, current), None);
    }

    #[test]
    fn set_budgets_rejects_a_bad_tree_and_keeps_the_old_amount() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let income = service::list_categories(&conn, Some("income"), false).unwrap()[0].id.clone();
        let adjustment = service::list_categories(&conn, Some("expense"), true).unwrap()
            .into_iter().find(|c| c.is_system).unwrap().id;
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
        ]).unwrap();

        let err = service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(20_000) },
        ]).unwrap_err();
        assert_eq!(msg(err), "Subcategory budgets add up to more than the parent.");
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_amount = versions.iter().find(|v| v.0 == food).map(|v| v.2);
        assert_eq!(food_amount, Some(Some(80_000)), "the failed batch did not lower Food");

        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: dining.clone(), amount_cents: Some(1) }, BudgetWrite { category_id: food.clone(), amount_cents: None }]).unwrap_err()),
            "Set a budget on the parent category first."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: income, amount_cents: Some(1) }]).unwrap_err()),
            "Income categories can't have a budget."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: adjustment, amount_cents: Some(1) }]).unwrap_err()),
            "The Adjustment category can't have a budget."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(-1) }]).unwrap_err()),
            "A budget can't be negative."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[
                BudgetWrite { category_id: food.clone(), amount_cents: Some(1) },
                BudgetWrite { category_id: food, amount_cents: Some(2) },
            ]).unwrap_err()),
            "A category can only be listed once."
        );
        service::set_budgets(&conn, &[]).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: dining.clone(), amount_cents: Some(0) }, BudgetWrite { category_id: parent_of(&conn, &dining), amount_cents: Some(0) }]).unwrap();
    }

    fn parent_of(conn: &rusqlite::Connection, id: &str) -> String {
        crate::repo::get_category(conn, id).unwrap().parent_id.unwrap()
    }

    #[test]
    fn archived_category_can_be_cleared_but_not_newly_budgeted() {
        let conn = open_in_memory().unwrap();
        let (food, _) = parent_and_child(&conn);
        service::archive_category(&conn, &food).unwrap();
        let err = service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(1) }]).unwrap_err();
        assert_eq!(msg(err), "Archived categories can't be given a new budget.");
        let today = crate::today();
        crate::repo::upsert_budget(&conn, "pre", &food, &today[..7], Some(50), "t").unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: None }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &today[..7]), None);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_tests -- --nocapture`

Expected: FAIL to compile. `resolve_amount` and `set_budgets` are missing.

- [ ] **Step 3: Implement version resolution and `set_budgets`**

```rust
pub fn shift_month(month: &str, delta: i32) -> String {
    let year: i32 = month[..4].parse().unwrap_or(0);
    let mon: i32 = month[5..7].parse().unwrap_or(1);
    let idx = year * 12 + (mon - 1) + delta;
    let y = idx.div_euclid(12);
    let m = idx.rem_euclid(12) + 1;
    format!("{y:04}-{m:02}")
}

pub fn resolve_amount(versions: &[(String, Option<i64>)], month: &str) -> Option<i64> {
    versions
        .iter()
        .filter(|(effective, _)| effective.as_str() <= month)
        .max_by(|a, b| a.0.cmp(&b.0))
        .and_then(|(_, amount)| *amount)
}

pub fn set_budgets(conn: &Connection, items: &[BudgetWrite]) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if !seen.insert(item.category_id.clone()) {
            return Err(AppError::Validation("A category can only be listed once.".into()));
        }
        if let Some(amount) = item.amount_cents {
            if amount < 0 {
                return Err(AppError::Validation("A budget can't be negative.".into()));
            }
        }
        let cat = repo::get_category(conn, &item.category_id)?;
        if item.amount_cents.is_some() {
            if cat.is_system {
                return Err(AppError::Validation("The Adjustment category can't have a budget.".into()));
            }
            if cat.kind != "expense" {
                return Err(AppError::Validation("Income categories can't have a budget.".into()));
            }
            if cat.is_archived {
                let today = crate::today();
                let month = &today[..7];
                let versions = repo::list_budget_versions(conn)?;
                let mine: Vec<_> = versions.into_iter().filter(|v| v.0 == cat.id).map(|v| (v.1, v.2)).collect();
                if resolve_amount(&mine, month).is_none() {
                    return Err(AppError::Conflict("Archived categories can't be given a new budget.".into()));
                }
            }
        }
    }
    let today = crate::today();
    let month = &today[..7];
    let tx = conn.unchecked_transaction()?;
    for item in items {
        repo::upsert_budget(&tx, &new_id(), &item.category_id, month, item.amount_cents, &now())?;
    }
    ensure_envelopes(&tx, month)?;
    tx.commit()?;
    Ok(())
}
```

`ensure_envelopes` loads every category and every version, resolves `month`, and:

- If a category has `parent_id` and a resolved `Some` amount, the parent must also resolve to `Some`, else `Conflict("Set a budget on the parent category first.")`.
- For each parent, the sum of resolved `Some` amounts on its children must be `<=` the parent's resolved amount when the parent has one, else `Conflict("Subcategory budgets add up to more than the parent.")`. A parent with no resolved amount is skipped for the sum (its children already failed the first check if they have amounts).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_tests -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: version monthly budgets and enforce the envelope"
```

---

### Task 3: Spent nets and `get_plan` budgets

**Files:**
- Modify: `src-tauri/src/repo.rs` (`spending_breakdown`)
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (`plan_tests`)

**Interfaces:**
- Consumes: `set_budgets`, `resolve_amount`, `month_range`, `repo::spending_breakdown`.
- Produces:
  - `repo::category_spend_nets(conn, from, to) -> AppResult<Vec<(String, i64)>>` as `(category_id, net_cents)`. Includes zeros only when a line exists; omits categories with no lines. Nets are after reimbursement apportion, before parent rollup.
  - `service::get_plan(conn, month: &str) -> AppResult<Plan>`. This task fills `budgets` and returns `goals: vec![]`. Task 5 fills goals without changing the budget fields.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn plan_spent_matches_the_dashboard_and_keeps_the_child() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let groceries = service::create_category(&conn, "Groceries", "expense", "🛒", None, Some(&food)).unwrap();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None).unwrap();
        let month = &crate::today()[..7];
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
        ]).unwrap();
        service::create_expense(&conn, &acc.id, Some(dining.as_str()), 30_000, None, &format!("{month}-02"), None, false, None).unwrap();
        service::create_expense(&conn, &acc.id, Some(groceries.id.as_str()), 10_000, None, &format!("{month}-03"), None, false, None).unwrap();
        let other = service::create_account(&conn, "Other", "savings", 0, None, None).unwrap();
        service::create_transfer(&conn, &acc.id, &other.id, 5_000, None, &format!("{month}-04"), None).unwrap();

        let plan = service::get_plan(&conn, month).unwrap();
        let row = |id: &str| plan.budgets.iter().find(|b| b.category_id == id).unwrap();
        assert_eq!(row(&dining).spent_cents, 30_000);
        assert_eq!(row(&food).spent_cents, 40_000);
        assert!(plan.budgets.iter().all(|b| b.category_id != groceries.id), "an unbudgeted child is absent");
        let dash = service::get_dashboard_summary(&conn, month).unwrap();
        let dash_food = dash.spending_breakdown.iter().find(|b| b.category_id == food).unwrap();
        assert_eq!(dash_food.total_cents, 40_000);

        let hidden = service::create_expense(&conn, &acc.id, Some(dining.as_str()), 9_000, None, &format!("{month}-05"), None, true, None).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == dining).unwrap().spent_cents, 30_000);
        let _ = hidden;

        let card = service::create_account(&conn, "Visa", "credit-card", 0, None, Some(500_000)).unwrap();
        service::create_payment(&conn, &acc.id, &card.id, 4_000, None, &format!("{month}-06"), None).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == food).unwrap().spent_cents, 40_000);

        let owed = service::create_expense(&conn, &acc.id, Some(dining.as_str()), 5_000, None, &format!("{month}-07"), None, false, None).unwrap();
        let next = shift_month(month, 1);
        service::create_reimbursement(&conn, &acc.id, 2_000, None, &format!("{next}-01"), None, vec![Allocation { expense_id: owed.id, amount_cents: 2_000 }]).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == dining).unwrap().spent_cents, 33_000);
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == food).unwrap().spent_cents, 43_000);
    }
```

`create_expense` is `(conn, account_id, category_id, amount_cents, description, date, time, excluded_from_reporting, splits)`. `create_transfer` and `create_payment` are `(conn, from_account_id, to_account_id, amount_cents, description, date, time)`. `create_reimbursement` is `(conn, account_id, amount_cents, description, date, time, allocations)`. Import `Allocation` through `use crate::models::*;`, which this module already does.

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_spent_matches_the_dashboard_and_keeps_the_child -- --nocapture`

Expected: FAIL to compile. `get_plan` is missing.

- [ ] **Step 3: Extract nets and implement `get_plan` budgets**

Move the line query and the apportion loop out of `spending_breakdown` into `category_spend_nets`. `spending_breakdown` calls it, then rolls each category id to `parent_id.unwrap_or(id)` exactly as it does now, drops totals `<= 0`, and sorts the same way. Do not change that rollup's output.

`get_plan`:

1. `month_range(month)?` for the spent window. A bad month returns the existing validation errors.
2. Build `own: HashMap<String, i64>` from `category_spend_nets`.
3. Load categories. For a parent (`parent_id.is_none()`), spent is `own[id]` plus `own` of every category whose `parent_id` is that id. For a child, spent is `own[id]` only. Missing keys are 0.
4. Resolve each category's versions. Emit a `PlanBudget` only when the resolved amount is `Some`. Copy name, emoji, `sort_order`, `is_archived`, `parent_id`.
5. Sort by `sort_order`, then name.
6. Return `Plan { month, budgets, goals: vec![] }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_spent_matches_the_dashboard_and_keeps_the_child -- --nocapture`

Expected: PASS. Also run `cargo test --lib spending_breakdown -- --nocapture` and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: report budget spent with the dashboard's category nets"
```

---

### Task 4: Category move guard and delete cascade

**Files:**
- Modify: `src-tauri/src/service.rs` (`set_category_parent`)
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ensure_envelopes`, `set_budgets`, `repo::set_category_parent`, `repo::delete_category`.
- Produces: `set_category_parent` returns `Conflict("This move would leave subcategory budgets that don't fit. Clear or lower them first.")` when the post-move tree fails `ensure_envelopes` for the current month. The category's parent is unchanged on failure.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn moving_a_slice_is_rejected_when_the_new_parent_cannot_hold_it() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let transport = service::create_category(&conn, "Transport", "expense", "🚌", None, None).unwrap();
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
            BudgetWrite { category_id: transport.id.clone(), amount_cents: Some(10_000) },
        ]).unwrap();
        let err = service::set_category_parent(&conn, &dining, Some(&transport.id)).unwrap_err();
        assert_eq!(msg(err), "This move would leave subcategory budgets that don't fit. Clear or lower them first.");
        assert_eq!(crate::repo::get_category(&conn, &dining).unwrap().parent_id.as_deref(), Some(food.as_str()));

        service::set_category_parent(&conn, &dining, None).unwrap();
        assert!(crate::repo::get_category(&conn, &dining).unwrap().parent_id.is_none());
    }

    #[test]
    fn deleting_a_category_deletes_its_budget_versions() {
        let conn = open_in_memory().unwrap();
        let lone = service::create_category(&conn, "Hobbies", "expense", "🎨", None, None).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: lone.id.clone(), amount_cents: Some(1_000) }]).unwrap();
        service::delete_category(&conn, &lone.id).unwrap();
        let left = crate::repo::list_budget_versions(&conn).unwrap();
        assert!(left.iter().all(|v| v.0 != lone.id));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib moving_a_slice_is_rejected_when_the_new_parent_cannot_hold_it -- --nocapture`

Expected: FAIL. The move succeeds, or the error text differs.

- [ ] **Step 3: Check the envelope after the move**

Inside `set_category_parent`, after the existing validation and instead of the bare `repo::set_category_parent` call:

```rust
let tx = conn.unchecked_transaction()?;
repo::set_category_parent(&tx, id, parent_id, &now())?;
let today = crate::today();
if let Err(err) = ensure_envelopes(&tx, &today[..7]) {
    return Err(AppError::Conflict(
        "This move would leave subcategory budgets that don't fit. Clear or lower them first.".into(),
    ));
}
tx.commit()?;
repo::get_category(conn, id)
```

Map any `ensure_envelopes` error to that one Conflict. Do not leak "Set a budget on the parent category first." through this path. `delete_category` needs no service change: `ON DELETE CASCADE` removes the versions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_tests -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: keep category moves inside the budget envelope"
```

---

### Task 5: Savings goals and the monthly amount

**Files:**
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `repo` goal helpers, `repo::get_account`, `ensure_active_account`, `get_plan`'s budget half.
- Produces:
  - `service::monthly_required(today: &str, target_date: Option<&str>, balance_cents: i64, target_cents: i64) -> Option<i64>`
  - `service::create_goal(conn, input: GoalWrite) -> AppResult<PlanGoal>` (`input.id` ignored)
  - `service::update_goal(conn, input: GoalWrite) -> AppResult<PlanGoal>` (`input.id` required)
  - `service::delete_goal(conn, id: &str) -> AppResult<()>`
  - `get_plan` fills `goals` for accounts with `is_archived == false`.
  - `update_account` returns `Conflict("Delete this account's goal before changing its type.")` when the resulting subtype is outside `cash|ewallet|savings|current` and `goal_for_account` is `Some`.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn monthly_required_matches_the_worked_examples() {
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 420_000, 1_000_000), Some(72_500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 0, 1_001), Some(334));
        assert_eq!(service::monthly_required("2026-10-14", None, 0, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-06-01"), 0, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 1_000, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-01-01"), 2_000, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-14"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-20"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-11-01"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-20"), -100, 500), Some(600));
    }

    #[test]
    fn a_goal_uses_the_live_balance_and_one_eligible_account() {
        let conn = open_in_memory().unwrap();
        let sav = service::create_account(&conn, "Maybank", "savings", 420_000, None, None).unwrap();
        let card = service::create_account(&conn, "Visa", "credit-card", 0, None, Some(500_000)).unwrap();
        let goal = service::create_goal(&conn, GoalWrite {
            id: None, name: "  Emergency  ".into(), account_id: sav.id.clone(),
            target_cents: 1_000_000, target_date: Some("2027-06-01".into()),
        }).unwrap();
        assert_eq!(goal.name, "Emergency");
        assert_eq!(goal.balance_cents, 420_000);
        assert!(goal.monthly_cents.is_some());

        let err = service::create_goal(&conn, GoalWrite {
            id: None, name: "Holiday".into(), account_id: sav.id.clone(),
            target_cents: 1, target_date: None,
        }).unwrap_err();
        assert_eq!(msg(err), "This account already has a goal.");
        let err = service::create_goal(&conn, GoalWrite {
            id: None, name: "Card".into(), account_id: card.id.clone(),
            target_cents: 1, target_date: None,
        }).unwrap_err();
        assert_eq!(msg(err), "Goals can only sit on cash, an e-wallet, savings, or a current account.");
        let err = service::update_account(&conn, UpdateAccountInput {
            id: sav.id.clone(), name: None, subtype: Some("credit-card".into()),
            opening_balance_cents: None, credit_limit_cents: Some(100_000),
        }).unwrap_err();
        assert_eq!(msg(err), "Delete this account's goal before changing its type.");

        service::archive_account(&conn, &sav.id).unwrap();
        assert!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.is_empty());
        service::restore_account(&conn, &sav.id).unwrap();
        assert_eq!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.len(), 1);

        service::delete_goal(&conn, &goal.id).unwrap();
        assert!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.is_empty());
        assert_eq!(service::get_account(&conn, &sav.id).unwrap().balance_cents, 420_000);
    }

    #[test]
    fn factory_reset_clears_budgets_and_goals() {
        let conn = open_in_memory().unwrap();
        let sav = service::create_account(&conn, "Maybank", "savings", 0, None, None).unwrap();
        let food = service::create_category(&conn, "Food", "expense", "🍜", None, None).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: food.id, amount_cents: Some(1) }]).unwrap();
        service::create_goal(&conn, GoalWrite {
            id: None, name: "Emergency".into(), account_id: sav.id, target_cents: 1, target_date: None,
        }).unwrap();
        service::reset_app(&conn).unwrap();
        assert_eq!(crate::repo::list_budget_versions(&conn).unwrap().len(), 0);
        let plan = service::get_plan(&conn, "2026-10").unwrap();
        assert!(plan.goals.is_empty());
    }
```

`UpdateAccountInput` fields are `id`, `name`, `subtype`, `opening_balance_cents`, and `credit_limit_cents`. `create_account` for `credit-card` must pass a positive `credit_limit_cents` because that subtype requires one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib monthly_required_matches_the_worked_examples -- --nocapture`

Expected: FAIL to compile. `monthly_required` is missing.

- [ ] **Step 3: Implement goals**

```rust
pub fn monthly_required(today: &str, target_date: Option<&str>, balance_cents: i64, target_cents: i64) -> Option<i64> {
    let date = target_date?;
    let gap = target_cents - balance_cents;
    if gap <= 0 || date < today {
        return None;
    }
    let months = months_left(&today[..7], &date[..7]);
    Some((gap + i64::from(months) - 1) / i64::from(months))
}

fn months_left(today_month: &str, target_month: &str) -> i32 {
    let idx = |ym: &str| -> i32 {
        let y: i32 = ym[..4].parse().unwrap_or(0);
        let m: i32 = ym[5..7].parse().unwrap_or(1);
        y * 12 + (m - 1)
    };
    let d = idx(target_month) - idx(today_month);
    if d <= 0 { 1 } else { d }
}

fn goal_subtype(subtype: &str) -> bool {
    matches!(subtype, "cash" | "ewallet" | "savings" | "current")
}
```

`create_goal` trims the name with `require_nonempty("Goal name", ...)`, rejects `target_cents <= 0` with `Target must be greater than zero.`, parses `target_date` with `chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")` or returns `Date must be a real YYYY-MM-DD.`, calls `ensure_active_account(conn, id, "selected")`, rejects a bad subtype, rejects an existing `goal_for_account`, inserts, and returns the `PlanGoal` built from the account balance and `monthly_required(&crate::today(), ...)`.

`update_goal` loads the goal or returns `NotFound("Goal not found")`, then applies the same checks. The current account may stay. Another account must be free of a goal.

`delete_goal` deletes or returns `Goal not found`.

`get_plan` loads every goal, skips archived accounts, and pushes a `PlanGoal`.

In `update_account`, after `resulting_subtype` is known and before the write:

```rust
if !goal_subtype(resulting_subtype) && repo::goal_for_account(conn, &input.id)?.is_some() {
    return Err(AppError::Conflict("Delete this account's goal before changing its type.".into()));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_tests -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: track one savings goal per cash account"
```

---

### Task 6: Commands, types, client, and the mock

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler`)
- Modify: `src/types.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/mock.ts`
- Create: `src/lib/plan.ts`
- Create: `src/lib/__tests__/plan.test.ts`
- Create: `src/__tests__/mock-plan.test.ts`
- Test: those two Vitest files, plus `cargo test --lib`

**Interfaces:**
- Consumes: `service::get_plan`, `set_budgets`, `create_goal`, `update_goal`, `delete_goal`.
- Produces, command names and client methods:
  - `get_plan(month: string) -> Plan` / `client.getPlan(month)`
  - `set_budgets(items: BudgetWrite[]) -> void` / `client.setBudgets(items)`
  - `create_goal(input: GoalWrite) -> PlanGoal` / `client.createGoal(input)`
  - `update_goal(input: GoalWrite) -> PlanGoal` / `client.updateGoal(input)`
  - `delete_goal(id: string) -> void` / `client.deleteGoal(id)`
  - TS `Plan`, `PlanBudget`, `PlanGoal`, `BudgetWrite`, `GoalWrite` in `src/types.ts` with the camelCase fields from Task 1.
  - `resolveAmount` and `monthlyRequired` in `src/lib/plan.ts`.

- [ ] **Step 1: Write the failing TypeScript tests**

`src/lib/__tests__/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { monthlyRequired, resolveAmount } from "../plan";

describe("resolveAmount", () => {
  const versions = [
    { effectiveMonth: "2026-10", amountCents: 80000 },
    { effectiveMonth: "2026-11", amountCents: null },
  ];
  it("keeps October and clears November onward", () => {
    expect(resolveAmount(versions, "2026-09")).toBeNull();
    expect(resolveAmount(versions, "2026-10")).toBe(80000);
    expect(resolveAmount(versions, "2026-12")).toBeNull();
  });
});

describe("monthlyRequired", () => {
  it("matches the worked examples", () => {
    expect(monthlyRequired("2026-10-14", "2027-06-01", 420_000, 1_000_000)).toBe(72_500);
    expect(monthlyRequired("2026-10-14", "2027-06-01", 0, 1_001)).toBe(334);
    expect(monthlyRequired("2026-10-14", null, 0, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2026-06-01", 0, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2027-06-01", 1_000, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2026-10-20", 0, 500)).toBe(500);
  });
});
```

`src/__tests__/mock-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Category, Plan, PlanGoal } from "../types";
import { localToday } from "../lib/plan";

const month = localToday().slice(0, 7);

async function cats() {
  const all = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: true });
  const food = all.find((c) => c.name === "Food" && c.parentId == null)!;
  const dining = all.find((c) => c.name === "Dining out" && c.parentId === food.id)!;
  return { food, dining };
}

describe("mock plan", () => {
  it("keeps the envelope and the goal rules", async () => {
    await mockInvoke("reset_app", {});
    const { food, dining } = await cats();
    const sav = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Savings", subtype: "savings", openingBalanceCents: 420_000, templateKey: null, creditLimitCents: null,
    });
    await mockInvoke("set_budgets", { items: [
      { categoryId: food.id, amountCents: 80_000 },
      { categoryId: dining.id, amountCents: 25_000 },
    ] });
    await expect(mockInvoke("set_budgets", { items: [{ categoryId: food.id, amountCents: 20_000 }] }))
      .rejects.toMatchObject({ message: "Subcategory budgets add up to more than the parent." });
    const kept = await mockInvoke<Plan>("get_plan", { month });
    expect(kept.budgets.find((b) => b.categoryId === food.id)?.amountCents).toBe(80_000);

    await mockInvoke("create_expense_transaction", {
      accountId: sav.id, categoryId: dining.id, amountCents: 30_000, description: null, date: `${month}-02`,
      time: null, excludedFromReporting: false, splits: null,
    });
    const other = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Other", subtype: "cash", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    await mockInvoke("create_transfer_transaction", {
      fromAccountId: sav.id, toAccountId: other.id, amountCents: 5_000, description: null, date: `${month}-03`, time: null,
    });
    const spent = await mockInvoke<Plan>("get_plan", { month });
    expect(spent.budgets.find((b) => b.categoryId === dining.id)?.spentCents).toBe(30_000);
    expect(spent.budgets.find((b) => b.categoryId === food.id)?.spentCents).toBe(30_000);

    const goal = await mockInvoke<PlanGoal>("create_goal", {
      input: { name: "Emergency", accountId: sav.id, targetCents: 1_000_000, targetDate: "2027-06-01" },
    });
    expect(goal.balanceCents).toBe(385_000);
    await expect(mockInvoke("create_goal", {
      input: { name: "Holiday", accountId: sav.id, targetCents: 1, targetDate: null },
    })).rejects.toMatchObject({ message: "This account already has a goal." });

    const card = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Card", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: 500_000,
    });
    await expect(mockInvoke("create_goal", {
      input: { name: "Card", accountId: card.id, targetCents: 1, targetDate: null },
    })).rejects.toMatchObject({ message: "Goals can only sit on cash, an e-wallet, savings, or a current account." });

    await mockInvoke("reset_app", {});
    const cleared = await mockInvoke<Plan>("get_plan", { month: "2026-10" });
    expect(cleared.budgets).toEqual([]);
    expect(cleared.goals).toEqual([]);
  });
});
```

The seeded expense parent is `Food` and its child is `Dining out` (`src/generated/seed-catalog.json`). The expense of 30,000 and the transfer of 5,000 leave the savings balance at 385,000 because the account opened at 420,000.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/plan.test.ts src/__tests__/mock-plan.test.ts`

Expected: FAIL. `../plan` cannot be resolved, and the mock commands are unknown.

- [ ] **Step 3: Register the commands and mirror the rules**

`commands.rs`:

```rust
#[tauri::command]
pub fn get_plan(state: State<'_, DbState>, month: String) -> AppResult<Plan> {
    with_conn!(state, c => service::get_plan(&c, &month))
}

#[tauri::command]
pub fn set_budgets(state: State<'_, DbState>, items: Vec<BudgetWrite>) -> AppResult<()> {
    with_conn!(state, c => service::set_budgets(&c, &items))
}

#[tauri::command]
pub fn create_goal(state: State<'_, DbState>, input: GoalWrite) -> AppResult<PlanGoal> {
    with_conn!(state, c => service::create_goal(&c, input))
}

#[tauri::command]
pub fn update_goal(state: State<'_, DbState>, input: GoalWrite) -> AppResult<PlanGoal> {
    with_conn!(state, c => service::update_goal(&c, input))
}

#[tauri::command]
pub fn delete_goal(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => service::delete_goal(&c, &id))
}
```

Add those five names to `tauri::generate_handler!` in `lib.rs`.

`src/lib/plan.ts`:

```ts
export function resolveAmount(
  versions: { effectiveMonth: string; amountCents: number | null }[],
  month: string,
): number | null {
  let best: { effectiveMonth: string; amountCents: number | null } | null = null;
  for (const v of versions) {
    if (v.effectiveMonth <= month && (best == null || v.effectiveMonth > best.effectiveMonth)) best = v;
  }
  return best ? best.amountCents : null;
}

export function monthlyRequired(
  today: string,
  targetDate: string | null,
  balanceCents: number,
  targetCents: number,
): number | null {
  if (targetDate == null) return null;
  const gap = targetCents - balanceCents;
  if (gap <= 0 || targetDate < today) return null;
  const idx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const d = idx(targetDate.slice(0, 7)) - idx(today.slice(0, 7));
  const months = d <= 0 ? 1 : d;
  return Math.ceil(gap / months);
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

In `mock.ts`, store `budgetVersions` and `goals` arrays. Implement the five commands with the same error strings. Current month for writes is `localToday().slice(0, 7)`, not the existing UTC `today()`. Spend nets copy the attribution loop already in `get_dashboard_summary` (the `attrib` array, before `parentOf`). Refactor that loop into `spendNets(from, to): Map<string, number>` and use it both there and in `get_plan`, so the parent rollup cannot drift. `reset_app` clears both arrays before `seedCategories()`.

Add the client wrappers next to `getDashboardSummary`:

```ts
getPlan: (month: string) => dispatch<Plan>("get_plan", { month }),
setBudgets: (items: BudgetWrite[]) => dispatch<void>("set_budgets", { items }),
createGoal: (input: GoalWrite) => dispatch<PlanGoal>("create_goal", { input }),
updateGoal: (input: GoalWrite) => dispatch<PlanGoal>("update_goal", { input }),
deleteGoal: (id: string) => dispatch<void>("delete_goal", { id }),
```

The mock reads the camelCase args the client sends (`items`, `input`, `categoryId`, `amountCents`, `accountId`, `targetCents`, `targetDate`). `fail(code, message)` throws `{ code, message }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/plan.test.ts src/__tests__/mock-plan.test.ts`

Expected: PASS

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib plan_tests -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/types.ts src/client/index.ts src/client/mock.ts src/lib/plan.ts src/lib/__tests__/plan.test.ts src/__tests__/mock-plan.test.ts
git commit -m "feat: expose budgets and goals through the client and the mock"
```

---

### Task 7: Plan screen

**Files:**
- Modify: `src/nav.ts`
- Modify: `src/components/Icon.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/TopBar.tsx` (comment only if the prop stays `isDashboard`)
- Create: `src/screens/Plan.tsx`
- Create: `src/modals/BudgetForm.tsx`
- Create: `src/modals/GoalForm.tsx`
- Test: `npm run build`

**Interfaces:**
- Consumes: `client.getPlan`, `client.setBudgets`, `client.createGoal`, `client.updateGoal`, `client.deleteGoal`, `useAppData()` categories and accounts, `currentMonth()` from `src/lib/format.ts`, `Card`, `SectionTitle`, `Money`, `Btn`, `Modal`, `Field`, `inputStyle`, `Empty`.
- Produces: sidebar item `plan` and `<Plan month={month} />`. No new exported service.

- [ ] **Step 1: Add the screen shell so the typecheck names the missing screen**

In `src/nav.ts`, add `"plan"` to `ScreenId`. Insert it in Overview after `"dashboard"`:

```ts
{ id: "plan", label: "Plan", icon: "plan", sub: "Budgets and savings goals" },
```

```ts
{ label: "Overview", items: ["dashboard", "plan"] },
```

In `Icon.tsx`, add `"plan"` to `IconName` and this path:

```tsx
plan: <><circle {...P} cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" fill={color} stroke="none" /></>,
```

In `App.tsx`, render `{active === "plan" && <Plan month={month} />}` and pass `isDashboard={active === "dashboard" || active === "plan"}` so the existing month control shows on both screens. Update the TopBar comment to say the month control is for Dashboard and Plan.

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `npx tsc --noEmit`

Expected: FAIL. `Plan` is not defined, or `icon: "plan"` is fine once the icon exists and the screen import is missing.

- [ ] **Step 3: Build Plan and the two forms**

`Plan.tsx` loads `client.getPlan(month)` in an effect that depends on `month` and `version` from `useAppData()`. On failure, toast `error.message` the same way Dashboard does.

Closed month: `month !== currentMonth()`. Show `${fmtMonth(month)} is closed and kept as it was.` Do not render Add, Edit, or Clear.

**Budgets card.** Parents are rows with `parentId == null`. Total is the sum of their `amountCents` and the sum of their `spentCents`, with the caption "Budgeted categories only". Each row shows emoji, name, `Money` for spent and amount, then "left" or "Over". Left is `amountCents - spentCents` when spent is `<=` amount. Over uses `t.expense` and the word "Over". The bar width is `0` when amount is 0 and spent is 0, `100%` when amount is 0 and spent is above 0, otherwise `Math.min(100, spent / amount * 100)`. Expand shows child rows from `budgets` whose `parentId` matches, plus a line `{unassigned} not assigned` whenever that parent has any subcategory in `useAppData().categories` (active, or archived with a budget row). Unassigned is `parent.amountCents` minus the sum of those children's `amountCents`. Show it when it is zero too. An archived row appends the word "Archived". Empty budgets: `Empty` title "No budgets yet" and a button "Add a budget".

**Budget form.** Add picks an active expense parent (`kind === "expense"`, `!isSystem`, `!parentId`, `!isArchived`) that has no budget row this month. Edit opens an existing parent. Fields: parent amount, and one field per active child plus archived children that already have a `PlanBudget` row. Blank child → `amountCents: null`. Typed `0` → `0`. Parse with the same non-negative magnitude rule as `parseMagnitude` in `SetBalance.tsx`. Save sends one `setBudgets` array of the parent and every shown child. Clear sends `null` for the parent and every shown child. Show the thrown `message` in the modal. On success call `reload()` from `useAppData()` and close.

**Goals card.** Each goal shows name, account name, balance, target, and a bar: `0` when `balanceCents <= 0`, `100%` when `balanceCents >= targetCents`, otherwise `balance / target * 100`. When `monthlyCents != null`, show that money and `targetDate`. When `balanceCents >= targetCents`, show "Reached". When `targetDate` is set, `monthlyCents` is null, and balance is still short, show "Date passed" and the shortfall `targetCents - balanceCents`.

**Goal form.** Name, account, target, optional date. The account list is active accounts whose subtype is `cash`, `ewallet`, `savings`, or `current` and that do not already have a goal. While editing, keep the goal's current account in the list. Delete calls `deleteGoal` immediately, with no confirm dialog. Success calls `reload()`.

- [ ] **Step 4: Run the typecheck to verify it passes**

Run: `npm run build`

Expected: PASS (tsc + vite build).

- [ ] **Step 5: Commit**

```bash
git add src/nav.ts src/components/Icon.tsx src/components/TopBar.tsx src/App.tsx src/screens/Plan.tsx src/modals/BudgetForm.tsx src/modals/GoalForm.tsx
git commit -m "feat: add the Plan screen for budgets and goals"
```

---

### Task 8: Dashboard card

**Files:**
- Modify: `src/screens/Dashboard.tsx`
- Test: `npm run build`

**Interfaces:**
- Consumes: `client.getPlan(month)`, `Plan` from `src/types.ts`, `go(screen: string)`.
- Produces: a card under the spending card. No new command.

- [ ] **Step 1: Write the card into Dashboard and typecheck**

Fetch `getPlan(month)` in the same `version` effect style as `getDashboardSummary`. Ignore a load error by leaving the card hidden (the Plan screen surfaces its own error).

Place the card immediately after the spending `Card` and before the accounts `Card`. Render nothing when `budgets.length === 0 && goals.length === 0`. Otherwise:

- List every budget row with `spentCents > amountCents`, parent and slice. A parent and a slice can both appear. Each line is emoji, name, the word "Over", and `Money` for `spentCents - amountCents`.
- When `budgets.length > 0` and no row is over, one line: "All budgets are within their amounts."
- Then every goal with `balanceCents < targetCents`. A goal with `monthlyCents != null` shows that amount. A goal with a date and no monthly amount shows "Date passed".
- The card's title is "Plan". A "View" link calls `go("plan")`.
- Over uses `t.expense` and the word "Over".

- [ ] **Step 2: Run the typecheck**

Run: `npm run build`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/screens/Dashboard.tsx
git commit -m "feat: show over-budget categories and open goals on the dashboard"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/architecture/backend.md`
- Modify: `docs/architecture/categories.md`
- Modify: `docs/architecture/frontend.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-10-14-budgets-and-goals-design.md` (status line only, if it still says Approved and the work shipped: `Approved — implemented per the plan`)

- [ ] **Step 1: Update the architecture notes**

`backend.md`: state migration 013 adds `category_budgets` and `savings_goals`, and list `get_plan`, `set_budgets`, `create_goal`, `update_goal`, `delete_goal`. Say factory reset deletes both tables before accounts and categories.

`categories.md`: moving a category is rejected when the current month's budgets would not fit, and deleting a category deletes its budget versions.

`frontend.md`: Plan is under Overview, shares the Dashboard month control, and the Dashboard has a Plan card under spending.

- [ ] **Step 2: Update the changelog and the roadmap**

Under `CHANGELOG.md` `[Unreleased]` → `### Added`:

```markdown
- **Budgets and savings goals.** Set a monthly amount on an expense category. Subcategory amounts are slices of the parent and must fit inside it. This month and later months use the new amount; a finished month keeps its own. Spending uses the same figure as the Dashboard, and saving a transaction is never blocked. A goal has a name, one cash, e-wallet, savings, or current account, a target, and an optional date. Progress is that account's balance. With a date, Plan shows the amount still to add each month.
```

In `ROADMAP.md`, tick the three budgets-and-goals checkboxes and point the spec line at `docs/superpowers/specs/2026-10-14-budgets-and-goals-design.md`. Leave the phase in Planned until the release is cut. Do not assign a version.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/backend.md docs/architecture/categories.md docs/architecture/frontend.md CHANGELOG.md ROADMAP.md docs/superpowers/specs/2026-10-14-budgets-and-goals-design.md
git commit -m "docs: describe budgets and savings goals"
```

---

## Self-review notes

Spec coverage is task-by-task: tables (1), versions and envelope (2), spent and parent rollup (3), move and delete (4), goals, pace, archive, subtype, reset (5), mock parity (6), Plan UI (7), Dashboard (8), docs (9). Transaction save is untouched, so nothing in `create_expense` checks a budget. A closed month's amount stays because `set_budgets` only writes `today()`'s month; its spent can still change because `get_plan` recomputes nets. The UI does not recompute `monthlyCents`.
