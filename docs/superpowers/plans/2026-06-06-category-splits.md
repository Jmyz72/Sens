# Category Splits & Add-Transaction Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an income/expense transaction divide its amount across multiple categories (a "split"), entered through a fast itemized Add-Transaction builder, and display splits correctly in the list, detail panel, and dashboard.

**Architecture:** Splits are a *category-attribution* layer only — they never touch the double-entry `postings` ledger or balances. A transaction is either single-category (`transactions.category_id` set, no split rows) or split (`category_id` NULL + ≥2 rows in a new `transaction_splits` table, summing to the header `amount_cents`). The single Tauri→service→repo→SQLite chain and the dev-only `src/client/mock.ts` are changed in lockstep. Only `spending_breakdown` changes in reporting; `sum_kind_in_range` is untouched.

**Tech Stack:** Tauri v2 (Rust, rusqlite) · React 19 + TypeScript + Vite · SQLite · Vitest · `cargo test --lib`.

**Spec:** `docs/superpowers/specs/2026-06-06-category-splits-and-add-transaction-redesign-design.md`

**Commands:** Rust needs `export PATH="$HOME/.cargo/bin:$PATH"`. Frontend gate `npm run build`; tests `npm test` and `cd src-tauri && cargo test --lib`.

---

## File Structure

**Backend (Rust)**
- `src-tauri/src/db/migrations.rs` — add `MIGRATION_009` (new `transaction_splits` table) + register it.
- `src-tauri/src/models.rs` — `TxnSplit` (Serialize), `SplitInput` (Deserialize), `Transaction.splits`, `UpdateTransactionInput.splits`.
- `src-tauri/src/repo.rs` — split CRUD, split hydration on reads, `spending_breakdown` rewrite, `count_transactions_for_category` + `list_transactions` filter updates.
- `src-tauri/src/service.rs` — `validate_splits`, splits in `create_income`/`create_expense`/`update_transaction`.
- `src-tauri/src/commands.rs` — thread `splits` through the three commands.

**Frontend (TypeScript)**
- `src/types.ts` — `TxnSplit`, `Transaction.splits`, input shapes.
- `src/client/index.ts` — pass `splits` through wrappers.
- `src/client/mock.ts` — mirror split storage, create/update, `spending_breakdown`, counts, filter.
- `src/lib/txnBuilder.ts` — **new** pure, unit-tested builder logic (add/remove/total/finalize/isSplit/validate).
- `src/modals/AddTransaction.tsx` — itemized builder UI.
- `src/components/TxnRow.tsx` — split row rendering (glyph badge + SPLIT·N pill + total only).
- `src/components/TxnDetailPanel.tsx` — split breakdown + per-item edit.

**Tests**
- `src-tauri/src/lib.rs` `#[cfg(test)]` — Rust service/repo tests.
- `src/__tests__/txnBuilder.test.ts` — builder logic.
- `src/__tests__/mock-splits.test.ts` — mock parity.

---

## Phase 1 — Backend data model & service

### Task 1: Migration — `transaction_splits` table

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (the `MIGRATIONS` array line ~6, and add a new `const`)

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/lib.rs` inside the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn migration_009_creates_splits_table() {
    let conn = test_conn(); // existing helper that runs migrations on an in-memory db
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='transaction_splits'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
```

> If the test helper is not named `test_conn`, mirror whatever existing tests use to get a migrated `Connection` (search `fn ` in the test module).

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_009_creates_splits_table`
Expected: FAIL — no such table `transaction_splits`.

- [ ] **Step 3: Add the migration**

In `src-tauri/src/db/migrations.rs`, change the `MIGRATIONS` array to append version 9:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007), (8, MIGRATION_008), (9, MIGRATION_009)];
```

Add the new constant (place it near the other recent migrations):

```rust
// v-next — category splits. A transaction may divide its amount across multiple
// categories. Splits are a category-attribution layer only — they never touch
// the `postings` ledger or balances. Data-preserving: a NEW table only (no
// rebuild of `transactions`, so migration 006's posting cascade is irrelevant).
// No backfill needed — no existing transaction is a split.
const MIGRATION_009: &str = r#"
CREATE TABLE transaction_splits (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES categories(id)   ON DELETE RESTRICT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_splits_txn ON transaction_splits(transaction_id);
CREATE INDEX idx_splits_cat ON transaction_splits(category_id);
"#;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_009_creates_splits_table`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/lib.rs
git commit -m "feat(db): add transaction_splits table (migration 009)"
```

---

### Task 2: Models — `TxnSplit`, `SplitInput`, `Transaction.splits`

**Files:**
- Modify: `src-tauri/src/models.rs` (Transaction struct ~77-90; UpdateTransactionInput ~127-139)

- [ ] **Step 1: Add the structs and fields**

Add near the `Transaction` struct:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnSplit {
    pub category_id: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    pub category_id: String,
    pub amount_cents: i64,
}
```

Add to `Transaction` (after `excluded_from_reporting`):

```rust
    #[serde(default)]
    pub splits: Vec<TxnSplit>,
```

> `Transaction` derives `Serialize` only, so `#[serde(default)]` is harmless; it documents that `splits` is empty for single-category rows. If adding the field breaks any struct-literal construction sites, fix them in this step (search `Transaction {` in `repo.rs` — `map_transaction` is the only constructor; Task 3 sets `splits` there).

Add to `UpdateTransactionInput` (after `excluded_from_reporting`):

```rust
    #[serde(default)]
    pub splits: Option<Vec<SplitInput>>,
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build`
Expected: compiles (after Task 3 fixes `map_transaction`; if it errors only on `map_transaction` missing `splits`, proceed to Task 3 then return). To keep this task self-contained, temporarily set `splits: Vec::new()` in `map_transaction` now:

