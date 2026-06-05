# Balance Correction as Income / Expense — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Record as income/expense" checkbox to the Correct balance modal so a reconciliation difference can be booked as a real income or expense (auto-assigned to a protected "Adjustment" category) instead of a neutral, reporting-excluded `adjustment`.

**Architecture:** Reintroduce a protected-category concept via a new `is_system` boolean column on `categories` (migration 008). Seed two protected "Adjustment" categories (income + expense). `set_account_balance` gains a `record_as_income_expense` flag: when true and the account has activity, it inserts an `income`/`expense` transaction (sign decides) tagged the system category, otherwise the existing `adjustment`. System categories are blocked from delete/edit/archive/reparent/hand-assign and hidden from the Categories screen and transaction picker, but still flow through dashboard reporting. Every change is mirrored in the dev-only mock backend so browser-dev and the packaged app stay identical.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests via `cargo test --lib`; frontend via Vitest + `npm run build`.

**Conventions:**
- Rust/Tauri commands need `export PATH="$HOME/.cargo/bin:$PATH"` prefixed.
- Every command behavior change must land in **both** the Rust chain and `src/client/mock.ts`.
- Commit after each task. Branch is already `feat/balance-correction-income-expense`.
- Spec: `docs/superpowers/specs/2026-06-03-balance-correction-as-income-expense-design.md`.

---

## File Structure

**Rust (`src-tauri/src/`)**
- `db/migrations.rs` — add `MIGRATION_008` (ADD COLUMN `is_system`) + register in `MIGRATIONS`.
- `models.rs` — `Category.is_system: bool`.
- `repo.rs` — `map_category` reads `is_system`; new `get_system_category_id`.
- `db/seed.rs` — seed the two protected "Adjustment" categories (INSERT-OR-IGNORE + promote).
- `db/mod.rs` — `DEFAULTS_V4_KEY` gate; add to `BACKFILL_GATES` and the reset flag list.
- `service.rs` — `ensure_not_system` guard; system rejection in `validate_category_for`; `update_transaction` guard for system-categorized rows; `set_account_balance` gains `record_as_income_expense`.
- `commands.rs` — `set_account_balance` command gains the flag arg.
- `lib.rs` — update existing `set_account_balance` test call sites; add new tests.

**Frontend (`src/`)**
- `types.ts` — `Category.isSystem: boolean`.
- `client/index.ts` — `setAccountBalance` gains `recordAsIncomeExpense`.
- `client/mock.ts` — seed system rows; mirror `set_account_balance` flag, guards, picker filter.
- `lib/categories.ts` — `categoryTree` excludes `isSystem`.
- `screens/Categories.tsx` — filter `isSystem` from the loaded list.
- `modals/SetBalance.tsx` — the "Record as income/expense" checkbox.
- `__tests__/mock.test.ts` — mock-side tests.

---

## Task 1: Add `is_system` column + struct field (Rust schema foundation)

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (MIGRATIONS array + new const)
- Modify: `src-tauri/src/models.rs:61-72` (Category struct)
- Modify: `src-tauri/src/repo.rs:211-224` (map_category)

- [ ] **Step 1: Add the migration constant and register it**

In `src-tauri/src/db/migrations.rs`, change the `MIGRATIONS` array (line 6) to append `(8, MIGRATION_008)`:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007), (8, MIGRATION_008)];
```

Add the new constant directly after `MIGRATION_007` (after line 58):

```rust
// Protected ("system") categories. Adds a boolean flag so balance corrections
// booked as income/expense can be auto-assigned to a locked "Adjustment"
// category the user can't delete, rename, archive, reparent, or hand-pick.
// Plain ADD COLUMN with a default — NOT a table rebuild (a rebuild would
// cascade-delete every posting via migration 006's ON DELETE CASCADE).
const MIGRATION_008: &str = r#"
ALTER TABLE categories ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
"#;
```

- [ ] **Step 2: Add the struct field**

In `src-tauri/src/models.rs`, add to the `Category` struct (after `is_archived` on line 69):

```rust
    pub is_archived: bool,
    pub is_system: bool,
    pub created_at: String,
```

- [ ] **Step 3: Map the column**

In `src-tauri/src/repo.rs` `map_category` (line 211), add after the `is_archived` line (220):

```rust
        is_archived: r.get::<_, i64>("is_archived")? != 0,
        is_system: r.get::<_, i64>("is_system")? != 0,
        created_at: r.get("created_at")?,
