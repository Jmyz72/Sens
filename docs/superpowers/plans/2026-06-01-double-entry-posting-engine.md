# Double-Entry Posting Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the balance engine onto a double-entry `postings` ledger with zero visible behavior change, so balances come from one uniform rule and every transaction's legs provably sum to zero.

**Architecture:** A new `postings` table is the authoritative balance source. Each posting is *either* a real-money leg (`account_id` set) *or* a nominal counter leg (`system_bucket` ∈ `income|expense|equity`, `account_id` NULL). The `transactions` header is kept unchanged as the input shape; the service materializes balanced postings from it on every write. `accounts`/`categories` schema, all commands, and the entire frontend UI are untouched. Splits are out of scope (separate later spec).

**Tech Stack:** Tauri v2 (Rust, rusqlite/SQLite) backend; React 19 + TypeScript + Vite frontend; Vitest + `cargo test --lib`. Reference spec: `docs/superpowers/specs/2026-06-01-double-entry-posting-engine-design.md`.

---

## File Structure

**Backend (Rust):**
- `src-tauri/src/db/migrations.rs` — add `MIGRATION_006` (create `postings` + backfill); register in `MIGRATIONS`.
- `src-tauri/src/repo.rs` — rewrite `balance_expr`; add `insert_posting`, `delete_postings_for`, `get_opening_transaction`.
- `src-tauri/src/service.rs` — add `Leg`, `postings_for`, `materialize_postings`; wire into every transaction write path (create income/expense/transfer, create_account opening, update, set_account_balance).
- `src-tauri/src/db/mod.rs` — `reset_to_defaults` clears `postings`; make `migrations` module reachable from tests.
- `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`) — all new Rust tests.

**Frontend (TypeScript):**
- `src/lib/kinds.ts` — add `Posting` type + `postingsFor()` (the single frontend sign rule).
- `src/client/mock.ts` — rewrite `balanceOf` to sum `postingsFor` legs.
- `src/__tests__/postings.test.ts` — new Vitest test for `postingsFor`.

**Docs:**
- `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md` — reflect the new engine.

---

## The canonical sign rule (referenced by multiple tasks)

For a header `(kind, account_id, to_account_id, amount_cents)` where `amount_cents` is positive for income/expense/transfer and already-signed for adjustment/opening, the balanced legs are:

| kind        | leg 1 (real account)          | leg 2 (counter)                       |
|-------------|-------------------------------|---------------------------------------|
| `income`    | `account_id`, `+amount`       | bucket `income`,  `-amount`           |
| `expense`   | `account_id`, `-amount`       | bucket `expense`, `+amount`           |
| `transfer`  | `account_id`, `-amount`       | `to_account_id`, `+amount` (real)     |
| `adjustment`| `account_id`, `+amount`       | bucket `equity`,  `-amount`           |
| `opening`   | `account_id`, `+amount`       | bucket `equity`,  `-amount`           |

Account balance = `SUM(amount_cents) WHERE account_id = X`, which equals the old `balance_expr` term-for-term.

---

## Task 1: Migration 006 — `postings` table + backfill

**Files:**
- Modify: `src-tauri/src/db/migrations.rs:6` (the `MIGRATIONS` array) and add the new const.
- Modify: `src-tauri/src/db/mod.rs` (ensure `pub mod migrations;` so tests can read `MIGRATIONS`).
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing migration test**

Add to `src-tauri/src/lib.rs` inside `mod tests`:

```rust
#[test]
fn migration_006_backfills_balanced_postings() {
    use rusqlite::Connection;
    let c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    // Run migrations 1..=5 only — a pre-postings database.
    for (v, sql) in crate::db::migrations::MIGRATIONS {
        if *v <= 5 {
            c.execute_batch(sql).unwrap();
        }
    }
    // Minimal fixture: one account (subtype 'cash' seeded by migration 002),
    // one expense category, and one of each money-moving kind.
    let now = "2026-01-01T00:00:00Z";
    c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
               VALUES ('a1', NULL, 'Cash', 'cash', 'MYR', 0, ?1, ?1)", [now]).unwrap();
    c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
               VALUES ('a2', NULL, 'Bank', 'savings', 'MYR', 0, ?1, ?1)", [now]).unwrap();
    c.execute("INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at) \
               VALUES ('cx', 'Food', 'expense', '🍜', NULL, NULL, 0, 0, ?1, ?1)", [now]).unwrap();
    let ins = |id: &str, kind: &str, acc: &str, to: Option<&str>, cat: Option<&str>, amt: i64| {
        c.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '2026-01-02', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id, kind, acc, to, cat, amt],
        ).unwrap();
    };
    ins("t_open", "opening", "a1", None, None, 10_000);
    ins("t_inc", "income", "a1", None, None, 5_000); // income/expense need a category per CHECK
    // Fix: income/expense require category_id — set it:
    c.execute("UPDATE transactions SET category_id='cx' WHERE id='t_inc'", []).unwrap();
    ins("t_exp", "expense", "a1", None, Some("cx"), 2_000);
    ins("t_xfer", "transfer", "a1", Some("a2"), None, 1_000);
    ins("t_adj", "adjustment", "a1", None, None, -500);

    // Run migration 006.
    let (_, sql6) = crate::db::migrations::MIGRATIONS.iter().find(|(v, _)| *v == 6).unwrap();
    c.execute_batch(sql6).unwrap();

    // Every transaction's postings sum to zero.
    let unbalanced: i64 = c.query_row(
        "SELECT COUNT(*) FROM (SELECT transaction_id, SUM(amount_cents) s FROM postings GROUP BY transaction_id) WHERE s <> 0",
        [], |r| r.get(0)).unwrap();
    assert_eq!(unbalanced, 0, "all transactions must balance to zero");

    // a1 balance from postings = 10000 + 5000 - 2000 - 1000 (transfer out) - 500 (adj) = 11500.
    let bal_a1: i64 = c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id='a1'", [], |r| r.get(0)).unwrap();
    assert_eq!(bal_a1, 11_500);
    // a2 receives the transfer: +1000.
    let bal_a2: i64 = c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id='a2'", [], |r| r.get(0)).unwrap();
    assert_eq!(bal_a2, 1_000);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_006_backfills_balanced_postings`
Expected: FAIL — `MIGRATION_006` doesn't exist / `no such table: postings`.

- [ ] **Step 3: Add `MIGRATION_006` and register it**

In `src-tauri/src/db/migrations.rs`, change the array at line 6 to include version 6:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006)];
```

Add this const near the top of the file (above `MIGRATION_005`):

```rust
// v0.6.0 — double-entry posting engine. Adds a `postings` ledger that is the
// authoritative source for account balances. Each posting is either a real
// account leg (account_id set) or a nominal counter leg (system_bucket set).
// Data-preserving: backfills two balanced legs per existing transaction using
// the canonical sign rule, so older databases upgrade automatically. Fresh
// installs run 001→006; the backfill is a no-op with zero transactions.
const MIGRATION_006: &str = r#"
CREATE TABLE postings (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  system_bucket  TEXT CHECK (system_bucket IN ('income', 'expense', 'equity')),
  amount_cents   INTEGER NOT NULL,
  CHECK ((account_id IS NOT NULL AND system_bucket IS NULL)
      OR (account_id IS NULL     AND system_bucket IS NOT NULL))
);
CREATE INDEX idx_postings_account ON postings(account_id);
CREATE INDEX idx_postings_txn     ON postings(transaction_id);

-- Leg 1: the real-money leg on account_id.
INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
SELECT 'p1-' || id, id, account_id, NULL,
       CASE kind WHEN 'expense'  THEN -amount_cents
                 WHEN 'transfer' THEN -amount_cents
                 ELSE amount_cents END
FROM transactions;