In `repo.rs` `map_transaction`, add as the last field:
```rust
        splits: Vec::new(),
```

Run `cargo build` again → compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/repo.rs
git commit -m "feat(models): add TxnSplit/SplitInput and Transaction.splits"
```

---

### Task 3: Repo — split CRUD + hydration

**Files:**
- Modify: `src-tauri/src/repo.rs`

- [ ] **Step 1: Write the failing test**

Add to the test module in `lib.rs`:

```rust
#[test]
fn splits_insert_and_hydrate() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let cat_a = first_category_id(&conn, "expense", 0); // helper: nth non-system expense category id
    let cat_b = first_category_id(&conn, "expense", 1);
    // Insert a split transaction directly via repo helpers.
    let now = "2026-06-06T00:00:00Z";
    let t = repo::insert_transaction(&conn, "tx1", "expense", &acc.id, None, None, 15000, Some("Lotus"), "2026-06-06", None, false, now).unwrap();
    repo::insert_split(&conn, "s1", &t.id, &cat_a, 10000, 0, now).unwrap();
    repo::insert_split(&conn, "s2", &t.id, &cat_b, 5000, 1, now).unwrap();
    let got = repo::get_transaction(&conn, &t.id).unwrap();
    assert_eq!(got.splits.len(), 2);
    assert_eq!(got.splits.iter().map(|s| s.amount_cents).sum::<i64>(), 15000);
}
```

> If helpers `first_category_id` / `test_conn` don't exist, add a tiny local helper in the test module that selects expense category ids: `SELECT id FROM categories WHERE kind='expense' AND is_system=0 ORDER BY sort_order LIMIT 1 OFFSET ?`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib splits_insert_and_hydrate`
Expected: FAIL — `repo::insert_split` not found.

- [ ] **Step 3: Implement repo split functions + hydration**

In `repo.rs`, add (near the transaction functions):

```rust
pub fn insert_split(conn: &Connection, id: &str, transaction_id: &str, category_id: &str, amount_cents: i64, sort_order: i64, now: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, transaction_id, category_id, amount_cents, sort_order, now],
    ).map_err(map_check)?;
    Ok(())
}

pub fn list_splits_for(conn: &Connection, transaction_id: &str) -> AppResult<Vec<TxnSplit>> {
    let mut stmt = conn.prepare(
        "SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map([transaction_id], |r| Ok(TxnSplit { category_id: r.get(0)?, amount_cents: r.get(1)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_splits_for(conn: &Connection, transaction_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM transaction_splits WHERE transaction_id = ?1", [transaction_id])?;
    Ok(())
}
```

Add `use crate::models::TxnSplit;` to the imports if `TxnSplit` is not already in scope.

Hydrate splits everywhere a `Transaction` is returned. The cleanest single chokepoint: `get_transaction`. Find `get_transaction` and, after it builds the `Transaction` via `map_transaction`, set `.splits`:

```rust
pub fn get_transaction(conn: &Connection, id: &str) -> AppResult<Transaction> {
    let mut t = conn.query_row(
        "SELECT * FROM transactions WHERE id = ?1", [id], map_transaction,
    ).map_err(not_found_if_missing)?; // keep existing error mapping
    t.splits = list_splits_for(conn, id)?;
    Ok(t)
}
```

> Match the **existing** body of `get_transaction` (error handling, column list); only add the two lines that load and assign `t.splits`. Remove the temporary `splits: Vec::new()` default from `map_transaction` only if you instead hydrate in every caller; simplest is to **keep** `map_transaction` defaulting to empty and hydrate in `get_transaction` + `list_transactions` (next).

In `list_transactions`, after collecting `rows: Vec<Transaction>`, hydrate each (batch is fine for app scale):

```rust
    let mut rows = /* existing collect */;
    for t in rows.iter_mut() {
        t.splits = list_splits_for(conn, &t.id)?;
    }
    Ok(rows)
```

Do the same in `recent_transactions` (dashboard recent list) so split rows render there too.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib splits_insert_and_hydrate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/lib.rs
git commit -m "feat(repo): split CRUD and hydration on transaction reads"
```

---

### Task 4: Service — validate + create split income/expense

**Files:**
- Modify: `src-tauri/src/service.rs` (`create_income` ~472, `create_expense` ~484)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn create_split_expense_sums_and_attributes() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let a = first_category_id(&conn, "expense", 0);
    let b = first_category_id(&conn, "expense", 1);
    let splits = vec![
        models::SplitInput { category_id: a.clone(), amount_cents: 10000 },
        models::SplitInput { category_id: b.clone(), amount_cents: 5000 },
    ];
    let t = service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-06", None, false, Some(splits)).unwrap();
    assert_eq!(t.category_id.as_deref(), Some(a.as_str())); // header = first split's category (CHECK requires non-null)
    assert_eq!(t.splits.len(), 2);
    assert_eq!(t.amount_cents, 15000);
    // balance unaffected by attribution: account dropped by 15000
    assert_eq!(service::get_account_balance(&conn, &acc.id).unwrap(), -15000);
}

#[test]
fn create_split_rejects_sum_mismatch() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let a = first_category_id(&conn, "expense", 0);
    let b = first_category_id(&conn, "expense", 1);
    let splits = vec![
        models::SplitInput { category_id: a, amount_cents: 10000 },
        models::SplitInput { category_id: b, amount_cents: 4000 },
    ];
    let err = service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-06", None, false, Some(splits)).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib create_split`
Expected: FAIL — `create_expense` arity mismatch / function signature.

- [ ] **Step 3: Implement validator + thread splits through create**