```

(`list_categories` / `get_category` use `SELECT *`, so the new column is returned automatically.)

- [ ] **Step 4: Compile**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: compiles (struct, mapper, migration consistent). Warnings OK.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/models.rs src-tauri/src/repo.rs
git commit -m "feat(db): add is_system column to categories (migration 008)"
```

---

## Task 2: Seed the protected "Adjustment" categories + backfill gate

**Files:**
- Modify: `src-tauri/src/db/seed.rs` (seed_categories, after line 113 block)
- Modify: `src-tauri/src/db/mod.rs:13-21` (gate const + BACKFILL_GATES) and `:187` (reset flag list)
- Test: `src-tauri/src/lib.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/lib.rs` (place near the other seed/category tests):

```rust
#[test]
fn seeds_two_protected_adjustment_categories() {
    let c = crate::db::open_in_memory().unwrap();
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM categories WHERE is_system = 1 AND name = 'Adjustment' AND parent_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2, "expected one income + one expense Adjustment system category");
    let kinds: Vec<String> = {
        let mut stmt = c
            .prepare("SELECT kind FROM categories WHERE is_system = 1 ORDER BY kind")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(kinds, vec!["expense".to_string(), "income".to_string()]);
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib seeds_two_protected_adjustment_categories`
Expected: FAIL — assert_eq count is 0, not 2.

- [ ] **Step 3: Seed the system categories**

In `src-tauri/src/db/seed.rs`, in `seed_categories`, add this block just before the final `Ok(())` (after the SUBCATEGORIES loop):

```rust
    // Protected "Adjustment" categories (one income, one expense) for balance
    // corrections booked as income/expense. INSERT OR IGNORE then promote, so
    // exactly one system row exists per side even if the user already owns a
    // plain top-level "Adjustment" (the unique index would block a 2nd insert).
    for kind in ["income", "expense"] {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO categories
               (id, name, kind, emoji, color, sort_order, is_archived, is_system, created_at, updated_at)
             VALUES (?1, 'Adjustment', ?2, '\u{2696}\u{FE0F}', '#9aa4b2', 999, 0, 1, ?3, ?3)",
            rusqlite::params![id, kind, now],
        )?;
        conn.execute(
            "UPDATE categories SET is_system = 1
             WHERE kind = ?1 AND name = 'Adjustment' AND parent_id IS NULL",
            rusqlite::params![kind],
        )?;
    }
```

- [ ] **Step 4: Add the backfill gate for existing users**

In `src-tauri/src/db/mod.rs`, add the constant after line 14:

```rust
const DEFAULTS_V3_KEY: &str = "defaults_v3_seeded";
const DEFAULTS_V4_KEY: &str = "defaults_v4_seeded";
```

Add it to `BACKFILL_GATES` (line 21):

```rust
const BACKFILL_GATES: &[&str] = &[DEFAULTS_V2_KEY, DEFAULTS_V3_KEY, DEFAULTS_V4_KEY];
```

And add it to the reset flag list in `reset_to_defaults` (line 187):

```rust
        for key in [FIRST_RUN_KEY, DEFAULTS_V2_KEY, DEFAULTS_V3_KEY, DEFAULTS_V4_KEY] {
```

- [ ] **Step 5: Add a backfill/promotion test**

Add to `src-tauri/src/lib.rs` tests:

```rust
#[test]
fn backfill_promotes_preexisting_adjustment_category() {
    let c = crate::db::open_in_memory().unwrap();
    // Simulate an existing user who never hit the v4 gate AND owns a plain
    // top-level expense "Adjustment". Delete the seeded system rows + clear the
    // gate so backfill_gate runs seed_categories again.
    c.execute("UPDATE categories SET is_system = 0 WHERE name = 'Adjustment'", []).unwrap();
    c.execute("DELETE FROM categories WHERE name = 'Adjustment' AND kind = 'income'", []).unwrap();
    c.execute("DELETE FROM app_settings WHERE key = 'defaults_v4_seeded'", []).unwrap();
    crate::db::backfill_defaults_for_test(&c).unwrap();
    // The pre-existing expense "Adjustment" is promoted; the income one is created.
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM categories WHERE is_system = 1 AND name = 'Adjustment' AND parent_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}
```

This needs a test-only re-runner. In `src-tauri/src/db/mod.rs`, add directly after `backfill_defaults`:

```rust
/// Test hook: re-run the backfill gates (used to exercise the promotion path).
#[cfg(test)]
pub fn backfill_defaults_for_test(conn: &Connection) -> AppResult<()> {
    backfill_defaults(conn)
}
```

- [ ] **Step 6: Run the tests**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib seeds_two_protected_adjustment_categories backfill_promotes_preexisting_adjustment_category`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/seed.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "feat(db): seed protected Adjustment categories + v4 backfill gate"
```

---

## Task 3: Protect system categories in the service layer

**Files:**
- Modify: `src-tauri/src/repo.rs` (new `get_system_category_id`)
- Modify: `src-tauri/src/service.rs` (guards in delete/update/archive/restore/reparent/reorder/validate_category_for)
- Test: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/lib.rs` tests:

```rust
#[test]
fn system_categories_are_protected() {
    let c = crate::db::open_in_memory().unwrap();
    let sys_id: String = c
        .query_row(
            "SELECT id FROM categories WHERE is_system = 1 AND kind = 'expense' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(crate::service::delete_category(&c, &sys_id).is_err(), "delete must be blocked");
    let upd = crate::models::UpdateCategoryInput { id: sys_id.clone(), name: Some("Renamed".into()), emoji: None, color: None, sort_order: None };
    assert!(crate::service::update_category(&c, upd).is_err(), "rename must be blocked");
    assert!(crate::service::archive_category(&c, &sys_id).is_err(), "archive must be blocked");
    assert!(crate::service::set_category_parent(&c, &sys_id, None).is_err(), "reparent must be blocked");
}
```

- [ ] **Step 2: Run to confirm it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib system_categories_are_protected`
Expected: FAIL — delete/update/archive currently succeed.

- [ ] **Step 3: Add the repo lookup helper**

In `src-tauri/src/repo.rs`, add after `get_category` (after line 253):

```rust
/// The protected "Adjustment" category id for a kind ('income' | 'expense').
/// Guaranteed to exist by the seed; NotFound surfaces a corrupt install loudly.
pub fn get_system_category_id(conn: &Connection, kind: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT id FROM categories WHERE is_system = 1 AND kind = ?1 AND parent_id IS NULL LIMIT 1",
        [kind],
        |r| r.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("System category missing".into()),
        other => other.into(),
    })
}
```

- [ ] **Step 4: Add the service guard helper and apply it**

In `src-tauri/src/service.rs`, add a helper near `ensure_active_account` (after line 79):

```rust
/// Reject mutating a protected (system) category.
fn ensure_not_system(conn: &Connection, id: &str) -> AppResult<()> {
    if repo::get_category(conn, id)?.is_system {
        return Err(AppError::Conflict("This is a system category and can't be changed".into()));
    }
    Ok(())
}
```

Apply the guard at the start of each mutator:

`update_category` (after the `repo::get_category` on line 256):
```rust
pub fn update_category(conn: &Connection, input: UpdateCategoryInput) -> AppResult<Category> {
    repo::get_category(conn, &input.id)?;
    ensure_not_system(conn, &input.id)?;
```

`archive_category` (after line 273 `let cat = ...`):
```rust
pub fn archive_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    ensure_not_system(conn, id)?;
```

`restore_category` (after line 283 `let cat = ...`):
```rust
pub fn restore_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    ensure_not_system(conn, id)?;
```

`delete_category` (after line 297 `repo::get_category`):
```rust
pub fn delete_category(conn: &Connection, id: &str) -> AppResult<()> {
    repo::get_category(conn, id)?; // NotFound if missing
    ensure_not_system(conn, id)?;
```

`set_category_parent` (after line 312 `let cat = ...`):
```rust
pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    ensure_not_system(conn, id)?;
```

`reorder_categories` — guard each id (after line 355 `let first = ...`, extend the validation loop). Replace lines 355-361 with:
```rust
    let first = repo::get_category(conn, &ids[0])?;
    ensure_not_system(conn, &ids[0])?;
    for id in &ids[1..] {
        let cat = repo::get_category(conn, id)?;
        ensure_not_system(conn, id)?;
        if cat.kind != first.kind || cat.parent_id != first.parent_id {
            return Err(AppError::Validation("Can only reorder categories within one group".into()));
        }
    }
```

(`set_categories_archived` delegates to `archive_category`/`restore_category`, so it's covered.)

- [ ] **Step 5: Reject system categories on manual transaction assignment**

In `src-tauri/src/service.rs` `validate_category_for` (line 371), add the system check before the kind check:

```rust
fn validate_category_for(conn: &Connection, category_id: &str, kind: &str) -> AppResult<()> {
    let c = repo::get_category(conn, category_id)?;
    if c.is_system {
        return Err(AppError::Validation("That category can't be selected".into()));
    }
    if c.kind != kind {
        return Err(AppError::Validation(format!(
            "Category kind '{}' does not match transaction kind '{}'",
            c.kind, kind
        )));
    }
    Ok(())
}
```

- [ ] **Step 6: Run the tests**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib system_categories_are_protected`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat(service): protect system categories from edit/delete/assign"
```

---

## Task 4: `set_account_balance` income/expense flag (Rust + command)

**Files:**
- Modify: `src-tauri/src/service.rs:171-208` (`set_account_balance`)
- Modify: `src-tauri/src/commands.rs:65-67`
- Modify: `src-tauri/src/lib.rs` (existing call sites + new tests)

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/lib.rs` tests:

```rust
#[test]
fn correction_as_income_books_income_with_system_category() {
    let c = crate::db::open_in_memory().unwrap();
    let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None).unwrap();
    // Real activity so the adjustment/income path (not opening edit) is used.
    let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
    crate::service::create_expense(&c, &a.id, &cat, 100_00, None, "2026-06-01", None, false).unwrap();
    // Balance now 900.00; correct UP to 950.00 → +50.00 income.
    crate::service::set_account_balance(&c, &a.id, 950_00, true).unwrap();
    let sys: String = c.query_row("SELECT id FROM categories WHERE is_system=1 AND kind='income' LIMIT 1", [], |r| r.get(0)).unwrap();
    let (kind, amt, cat_id): (String, i64, Option<String>) = c
        .query_row(
            "SELECT kind, amount_cents, category_id FROM transactions WHERE kind IN ('income','expense','adjustment') AND account_id=?1 ORDER BY created_at DESC LIMIT 1",
            [&a.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(kind, "income");
    assert_eq!(amt, 50_00);
    assert_eq!(cat_id.as_deref(), Some(sys.as_str()));
    assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 950_00);
}

#[test]
fn correction_as_income_books_expense_when_diff_negative() {
    let c = crate::db::open_in_memory().unwrap();
    let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None).unwrap();
    let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
    crate::service::create_expense(&c, &a.id, &cat, 100_00, None, "2026-06-01", None, false).unwrap();
    // Balance 900.00; correct DOWN to 850.00 → -50.00 expense.
    crate::service::set_account_balance(&c, &a.id, 850_00, true).unwrap();
    let kind: String = c.query_row("SELECT kind FROM transactions WHERE account_id=?1 ORDER BY created_at DESC LIMIT 1", [&a.id], |r| r.get(0)).unwrap();
    assert_eq!(kind, "expense");
    assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 850_00);
}