-- Leg 2: the counter leg — destination account for transfers, else a system bucket.
INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
SELECT 'p2-' || id, id,
       CASE kind WHEN 'transfer' THEN to_account_id ELSE NULL END,
       CASE kind WHEN 'income'  THEN 'income'
                 WHEN 'expense' THEN 'expense'
                 WHEN 'transfer' THEN NULL
                 ELSE 'equity' END,
       CASE kind WHEN 'income'   THEN -amount_cents
                 WHEN 'expense'  THEN  amount_cents
                 WHEN 'transfer' THEN  amount_cents
                 ELSE -amount_cents END
FROM transactions;
"#;
```

In `src-tauri/src/db/mod.rs`, confirm the module is declared `pub mod migrations;` (change `mod migrations;` → `pub mod migrations;` if needed) so the test can reference `crate::db::migrations::MIGRATIONS`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_006_backfills_balanced_postings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(db): migration 006 — postings ledger + backfill\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Balance engine + repo posting helpers

**Files:**
- Modify: `src-tauri/src/repo.rs:10-21` (`balance_expr`), and add three helpers.
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing test (balance parity through the engine)**

Add to `mod tests` in `src-tauri/src/lib.rs`:

```rust
#[test]
fn balance_reads_from_postings() {
    let c = crate::db::open_in_memory().unwrap();
    // Account created via service writes an opening posting (Task 5 wires this);
    // here we assert the engine reads postings. Insert an account + opening row
    // + matching postings directly to isolate the repo read.
    let now = crate::now();
    c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
               VALUES ('a1', NULL, 'Cash', 'cash', 'MYR', 0, ?1, ?1)", [&now]).unwrap();
    c.execute("INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at) \
               VALUES ('o1','opening','a1',NULL,NULL,7000,'Opening balance','2026-01-01',0,?1,?1)", [&now]).unwrap();
    c.execute("INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('o1a','o1','a1',NULL,7000)", []).unwrap();
    c.execute("INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('o1b','o1',NULL,'equity',-7000)", []).unwrap();

    let acc = crate::repo::get_account(&c, "a1").unwrap();
    assert_eq!(acc.balance_cents, 7000);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib balance_reads_from_postings`
Expected: FAIL — `balance_cents` is still 0 because `balance_expr` reads `transactions`, and the opening row above has no income/etc. mapping… actually it would read the opening row and pass. To make this a true RED, first confirm: the old `balance_expr` *would* sum the opening transaction (7000) and pass. So this test is GREEN against old code. Replace the assertion approach: assert the engine ignores `transactions` and uses `postings` by giving them *different* values.

Revise the test body's transaction/posting amounts to diverge:

```rust
    // Transaction header says 7000, but postings say 9000. Engine must report 9000.
    c.execute("UPDATE postings SET amount_cents = 9000 WHERE id='o1a'", []).unwrap();
    c.execute("UPDATE postings SET amount_cents = -9000 WHERE id='o1b'", []).unwrap();
    let acc = crate::repo::get_account(&c, "a1").unwrap();
    assert_eq!(acc.balance_cents, 9000); // proves the read comes from postings, not the header
```

Re-run: Expected FAIL — old `balance_expr` returns 7000 (from the header), not 9000.

- [ ] **Step 3: Rewrite `balance_expr` and add helpers**

In `src-tauri/src/repo.rs`, replace the body of `balance_expr` (lines 10-21) with:

```rust
/// SQL expression computing an account's current balance as the sum of its
/// postings. `{a}` is the accounts-table alias. One uniform rule for every kind.
fn balance_expr(a: &str) -> String {
    format!("COALESCE((SELECT SUM(amount_cents) FROM postings WHERE account_id = {a}.id), 0)")
}
```

Add these helpers in `repo.rs` (near `insert_transaction`):

```rust
pub fn insert_posting(
    conn: &Connection,
    id: &str,
    transaction_id: &str,
    account_id: Option<&str>,
    system_bucket: Option<&str>,
    amount_cents: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, transaction_id, account_id, system_bucket, amount_cents],
    )
    .map_err(map_check)?;
    Ok(())
}