Add the shared validator in `service.rs`:

```rust
/// Validate split lines for an income/expense transaction. Returns Ok only when
/// there are >= 2 lines, all positive, summing to `total`, each category valid
/// for `kind` and non-system.
fn validate_splits(conn: &Connection, kind: &str, splits: &[crate::models::SplitInput], total: i64) -> AppResult<()> {
    if splits.len() < 2 {
        return Err(AppError::Validation("A split needs at least two categories".into()));
    }
    let mut sum = 0i64;
    for s in splits {
        if s.amount_cents <= 0 {
            return Err(AppError::Validation("Each split amount must be positive".into()));
        }
        validate_category_for(conn, &s.category_id, kind)?; // also rejects wrong-kind
        ensure_not_system(conn, &s.category_id)?;           // existing guard
        sum += s.amount_cents;
    }
    if sum != total {
        return Err(AppError::Validation("Split amounts must add up to the total".into()));
    }
    Ok(())
}
```

> If `ensure_not_system` takes different args, match its existing signature (search `fn ensure_not_system`). If it does not exist as a standalone, inline the check: `if repo::get_category(conn, &s.category_id)?.is_system { return Err(...) }`.

Change `create_income` and `create_expense` to accept `category_id: Option<&str>` and a new `splits: Option<Vec<SplitInput>>`. New `create_expense` (mirror for `create_income` with `KIND_INCOME`):

```rust
pub fn create_expense(conn: &Connection, account_id: &str, category_id: Option<&str>, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, None)?;
    let tx = conn.unchecked_transaction()?;

    // The transactions CHECK requires category_id NOT NULL for income/expense, so
    // a split stores its FIRST line's category as a representative header. "Is a
    // split" is decided by the presence of split rows, never by a null category.
    let header_cat: Option<String> = match &splits {
        Some(s) if !s.is_empty() => {
            validate_splits(&tx, KIND_EXPENSE, s, amount_cents)?;
            Some(s[0].category_id.clone())
        }
        _ => {
            let cat = category_id.ok_or_else(|| AppError::Validation("A category is required".into()))?;
            validate_category_for(&tx, cat, KIND_EXPENSE)?;
            Some(cat.to_string())
        }
    };

    let t = repo::insert_transaction(&tx, &new_id(), KIND_EXPENSE, account_id, None, header_cat.as_deref(), amount_cents, description, date, time.as_deref(), excluded_from_reporting, &now())?;
    if let Some(s) = &splits {
        if !s.is_empty() {
            for (i, line) in s.iter().enumerate() {
                repo::insert_split(&tx, &new_id(), &t.id, &line.category_id, line.amount_cents, i as i64, &now())?;
            }
        }
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    repo::get_transaction(conn, &t.id) // re-read so returned Transaction carries hydrated splits
}
```

> `materialize_postings` uses only the header (`amount_cents`, account, kind) — unchanged, correct for splits.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib create_split`
Expected: PASS (both tests). Compilation will fail at call sites in `commands.rs`/`lib.rs` until Task 7 — temporarily update existing callers to pass `None` for `category_id`→`Some(..)` and `None` for `splits` so this task's tests build. Specifically, existing non-split callers become `create_expense(&c, &account_id, Some(&category_id), amount_cents, ..., None)`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(service): create split income/expense with validation"
```

---

### Task 5: Service — update transaction with splits

**Files:**
- Modify: `src-tauri/src/service.rs` (`update_transaction` ~514-580)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn update_single_to_split_and_back() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let a = first_category_id(&conn, "expense", 0);
    let b = first_category_id(&conn, "expense", 1);
    let t = service::create_expense(&conn, &acc.id, Some(&a), 15000, None, "2026-06-06", None, false, None).unwrap();
    // single -> split
    let upd = models::UpdateTransactionInput {
        id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(), to_account_id: None,
        category_id: None, amount_cents: 15000, description: None, transaction_date: "2026-06-06".into(),
        transaction_time: None, excluded_from_reporting: false,
        splits: Some(vec![
            models::SplitInput { category_id: a.clone(), amount_cents: 9000 },
            models::SplitInput { category_id: b.clone(), amount_cents: 6000 },
        ]),
    };
    let t2 = service::update_transaction(&conn, upd).unwrap();
    assert_eq!(t2.splits.len(), 2);
    assert_eq!(t2.category_id.as_deref(), Some(a.as_str())); // header = first split's category
    // split -> single
    let upd2 = models::UpdateTransactionInput {
        id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(), to_account_id: None,
        category_id: Some(a.clone()), amount_cents: 15000, description: None, transaction_date: "2026-06-06".into(),
        transaction_time: None, excluded_from_reporting: false, splits: None,
    };
    let t3 = service::update_transaction(&conn, upd2).unwrap();
    assert_eq!(t3.splits.len(), 0);
    assert_eq!(t3.category_id.as_deref(), Some(a.as_str()));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib update_single_to_split_and_back`
Expected: FAIL — `UpdateTransactionInput` has no `splits` / behavior missing.

- [ ] **Step 3: Implement splits in `update_transaction`**

In the `KIND_INCOME | KIND_EXPENSE` match arm, branch on `input.splits`. Replace the existing arm body:

```rust
        KIND_INCOME | KIND_EXPENSE => {
            match &input.splits {
                Some(s) if !s.is_empty() => {
                    validate_splits(conn, &input.kind, s, input.amount_cents)?;
                    (None, Some(s[0].category_id.clone())) // header = first split's category (CHECK needs non-null)
                }
                _ => {
                    let cat = input.category_id.as_deref()
                        .ok_or_else(|| AppError::Validation("A category is required".into()))?;
                    validate_category_for(conn, cat, &input.kind)?;
                    (None, Some(cat.to_string()))
                }
            }
        }