#[test]
fn correction_flag_ignored_when_no_activity_edits_opening() {
    let c = crate::db::open_in_memory().unwrap();
    let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None).unwrap();
    crate::service::set_account_balance(&c, &a.id, 1_500_00, true).unwrap();
    // No income/expense row created; opening was edited.
    let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE account_id=?1 AND kind IN ('income','expense','adjustment')", [&a.id], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 1_500_00);
}
```

> Confirmed: `crate::service::get_account_balance(conn, account_id) -> AppResult<i64>` exists (`service.rs:554`); `create_expense(conn, account_id, category_id, amount_cents, description, date, time, excluded_from_reporting)` matches the test calls.

- [ ] **Step 2: Update existing call sites so the crate compiles**

The signature gains a 4th param. Update every existing `set_account_balance` call in `src-tauri/src/lib.rs` (lines ~155, 165, 333, 781, 792) to pass `false`:

Run to find them: `export PATH="$HOME/.cargo/bin:$PATH" && grep -n "set_account_balance(&c" src-tauri/src/lib.rs`

Each call like `service::set_account_balance(&c, &a.id, 5000)` becomes `service::set_account_balance(&c, &a.id, 5000, false)`.

- [ ] **Step 3: Run tests to confirm they fail (compile error or wrong behavior)**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib correction_as_income`
Expected: FAIL — `set_account_balance` takes 3 args, not 4 (signature not yet changed). This is the expected red.

- [ ] **Step 4: Change the service function**