pub fn delete_postings_for(conn: &Connection, transaction_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM postings WHERE transaction_id = ?1", [transaction_id])?;
    Ok(())
}

pub fn get_opening_transaction(conn: &Connection, account_id: &str) -> AppResult<Transaction> {
    conn.query_row(
        "SELECT * FROM transactions WHERE account_id = ?1 AND kind = 'opening' LIMIT 1",
        [account_id],
        map_transaction,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Opening transaction not found".into()),
        other => other.into(),
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib balance_reads_from_postings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(repo): balance from postings; add posting helpers\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Service sign rule + wire create income/expense/transfer

**Files:**
- Modify: `src-tauri/src/service.rs` — add `Leg`, `postings_for`, `materialize_postings`; update `create_income`, `create_expense`, `create_transfer`.
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/lib.rs`:

```rust
// Helper: assert every transaction in the DB has postings summing to zero.
fn assert_books_balance(c: &rusqlite::Connection) {
    let unbalanced: i64 = c.query_row(
        "SELECT COUNT(*) FROM (SELECT transaction_id, SUM(amount_cents) s FROM postings GROUP BY transaction_id) WHERE s <> 0",
        [], |r| r.get(0)).unwrap();
    assert_eq!(unbalanced, 0, "every transaction's postings must sum to zero");
}

#[test]
fn create_income_expense_transfer_write_balanced_postings() {
    let c = crate::db::open_in_memory().unwrap();
    let acc = crate::service::create_account(&c, "Cash", "cash", 10_000, None).unwrap();
    let bank = crate::service::create_account(&c, "Bank", "savings", 0, None).unwrap();
    // An income category seeded by defaults; fetch one.
    let cats = crate::service::list_categories(&c, Some("income"), false).unwrap();
    let inc_cat = &cats[0].id;
    let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
    let exp_cat = &xcats[0].id;

    crate::service::create_income(&c, &acc.id, inc_cat, 5_000, None, "2026-02-01", false).unwrap();
    crate::service::create_expense(&c, &acc.id, exp_cat, 2_000, None, "2026-02-02", false).unwrap();
    crate::service::create_transfer(&c, &acc.id, &bank.id, 1_000, None, "2026-02-03").unwrap();

    assert_books_balance(&c);
    // Cash: opening 10000 + income 5000 - expense 2000 - transfer 1000 = 12000.
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 12_000);
    // Bank: opening 0 + transfer in 1000 = 1000.
    assert_eq!(crate::repo::get_account(&c, &bank.id).unwrap().balance_cents, 1_000);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib create_income_expense_transfer_write_balanced_postings`
Expected: FAIL — `create_account`/create_* don't write postings yet, so `assert_books_balance` fails (or balances are 0).

- [ ] **Step 3: Add the sign rule and materializer; wire the three creators**

In `src-tauri/src/service.rs`, add near the top (after `new_id`):

```rust
/// One balanced posting leg. Exactly one of `account_id` / `system_bucket` is set.
struct Leg {
    account_id: Option<String>,
    system_bucket: Option<&'static str>,
    amount_cents: i64,
}

/// The single canonical sign rule: turn a transaction header into balanced legs.
/// `amount_cents` is positive for income/expense/transfer and already-signed for
/// adjustment/opening. The legs always sum to zero.
fn postings_for(kind: &str, account_id: &str, to_account_id: Option<&str>, amount_cents: i64) -> Vec<Leg> {
    let real = |amt: i64| Leg { account_id: Some(account_id.to_string()), system_bucket: None, amount_cents: amt };
    let bucket = |b: &'static str, amt: i64| Leg { account_id: None, system_bucket: Some(b), amount_cents: amt };
    match kind {
        KIND_INCOME => vec![real(amount_cents), bucket("income", -amount_cents)],
        KIND_EXPENSE => vec![real(-amount_cents), bucket("expense", amount_cents)],
        KIND_TRANSFER => vec![
            real(-amount_cents),
            Leg { account_id: to_account_id.map(|s| s.to_string()), system_bucket: None, amount_cents },
        ],
        KIND_ADJUSTMENT | KIND_OPENING => vec![real(amount_cents), bucket("equity", -amount_cents)],
        _ => vec![],
    }
}

/// (Re)write the postings for a transaction from its header. Idempotent: clears
/// any existing postings first, so it is safe on both create and update paths.
fn materialize_postings(conn: &Connection, t: &Transaction) -> AppResult<()> {
    repo::delete_postings_for(conn, &t.id)?;
    for leg in postings_for(&t.kind, &t.account_id, t.to_account_id.as_deref(), t.amount_cents) {
        repo::insert_posting(conn, &new_id(), &t.id, leg.account_id.as_deref(), leg.system_bucket, leg.amount_cents)?;
    }
    Ok(())
}
```

Replace the final line of `create_income` (currently the bare `repo::insert_transaction(...)`) with an atomic write:

```rust
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_INCOME, account_id, None, Some(category_id), amount_cents, description, date, excluded_from_reporting, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
```

Replace the final line of `create_expense` similarly:

```rust
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_EXPENSE, account_id, None, Some(category_id), amount_cents, description, date, excluded_from_reporting, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
```

Replace the final line of `create_transfer` similarly:

```rust
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_TRANSFER, from_account_id, Some(to_account_id), None, amount_cents, description, date, false, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib create_income_expense_transfer_write_balanced_postings`
Expected: FAIL still on balances if `create_account` opening isn't wired — but the opening posting is added in Task 5. To keep this task self-contained, the opening balance contribution comes from the opening row's postings. **Wire `create_account` opening here too** (it is the prerequisite for the balances in this test):

In `create_account`, capture and materialize the opening row before commit. Replace:

```rust
    repo::insert_transaction(
        &tx, &new_id(), KIND_OPENING, &account_id, None, None,
        opening_balance_cents, Some("Opening balance"), &crate::today(), false, &now(),
    )?;
    tx.commit()?;
```

with:

```rust
    let opening = repo::insert_transaction(
        &tx, &new_id(), KIND_OPENING, &account_id, None, None,
        opening_balance_cents, Some("Opening balance"), &crate::today(), false, &now(),
    )?;
    materialize_postings(&tx, &opening)?;
    tx.commit()?;
```

Re-run: Expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(service): materialize balanced postings on create + opening\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Update + delete keep postings consistent

**Files:**
- Modify: `src-tauri/src/service.rs` — `update_transaction` (wrap write + materialize).
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn update_and_delete_keep_postings_consistent() {
    let c = crate::db::open_in_memory().unwrap();
    let acc = crate::service::create_account(&c, "Cash", "cash", 0, None).unwrap();
    let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
    let exp_cat = xcats[0].id.clone();
    let t = crate::service::create_expense(&c, &acc.id, &exp_cat, 2_000, None, "2026-02-02", false).unwrap();
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, -2_000);

    // Edit the amount up to 5000.
    let input = crate::models::UpdateTransactionInput {
        id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(),
        to_account_id: None, category_id: Some(exp_cat.clone()),
        amount_cents: 5_000, description: None, transaction_date: "2026-02-02".into(),
        excluded_from_reporting: false,
    };
    crate::service::update_transaction(&c, input).unwrap();
    assert_books_balance(&c);
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, -5_000);
    // Exactly 2 postings remain for the txn (no stale rows from the old amount).
    let n: i64 = c.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id = ?1", [&t.id], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);

    // Delete cascades postings away.
    crate::service::delete_transaction(&c, &t.id).unwrap();
    let after: i64 = c.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id = ?1", [&t.id], |r| r.get(0)).unwrap();
    assert_eq!(after, 0);
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib update_and_delete_keep_postings_consistent`
Expected: FAIL — `update_transaction` doesn't re-materialize postings, so balance stays -2000 / stale postings remain.

- [ ] **Step 3: Wire `update_transaction`**

In `src-tauri/src/service.rs`, replace the final `repo::update_transaction_row(...)` call in `update_transaction` with:

```rust
    let dbtx = conn.unchecked_transaction()?;
    let t = repo::update_transaction_row(
        &dbtx,
        &input.id,
        &input.kind,
        &input.account_id,
        to_account_id.as_deref(),
        category_id.as_deref(),
        input.amount_cents,
        input.description.as_deref(),
        &input.transaction_date,
        excluded,
        &now(),
    )?;
    materialize_postings(&dbtx, &t)?;
    dbtx.commit()?;
    Ok(t)
```

`delete_transaction` needs no change — `ON DELETE CASCADE` removes the postings when the header row is deleted.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib update_and_delete_keep_postings_consistent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(service): re-materialize postings on transaction update\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Balance correction keeps postings consistent

**Files:**
- Modify: `src-tauri/src/service.rs` — `set_account_balance` (both branches).
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn set_account_balance_keeps_postings_consistent() {
    let c = crate::db::open_in_memory().unwrap();
    // Fresh account, only the opening row exists → reconcile edits opening.
    let acc = crate::service::create_account(&c, "Cash", "cash", 1_000, None).unwrap();
    crate::service::set_account_balance(&c, &acc.id, 4_000).unwrap();
    assert_books_balance(&c);
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 4_000);

    // Now create real activity, then reconcile → inserts a balanced adjustment.
    let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
    crate::service::create_expense(&c, &acc.id, &xcats[0].id, 500, None, "2026-03-01", false).unwrap();
    // balance is now 3500; reconcile to 3000 → adjustment of -500.
    crate::service::set_account_balance(&c, &acc.id, 3_000).unwrap();
    assert_books_balance(&c);
    assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 3_000);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_account_balance_keeps_postings_consistent`
Expected: FAIL — the opening-edit branch changes the opening header amount but not its postings (balance stays 1000), and the adjustment branch inserts a header with no postings.

- [ ] **Step 3: Wire both branches of `set_account_balance`**

In `src-tauri/src/service.rs`, replace the opening-edit branch:

```rust
    if !repo::account_has_nonopening_activity(conn, account_id)? {
        // Only the opening row exists — edit it so the balance equals the target.
        let tx = conn.unchecked_transaction()?;
        let acc2 = repo::set_opening_amount(&tx, account_id, real_balance_cents, &now())?;
        let opening = repo::get_opening_transaction(&tx, account_id)?;
        materialize_postings(&tx, &opening)?;
        tx.commit()?;
        return Ok(acc2);
    }
```

Replace the adjustment-insert branch (the `repo::insert_transaction(...)` + `repo::get_account(...)` tail) with:

```rust
    let today = crate::today();
    let tx = conn.unchecked_transaction()?;
    let adj = repo::insert_transaction(
        &tx, &new_id(), KIND_ADJUSTMENT, account_id, None, None,
        diff, Some("Balance adjustment"), &today, false, &now(),
    )?;
    materialize_postings(&tx, &adj)?;
    tx.commit()?;
    repo::get_account(conn, account_id)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_account_balance_keeps_postings_consistent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(service): keep postings consistent on balance correction\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Factory reset clears postings

**Files:**
- Modify: `src-tauri/src/db/mod.rs:178` (`reset_to_defaults`).
- Test: `src-tauri/src/lib.rs` (`mod tests`).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn reset_app_clears_postings() {
    let c = crate::db::open_in_memory().unwrap();
    let acc = crate::service::create_account(&c, "Cash", "cash", 1_000, None).unwrap();
    let _ = acc;
    let before: i64 = c.query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0)).unwrap();
    assert!(before > 0);
    crate::db::reset_to_defaults(&c).unwrap();
    let after: i64 = c.query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0)).unwrap();
    assert_eq!(after, 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reset_app_clears_postings`
Expected: PASS or FAIL depending on cascade. Because `reset_to_defaults` deletes `transactions` (which cascades to `postings`) **before** `accounts`, this may already pass. If it passes, keep the explicit delete anyway for clarity (Step 3) and re-run. If it fails (e.g. ordering changes later), Step 3 fixes it.

- [ ] **Step 3: Add an explicit `DELETE FROM postings`**

In `src-tauri/src/db/mod.rs`, in `reset_to_defaults`, add as the **first** delete (before `DELETE FROM transactions`):

```rust
        conn.execute("DELETE FROM postings", [])?;
        conn.execute("DELETE FROM transactions", [])?;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reset_app_clears_postings`
Expected: PASS.

- [ ] **Step 5: Run the full Rust suite + commit**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: all PASS (existing balance/dashboard tests still green — proves no number change).

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "$(printf 'feat(db): clear postings on factory reset\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Frontend mock parity (the seam)

**Files:**
- Modify: `src/lib/kinds.ts` — add `Posting` type + `postingsFor()`.
- Modify: `src/client/mock.ts:115-127` — rewrite `balanceOf` to use `postingsFor`.
- Test: `src/__tests__/postings.test.ts` (new).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/postings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { postingsFor } from "../lib/kinds";

describe("postingsFor", () => {
  const cases = [
    { kind: "income" as const, amt: 5000, acc: "a", to: null },
    { kind: "expense" as const, amt: 2000, acc: "a", to: null },
    { kind: "transfer" as const, amt: 1000, acc: "a", to: "b" },
    { kind: "adjustment" as const, amt: -500, acc: "a", to: null },
    { kind: "opening" as const, amt: 7000, acc: "a", to: null },
  ];

  it("always produces legs that sum to zero", () => {
    for (const c of cases) {
      const legs = postingsFor(c.kind, c.amt, c.acc, c.to);
      const sum = legs.reduce((s, l) => s + l.amountCents, 0);
      expect(sum).toBe(0);
    }
  });

  it("the real-account leg matches the old per-account sign", () => {
    const inc = postingsFor("income", 5000, "a", null).filter((l) => l.accountId === "a");
    expect(inc.reduce((s, l) => s + l.amountCents, 0)).toBe(5000);
    const exp = postingsFor("expense", 2000, "a", null).filter((l) => l.accountId === "a");
    expect(exp.reduce((s, l) => s + l.amountCents, 0)).toBe(-2000);
    const xferSrc = postingsFor("transfer", 1000, "a", "b").filter((l) => l.accountId === "a");
    expect(xferSrc.reduce((s, l) => s + l.amountCents, 0)).toBe(-1000);
    const xferDst = postingsFor("transfer", 1000, "a", "b").filter((l) => l.accountId === "b");
    expect(xferDst.reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/postings.test.ts`
Expected: FAIL — `postingsFor` is not exported from `../lib/kinds`.

- [ ] **Step 3: Add `postingsFor` to `kinds.ts` and use it in the mock**

Append to `src/lib/kinds.ts`:

```ts
/** A single double-entry posting leg, mirroring the Rust `postings` row. */
export interface Posting {
  accountId: string | null;
  bucket: "income" | "expense" | "equity" | null;
  amountCents: number;
}

/**
 * The single canonical sign rule (mirrors `service::postings_for` in Rust).
 * `amountCents` is positive for income/expense/transfer and already-signed for
 * adjustment/opening. The returned legs always sum to zero.
 */
export function postingsFor(
  kind: TransactionKind,
  amountCents: number,
  accountId: string,
  toAccountId: string | null,
): Posting[] {
  const real = (amt: number): Posting => ({ accountId, bucket: null, amountCents: amt });
  switch (kind) {
    case "income":
      return [real(amountCents), { accountId: null, bucket: "income", amountCents: -amountCents }];
    case "expense":
      return [real(-amountCents), { accountId: null, bucket: "expense", amountCents: amountCents }];
    case "transfer":
      return [real(-amountCents), { accountId: toAccountId, bucket: null, amountCents: amountCents }];
    case "adjustment":
    case "opening":
      return [real(amountCents), { accountId: null, bucket: "equity", amountCents: -amountCents }];
  }
}
```

In `src/client/mock.ts`, add the import at the top (merge with the existing kinds import if present):

```ts
import { postingsFor } from "../lib/kinds";
```

Replace the `balanceOf` function (lines ~115-127) with:

```ts
function balanceOf(a: Account): number {
  let b = 0;
  for (const t of txns) {
    for (const leg of postingsFor(t.kind, t.amountCents, t.accountId, t.toAccountId)) {
      if (leg.accountId === a.id) b += leg.amountCents;
    }
  }
  return b;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/postings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/kinds.ts src/client/mock.ts src/__tests__/postings.test.ts
git commit -m "$(printf 'feat(mock): balances from the postings sign rule (seam parity)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Full verification + docs

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md`.

- [ ] **Step 1: Run every gate**

Run: `npm run build`
Expected: typecheck + Vite build clean (strict TS, no unused).

Run: `npm test`
Expected: all Vitest suites PASS.

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: all Rust tests PASS.

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build`
Expected: desktop binary compiles (validates command registration + schema).

- [ ] **Step 2: Manually verify parity in the browser mock**

Run: `npm run dev`, open the app, and confirm account balances, net worth, and the dashboard match what they showed before (the mock reseeds the same demo data). Use the preview verification workflow to capture a screenshot of the dashboard.

- [ ] **Step 3: Update the docs**

In `CLAUDE.md`, under "Money, balances, and transaction kinds", replace the description of `balance_expr` (the pure-sum-of-signed-history paragraph) with a note that balances are now the sum of an account's **postings** (double-entry): each transaction materializes balanced legs (real account leg(s) + a `system_bucket` counter leg in `income|expense|equity`) via `service::postings_for`, mirrored by `postingsFor` in `src/lib/kinds.ts` and used by `balanceOf` in `mock.ts`; every transaction's legs sum to zero. Mention migration 006 added the `postings` table and backfilled existing data, and that `transactions`/`accounts` schema and all commands are unchanged.

In `CHANGELOG.md`, add under `[Unreleased]`:

```markdown
### Changed
- Internal: balances now come from a double-entry `postings` ledger (one uniform
  rule) instead of a per-kind signed sum. No visible behavior change; existing
  data is migrated automatically (migration 006). Sets up split transactions.
```

In `ROADMAP.md`, note the double-entry posting engine shipped as the foundation for later split-transaction and credit/debt work.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "$(printf 'docs: double-entry posting engine\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide how to integrate (PR vs merge). All gates from Step 1 must be green first.

---

## Self-Review notes (addressed)

- **Spec coverage:** postings table + invariants (Task 1, 2), single sign rule (Task 3, 7), balance engine rewrite (Task 2), all write paths materialize postings (Tasks 3–5), reset (Task 6), mock parity / seam (Task 7), no-number-change verification (existing suite in Task 6 Step 5 + Task 8), docs (Task 8). No frontend command/type changes — matches spec §9.
- **Type consistency:** `postings_for`/`materialize_postings`/`Leg` (Rust) and `postingsFor`/`Posting` (TS) are named consistently across tasks; `system_bucket` values `income|expense|equity` match between the SQL CHECK, `postings_for`, and `postingsFor`.
- **Naming caution for the implementer:** in service write paths the local DB-transaction handle is `tx` (rusqlite `Transaction`) while the transaction *model* is `t` — do not conflate them. `&tx` coerces to `&Connection` via `Deref` (the existing `create_account` already relies on this).