```

After `update_transaction_row(...)` succeeds and before `materialize_postings`, replace the split set:

```rust
    repo::delete_splits_for(&dbtx, &input.id)?;
    if let Some(s) = &input.splits {
        if !s.is_empty() {
            for (i, line) in s.iter().enumerate() {
                repo::insert_split(&dbtx, &new_id(), &input.id, &line.category_id, line.amount_cents, i as i64, &now())?;
            }
        }
    }
```

Then change the final return to re-read so splits are hydrated:

```rust
    materialize_postings(&dbtx, &t)?;
    dbtx.commit()?;
    repo::get_transaction(conn, &input.id)
```

> The existing guards (opening/adjustment/system-category) stay exactly as-is at the top — a split can't be created on those kinds because they never reach this arm.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib update_single_to_split_and_back`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat(service): edit splits via update_transaction (single<->split)"
```

---

### Task 6: Repo — reporting & counts honor splits

**Files:**
- Modify: `src-tauri/src/repo.rs` (`spending_breakdown` ~555, `count_transactions_for_category` ~341, `list_transactions` filter ~513)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn breakdown_attributes_split_lines() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let a = first_category_id(&conn, "expense", 0);
    let b = first_category_id(&conn, "expense", 1);
    service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-10", None, false,
        Some(vec![
            models::SplitInput { category_id: a.clone(), amount_cents: 10000 },
            models::SplitInput { category_id: b.clone(), amount_cents: 5000 },
        ])).unwrap();
    let rows = repo::spending_breakdown(&conn, "2026-06-01", "2026-07-01").unwrap();
    let total: i64 = rows.iter().map(|r| r.total_cents).sum();
    assert_eq!(total, 15000);
    assert!(rows.iter().any(|r| r.total_cents == 10000));
    assert!(rows.iter().any(|r| r.total_cents == 5000));
}

#[test]
fn category_count_includes_split_refs() {
    let conn = test_conn();
    let acc = service::create_account(&conn, "Cash", "cash", 0, None).unwrap();
    let a = first_category_id(&conn, "expense", 0);
    let b = first_category_id(&conn, "expense", 1);
    service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-10", None, false,
        Some(vec![
            models::SplitInput { category_id: a.clone(), amount_cents: 10000 },
            models::SplitInput { category_id: b.clone(), amount_cents: 5000 },
        ])).unwrap();
    assert!(repo::count_transactions_for_category(&conn, &a).unwrap() >= 1);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib breakdown_attributes_split_lines category_count_includes_split_refs`
Expected: FAIL — breakdown returns 0 (split header has NULL category, not summed), count excludes splits.

- [ ] **Step 3: Rewrite `spending_breakdown`**

Replace the SQL in `spending_breakdown` with a UNION of non-split headers and split lines:

```rust
pub fn spending_breakdown(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CategoryBreakdown>> {
    let mut stmt = conn.prepare(
        "WITH attrib AS (
           SELECT t.category_id AS cat, t.amount_cents AS amt
           FROM transactions t
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
           UNION ALL
           SELECT s.category_id AS cat, s.amount_cents AS amt
           FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
         )
         SELECT COALESCE(c.parent_id, c.id) AS group_id, pc.name, pc.emoji, pc.color, SUM(a.amt) AS total
         FROM attrib a
         JOIN categories c  ON c.id = a.cat
         JOIN categories pc ON pc.id = COALESCE(c.parent_id, c.id)
         GROUP BY group_id ORDER BY total DESC",
    )?;
    let rows = stmt.query_map(params![from, to], |r| Ok(CategoryBreakdown {
        category_id: r.get(0)?, category_name: r.get(1)?, emoji: r.get(2)?, color: r.get(3)?, total_cents: r.get(4)?,
    }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

Update `count_transactions_for_category`:

```rust
pub fn count_transactions_for_category(conn: &Connection, category_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM transactions WHERE category_id = ?1)
              + (SELECT COUNT(*) FROM transaction_splits WHERE category_id = ?1)",
        [category_id], |r| r.get(0),
    )?)
}
```

Update the category filter in `list_transactions` (~line 513) so a split matches if any line uses the category:

```rust
    if let Some(v) = &f.category_id {
        sql.push_str(" AND (category_id = ? OR id IN (SELECT transaction_id FROM transaction_splits WHERE category_id = ?))");
        // push the param twice when binding
    }
```

> Match the existing parameter-binding style in `list_transactions` (it builds a `params` vec or uses positional `?`). Bind `v` twice for the two placeholders.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib breakdown_attributes_split_lines category_count_includes_split_refs`
Expected: PASS. Also run the full suite: `cargo test --lib` → all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/lib.rs
git commit -m "feat(repo): spending_breakdown, category count, and filter honor splits"
```

---

### Task 7: Commands — thread `splits` through

**Files:**
- Modify: `src-tauri/src/commands.rs` (`create_income_transaction` ~119, `create_expense_transaction` ~124, `update_transaction` ~139)

- [ ] **Step 1: Update the command signatures**

```rust
#[tauri::command]
pub fn create_income_transaction(state: State<'_, DbState>, account_id: Option<String>, category_id: Option<String>, amount_cents: i64, description: Option<String>, date: String, time: Option<String>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_income(&c, account_id.as_deref().unwrap_or_default(), category_id.as_deref(), amount_cents, description.as_deref(), &date, time.as_deref(), excluded_from_reporting, splits))
}