In `src-tauri/src/service.rs`, replace `set_account_balance` (lines 171-208) with:

```rust
pub fn set_account_balance(
    conn: &Connection,
    account_id: &str,
    real_balance_cents: i64,
    record_as_income_expense: bool,
) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot reconcile an archived account".into()));
    }
    if !repo::account_has_nonopening_activity(conn, account_id)? {
        // Only the opening row exists — edit it so the balance equals the target.
        // The income/expense flag has no meaning here (nothing to classify).
        let tx = conn.unchecked_transaction()?;
        repo::set_opening_amount(&tx, account_id, real_balance_cents, &now())?;
        let opening = repo::get_opening_transaction(&tx, account_id)?;
        materialize_postings(&tx, &opening)?;
        tx.commit()?;
        return repo::get_account(conn, account_id);
    }
    let diff = real_balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let today = crate::today();
    let tx = conn.unchecked_transaction()?;
    let txn = if record_as_income_expense {
        // Sign decides: surplus → income, shortfall → expense. Amount is the
        // positive magnitude; the posting engine applies the sign per kind.
        let kind = if diff > 0 { KIND_INCOME } else { KIND_EXPENSE };
        let cat_id = repo::get_system_category_id(&tx, kind)?;
        repo::insert_transaction(
            &tx,
            &new_id(),
            kind,
            account_id,
            None,
            Some(&cat_id),
            diff.abs(),
            Some("Balance adjustment"),
            &today,
            None,
            false,
            &now(),
        )?
    } else {
        repo::insert_transaction(
            &tx,
            &new_id(),
            KIND_ADJUSTMENT,
            account_id,
            None,
            None,
            diff,
            Some("Balance adjustment"),
            &today,
            None,
            false,
            &now(),
        )?
    };
    materialize_postings(&tx, &txn)?;
    tx.commit()?;
    repo::get_account(conn, account_id)
}
```

- [ ] **Step 5: Change the Tauri command**

In `src-tauri/src/commands.rs`, replace lines 65-67:

```rust
#[tauri::command]
pub fn set_account_balance(state: State<'_, DbState>, account_id: String, real_balance_cents: i64, record_as_income_expense: bool) -> AppResult<Account> {
    with_conn!(state, c => service::set_account_balance(&c, &account_id, real_balance_cents, record_as_income_expense))
}
```

- [ ] **Step 6: Run the tests**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib`
Expected: PASS — all tests including the three new ones and the pre-existing `set_account_balance` tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(service): set_account_balance can book a correction as income/expense"
```

---

## Task 5: Lock editing of correction (system-categorized) transactions

**Files:**
- Modify: `src-tauri/src/service.rs` `update_transaction` (around line 470-476)
- Test: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/lib.rs` tests:

```rust
#[test]
fn correction_income_expense_cannot_be_edited() {
    let c = crate::db::open_in_memory().unwrap();
    let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None).unwrap();
    let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
    crate::service::create_expense(&c, &a.id, &cat, 100_00, None, "2026-06-01", None, false).unwrap();
    crate::service::set_account_balance(&c, &a.id, 950_00, true).unwrap();
    let corr_id: String = c.query_row("SELECT id FROM transactions WHERE kind='income' AND account_id=?1 LIMIT 1", [&a.id], |r| r.get(0)).unwrap();
    let income_cat: String = c.query_row("SELECT id FROM categories WHERE kind='income' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
    let input = crate::models::UpdateTransactionInput {
        id: corr_id,
        kind: "income".into(),
        account_id: a.id.clone(),
        to_account_id: None,
        category_id: Some(income_cat),
        amount_cents: 50_00,
        description: None,
        transaction_date: "2026-06-02".into(),
        transaction_time: None,
        excluded_from_reporting: false,
    };
    assert!(crate::service::update_transaction(&c, input).is_err(), "editing a balance correction must be blocked");
}
```

> Note: confirm `UpdateTransactionInput`'s exact fields by reading `src-tauri/src/models.rs:124-140` and match them (e.g. the order/optionality of `excluded_from_reporting`, `transaction_time`). Adjust the struct literal to compile.

- [ ] **Step 2: Run to confirm it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib correction_income_expense_cannot_be_edited`
Expected: FAIL — the edit currently succeeds.

- [ ] **Step 3: Add the guard**

In `src-tauri/src/service.rs` `update_transaction`, after the existing `KIND_ADJUSTMENT` guard (line 474-476) and before `validate_positive`, add:

```rust
    if existing.kind == KIND_ADJUSTMENT || input.kind == KIND_ADJUSTMENT {
        return Err(AppError::Validation("Adjustments cannot be edited; delete it and reconcile again".into()));
    }
    // Corrections booked as income/expense carry a protected (system) category.
    // They are structural like adjustments — edit by deleting and reconciling.
    if let Some(cid) = existing.category_id.as_deref() {
        if repo::get_category(conn, cid)?.is_system {
            return Err(AppError::Validation("Balance corrections can't be edited; delete it and reconcile again".into()));
        }
    }
    validate_positive(input.amount_cents)?;
```

- [ ] **Step 4: Run the test**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib correction_income_expense_cannot_be_edited`
Expected: PASS.

- [ ] **Step 5: Full Rust suite**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib`
Expected: PASS (whole suite).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat(service): block editing balance-correction transactions"
```

---

## Task 6: TS types + client + mock parity

**Files:**
- Modify: `src/types.ts:45-57` (Category)
- Modify: `src/client/index.ts:32-33` (setAccountBalance)
- Modify: `src/client/mock.ts` (seed, set_account_balance, guards, picker)
- Test: `src/__tests__/mock.test.ts`

- [ ] **Step 1: Add the TS type field**

In `src/types.ts` `Category`, add after `isArchived`:

```typescript
  isArchived: boolean;
  isSystem: boolean;
  createdAt: string;
```

- [ ] **Step 2: Extend the client wrapper**

In `src/client/index.ts`, replace the `setAccountBalance` entry (lines 32-33):

```typescript
  setAccountBalance: (accountId: string, realBalanceCents: number, recordAsIncomeExpense = false) =>
    dispatch<Account>("set_account_balance", { accountId, realBalanceCents, recordAsIncomeExpense }),
```

- [ ] **Step 3: Write failing mock tests**

Add to `src/__tests__/mock.test.ts` (follow the file's existing import/helpers style — it imports the mock `invoke`/`client`; match how other tests call it):

```typescript
import { describe, it, expect } from "vitest";
import { client } from "../client";

describe("balance correction as income/expense (mock)", () => {
  it("books income with the system category when diff > 0", async () => {
    const acc = await client.createAccount("Cash", "cash", 1_000_00);
    const expCat = (await client.listCategories("expense")).find((c) => !c.isSystem)!;
    await client.createExpense(acc.id, expCat.id, 100_00, null, "2026-06-01");
    await client.setAccountBalance(acc.id, 950_00, true);
    const txns = await client.listTransactions({ accountId: acc.id });
    const corr = txns.find((t) => t.kind === "income")!;
    const sys = (await client.listCategories("income", true)).find((c) => c.isSystem)!;
    expect(corr).toBeTruthy();
    expect(corr.amountCents).toBe(50_00);
    expect(corr.categoryId).toBe(sys.id);
    const updated = await client.getAccountBalance(acc.id);
    expect(updated).toBe(950_00);
  });

  it("hides system categories from list_categories picker but keeps them queryable", async () => {
    const visible = await client.listCategories("income");
    expect(visible.some((c) => c.isSystem)).toBe(false);
  });

  it("blocks deleting and editing a system category", async () => {
    const sys = (await client.listCategories("expense", true)).find((c) => c.isSystem)!;
    await expect(client.deleteCategory(sys.id)).rejects.toBeTruthy();
    await expect(client.updateCategory({ id: sys.id, name: "Nope" })).rejects.toBeTruthy();
  });
});
```

> Note: `list_categories` in the mock currently returns system rows. The picker-filter test asserts they're excluded — decide the contract: **exclude `isSystem` from `list_categories` unless `includeArchived`-style override is requested.** Simpler and matches the screen needs: exclude `isSystem` from `list_categories` by default; the tests above query system rows with the second arg `true`. Implement accordingly in Step 5 (the mock filters `isSystem` out unless the second arg is true). Mirror this in the Rust `list_categories` only if you also want backend symmetry — NOT required, because the frontend filters via `categoryTree`/screen. Keep the backend returning all rows and do the system filtering in `categoryTree` + the screen (Task 7). For the mock, match the backend: return all rows; do the hiding in `categoryTree`. **Therefore change the second mock test to assert via `categoryTree`, not `list_categories`** — see corrected test below.

Replace the second test with:

```typescript
  it("excludes system categories from the transaction picker tree", async () => {
    const { categoryTree } = await import("../lib/categories");
    const all = await client.listCategories(undefined, true);
    const tree = categoryTree(all, "expense");
    expect(tree.some((n) => n.category.isSystem)).toBe(false);
  });
```

- [ ] **Step 4: Run to confirm failures**

Run: `npx vitest run src/__tests__/mock.test.ts -t "balance correction as income"`
Expected: FAIL — `isSystem` undefined on seeded rows, `setAccountBalance` ignores the flag, guards missing.

- [ ] **Step 5: Implement mock parity**

In `src/client/mock.ts`:

**(a) Seed `isSystem`** — in `seedCategories` (lines 97-108), add `isSystem: false` to both `categories.push(...)` literals, then append the two system rows before the function's close (after line 108, before `}`):

```typescript
  for (const kind of ["income", "expense"] as const) {
    categories.push({ id: uid(), name: "Adjustment", kind, emoji: "⚖️", color: "#9aa4b2", parentId: null, sortOrder: 999, isArchived: false, isSystem: true, createdAt: now(), updatedAt: now() });
  }
```

Also add `isSystem: false` to the `create_category` literal (line 251) and the system check (Step 5e).

**(b) `set_account_balance`** — replace the `else` branch (lines 220-223) with:

```typescript
      } else {
        const diff = a.realBalanceCents - balanceOf(acc);
        if (diff !== 0) {
          if (a.recordAsIncomeExpense) {
            const kind = diff > 0 ? "income" : "expense";
            const cat = categories.find((c) => c.isSystem && c.kind === kind && c.parentId == null);
            txns.unshift({ id: uid(), kind, accountId: acc.id, toAccountId: null, categoryId: cat ? cat.id : null, amountCents: Math.abs(diff), description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false });
          } else {
            txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false });
          }
        }
      }
```

**(c) Category mutator guards** — at the top of each case, after the `find(...) ?? fail(...)`:
- `update_category` (line 229): `if (cat.isSystem) fail("Conflict", "This is a system category and can't be changed");`
- `archive_category`/`restore_category` (line 257): `if (c.isSystem) fail("Conflict", "This is a system category and can't be changed");`
- `delete_category` (line 267): `if (c.isSystem) fail("Conflict", "This is a system category and can't be changed");`
- `set_categories_archived` (line 282 loop body): `if (c.isSystem) return;` (skip — bulk ops ignore system rows)
- `set_category_parent` (line 294): `if (cat.isSystem) fail("Conflict", "This is a system category and can't be changed");`
- `reorder_categories` (line 274 loop): `if (c && c.isSystem) return;` (skip)

**(d) Transaction-assignment guards:**
- In `create_income_transaction`/`create_expense_transaction` (line 321-324), after finding `c`: `if (c && c.isSystem) fail("ValidationError", "That category can't be selected");`
- In `update_transaction` (after line 353), add:
  ```typescript
  const exCat = categories.find((x) => x.id === txns[i].categoryId);
  if (exCat?.isSystem) fail("ValidationError", "Balance corrections can't be edited; delete it and reconcile again");
  ```
  and in the category-kind check block (line 354-357), also reject assigning a system category: after the kind check add `if (c && c.isSystem) fail("ValidationError", "That category can't be selected");`

**(e) `create_category` literal** (line 251): add `isSystem: false,` to the object.

- [ ] **Step 6: Filter `categoryTree`** (also used by the picker)

In `src/lib/categories.ts` `categoryTree` (line 20), add `!c.isSystem`:

```typescript
    .filter((c) => c.kind === kind && c.parentId == null && !c.isSystem)
```

- [ ] **Step 7: Run the mock tests**

Run: `npx vitest run src/__tests__/mock.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/client/index.ts src/client/mock.ts src/lib/categories.ts src/__tests__/mock.test.ts
git commit -m "feat(mock): mirror income/expense correction + system-category guards"
```

---

## Task 7: Categories screen filtering + SetBalance checkbox (UI)

**Files:**
- Modify: `src/screens/Categories.tsx:268`
- Modify: `src/modals/SetBalance.tsx`

- [ ] **Step 1: Hide system categories on the Categories screen**

In `src/screens/Categories.tsx`, replace line 268:

```typescript
    client.listCategories(undefined, true).then((rows) => setAll(rows.filter((c) => !c.isSystem))).catch(() => {});