#[tauri::command]
pub fn create_expense_transaction(state: State<'_, DbState>, account_id: Option<String>, category_id: Option<String>, amount_cents: i64, description: Option<String>, date: String, time: Option<String>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_expense(&c, account_id.as_deref().unwrap_or_default(), category_id.as_deref(), amount_cents, description.as_deref(), &date, time.as_deref(), excluded_from_reporting, splits))
}
```

> Keep `account_id` required in practice; using `Option` only avoids a breaking arg-shape change. If the existing macro/types prefer `String`, keep `account_id: String` and only add `category_id: Option<String>` + `splits: Option<...>`. `update_transaction` already takes the whole `UpdateTransactionInput`, which now includes `splits` — **no signature change needed** there.

- [ ] **Step 2: Verify the backend builds and all tests pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build && cargo test --lib`
Expected: builds; all tests green. Revert any temporary `None`/`Some` shims added in Tasks 2/4 so the real call paths are used.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): pass splits through create/update transaction"
```

---

## Phase 2 — Frontend client, types & mock

### Task 8: Types — `TxnSplit` and inputs

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add types**

After the `Transaction` interface add the field and a new interface:

```ts
export interface TxnSplit {
  categoryId: string;
  amountCents: number;
}
```

Add to `Transaction` (after `excludedFromReporting`): `splits: TxnSplit[];`
Add to `UpdateTransactionInput` (after `excludedFromReporting`): `splits?: TxnSplit[] | null;`

- [ ] **Step 2: Verify typecheck**

Run: `npm run build`
Expected: FAIL where `Transaction` is constructed without `splits` (mock.ts seed literals). Those are fixed in Task 10; if you want this task green in isolation, make it optional `splits?: TxnSplit[]` temporarily, then tighten to required in Task 10. Recommended: leave required and proceed to Task 10 in the same branch before running the gate.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add TxnSplit and Transaction.splits"
```

---

### Task 9: Client — pass `splits` through wrappers

**Files:**
- Modify: `src/client/index.ts` (~51-59)

- [ ] **Step 1: Update wrappers**

```ts
  createIncome: (accountId: string, categoryId: string | null, amountCents: number, description: string | null, date: string, time: string | null = null, excludedFromReporting = false, splits: TxnSplit[] | null = null) =>
    dispatch<Transaction>("create_income_transaction", { accountId, categoryId, amountCents, description, date, time, excludedFromReporting, splits }),
  createExpense: (accountId: string, categoryId: string | null, amountCents: number, description: string | null, date: string, time: string | null = null, excludedFromReporting = false, splits: TxnSplit[] | null = null) =>
    dispatch<Transaction>("create_expense_transaction", { accountId, categoryId, amountCents, description, date, time, excludedFromReporting, splits }),
```

Import `TxnSplit` in the type import line at the top of the file. `updateTransaction` is unchanged (it sends the whole `input`, which now carries `splits`).

- [ ] **Step 2: Verify typecheck**

Run: `npm run build` (will still depend on Task 10 for mock literals). Confirm no new errors in `index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/client/index.ts
git commit -m "feat(client): pass splits to create income/expense"
```

---

### Task 10: Mock — mirror splits end to end

**Files:**
- Modify: `src/client/mock.ts`
- Test: `src/__tests__/mock-splits.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../client/mock";

async function expenseCats() {
  const cats = await mockInvoke<any[]>("list_categories", { kind: "expense", includeArchived: false });
  return cats.filter((c) => !c.isSystem);
}

describe("mock splits", () => {
  it("creates a split expense, attributes breakdown per category, leaves balance whole", async () => {
    await mockInvoke("reset_app", {});
    const accs = await mockInvoke<any[]>("list_accounts", { includeArchived: false });
    const acc = accs[0];
    const cats = await expenseCats();
    const before = await mockInvoke<number>("get_account_balance", { accountId: acc.id });
    const tx = await mockInvoke<any>("create_expense_transaction", {
      accountId: acc.id, categoryId: null, amountCents: 15000, description: "Lotus",
      date: "2026-06-10", time: null, excludedFromReporting: false,
      splits: [
        { categoryId: cats[0].id, amountCents: 10000 },
        { categoryId: cats[1].id, amountCents: 5000 },
      ],
    });
    expect(tx.splits).toHaveLength(2);
    expect(tx.categoryId).toBe(cats[0].id); // header = first split's category
    const after = await mockInvoke<number>("get_account_balance", { accountId: acc.id });
    expect(before - after).toBe(15000);
    const dash = await mockInvoke<any>("get_dashboard_summary", { month: "2026-06" });
    const sum = dash.spendingBreakdown.reduce((s: number, r: any) => s + r.totalCents, 0);
    expect(sum).toBeGreaterThanOrEqual(15000);
  });

  it("rejects a split whose lines don't sum to the total", async () => {
    await mockInvoke("reset_app", {});
    const accs = await mockInvoke<any[]>("list_accounts", { includeArchived: false });
    const cats = await expenseCats();
    await expect(mockInvoke("create_expense_transaction", {
      accountId: accs[0].id, categoryId: null, amountCents: 15000, description: null,
      date: "2026-06-10", time: null, excludedFromReporting: false,
      splits: [
        { categoryId: cats[0].id, amountCents: 10000 },
        { categoryId: cats[1].id, amountCents: 4000 },
      ],
    })).rejects.toMatchObject({ code: "ValidationError" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/mock-splits.test.ts`
Expected: FAIL — mock ignores `splits`.

- [ ] **Step 3: Implement in `mock.ts`**

1. Seeds/literals: add `splits: []` to every `Transaction` object literal (the `txns.push({...})` calls at lines ~159, ~166, ~191, ~230, ~232, ~346, ~354 and the update at ~383). Each literal gets `splits: []` (transfers/opening/adjustment always `[]`).