```

(This single filter feeds the list, `activeCount`, the `categoryTree` view, and the drag-reorder sibling computation, so system rows never appear or get reordered.)

- [ ] **Step 2: Add the checkbox state to SetBalance**

In `src/modals/SetBalance.tsx`, after the `inCredit` state (line 35), add:

```typescript
  const [recordAsIE, setRecordAsIE] = useState(false);
```

- [ ] **Step 3: Pass the flag on submit**

In `submit()` (line 56), pass the flag (only meaningful when there are transactions):

```typescript
      await client.setAccountBalance(account.id, targetCents, hasTransactions && recordAsIE);
```

- [ ] **Step 4: Render the checkbox (only when transactions exist)**

In `src/modals/SetBalance.tsx`, immediately before the info box `<div>` (line 92), add:

```tsx
        {hasTransactions && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, cursor: "pointer" }}>
            <input type="checkbox" checked={recordAsIE} onChange={(e) => setRecordAsIE(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: t.accent, cursor: "pointer" }} />
            Record as income/expense (count it in reporting)
          </label>
        )}
```

- [ ] **Step 5: Update the info box to reflect the choice**

In `src/modals/SetBalance.tsx`, replace the transactions branch of the info box (the `diff === 0 ? ... : ( ... adjustment ... )` part, lines 95-102) with:

```tsx
          ) : diff === 0 ? (
            <>Balance already matches — no change will be recorded.</>
          ) : recordAsIE ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name={diff > 0 ? "in" : "out"} size={14} color={diff > 0 ? t.income : t.expense} />
              Records <b style={{ color: diff > 0 ? t.income : t.expense }}>{(Math.abs(diff) / 100).toFixed(2)}</b> as {diff > 0 ? "income" : "expense"} dated today, counted in reporting.
            </span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="sliders" size={14} color={t.adjustment} />
              Records a <b style={{ color: t.adjustment }}>{diff > 0 ? "+" : "−"}{(Math.abs(diff) / 100).toFixed(2)}</b> adjustment dated today. Past history is untouched.
            </span>
          )}
```

> Confirmed: `in` (income) and `out` (expense) are valid `Icon` names (`Icon.tsx:9`), and `t.income` / `t.expense` exist in the theme tokens (`tokens.ts:54`). `sliders` is the existing adjustment glyph.

- [ ] **Step 6: Frontend gate**

Run: `npm run build`
Expected: clean `tsc` + `vite build` (strict, `noUnusedLocals`).

Run: `npm test`
Expected: PASS (full Vitest suite).

- [ ] **Step 7: Manual smoke (optional but recommended)**

Run: `npm run dev`, open an account with transactions → Correct balance → toggle "Record as income/expense", confirm the preview switches between adjustment and income/expense and the amount updates. Confirm the Categories screen shows no "Adjustment" system rows and the Add Transaction category picker omits them.

- [ ] **Step 8: Commit**

```bash
git add src/screens/Categories.tsx src/modals/SetBalance.tsx
git commit -m "feat(ui): record-as-income/expense checkbox + hide system categories"
```

---

## Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (Money/balances + Subcategories/categories sections)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Update CLAUDE.md**

Add to the balance-correction bullet: corrections can now be booked as income/expense via `set_account_balance(..., record_as_income_expense)`; sign decides income (diff>0) vs expense (diff<0); auto-assigned to a protected "Adjustment" category. Add to the categories section: reintroduced `is_system` column (migration 008), two seeded protected "Adjustment" categories (income+expense) backfilled via `defaults_v4_seeded`; system categories can't be deleted/renamed/archived/reparented/hand-assigned, are hidden from the Categories screen and transaction picker (`categoryTree` filter), but still count in dashboard reporting; correction transactions (system-categorized) can't be edited (delete & reconcile).

- [ ] **Step 2: Update CHANGELOG.md**

Under `## [Unreleased]` → `### Added`:

```markdown
- Balance correction can now be recorded as real income or expense (not just a neutral adjustment), so forgotten interest/fees count in reporting. Such corrections are tagged a protected "Adjustment" category.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: document income/expense balance correction + system categories"
```

---

## Final verification

- [ ] `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib` — all pass
- [ ] `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build` — compiles (validates command registration)
- [ ] `npm run build` — clean
- [ ] `npm test` — all pass
- [ ] Manual: `npm run tauri dev` — open an existing DB, confirm migration 008 applies and the two Adjustment categories appear in a correction's reporting but not the Categories screen.