2. In the `create_income_transaction` / `create_expense_transaction` handler (~330-350), accept `a.splits`. Add a helper near the top:

```ts
function validateSplits(kind: string, splits: { categoryId: string; amountCents: number }[], total: number) {
  if (splits.length < 2) fail("ValidationError", "A split needs at least two categories");
  let sum = 0;
  for (const s of splits) {
    if (s.amountCents <= 0) fail("ValidationError", "Each split amount must be positive");
    const c = categories.find((x) => x.id === s.categoryId);
    if (!c || c.kind !== kind) fail("ValidationError", "Category doesn't match this transaction");
    if (c.isSystem) fail("ValidationError", "Adjustment category can't be chosen");
    sum += s.amountCents;
  }
  if (sum !== total) fail("ValidationError", "Split amounts must add up to the total");
}
```

In the create handler, branch:

```ts
      const hasSplits = Array.isArray(a.splits) && a.splits.length > 0;
      if (hasSplits) {
        validateSplits(kind, a.splits, a.amountCents);
      } else if (a.categoryId) {
        const c = categories.find((x) => x.id === a.categoryId);
        if (!c || c.kind !== kind) fail("ValidationError", "Category doesn't match this transaction");
      } else {
        fail("ValidationError", "A category is required");
      }
      const tx: Transaction = {
        id: uid(), kind, accountId: a.accountId, toAccountId: null,
        categoryId: hasSplits ? a.splits[0].categoryId : a.categoryId, // header = first split (mirrors Rust CHECK)
        amountCents: a.amountCents, description: a.description,
        transactionDate: a.date, transactionTime,
        createdAt: now(), updatedAt: now(),
        excludedFromReporting: !!a.excludedFromReporting,
        splits: hasSplits ? a.splits.map((s: any) => ({ categoryId: s.categoryId, amountCents: s.amountCents })) : [],
      };
```

3. In `update_transaction` handler (~372-383), mirror: if `a.input.splits?.length` validate and set `categoryId: a.input.splits[0].categoryId, splits: [...]`; else clear splits (`splits: []`) and keep the single `categoryId`.

4. `balanceOf` (~136) is unchanged — `postingsFor` uses the header only. Confirm no change needed.

5. `spendingBreakdown` block (~408-414): include split lines. Replace the expense iteration with one that emits per-attribution rows:

```ts
      const attrib: { cat: string; amt: number }[] = [];
      txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).forEach((t) => {
        if (t.splits.length) t.splits.forEach((s) => attrib.push({ cat: s.categoryId, amt: s.amountCents }));
        else if (t.categoryId) attrib.push({ cat: t.categoryId, amt: t.amountCents });
      });
      const byGroup = new Map<string, number>();
      attrib.forEach(({ cat, amt }) => {
        const pid = parentOf(cat);
        byGroup.set(pid, (byGroup.get(pid) ?? 0) + amt);
      });
      const breakdown = [...byGroup.entries()].map(([cid, total]) => {
        const c = categories.find((x) => x.id === cid)!;
        return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
      }).sort((x, y) => y.totalCents - x.totalCents);
```

> Keep `parentOf` as the existing helper. Income/expense **totals** (lines ~404-405) read the header `amountCents` — unchanged.

6. Category delete guard (~284): also block when used in splits: `if (txns.some((t) => t.categoryId === c.id || t.splits.some((s) => s.categoryId === c.id))) fail(...)`.

7. `list_transactions` category filter: if filtering by category, match `t.categoryId === id || t.splits.some((s) => s.categoryId === id)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/mock-splits.test.ts`
Expected: PASS. Then `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/client/mock.ts src/__tests__/mock-splits.test.ts src/types.ts
git commit -m "feat(mock): mirror category splits (create/update/breakdown/guards)"
```

---

## Phase 3 — Frontend UI

### Task 11: Builder logic module (`txnBuilder.ts`)

**Files:**
- Create: `src/lib/txnBuilder.ts`
- Test: `src/__tests__/txnBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { addItem, removeItem, itemsTotal, finalize, isSplit, type BuilderItem } from "../lib/txnBuilder";

const A: BuilderItem = { categoryId: "a", amountCents: 10000 };
const B: BuilderItem = { categoryId: "b", amountCents: 5000 };

describe("txnBuilder", () => {
  it("adds and totals items", () => {
    let items: BuilderItem[] = [];
    items = addItem(items, A);
    items = addItem(items, B);
    expect(items).toHaveLength(2);
    expect(itemsTotal(items)).toBe(15000);
  });
  it("removes by index", () => {
    expect(removeItem([A, B], 0)).toEqual([B]);
  });
  it("isSplit only when >= 2", () => {
    expect(isSplit([A])).toBe(false);
    expect(isSplit([A, B])).toBe(true);
  });
  it("finalize auto-adds a valid pending item", () => {
    const out = finalize([A], { categoryId: "b", amountCents: 5000 });
    expect(out).toHaveLength(2);
  });
  it("finalize ignores an empty pending item", () => {
    expect(finalize([A], { categoryId: "", amountCents: 0 })).toEqual([A]);
    expect(finalize([A], { categoryId: "b", amountCents: 0 })).toEqual([A]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/txnBuilder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// Pure logic for the itemized Add-Transaction builder. One item = an ordinary
// single-category transaction; two or more = a split. Tested in isolation.

export interface BuilderItem {
  categoryId: string;
  amountCents: number;
}

export function addItem(items: BuilderItem[], item: BuilderItem): BuilderItem[] {
  return [...items, item];
}

export function removeItem(items: BuilderItem[], index: number): BuilderItem[] {
  return items.filter((_, i) => i !== index);
}

export function itemsTotal(items: BuilderItem[]): number {
  return items.reduce((s, it) => s + it.amountCents, 0);
}

export function isSplit(items: BuilderItem[]): boolean {
  return items.length >= 2;
}

/** True when a pending builder line is complete enough to add. */
export function isPendingValid(pending: BuilderItem): boolean {
  return !!pending.categoryId && pending.amountCents > 0;
}

/** Items to persist on Save: auto-append a valid pending line (forgiving). */
export function finalize(items: BuilderItem[], pending: BuilderItem): BuilderItem[] {
  return isPendingValid(pending) ? addItem(items, pending) : items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/txnBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/txnBuilder.ts src/__tests__/txnBuilder.test.ts
git commit -m "feat(lib): pure itemized-builder logic for splits"
```

---

### Task 12: Add-Transaction itemized builder UI

**Files:**
- Modify: `src/modals/AddTransaction.tsx`

This task rebuilds the income/expense path of the modal around the builder. Transfer keeps its existing UI. Reference the current file (read it first) and apply these changes.

- [ ] **Step 1: Add builder state (income/expense only)**

At the top of the component, after the existing `categoryId` state, add:

```tsx
import { addItem, removeItem, itemsTotal, isSplit, finalize, isPendingValid, type BuilderItem } from "../lib/txnBuilder";

// items already added; pending = the line currently being built
const [items, setItems] = useState<BuilderItem[]>(
  editing && editing.splits.length ? editing.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents }))
  : editing && editing.categoryId ? [{ categoryId: editing.categoryId, amountCents: editing.amountCents }]
  : []
);
const [pendingCat, setPendingCat] = useState<string>("");
const [catFilter, setCatFilter] = useState("");
const [showFilter, setShowFilter] = useState(false);
```

Reuse `amount` state as the **pending** amount. `pendingItem` derives:

```tsx
const pendingItem: BuilderItem = { categoryId: pendingCat, amountCents: parseAmountToCents(amount) ?? 0 };
const totalCents = itemsTotal(items) + (isPendingValid(pendingItem) ? pendingItem.amountCents : 0);
```

- [ ] **Step 2: Render the category grid (replace the `<select>` for income/expense)**

Replace the income/expense Category `<Field>`/`<select>` (lines ~126-141, the non-transfer branch) with a tap-grid + items list. Grid renders `pickerItems` (already computed via `categoryPickerItems`) in order, filtered by `catFilter`:

```tsx
{/* Category grid */}
<div>
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim }}>Category</span>
    <button className="sens-btn" onClick={() => setShowFilter((v) => !v)} style={{ fontSize: 11, color: t.dim }}>🔍 filter</button>
  </div>
  {showFilter && (
    <input className="sens-input" autoFocus value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
      placeholder="Type to filter…" style={{ ...inputStyle(t), marginBottom: 8 }} />
  )}
  <div style={{ maxHeight: 180, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7 }}>
    {pickerItems
      .filter((it) => !catFilter || it.label.toLowerCase().includes(catFilter.toLowerCase()))
      .map((it) => {
        const on = pendingCat === it.id;
        return (
          <button key={it.id} className="sens-btn" onClick={() => setPendingCat(it.id)}
            style={{ flexDirection: "column", gap: 3, padding: "9px 4px", borderRadius: 11, fontSize: 10,
              border: `1.5px solid ${on ? accentForKind : t.border}`, background: on ? hexA(accentForKind, 0.18) : t.panel2,
              color: on ? t.text : t.dim }}>
            <span style={{ fontSize: 18 }}>{it.emoji}</span>{it.label}
          </button>
        );
      })}
  </div>
  <Btn variant="outline" disabled={!isPendingValid(pendingItem)}
    onClick={() => { setItems((xs) => addItem(xs, pendingItem)); setAmount(""); setPendingCat(""); }}
    style={{ width: "100%", justifyContent: "center", marginTop: 10 }}>+ Add item</Btn>
</div>

{/* Items list + total */}
{items.length > 0 && (
  <div>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.dim, marginBottom: 4 }}>
      <span>Items</span><span>{items.length}{isSplit(items) ? " · split" : ""}</span>
    </div>
    {items.map((it, i) => {
      const c = categories.find((x) => x.id === it.categoryId);
      return (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `0.5px solid ${t.divider}` }}>
          <span>{c?.emoji}</span><span style={{ flex: 1 }}>{c?.name}</span>
          <span style={{ fontFamily: t.mono }}>RM {(it.amountCents / 100).toFixed(2)}</span>
          <button className="sens-icon-btn" onClick={() => setItems((xs) => removeItem(xs, i))} style={{ color: t.dim }}>✕</button>
        </div>
      );
    })}
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontWeight: 700 }}>
      <span style={{ color: t.dim }}>Total</span>
      <span style={{ fontFamily: t.mono }}>RM {(totalCents / 100).toFixed(2)}</span>
    </div>
  </div>
)}
```

> Keep the **Account** select; it stays a whole-transaction field. Keep the amount input as the pending-item amount, but relabel placeholder to the current item amount. Transfer branch unchanged.

- [ ] **Step 3: Rework validity + submit**

```tsx
const finalItems = finalize(items, pendingItem);
const valid = kind === "transfer"
  ? (cents != null && accountId && toAccountId && toAccountId !== accountId && (!timeEnabled || !!time))
  : (accountId && finalItems.length >= 1 && (!timeEnabled || !!time));
```

In `submit()`, for income/expense replace the create/update calls:

```tsx
const list = finalize(items, pendingItem);
const total = itemsTotal(list);
const splits = list.length >= 2 ? list.map((it) => ({ categoryId: it.categoryId, amountCents: it.amountCents })) : null;
const singleCat = list.length === 1 ? list[0].categoryId : null;

if (editing) {
  await client.updateTransaction({
    id: editing.id, kind, accountId, toAccountId: null,
    categoryId: splits ? null : singleCat,
    amountCents: total, description: desc.trim() || null, transactionDate: date,
    transactionTime: txTime, excludedFromReporting: excluded, splits,
  });
} else if (kind === "income") {
  await client.createIncome(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
} else { // expense
  await client.createExpense(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
}
```

Transfer submit path is unchanged.

- [ ] **Step 4: Verify build + manual smoke**

Run: `npm run build`
Expected: clean. Then `npm run dev` and in the browser: add an expense with two categories → Save; confirm it appears as a split (Task 13 shows the row).

- [ ] **Step 5: Commit**

```bash
git add src/modals/AddTransaction.tsx
git commit -m "feat(ui): itemized builder for Add Transaction with category splits"
```

---

### Task 13: List row + detail panel display

**Files:**
- Modify: `src/components/TxnRow.tsx`, `src/components/TxnDetailPanel.tsx`

- [ ] **Step 1: TxnRow — split badge, pill, subtitle**

Read `TxnRow.tsx`. Where it derives the category label/glyph, add a split branch. A transaction is a split when `tx.splits.length >= 2`. Render:
- The glyph tile shows a small count badge (e.g. `tx.splits.length`).
- A `SPLIT · N` pill next to the description.
- The subtitle lists category names: `tx.splits.map(s => catName(s.categoryId)).join(" · ")`.
- The **amount column shows the total only** (`tx.amountCents`), exactly as a normal row — no per-item amounts.

```tsx
const split = tx.splits.length >= 2;
const splitNames = split ? tx.splits.map((s) => categories.find((c) => c.id === s.categoryId)?.name ?? "—").join(" · ") : null;
```

Use `splitNames` for the meta line when `split`, and render the pill:

```tsx
{split && (
  <span style={{ fontSize: 9, background: hexA(t.transfer, 0.22), color: t.transfer, borderRadius: 5, padding: "1px 5px", marginLeft: 6 }}>
    SPLIT · {tx.splits.length}
  </span>
)}
```

> `TxnRow` already receives `categories` or a category lookup; if not, thread the existing lookup it uses for single-category rows.

- [ ] **Step 2: TxnDetailPanel — breakdown**

Read `TxnDetailPanel.tsx`. When `tx.splits.length >= 2`, render the per-item breakdown (emoji + name + amount) and a proportion bar; keep the existing balance-impact line using `tx.amountCents`. Editing items reuses the same builder (open the existing edit modal — `TxnDetailPanel`'s inline edit can continue to call `AddTransaction` editing, which is now split-aware from Task 12). Minimal addition:

```tsx
{tx.splits.length >= 2 && (
  <div style={{ marginTop: 12 }}>
    <div style={{ fontSize: 11, color: t.dim, marginBottom: 6 }}>Split across {tx.splits.length} categories</div>
    {tx.splits.map((s, i) => {
      const c = categories.find((x) => x.id === s.categoryId);
      return (
        <div key={i} style={{ display: "flex", gap: 9, padding: "6px 0", borderBottom: `0.5px solid ${t.divider}` }}>
          <span>{c?.emoji}</span><span style={{ flex: 1 }}>{c?.name}</span>
          <span style={{ fontFamily: t.mono }}>RM {(s.amountCents / 100).toFixed(2)}</span>
        </div>
      );
    })}
  </div>
)}
```

- [ ] **Step 3: Verify build + smoke**

Run: `npm run build`
Expected: clean. `npm run dev`: the two-category expense from Task 12 shows a `SPLIT · 2` pill in the list and a breakdown in the detail panel; the dashboard shows the two categories in separate bars.

- [ ] **Step 4: Commit**

```bash
git add src/components/TxnRow.tsx src/components/TxnDetailPanel.tsx
git commit -m "feat(ui): show splits in the transactions list and detail panel"
```

---

## Phase 4 — Docs & final gate

### Task 14: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md`

- [ ] **Step 1: Update docs**

- `CLAUDE.md` — in the "Money, balances, and transaction kinds" section, add a paragraph: category splits (income/expense), `transaction_splits` table (migration 009), single↔split invariant, postings/`sum_kind_in_range` unchanged, `spending_breakdown` UNION; in the frontend section, note the itemized Add-Transaction builder and `src/lib/txnBuilder.ts`.
- `CHANGELOG.md` — under `[Unreleased]` → Added: "Category splits — divide an income/expense across multiple categories via the new itemized Add Transaction builder; shown in the list, detail panel, and dashboard."
- `ROADMAP.md` — mark category splits done / move it out of upcoming.

- [ ] **Step 2: Full gate**

Run:
```bash
npm run build && npm test
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib && cargo build
```
Expected: typecheck clean, Vitest green, cargo tests green, desktop binary compiles.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs: document category splits and the itemized builder"
```

---

## Self-Review notes (for the implementer)

- **Mock/Rust parity:** every behavior in Tasks 4-6 has a mock mirror in Task 10. If you change one, change the other.
- **Single↔split invariant** is enforced in three places: Rust service (`validate_splits` + create/update branching), mock (`validateSplits` + branching), and the builder (`isSplit` deciding whether `splits` is sent). Keep them consistent.
- **Balances never change with splits** — if any balance test shifts when a transaction becomes a split, a posting path was wrongly touched; revert it.
- **Naming consistency:** Rust `SplitInput { category_id, amount_cents }`, TS `TxnSplit { categoryId, amountCents }`, builder `BuilderItem { categoryId, amountCents }`. The command arg is `splits` everywhere.
