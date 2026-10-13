# Reimbursements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record money that comes back for an expense already booked (employer claim, friend's share of a bill, shop refund) as a `reimbursement` that is allocated to the expenses it repays, report those expenses at their true cost, and track what is still expected.

**Architecture:** Migration 012 rebuilds `transactions` so the CHECK can name `reimbursement`, adds a nullable `expected_reimbursement_cents` column, and creates `reimbursement_allocations`. A reimbursement posts `+amount` to the receiving account and `-amount` to the `expense` system bucket. Reporting subtracts an expense's allocations from its own month and category; a split expense's offset is spread across its lines by largest remainder. The Add Transaction modal gets a fourth segment that swaps in a self-contained `ReimbursementForm`. Every rule exists in Rust and in `src/client/mock.ts`.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md`. Where this plan and the spec differ, this plan wins (the spec was corrected to match).
- Money is integer MYR cents. Balances come from postings only.
- A `reimbursement` stores `category_id` NULL, `to_account_id` NULL, `excluded_from_reporting` 0, and no split rows. Amount is positive.
- Reimbursement postings: `+amount_cents` on `account_id`, `-amount_cents` on system bucket `expense`.
- A reimbursement's allocations sum exactly to its amount. An expense's allocations sum to at most its amount. Only a plain expense (kind `expense`, non-system category) can receive an allocation or an expectation.
- The receiving account can be **any active account**, including the credit card that was charged.
- Effective expense amount = `amount_cents` minus its allocations, in the expense's own month and category. An `excluded_from_reporting` expense is skipped by reporting, and so are its allocations.
- Split offsets use the largest-remainder method (whole cents, ties to the earliest line). No line goes negative.
- `outstanding = max(expected - reimbursed, 0)`.
- No date-ordering rule between a reimbursement and its expense.
- The `lent` account subtype already exists. Do not add a subtype, do not touch `db/seed.rs`, and `src/generated/seed-catalog.json` must not change.
- `create_income`, `create_expense`, and `UpdateTransactionInput` keep their signatures. The expectation is set only through `set_expected_reimbursement`.
- Exact error messages (Rust and mock must match character for character):
  - `Amount must be greater than zero` (existing `validate_positive`, no trailing period)
  - `Pick at least one expense to reimburse.`
  - `Each allocation must be greater than zero.`
  - `An expense can only be listed once.`
  - `Only expenses can be reimbursed.`
  - `Allocation exceeds what's left on that expense.`
  - `Allocations must add up to the reimbursement amount.`
  - `The selected account is archived` (Conflict, from `ensure_active_account(..., "selected")`)
  - `Only reimbursements can be edited here.`
  - `Edit a reimbursement from its own form.`
  - `Only expenses can expect a reimbursement.`
  - `Expected reimbursement must be more than zero and no more than the expense amount.`
  - `This expense has been reimbursed. Edit or delete the reimbursement first.` (Conflict)
  - `Amount can't go below what's already been reimbursed.`
- Error kinds: the messages above are `ValidationError` unless marked Conflict.
- Transaction time follows `resolve_time` / `resolveTime` the same way a transfer does.
- Never hardcode colors; use `useTheme()` tokens. A reimbursement uses `colorKey: "transfer"`; the label and icon carry the meaning.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- There is no backfill and no upgrade prompt.
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Keep `CHANGELOG.md` and `ROADMAP.md` current (Task 11).

---

## File Structure

Backend:
- `src-tauri/src/apportion.rs` (new) — pure largest-remainder split. Mirrors `apportion` in `src/lib/reimbursements.ts`.
- `src-tauri/src/db/migrations.rs` — `MIGRATION_012`.
- `src-tauri/src/db/mod.rs` — factory reset clears allocations; migration 012 test.
- `src-tauri/src/models.rs` — `KIND_REIMBURSEMENT`, `Allocation`, `AwaitingReimbursement`, three new `Transaction` fields.
- `src-tauri/src/repo.rs` — allocation SQL, row hydration, `sum_expense_net_in_range`, allocation-aware `spending_breakdown`, `awaiting_reimbursement`, `update_transaction_row` gains the expectation.
- `src-tauri/src/service.rs` — `create_reimbursement`, `update_reimbursement`, `set_expected_reimbursement`, `get_awaiting_reimbursement`, `postings_for`, guards in `update_transaction` / `delete_transaction`, dashboard uses net expense.
- `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` — four commands registered; `reimbursement_tests` module.

Frontend:
- `src/types.ts`, `src/lib/kinds.ts`, `src/components/Icon.tsx` — kind, sign rule, postings, `reimburse` icon.
- `src/lib/reimbursements.ts` (new) — allocation math and display helpers. Tests in `src/lib/__tests__/reimbursements.test.ts`.
- `src/lib/txnSelection.ts`, `src/components/TxnSelectionPanel.tsx` — reimbursement counts and bulk locks.
- `src/lib/accounts.ts` — `lentLabel`.
- `src/client/index.ts`, `src/client/mock.ts` — four commands and the shared rules. Tests in `src/__tests__/mock-reimbursements.test.ts`.
- `src/modals/ReimbursementForm.tsx` (new), `src/modals/AddTransaction.tsx` — fourth segment, expense "Expecting reimbursement".
- `src/components/TxnRow.tsx`, `src/components/TxnDetailPanel.tsx`, `src/screens/Transactions.tsx`, `src/screens/Dashboard.tsx`, `src/screens/Accounts.tsx` — badges, filter, quick action, dashboard tile, "Owes you".
- `AGENTS.md`, `docs/architecture/*.md`, `CHANGELOG.md`, `ROADMAP.md` — docs.

---

### Task 1: Migration 012, models, row hydration, factory reset

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/repo.rs`
- Modify: `src-tauri/src/lib.rs` (new test module at the end)
- Test: `src-tauri/src/db/mod.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: migrations 001–011 unchanged.
- Produces:
  - `MIGRATIONS` includes `(12, MIGRATION_012)`. `transactions` has `expected_reimbursement_cents INTEGER`. Table `reimbursement_allocations(id, reimbursement_id, expense_id, amount_cents, created_at)` with `UNIQUE (reimbursement_id, expense_id)`.
  - `models::KIND_REIMBURSEMENT`, `models::Allocation { expense_id: String, amount_cents: i64 }` (Serialize, Deserialize, PartialEq, camelCase), `models::AwaitingReimbursement { count: i64, total_cents: i64 }`.
  - `Transaction` gains `expected_reimbursement_cents: Option<i64>`, `reimbursed_cents: i64`, `allocations: Vec<Allocation>`.
  - `repo::insert_allocation(conn, id, reimbursement_id, expense_id, amount_cents, now) -> AppResult<()>`
  - `repo::list_allocations_for(conn, reimbursement_id) -> AppResult<Vec<Allocation>>`
  - `repo::delete_allocations_for(conn, reimbursement_id) -> AppResult<()>`
  - `repo::allocated_total_for_expense(conn, expense_id, except_reimbursement_id: Option<&str>) -> AppResult<i64>`
  - `repo::set_expected_reimbursement(conn, expense_id, expected: Option<i64>, now) -> AppResult<()>`
  - `repo::update_transaction_row(..., excluded_from_reporting: bool, expected_reimbursement_cents: Option<i64>, now: &str)` (new parameter before `now`).
  - Every `Transaction` read through `get_transaction`, `list_transactions`, `recent_transactions` carries `reimbursed_cents` and `allocations`.

- [ ] **Step 1: Write the failing migration test**

Append inside `mod migration_tests` in `src-tauri/src/db/mod.rs`, after `migration_011_copies_rows_and_accepts_payment`:

```rust
    #[test]
    fn migration_012_copies_rows_and_adds_reimbursements() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..11 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('src', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                      ('card', NULL, 'Visa', 'credit-card', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('c1', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
               VALUES ('xfer', 'payment', 'src', 'card', NULL, 4000, 'Pay', '2026-02-01', 0, NULL, '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00'),
                      ('exp', 'expense', 'src', NULL, 'c1', 1500, 'Lunch', '2026-02-02', 0, NULL, '2026-02-02T00:00:00+00:00', '2026-02-02T00:00:00+00:00');
             INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
               VALUES ('p1', 'xfer', 'src', NULL, -4000), ('p2', 'xfer', 'card', NULL, 4000);
             INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
               VALUES ('s1', 'exp', 'c1', 1500, 0, '2026-02-02T00:00:00+00:00');",
        );
        apply(MIGRATIONS[11].1);

        let kind: String = conn.query_row("SELECT kind FROM transactions WHERE id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "payment");
        let postings: i64 = conn.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(postings, 2);
        let splits: i64 = conn.query_row("SELECT COUNT(*) FROM transaction_splits WHERE transaction_id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(splits, 1);
        let expected: Option<i64> = conn.query_row("SELECT expected_reimbursement_cents FROM transactions WHERE id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(expected, None);

        let insert = |id: &str, kind: &str, to: &str, cat: &str| {
            conn.execute(
                &format!(
                    "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
                     VALUES ('{id}', '{kind}', 'src', {to}, {cat}, 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')"
                ),
                [],
            )
        };
        insert("re1", "reimbursement", "NULL", "NULL").unwrap();
        assert!(insert("bad1", "reimbursement", "NULL", "'c1'").is_err(), "a reimbursement cannot carry a category");
        assert!(insert("bad2", "reimbursement", "'card'", "NULL").is_err(), "a reimbursement cannot carry a destination");

        conn.execute("UPDATE transactions SET expected_reimbursement_cents = 1500 WHERE id='exp'", []).unwrap();
        assert!(
            conn.execute("UPDATE transactions SET expected_reimbursement_cents = 1501 WHERE id='exp'", []).is_err(),
            "expectation cannot exceed the expense amount"
        );
        assert!(
            conn.execute("UPDATE transactions SET expected_reimbursement_cents = 100 WHERE id='xfer'", []).is_err(),
            "only an expense can carry an expectation"
        );

        conn.execute(
            "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
             VALUES ('a1', 're1', 'exp', 1000, '2026-03-01T00:00:00+00:00')",
            [],
        ).unwrap();
        assert!(
            conn.execute(
                "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
                 VALUES ('a2', 're1', 'exp', 100, '2026-03-01T00:00:00+00:00')",
                [],
            ).is_err(),
            "one reimbursement lists an expense once"
        );
        assert!(
            conn.execute("DELETE FROM transactions WHERE id='exp'", []).is_err(),
            "an expense with allocations cannot be deleted at the SQL level"
        );
        conn.execute("DELETE FROM transactions WHERE id='re1'", []).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM reimbursement_allocations", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "deleting a reimbursement removes its allocations");
    }
```

Append a new test module at the very end of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod reimbursement_tests {
    use crate::db::open_in_memory;
    use crate::models::{Account, Allocation, Transaction};
    use crate::repo;
    use crate::service;
    use rusqlite::Connection;

    fn expense_cat(c: &Connection, n: i64) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE kind='expense' AND is_system=0 AND parent_id IS NULL ORDER BY sort_order LIMIT 1 OFFSET ?1",
            [n],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn pair(c: &Connection) -> (Account, Account) {
        let savings = service::create_account(c, "Maybank", "savings", 500_000, None, None).unwrap();
        let card = service::create_account(c, "Visa", "credit-card", -80_000, None, Some(1_000_000)).unwrap();
        (savings, card)
    }

    fn spend(c: &Connection, account_id: &str, cents: i64, date: &str) -> Transaction {
        let cat = expense_cat(c, 0);
        service::create_expense(c, account_id, Some(&cat), cents, Some("Dinner"), date, None, false, None).unwrap()
    }

    #[test]
    fn allocations_hydrate_on_both_sides() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        let r = repo::insert_transaction(
            &c, "re1", "reimbursement", &savings.id, None, None, 15_000, Some("Back"),
            "2026-06-05", None, false, "2026-06-05T00:00:00Z",
        )
        .unwrap();
        repo::insert_allocation(&c, "al1", &r.id, &e.id, 15_000, "2026-06-05T00:00:00Z").unwrap();

        let expense = repo::get_transaction(&c, &e.id).unwrap();
        assert_eq!(expense.reimbursed_cents, 15_000);
        assert_eq!(expense.expected_reimbursement_cents, None);
        assert!(expense.allocations.is_empty());

        let reimbursement = repo::get_transaction(&c, &r.id).unwrap();
        assert_eq!(reimbursement.reimbursed_cents, 0);
        assert_eq!(
            reimbursement.allocations,
            vec![Allocation { expense_id: e.id.clone(), amount_cents: 15_000 }]
        );
    }

    #[test]
    fn factory_reset_clears_allocations() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        let r = repo::insert_transaction(
            &c, "re1", "reimbursement", &savings.id, None, None, 5_000, None,
            "2026-06-05", None, false, "2026-06-05T00:00:00Z",
        )
        .unwrap();
        repo::insert_allocation(&c, "al1", &r.id, &e.id, 5_000, "2026-06-05T00:00:00Z").unwrap();

        service::reset_app(&c).unwrap();

        let allocs: i64 = c.query_row("SELECT COUNT(*) FROM reimbursement_allocations", [], |row| row.get(0)).unwrap();
        let txns: i64 = c.query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get(0)).unwrap();
        assert_eq!(allocs, 0);
        assert_eq!(txns, 0);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib 2>&1 | tail -30`

Expected: compile errors (`KIND_REIMBURSEMENT`/`Allocation` not found, `insert_allocation` not found, `reimbursed_cents` not a field). No test passes.

- [ ] **Step 3: Add migration 012**

In `src-tauri/src/db/migrations.rs`, change the list to include 012:

```rust
    (9, MIGRATION_009), (10, MIGRATION_010), (11, MIGRATION_011), (12, MIGRATION_012),
];
```

Append at the end of the file:

```rust

// Reimbursements. Rebuilds transactions so the CHECK can name 'reimbursement' and
// adds the nullable expected_reimbursement_cents column, then creates the
// allocation table that pairs a reimbursement with the expenses it repays.
// postings and transaction_splits reference transactions ON DELETE CASCADE, so
// they are copied first and dropped before transactions (same pattern as 011).
// reimbursement_allocations is created AFTER the swap so its foreign keys point
// at the final `transactions` table.
const MIGRATION_012: &str = r#"
CREATE TABLE transactions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment', 'opening', 'payment', 'reimbursement')),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL,
  description      TEXT,
  transaction_date TEXT NOT NULL,
  excluded_from_reporting INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_reporting IN (0, 1)),
  transaction_time TEXT,
  expected_reimbursement_cents INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (kind IN ('income', 'expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
    (kind = 'transfer' AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'payment'  AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'reimbursement' AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'opening' AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0)
  ),
  CHECK (
    expected_reimbursement_cents IS NULL OR
    (kind = 'expense' AND expected_reimbursement_cents > 0 AND expected_reimbursement_cents <= amount_cents)
  )
);

INSERT INTO transactions_new
  (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
  SELECT id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at
  FROM transactions;

CREATE TABLE postings_new (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions_new(id) ON DELETE CASCADE,
  account_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  system_bucket  TEXT CHECK (system_bucket IN ('income', 'expense', 'equity')),
  amount_cents   INTEGER NOT NULL,
  CHECK ((account_id IS NOT NULL AND system_bucket IS NULL)
      OR (account_id IS NULL     AND system_bucket IS NOT NULL))
);
INSERT INTO postings_new (id, transaction_id, account_id, system_bucket, amount_cents)
  SELECT id, transaction_id, account_id, system_bucket, amount_cents FROM postings;

CREATE TABLE transaction_splits_new (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES transactions_new(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
INSERT INTO transaction_splits_new (id, transaction_id, category_id, amount_cents, sort_order, created_at)
  SELECT id, transaction_id, category_id, amount_cents, sort_order, created_at FROM transaction_splits;

DROP TABLE transaction_splits;
DROP TABLE postings;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
ALTER TABLE postings_new RENAME TO postings;
ALTER TABLE transaction_splits_new RENAME TO transaction_splits;

CREATE INDEX idx_tx_date ON transactions(transaction_date);
CREATE INDEX idx_tx_account ON transactions(account_id);
CREATE INDEX idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);
CREATE INDEX idx_tx_kind ON transactions(kind);
CREATE INDEX idx_postings_account ON postings(account_id);
CREATE INDEX idx_postings_txn ON postings(transaction_id);
CREATE INDEX idx_splits_txn ON transaction_splits(transaction_id);
CREATE INDEX idx_splits_cat ON transaction_splits(category_id);

CREATE TABLE reimbursement_allocations (
  id               TEXT PRIMARY KEY,
  reimbursement_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  expense_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at       TEXT NOT NULL,
  UNIQUE (reimbursement_id, expense_id)
);
CREATE INDEX idx_alloc_reimbursement ON reimbursement_allocations(reimbursement_id);
CREATE INDEX idx_alloc_expense ON reimbursement_allocations(expense_id);
"#;
```

- [ ] **Step 4: Clear allocations on factory reset**

In `src-tauri/src/db/mod.rs`, inside `reset_to_defaults`, add the delete before `DELETE FROM postings`:

```rust
        // reimbursement_allocations.expense_id is ON DELETE RESTRICT, so the links
        // must go before the transactions they reference.
        conn.execute("DELETE FROM reimbursement_allocations", [])?;
        conn.execute("DELETE FROM postings", [])?;
```

(The existing `conn.execute("DELETE FROM postings", [])?;` line is replaced by the three lines above, keeping the original comment block above it.)

- [ ] **Step 5: Add the models**

In `src-tauri/src/models.rs`, add after `KIND_PAYMENT`:

```rust
pub const KIND_REIMBURSEMENT: &str = "reimbursement";
```

Update the doc comment above the constants to read:

```rust
/// Transaction kind. `transfer`, `payment`, `reimbursement`, and `adjustment` are
/// excluded from income / expense / cashflow aggregates (see the dashboard rules
/// in the spec). A reimbursement instead reduces the expenses it repays.
```

Add after `SplitInput`:

```rust
/// One link between a reimbursement and an expense it repays. Used both as a
/// command input and as the serialized shape on `Transaction.allocations`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub expense_id: String,
    pub amount_cents: i64,
}

/// Dashboard tile: expenses whose expected reimbursement is not yet received.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingReimbursement {
    pub count: i64,
    pub total_cents: i64,
}
```

Add three fields to `Transaction`, after `splits`:

```rust
    #[serde(default)]
    pub splits: Vec<TxnSplit>,
    /// Expenses only: the amount the user expects to get back. NULL when none.
    pub expected_reimbursement_cents: Option<i64>,
    /// Expenses only: sum of this expense's allocations.
    pub reimbursed_cents: i64,
    /// Reimbursements only: the expenses this row repays.
    pub allocations: Vec<Allocation>,
    pub created_at: String,
```

- [ ] **Step 6: Repository: mapping, hydration, allocation SQL**

In `src-tauri/src/repo.rs`:

In `map_transaction`, after `splits: Vec::new(),` add:

```rust
        expected_reimbursement_cents: r.get("expected_reimbursement_cents")?,
        reimbursed_cents: 0,
        allocations: Vec::new(),
```

Replace the three places that set `splits` after reading rows with one helper. Add this function after `delete_splits_for`:

```rust
/// Fill the derived collections on a row: split lines, an expense's reimbursed
/// total, and a reimbursement's allocations.
fn hydrate(conn: &Connection, t: &mut Transaction) -> AppResult<()> {
    t.splits = list_splits_for(conn, &t.id)?;
    t.reimbursed_cents = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM reimbursement_allocations WHERE expense_id = ?1",
        [&t.id],
        |r| r.get(0),
    )?;
    t.allocations = list_allocations_for(conn, &t.id)?;
    Ok(())
}
```

In `get_transaction`, replace `t.splits = list_splits_for(conn, id)?;` with `hydrate(conn, &mut t)?;`.

In `list_transactions` and in `recent_transactions`, replace the loop body `t.splits = list_splits_for(conn, &t.id)?;` with `hydrate(conn, t)?;` (the loop variable is `t: &mut Transaction`).

Add the allocation SQL section after `delete_splits_for` / `hydrate`:

```rust
// ── Reimbursement allocations ────────────────────────────────────────────────

pub fn insert_allocation(
    conn: &Connection,
    id: &str,
    reimbursement_id: &str,
    expense_id: &str,
    amount_cents: i64,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, reimbursement_id, expense_id, amount_cents, now],
    )
    .map_err(map_check)?;
    Ok(())
}

pub fn list_allocations_for(conn: &Connection, reimbursement_id: &str) -> AppResult<Vec<Allocation>> {
    let mut stmt = conn.prepare(
        "SELECT expense_id, amount_cents FROM reimbursement_allocations WHERE reimbursement_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt
        .query_map([reimbursement_id], |r| {
            Ok(Allocation { expense_id: r.get(0)?, amount_cents: r.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_allocations_for(conn: &Connection, reimbursement_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM reimbursement_allocations WHERE reimbursement_id = ?1", [reimbursement_id])?;
    Ok(())
}

/// Total already allocated to an expense, optionally ignoring one reimbursement
/// (the one being edited, so its own links don't count as used).
pub fn allocated_total_for_expense(
    conn: &Connection,
    expense_id: &str,
    except_reimbursement_id: Option<&str>,
) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM reimbursement_allocations
         WHERE expense_id = ?1 AND (?2 IS NULL OR reimbursement_id <> ?2)",
        params![expense_id, except_reimbursement_id],
        |r| r.get(0),
    )?)
}

pub fn set_expected_reimbursement(
    conn: &Connection,
    expense_id: &str,
    expected: Option<i64>,
    now: &str,
) -> AppResult<()> {
    let n = conn
        .execute(
            "UPDATE transactions SET expected_reimbursement_cents = ?2, updated_at = ?3 WHERE id = ?1",
            params![expense_id, expected, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    Ok(())
}
```

Change `update_transaction_row` to write the expectation. Replace the whole function with:

```rust
#[allow(clippy::too_many_arguments)]
pub fn update_transaction_row(
    conn: &Connection,
    id: &str,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: Option<&str>,
    amount_cents: i64,
    description: Option<&str>,
    transaction_date: &str,
    transaction_time: Option<&str>,
    excluded_from_reporting: bool,
    expected_reimbursement_cents: Option<i64>,
    now: &str,
) -> AppResult<Transaction> {
    let n = conn
        .execute(
            "UPDATE transactions SET kind=?2, account_id=?3, to_account_id=?4, category_id=?5,
               amount_cents=?6, description=?7, transaction_date=?8, transaction_time=?9, excluded_from_reporting=?10,
               expected_reimbursement_cents=?11, updated_at=?12 WHERE id=?1",
            params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting as i64, expected_reimbursement_cents, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    get_transaction(conn, id)
}
```

In `src-tauri/src/service.rs`, inside `update_transaction`, update the call so it compiles (the expectation is derived properly in Task 3; for now preserve it). Change:

```rust
        time.as_deref(),
        excluded,
        &now(),
    )?;
    repo::delete_splits_for(&dbtx, &input.id)?;
```

to:

```rust
        time.as_deref(),
        excluded,
        existing.expected_reimbursement_cents,
        &now(),
    )?;
    repo::delete_splits_for(&dbtx, &input.id)?;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib 2>&1 | tail -15`

Expected: all tests pass, including `migration_012_copies_rows_and_adds_reimbursements`, `allocations_hydrate_on_both_sides`, and `factory_reset_clears_allocations`. If a test elsewhere fails because it builds a `Transaction` struct literal, add the three new fields there (`expected_reimbursement_cents: None, reimbursed_cents: 0, allocations: vec![]`).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: add reimbursement schema, allocations, and row hydration"
```

---

### Task 2: Create a reimbursement

**Files:**
- Modify: `src-tauri/src/service.rs`
- Test: `src-tauri/src/lib.rs` (`mod reimbursement_tests`)

**Interfaces:**
- Consumes: Task 1 (`Allocation`, `KIND_REIMBURSEMENT`, `repo::insert_allocation`, `repo::allocated_total_for_expense`, hydrated `Transaction`).
- Produces:
  - `service::create_reimbursement(conn, account_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, allocations: Vec<Allocation>) -> AppResult<Transaction>`
  - private `service::validate_allocations(conn, amount_cents, &[Allocation], except_reimbursement_id: Option<&str>) -> AppResult<()>`
  - `postings_for` handles `KIND_REIMBURSEMENT`.

- [ ] **Step 1: Write the failing tests**

Add these helpers inside `mod reimbursement_tests` (after `spend`), and extend its imports to `use crate::error::AppError;`:

```rust
    fn validation_message(err: AppError) -> String {
        match err {
            AppError::Validation(m) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn conflict_message(err: AppError) -> String {
        match err {
            AppError::Conflict(m) => m,
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    fn income_cat(c: &Connection) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE kind='income' AND is_system=0 AND parent_id IS NULL ORDER BY sort_order LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn alloc(expense: &Transaction, cents: i64) -> Allocation {
        Allocation { expense_id: expense.id.clone(), amount_cents: cents }
    }

    fn reimburse(c: &Connection, account_id: &str, cents: i64, date: &str, allocs: Vec<Allocation>) -> Transaction {
        service::create_reimbursement(c, account_id, cents, Some("Back"), date, None, allocs).unwrap()
    }

    fn balance(c: &Connection, id: &str) -> i64 {
        repo::get_account(c, id).unwrap().balance_cents
    }
```

Add these tests inside the module:

```rust
    #[test]
    fn reimbursement_raises_the_balance_and_offsets_the_expense_bucket() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        assert_eq!(balance(&c, &savings.id), 480_000);

        let r = reimburse(&c, &savings.id, 15_000, "2026-06-05", vec![alloc(&e, 15_000)]);

        assert_eq!(r.kind, "reimbursement");
        assert_eq!(r.category_id, None);
        assert_eq!(r.to_account_id, None);
        assert!(!r.excluded_from_reporting);
        assert_eq!(r.allocations, vec![alloc(&e, 15_000)]);
        assert_eq!(balance(&c, &savings.id), 495_000);
        let sum: i64 = c
            .query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE transaction_id=?1", [&r.id], |row| row.get(0))
            .unwrap();
        assert_eq!(sum, 0);
        let bucket: i64 = c
            .query_row(
                "SELECT amount_cents FROM postings WHERE transaction_id=?1 AND system_bucket='expense'",
                [&r.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bucket, -15_000);
        assert_eq!(repo::get_transaction(&c, &e.id).unwrap().reimbursed_cents, 15_000);
    }

    #[test]
    fn a_refund_can_land_on_the_card_that_was_charged() {
        let c = open_in_memory().unwrap();
        let (_savings, card) = pair(&c);
        let e = spend(&c, &card.id, 8_000, "2026-06-01");
        assert_eq!(balance(&c, &card.id), -88_000);
        reimburse(&c, &card.id, 8_000, "2026-06-03", vec![alloc(&e, 8_000)]);
        assert_eq!(balance(&c, &card.id), -80_000);
    }

    #[test]
    fn one_reimbursement_covers_many_and_one_expense_takes_parts() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e1 = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        reimburse(&c, &savings.id, 15_000, "2026-06-10", vec![alloc(&e1, 10_000), alloc(&e2, 5_000)]);
        assert_eq!(repo::get_transaction(&c, &e1.id).unwrap().reimbursed_cents, 10_000);
        assert_eq!(repo::get_transaction(&c, &e2.id).unwrap().reimbursed_cents, 5_000);

        let e3 = spend(&c, &savings.id, 10_000, "2026-06-03");
        reimburse(&c, &savings.id, 3_000, "2026-06-11", vec![alloc(&e3, 3_000)]);
        reimburse(&c, &savings.id, 2_000, "2026-06-12", vec![alloc(&e3, 2_000)]);
        assert_eq!(repo::get_transaction(&c, &e3.id).unwrap().reimbursed_cents, 5_000);

        let err = service::create_reimbursement(&c, &savings.id, 6_000, None, "2026-06-13", None, vec![alloc(&e3, 6_000)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Allocation exceeds what's left on that expense.");
    }

    #[test]
    fn create_rejects_each_bad_shape_without_writing() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 4_000, "2026-06-02");
        let inc_cat = income_cat(&c);
        let income = service::create_income(&c, &savings.id, Some(&inc_cat), 1_000, None, "2026-06-01", None, false, None).unwrap();

        let go = |amount: i64, allocs: Vec<Allocation>| {
            validation_message(
                service::create_reimbursement(&c, &savings.id, amount, None, "2026-06-02", None, allocs).unwrap_err(),
            )
        };
        assert_eq!(go(0, vec![alloc(&e, 1)]), "Amount must be greater than zero");
        assert_eq!(go(100, vec![]), "Pick at least one expense to reimburse.");
        assert_eq!(go(100, vec![alloc(&e, 0)]), "Each allocation must be greater than zero.");
        assert_eq!(go(200, vec![alloc(&e, 100), alloc(&e, 100)]), "An expense can only be listed once.");
        assert_eq!(go(100, vec![alloc(&income, 100)]), "Only expenses can be reimbursed.");
        assert_eq!(
            go(100, vec![Allocation { expense_id: "nope".into(), amount_cents: 100 }]),
            "Only expenses can be reimbursed."
        );
        assert_eq!(go(100, vec![alloc(&e, 60), alloc(&e2, 30)]), "Allocations must add up to the reimbursement amount.");
        assert_eq!(go(20_000, vec![alloc(&e, 20_000)]), "Allocation exceeds what's left on that expense.");

        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE kind='reimbursement'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn create_rejects_balance_corrections_and_archived_accounts() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        // A shortfall booked as an expense lands in the protected "Adjustment" category.
        service::set_account_balance(&c, &savings.id, 400_000, true).unwrap();
        let correction_id: String = c
            .query_row(
                "SELECT t.id FROM transactions t JOIN categories k ON k.id = t.category_id WHERE k.is_system = 1 AND t.kind = 'expense'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let correction = repo::get_transaction(&c, &correction_id).unwrap();
        let err = service::create_reimbursement(&c, &savings.id, 100, None, "2026-06-02", None, vec![alloc(&correction, 100)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Only expenses can be reimbursed.");

        service::archive_account(&c, &savings.id).unwrap();
        let err = service::create_reimbursement(&c, &savings.id, 100, None, "2026-06-02", None, vec![alloc(&e, 100)])
            .unwrap_err();
        assert_eq!(conflict_message(err), "The selected account is archived");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib reimbursement_tests 2>&1 | tail -20`

Expected: compile error, `create_reimbursement` not found in `service`.

- [ ] **Step 3: Implement**

In `src-tauri/src/service.rs`:

Update the doc comment on `postings_for` and add the arm. The match becomes:

```rust
        KIND_INCOME => vec![real(amount_cents), bucket("income", -amount_cents)],
        KIND_EXPENSE => vec![real(-amount_cents), bucket("expense", amount_cents)],
        // Money back for spending: the expense bucket shrinks as the account grows.
        KIND_REIMBURSEMENT => vec![real(amount_cents), bucket("expense", -amount_cents)],
```

Add, after `create_payment`:

```rust
/// Validate a reimbursement's allocations against its amount and the expenses
/// they repay. `except_reimbursement_id` is the reimbursement being edited, so
/// its own existing links do not count as already used.
fn validate_allocations(
    conn: &Connection,
    amount_cents: i64,
    allocations: &[Allocation],
    except_reimbursement_id: Option<&str>,
) -> AppResult<()> {
    if allocations.is_empty() {
        return Err(AppError::Validation("Pick at least one expense to reimburse.".into()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut sum = 0i64;
    for a in allocations {
        if a.amount_cents <= 0 {
            return Err(AppError::Validation("Each allocation must be greater than zero.".into()));
        }
        if !seen.insert(a.expense_id.as_str()) {
            return Err(AppError::Validation("An expense can only be listed once.".into()));
        }
        let expense = match repo::get_transaction(conn, &a.expense_id) {
            Ok(t) => t,
            Err(AppError::NotFound(_)) => {
                return Err(AppError::Validation("Only expenses can be reimbursed.".into()))
            }
            Err(other) => return Err(other),
        };
        if !is_plain_expense(conn, &expense)? {
            return Err(AppError::Validation("Only expenses can be reimbursed.".into()));
        }
        let used = repo::allocated_total_for_expense(conn, &a.expense_id, except_reimbursement_id)?;
        if used + a.amount_cents > expense.amount_cents {
            return Err(AppError::Validation("Allocation exceeds what's left on that expense.".into()));
        }
        sum += a.amount_cents;
    }
    if sum != amount_cents {
        return Err(AppError::Validation("Allocations must add up to the reimbursement amount.".into()));
    }
    Ok(())
}

/// An expense that is not a balance correction (those sit in a system category).
fn is_plain_expense(conn: &Connection, t: &Transaction) -> AppResult<bool> {
    if t.kind != KIND_EXPENSE {
        return Ok(false);
    }
    match t.category_id.as_deref() {
        Some(cid) => Ok(!repo::get_category(conn, cid)?.is_system),
        None => Ok(true),
    }
}

pub fn create_reimbursement(
    conn: &Connection,
    account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, None)?;
    let tx = conn.unchecked_transaction()?;
    validate_allocations(&tx, amount_cents, &allocations, None)?;
    let t = repo::insert_transaction(
        &tx, &new_id(), KIND_REIMBURSEMENT, account_id, None, None,
        amount_cents, description, date, time.as_deref(), false, &now(),
    )?;
    for a in &allocations {
        repo::insert_allocation(&tx, &new_id(), &t.id, &a.expense_id, a.amount_cents, &now())?;
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    repo::get_transaction(conn, &t.id)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib reimbursement_tests 2>&1 | tail -15`

Expected: all `reimbursement_tests` pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: create reimbursements allocated to expenses"
```

---

### Task 3: Expectation, editing a reimbursement, and guards

**Files:**
- Modify: `src-tauri/src/service.rs`
- Test: `src-tauri/src/lib.rs` (`mod reimbursement_tests`)

**Interfaces:**
- Consumes: Task 2 (`create_reimbursement`, `validate_allocations`, `is_plain_expense`), Task 1 repo functions.
- Produces:
  - `service::set_expected_reimbursement(conn, expense_id: &str, expected_cents: Option<i64>) -> AppResult<Transaction>`
  - `service::update_reimbursement(conn, id: &str, account_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, allocations: Vec<Allocation>) -> AppResult<Transaction>`
  - `update_transaction` rejects the `reimbursement` kind, blocks changing a reimbursed expense into a non-expense or below its reimbursed total, and clamps or clears the expectation.
  - `delete_transaction` rejects an expense that has allocations.

- [ ] **Step 1: Write the failing tests**

Add inside `mod reimbursement_tests` (and add `UpdateTransactionInput` to the `use crate::models::{...}` line):

```rust
    fn expense_update(e: &Transaction, amount: i64) -> UpdateTransactionInput {
        UpdateTransactionInput {
            id: e.id.clone(),
            kind: "expense".into(),
            account_id: e.account_id.clone(),
            to_account_id: None,
            category_id: e.category_id.clone(),
            amount_cents: amount,
            description: e.description.clone(),
            transaction_date: e.transaction_date.clone(),
            transaction_time: None,
            excluded_from_reporting: false,
            splits: None,
        }
    }

    #[test]
    fn expectation_can_be_set_changed_and_cleared() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let t = service::set_expected_reimbursement(&c, &e.id, Some(7_000)).unwrap();
        assert_eq!(t.expected_reimbursement_cents, Some(7_000));
        let t = service::set_expected_reimbursement(&c, &e.id, Some(10_000)).unwrap();
        assert_eq!(t.expected_reimbursement_cents, Some(10_000));

        let range = "Expected reimbursement must be more than zero and no more than the expense amount.";
        assert_eq!(validation_message(service::set_expected_reimbursement(&c, &e.id, Some(10_001)).unwrap_err()), range);
        assert_eq!(validation_message(service::set_expected_reimbursement(&c, &e.id, Some(0)).unwrap_err()), range);

        let inc_cat = income_cat(&c);
        let income = service::create_income(&c, &savings.id, Some(&inc_cat), 1_000, None, "2026-06-01", None, false, None).unwrap();
        assert_eq!(
            validation_message(service::set_expected_reimbursement(&c, &income.id, Some(100)).unwrap_err()),
            "Only expenses can expect a reimbursement."
        );

        let t = service::set_expected_reimbursement(&c, &e.id, None).unwrap();
        assert_eq!(t.expected_reimbursement_cents, None);
    }

    #[test]
    fn update_reimbursement_rewrites_amount_account_and_allocations() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let cash = service::create_account(&c, "Wallet", "cash", 0, None, None).unwrap();
        let e1 = spend(&c, &savings.id, 20_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        let r = reimburse(&c, &savings.id, 10_000, "2026-06-05", vec![alloc(&e1, 10_000)]);
        assert_eq!(balance(&c, &savings.id), 485_000);

        let u = service::update_reimbursement(
            &c, &r.id, &cash.id, 6_000, Some("Fixed"), "2026-06-09", None,
            vec![alloc(&e1, 1_000), alloc(&e2, 5_000)],
        )
        .unwrap();

        assert_eq!(u.amount_cents, 6_000);
        assert_eq!(u.account_id, cash.id);
        assert_eq!(u.description.as_deref(), Some("Fixed"));
        assert_eq!(u.allocations, vec![alloc(&e1, 1_000), alloc(&e2, 5_000)]);
        assert_eq!(repo::get_transaction(&c, &e1.id).unwrap().reimbursed_cents, 1_000);
        assert_eq!(repo::get_transaction(&c, &e2.id).unwrap().reimbursed_cents, 5_000);
        assert_eq!(balance(&c, &cash.id), 6_000);
        assert_eq!(balance(&c, &savings.id), 475_000);
    }

    #[test]
    fn update_reimbursement_ignores_its_own_links_when_checking_what_is_left() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 10_000, "2026-06-05", vec![alloc(&e, 10_000)]);
        let u = service::update_reimbursement(&c, &r.id, &savings.id, 10_000, None, "2026-06-06", None, vec![alloc(&e, 10_000)])
            .unwrap();
        assert_eq!(u.allocations, vec![alloc(&e, 10_000)]);
    }

    #[test]
    fn a_failed_update_reimbursement_changes_nothing() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);
        let err = service::update_reimbursement(&c, &r.id, &savings.id, 12_000, None, "2026-06-06", None, vec![alloc(&e, 12_000)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Allocation exceeds what's left on that expense.");
        let stored = repo::get_transaction(&c, &r.id).unwrap();
        assert_eq!(stored.amount_cents, 4_000);
        assert_eq!(stored.allocations, vec![alloc(&e, 4_000)]);
        assert_eq!(balance(&c, &savings.id), 494_000);
    }

    #[test]
    fn update_reimbursement_only_accepts_reimbursements() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let err = service::update_reimbursement(&c, &e.id, &savings.id, 100, None, "2026-06-06", None, vec![alloc(&e, 100)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Only reimbursements can be edited here.");
    }

    #[test]
    fn update_transaction_refuses_reimbursements() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);

        let mut input = expense_update(&e, 4_000);
        input.id = r.id.clone();
        input.kind = "reimbursement".into();
        assert_eq!(
            validation_message(service::update_transaction(&c, input).unwrap_err()),
            "Edit a reimbursement from its own form."
        );
        let mut as_expense = expense_update(&e, 4_000);
        as_expense.id = r.id.clone();
        assert_eq!(
            validation_message(service::update_transaction(&c, as_expense).unwrap_err()),
            "Edit a reimbursement from its own form."
        );
    }

    #[test]
    fn a_reimbursed_expense_cannot_be_deleted_shrunk_or_retyped() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 6_000, "2026-06-05", vec![alloc(&e, 6_000)]);

        let locked = "This expense has been reimbursed. Edit or delete the reimbursement first.";
        assert_eq!(conflict_message(service::delete_transaction(&c, &e.id).unwrap_err()), locked);
        assert_eq!(
            validation_message(service::update_transaction(&c, expense_update(&e, 5_000)).unwrap_err()),
            "Amount can't go below what's already been reimbursed."
        );
        service::update_transaction(&c, expense_update(&e, 6_000)).unwrap();

        let mut retyped = expense_update(&e, 6_000);
        retyped.kind = "income".into();
        retyped.category_id = None;
        assert_eq!(conflict_message(service::update_transaction(&c, retyped).unwrap_err()), locked);

        service::delete_transaction(&c, &r.id).unwrap();
        assert_eq!(repo::get_transaction(&c, &e.id).unwrap().reimbursed_cents, 0);
        assert_eq!(balance(&c, &savings.id), 494_000);
        service::delete_transaction(&c, &e.id).unwrap();
    }

    #[test]
    fn editing_an_expense_clamps_or_clears_the_expectation() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        service::set_expected_reimbursement(&c, &e.id, Some(10_000)).unwrap();

        let shrunk = service::update_transaction(&c, expense_update(&e, 8_000)).unwrap();
        assert_eq!(shrunk.expected_reimbursement_cents, Some(8_000));

        let mut as_income = expense_update(&e, 8_000);
        as_income.kind = "income".into();
        as_income.category_id = Some(income_cat(&c));
        let flipped = service::update_transaction(&c, as_income).unwrap();
        assert_eq!(flipped.kind, "income");
        assert_eq!(flipped.expected_reimbursement_cents, None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib reimbursement_tests 2>&1 | tail -20`

Expected: compile errors (`set_expected_reimbursement`, `update_reimbursement` not found).

- [ ] **Step 3: Implement**

In `src-tauri/src/service.rs`, add after `create_reimbursement`:

```rust
pub fn update_reimbursement(
    conn: &Connection,
    id: &str,
    account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    let existing = repo::get_transaction(conn, id)?;
    if existing.kind != KIND_REIMBURSEMENT {
        return Err(AppError::Validation("Only reimbursements can be edited here.".into()));
    }
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, existing.transaction_time.clone())?;
    let tx = conn.unchecked_transaction()?;
    validate_allocations(&tx, amount_cents, &allocations, Some(id))?;
    let t = repo::update_transaction_row(
        &tx, id, KIND_REIMBURSEMENT, account_id, None, None,
        amount_cents, description, date, time.as_deref(), false, None, &now(),
    )?;
    repo::delete_allocations_for(&tx, id)?;
    for a in &allocations {
        repo::insert_allocation(&tx, &new_id(), id, &a.expense_id, a.amount_cents, &now())?;
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    repo::get_transaction(conn, id)
}

pub fn set_expected_reimbursement(
    conn: &Connection,
    expense_id: &str,
    expected_cents: Option<i64>,
) -> AppResult<Transaction> {
    let expense = repo::get_transaction(conn, expense_id)?;
    if !is_plain_expense(conn, &expense)? {
        return Err(AppError::Validation("Only expenses can expect a reimbursement.".into()));
    }
    if let Some(n) = expected_cents {
        if n <= 0 || n > expense.amount_cents {
            return Err(AppError::Validation(
                "Expected reimbursement must be more than zero and no more than the expense amount.".into(),
            ));
        }
    }
    repo::set_expected_reimbursement(conn, expense_id, expected_cents, &now())?;
    repo::get_transaction(conn, expense_id)
}
```

In `update_transaction`, add the reimbursement guard directly after the adjustment guard (the `if existing.kind == KIND_ADJUSTMENT || input.kind == KIND_ADJUSTMENT { ... }` block):

```rust
    if existing.kind == KIND_REIMBURSEMENT || input.kind == KIND_REIMBURSEMENT {
        return Err(AppError::Validation("Edit a reimbursement from its own form.".into()));
    }
```

Directly after `ensure_active_account(conn, &input.account_id, "selected")?;` add:

```rust
    // A reimbursed expense stays an expense, and cannot drop below what is already repaid.
    if existing.reimbursed_cents > 0 {
        if input.kind != KIND_EXPENSE {
            return Err(AppError::Conflict(
                "This expense has been reimbursed. Edit or delete the reimbursement first.".into(),
            ));
        }
        if input.amount_cents < existing.reimbursed_cents {
            return Err(AppError::Validation(
                "Amount can't go below what's already been reimbursed.".into(),
            ));
        }
    }
```

Directly after the `let excluded = ...;` line add:

```rust
    // The expectation survives an expense edit (clamped to the new amount) and is
    // cleared when the row stops being an expense, so the table CHECK still holds.
    let expected = match existing.expected_reimbursement_cents {
        Some(n) if input.kind == KIND_EXPENSE => Some(n.min(input.amount_cents)),
        _ => None,
    };
```

Change the `repo::update_transaction_row` call so it passes `expected` instead of the Task 1 placeholder:

```rust
        time.as_deref(),
        excluded,
        expected,
        &now(),
```

In `delete_transaction`, add after the opening guard:

```rust
    if existing.reimbursed_cents > 0 {
        return Err(AppError::Conflict(
            "This expense has been reimbursed. Edit or delete the reimbursement first.".into(),
        ));
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib 2>&1 | tail -15`

Expected: the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: edit reimbursements, track expectations, guard reimbursed expenses"
```

---

### Task 4: True-cost reporting and the awaiting summary

**Files:**
- Create: `src-tauri/src/apportion.rs`
- Modify: `src-tauri/src/lib.rs` (`mod apportion;`, tests)
- Modify: `src-tauri/src/repo.rs`
- Modify: `src-tauri/src/service.rs`
- Test: `src-tauri/src/apportion.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `apportion::apportion(total: i64, weights: &[i64]) -> Vec<i64>`
  - `repo::sum_expense_net_in_range(conn, from, to) -> AppResult<i64>`
  - `repo::spending_breakdown(conn, from, to)` (same signature) now uses effective amounts.
  - `repo::awaiting_reimbursement(conn) -> AppResult<AwaitingReimbursement>`
  - `service::get_awaiting_reimbursement(conn) -> AppResult<AwaitingReimbursement>`
  - `get_dashboard_summary` reports `expense_cents` net of allocations.

- [ ] **Step 1: Write the failing apportion tests**

Create `src-tauri/src/apportion.rs`:

```rust
//! Largest-remainder apportionment. Spreads a reimbursement offset across the
//! lines of a split expense. Mirrored by `apportion` in `src/lib/reimbursements.ts`.

/// Split `total` across `weights` in proportion to each weight, in whole cents.
///
/// Every weight should be positive. `total` is clamped into `0..=sum(weights)`.
/// The result sums to the clamped total and `result[i] <= weights[i]`. Rounding
/// cents go to the largest fractional remainders; ties go to the earliest line.
pub fn apportion(total: i64, weights: &[i64]) -> Vec<i64> {
    let sum: i128 = weights.iter().map(|w| *w as i128).sum();
    if weights.is_empty() || sum <= 0 {
        return vec![0; weights.len()];
    }
    let t = (total as i128).clamp(0, sum);
    let mut shares: Vec<i64> = Vec::with_capacity(weights.len());
    let mut rems: Vec<(usize, i128)> = Vec::with_capacity(weights.len());
    for (i, w) in weights.iter().enumerate() {
        let num = t * (*w as i128);
        shares.push((num / sum) as i64);
        rems.push((i, num % sum));
    }
    let assigned: i64 = shares.iter().sum();
    let mut leftover = t as i64 - assigned;
    rems.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (i, _) in rems {
        if leftover <= 0 {
            break;
        }
        shares[i] += 1;
        leftover -= 1;
    }
    shares
}

#[cfg(test)]
mod tests {
    use super::apportion;

    #[test]
    fn splits_in_proportion() {
        assert_eq!(apportion(5_000, &[6_000, 4_000]), vec![3_000, 2_000]);
        assert_eq!(apportion(50, &[100]), vec![50]);
        assert_eq!(apportion(100, &[1, 99]), vec![1, 99]);
    }

    #[test]
    fn rounding_cents_follow_the_largest_remainder() {
        // Three 1-sen lines, 2-sen offset: no line goes past its own amount.
        assert_eq!(apportion(2, &[1, 1, 1]), vec![1, 1, 0]);
        assert_eq!(apportion(1, &[2, 2]), vec![1, 0]);
        assert_eq!(apportion(7, &[5, 3, 2]), vec![4, 2, 1]);
    }

    #[test]
    fn handles_empty_zero_and_overshoot() {
        assert_eq!(apportion(5, &[]), Vec::<i64>::new());
        assert_eq!(apportion(0, &[3, 4]), vec![0, 0]);
        assert_eq!(apportion(99, &[2, 3]), vec![2, 3]);
        assert_eq!(apportion(-5, &[2, 3]), vec![0, 0]);
    }

    #[test]
    fn always_sums_to_the_total_and_never_exceeds_a_line() {
        for a in 1..=4i64 {
            for b in 1..=4i64 {
                for c in 1..=4i64 {
                    let w = [a, b, c];
                    let sum = a + b + c;
                    for total in 0..=sum {
                        let s = apportion(total, &w);
                        assert_eq!(s.iter().sum::<i64>(), total, "weights {w:?} total {total}");
                        for (share, weight) in s.iter().zip(w.iter()) {
                            assert!(share <= weight, "weights {w:?} total {total} got {s:?}");
                        }
                    }
                }
            }
        }
    }
}
```

In `src-tauri/src/lib.rs`, register the module (keep the list alphabetical):

```rust
mod apportion;
mod commands;
```

- [ ] **Step 2: Run the apportion tests**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib apportion 2>&1 | tail -15`

Expected: 4 tests PASS (the function and its tests are written together; this proves the algorithm before it is wired in). A `dead_code` warning for `apportion` is expected until Step 5.

- [ ] **Step 3: Write the failing reporting tests**

Add inside `mod reimbursement_tests` in `src-tauri/src/lib.rs` (and add `SplitInput` to the `use crate::models::{...}` line):

```rust
    #[test]
    fn dashboard_uses_the_effective_expense_in_its_original_month() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-10");
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(before.expense_cents, 20_000);

        reimburse(&c, &savings.id, 15_000, "2026-07-03", vec![alloc(&e, 15_000)]);

        let june = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(june.expense_cents, 5_000);
        assert_eq!(june.income_cents, before.income_cents);
        assert_eq!(june.net_cashflow_cents, before.income_cents - 5_000);
        assert_eq!(june.spending_breakdown.len(), 1);
        assert_eq!(june.spending_breakdown[0].total_cents, 5_000);

        let july = service::get_dashboard_summary(&c, "2026-07").unwrap();
        assert_eq!(july.expense_cents, 0);
        assert_eq!(july.income_cents, 0);
    }

    #[test]
    fn a_split_expense_is_offset_in_proportion_across_its_lines() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let a = expense_cat(&c, 0);
        let b = expense_cat(&c, 1);
        let e = service::create_expense(
            &c, &savings.id, None, 10_000, None, "2026-06-10", None, false,
            Some(vec![
                SplitInput { category_id: a.clone(), amount_cents: 6_000 },
                SplitInput { category_id: b.clone(), amount_cents: 4_000 },
            ]),
        )
        .unwrap();
        reimburse(&c, &savings.id, 5_000, "2026-06-20", vec![alloc(&e, 5_000)]);

        let s = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(s.expense_cents, 5_000);
        let amount = |id: &str| s.spending_breakdown.iter().find(|x| x.category_id == id).map(|x| x.total_cents);
        assert_eq!(amount(&a), Some(3_000));
        assert_eq!(amount(&b), Some(2_000));
    }

    #[test]
    fn fully_reimbursed_and_excluded_expenses_report_correctly() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let full = spend(&c, &savings.id, 10_000, "2026-06-02");
        reimburse(&c, &savings.id, 10_000, "2026-06-03", vec![alloc(&full, 10_000)]);

        let cat = expense_cat(&c, 0);
        let excluded = service::create_expense(&c, &savings.id, Some(&cat), 7_000, None, "2026-06-04", None, true, None).unwrap();
        reimburse(&c, &savings.id, 7_000, "2026-06-05", vec![alloc(&excluded, 7_000)]);

        let s = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(s.expense_cents, 0, "neither a fully repaid nor an excluded expense may go negative");
        assert!(s.spending_breakdown.is_empty());
    }

    #[test]
    fn a_reimbursement_never_counts_as_income() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-02");
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);
        let after = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(after.income_cents, before.income_cents);
        assert_eq!(after.net_worth_cents, before.net_worth_cents + 4_000);
    }

    #[test]
    fn awaiting_summary_counts_outstanding_expectations_only() {
        let c = open_in_memory().unwrap();
        let (savings, _card) = pair(&c);
        let e1 = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        let _plain = spend(&c, &savings.id, 3_000, "2026-06-03");
        service::set_expected_reimbursement(&c, &e1.id, Some(10_000)).unwrap();
        service::set_expected_reimbursement(&c, &e2.id, Some(5_000)).unwrap();

        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (2, 15_000));

        reimburse(&c, &savings.id, 4_000, "2026-06-10", vec![alloc(&e1, 4_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (2, 11_000));

        reimburse(&c, &savings.id, 6_000, "2026-06-11", vec![alloc(&e1, 6_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (1, 5_000));

        reimburse(&c, &savings.id, 5_000, "2026-06-12", vec![alloc(&e2, 5_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (0, 0));
    }
```

- [ ] **Step 4: Run to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib reimbursement_tests 2>&1 | tail -20`

Expected: compile error (`get_awaiting_reimbursement` not found), then once added, the dashboard tests fail on the old totals.

- [ ] **Step 5: Implement the repository queries**

In `src-tauri/src/repo.rs`, add this import near the top (after the existing `use` lines):

```rust
use std::collections::HashMap;
```

Add after `sum_kind_in_range`:

```rust
/// Net expense total in a half-open range: each non-excluded expense counts at
/// its amount minus what has been reimbursed, in the expense's own month.
pub fn sum_expense_net_in_range(conn: &Connection, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(t.amount_cents - COALESCE(
                  (SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0)), 0)
         FROM transactions t
         WHERE t.kind = 'expense' AND t.excluded_from_reporting = 0
           AND t.transaction_date >= ?1 AND t.transaction_date < ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}

/// Expenses whose expectation is not yet received: count and outstanding total.
pub fn awaiting_reimbursement(conn: &Connection) -> AppResult<AwaitingReimbursement> {
    let (count, total_cents) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(outstanding), 0) FROM (
           SELECT MAX(t.expected_reimbursement_cents - COALESCE(
                    (SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0), 0) AS outstanding
           FROM transactions t
           WHERE t.kind = 'expense' AND t.expected_reimbursement_cents IS NOT NULL
         ) WHERE outstanding > 0",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    Ok(AwaitingReimbursement { count, total_cents })
}
```

Replace the whole `spending_breakdown` function with:

```rust
pub fn spending_breakdown(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CategoryBreakdown>> {
    // One row per attributed line (a plain expense is one line; a split expense is
    // one line per split), carrying the expense's total allocated amount.
    let mut stmt = conn.prepare(
        "SELECT expense_id, cat, amt, alloc FROM (
           SELECT t.id AS expense_id, t.category_id AS cat, t.amount_cents AS amt, 0 AS ord,
                  COALESCE((SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0) AS alloc
           FROM transactions t
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
           UNION ALL
           SELECT t.id, s.category_id, s.amount_cents, s.sort_order,
                  COALESCE((SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0)
           FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
         ) ORDER BY expense_id, ord",
    )?;
    let lines: Vec<(String, String, i64, i64)> = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    // Offset each expense's lines by its allocations, then total per category.
    let mut by_category: HashMap<String, i64> = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j < lines.len() && lines[j].0 == lines[i].0 {
            j += 1;
        }
        let amounts: Vec<i64> = lines[i..j].iter().map(|l| l.2).collect();
        let shares = crate::apportion::apportion(lines[i].3, &amounts);
        for (k, line) in lines[i..j].iter().enumerate() {
            *by_category.entry(line.1.clone()).or_insert(0) += line.2 - shares[k];
        }
        i = j;
    }

    // Roll subcategories into their parent, then attach display fields.
    let mut by_group: HashMap<String, i64> = HashMap::new();
    for (cat_id, net) in by_category {
        let cat = get_category(conn, &cat_id)?;
        *by_group.entry(cat.parent_id.unwrap_or(cat.id)).or_insert(0) += net;
    }
    let mut out = Vec::new();
    for (group_id, total_cents) in by_group {
        if total_cents <= 0 {
            continue;
        }
        let g = get_category(conn, &group_id)?;
        out.push(CategoryBreakdown {
            category_id: group_id,
            category_name: g.name,
            emoji: g.emoji,
            color: g.color,
            total_cents,
        });
    }
    out.sort_by(|a, b| {
        b.total_cents
            .cmp(&a.total_cents)
            .then_with(|| a.category_name.cmp(&b.category_name))
    });
    Ok(out)
}
```

- [ ] **Step 6: Implement the service wiring**

In `src-tauri/src/service.rs`, in `get_dashboard_summary` replace

```rust
    let expense = repo::sum_kind_in_range(conn, KIND_EXPENSE, &from, &to)?;
```

with

```rust
    let expense = repo::sum_expense_net_in_range(conn, &from, &to)?;
```

Update the doc comment on `get_dashboard_summary` to: `/// Build the dashboard summary for a \`YYYY-MM\` month. Income/expense/cashflow and the spending breakdown exclude transfers, payments, reimbursements, and adjustments; expenses count net of their reimbursements.`

Add after `set_expected_reimbursement`:

```rust
pub fn get_awaiting_reimbursement(conn: &Connection) -> AppResult<AwaitingReimbursement> {
    repo::awaiting_reimbursement(conn)
}
```

- [ ] **Step 7: Run the whole suite**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib 2>&1 | tail -15`

Expected: PASS. If the pre-existing `spending_breakdown_rolls_subcategories_into_parent` or the test near `repo::spending_breakdown(&conn, "2026-06-01", "2026-07-01")` fails on row order, the tie-break (total desc, then name) is the only intended difference; update that expectation to the name-ordered result.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/apportion.rs src-tauri/src/lib.rs src-tauri/src/repo.rs src-tauri/src/service.rs
git commit -m "feat: report reimbursed expenses at true cost and track what is awaited"
```

---

### Task 5: Register the commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 2–4 service functions.
- Produces Tauri commands (Tauri maps camelCase JS args to these snake_case params):
  - `create_reimbursement_transaction(account_id, amount_cents, description, date, time, allocations)` → `Transaction`
  - `update_reimbursement_transaction(id, account_id, amount_cents, description, date, time, allocations)` → `Transaction`
  - `set_expected_reimbursement(expense_id, expected_cents)` → `Transaction`
  - `get_awaiting_reimbursement()` → `AwaitingReimbursement`

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, add after `create_payment_transaction`:

```rust
#[tauri::command]
pub fn create_reimbursement_transaction(
    state: State<'_, DbState>,
    account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_reimbursement(
        &c, &account_id, amount_cents, description.as_deref(), &date, time.as_deref(), allocations
    ))
}

#[tauri::command]
pub fn update_reimbursement_transaction(
    state: State<'_, DbState>,
    id: String,
    account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::update_reimbursement(
        &c, &id, &account_id, amount_cents, description.as_deref(), &date, time.as_deref(), allocations
    ))
}

#[tauri::command]
pub fn set_expected_reimbursement(
    state: State<'_, DbState>,
    expense_id: String,
    expected_cents: Option<i64>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::set_expected_reimbursement(&c, &expense_id, expected_cents))
}
```

And at the end of the Dashboard section (after `get_account_balances`):

```rust
#[tauri::command]
pub fn get_awaiting_reimbursement(state: State<'_, DbState>) -> AppResult<AwaitingReimbursement> {
    with_conn!(state, c => service::get_awaiting_reimbursement(&c))
}
```

In `src-tauri/src/lib.rs`, register them in `generate_handler!`:

```rust
            commands::create_payment_transaction,
            commands::create_reimbursement_transaction,
            commands::update_reimbursement_transaction,
            commands::set_expected_reimbursement,
            commands::list_transactions,
```

and

```rust
            commands::get_account_balances,
            commands::get_awaiting_reimbursement,
            commands::get_setting,
```

- [ ] **Step 2: Build and run the suite**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build --locked 2>&1 | tail -10 && cargo test --lib --locked 2>&1 | tail -6`

Expected: `Finished` for the build with no warnings about unused code, then all tests pass. The seed-catalog freshness test passes without regenerating (no seed change).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: expose reimbursement commands"
```

---

### Task 6: Frontend kind, signs, and fixtures

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/kinds.ts`
- Modify: `src/components/Icon.tsx`
- Modify: `src/lib/txnSelection.ts`
- Modify: `src/components/TxnSelectionPanel.tsx`
- Modify (fixtures): `src/__tests__/kinds.test.ts`, `src/__tests__/txnSelection.test.ts`, `src/__tests__/accountStats.test.ts`, `src/__tests__/txnTime.test.ts`
- Test: `src/__tests__/kinds.test.ts`, `src/__tests__/postings.test.ts`, `src/__tests__/txnSelection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TransactionKind` includes `"reimbursement"`.
  - `TxnAllocation { expenseId: string; amountCents: number }`, `AwaitingReimbursement { count: number; totalCents: number }`.
  - `Transaction` gains `expectedReimbursementCents: number | null`, `reimbursedCents: number`, `allocations: TxnAllocation[]`.
  - `KIND_META.reimbursement` is `{ label: "Reimbursement", icon: "reimburse", colorKey: "transfer", sign: 0 }`.
  - `signedFor("reimbursement", amount)` is `+amount`. `postingsFor("reimbursement", amount, accountId, null)` is `[+amount on accountId, -amount on bucket "expense"]`.
  - `summarizeSelection(...).otherCounts.reimbursement`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/kinds.test.ts`, append inside the `signedFor` describe (before its closing `});`):

```ts
  it("signs a reimbursement as money in", () => {
    expect(signedFor("reimbursement", 10000)).toBe(10000);
    expect(signedFor("reimbursement", 10000, true)).toBe(10000);
  });

  it("labels a reimbursement and reuses the transfer color token", () => {
    expect(KIND_META.reimbursement.label).toBe("Reimbursement");
    expect(KIND_META.reimbursement.icon).toBe("reimburse");
    expect(KIND_META.reimbursement.colorKey).toBe("transfer");
  });
```

In `src/__tests__/postings.test.ts`, add to the `cases` array:

```ts
    { kind: "reimbursement" as const, amt: 1000, acc: "a", to: null },
```

and at the end of the "real-account leg" test add:

```ts
    const reimb = postingsFor("reimbursement", 1000, "a", null);
    expect(reimb.filter((l) => l.accountId === "a").reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
    expect(reimb.find((l) => l.bucket === "expense")?.amountCents).toBe(-1000);
```

In `src/__tests__/txnSelection.test.ts`, change the `otherCounts` expectation to:

```ts
    expect(s.otherCounts).toEqual({ transfer: 1, adjustment: 1, opening: 1, payment: 0, reimbursement: 0 });
```

and append a new test at the end of the `planBulk` describe:

```ts
  it("reimbursement: counted separately, deletable, locked from every other bulk action", () => {
    const reimb = tx("reimbursement", 500, { id: "rmb" });
    expect(summarizeSelection([reimb]).otherCounts.reimbursement).toBe(1);
    expect(planBulk("delete", [reimb]).changeable.map((t) => t.id)).toEqual(["rmb"]);
    for (const action of ["recategorize", "move", "exclude", "include"] as const) {
      const p = planBulk(action, [reimb]);
      expect(p.changeable).toEqual([]);
      expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["rmb"]);
    }
    expect(planBulk("recategorize", [reimb]).lockedSkipped[0].reason).toMatch(/categor/i);
  });
```

Update the four typed `Transaction` fixtures so they keep compiling once the type grows. In each, add `expectedReimbursementCents: null, reimbursedCents: 0, allocations: [],` next to `splits: [],`:

- `src/__tests__/kinds.test.ts`: the `mkTx` object (`splits: [],` followed by `createdAt: "2026-01-01T00:00:00Z"`) and the `mk` object (`excludedFromReporting: false, splits: [], createdAt: "1", updatedAt: "1", ...over,`).
- `src/__tests__/txnSelection.test.ts`: the `tx()` object (`splits: [],` followed by `createdAt: "2026-06-01T00:00:00Z"`).
- `src/__tests__/accountStats.test.ts`: `description: null, transactionDate: date, transactionTime: null, excludedFromReporting: false, splits: [],`.
- `src/__tests__/txnTime.test.ts`: `updatedAt: "2026-05-10T00:00:00Z", excludedFromReporting: false, splits: [], ...p,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/kinds.test.ts src/__tests__/postings.test.ts src/__tests__/txnSelection.test.ts`

Expected: FAIL. `KIND_META.reimbursement` is undefined, `postingsFor` has no reimbursement case, and `otherCounts.reimbursement` is missing.

- [ ] **Step 3: Implement**

In `src/types.ts`:

```ts
export type TransactionKind = "income" | "expense" | "transfer" | "adjustment" | "opening" | "payment" | "reimbursement";
```

Add after `TxnSplit`:

```ts
export interface TxnAllocation {
  expenseId: string;
  amountCents: number;
}

export interface AwaitingReimbursement {
  count: number;
  totalCents: number;
}
```

Add to `Transaction` after `splits: TxnSplit[];`:

```ts
  /** Expenses only: the amount expected back, or null. */
  expectedReimbursementCents: number | null;
  /** Expenses only: sum of this expense's allocations. */
  reimbursedCents: number;
  /** Reimbursements only: the expenses this row repays. */
  allocations: TxnAllocation[];
```

In `src/components/Icon.tsx`, add `"reimburse"` to the `IconName` union (after `"copy"`: `| "alertCircle" | "info" | "flag" | "copy" | "reimburse";`) and this entry after `copy`:

```tsx
    reimburse: <>{<path {...P} d="M9 7 4 12l5 5" />}<path {...P} d="M4 12h10a6 6 0 0 1 6 6" /></>,
```

In `src/lib/kinds.ts`, add after the `payment` meta:

```ts
  reimbursement: { label: "Reimbursement", icon: "reimburse", colorKey: "transfer", sign: 0 },
```

In `signedFor`, add before the transfer comment:

```ts
  if (kind === "reimbursement") return amountCents; // money back in
```

In `postingsFor`, add a case before `"adjustment"`:

```ts
    case "reimbursement":
      return [real(amountCents), { accountId: null, bucket: "expense", amountCents: -amountCents }];
```

In `src/lib/txnSelection.ts`, change the interface line and the initial object:

```ts
  otherCounts: { transfer: number; payment: number; adjustment: number; opening: number; reimbursement: number };
```

```ts
  const otherCounts = { transfer: 0, payment: 0, adjustment: 0, opening: 0, reimbursement: 0 };
```

and add to `editLockReason`, after the payment block:

```ts
  if (t.kind === "reimbursement") {
    return action === "recategorize" ? "Reimbursements have no category" : "Reimbursements are edited from their own form";
  }
```

In `src/components/TxnSelectionPanel.tsx`, add to the `others` array after the payment line:

```ts
    s.otherCounts.reimbursement && `${s.otherCounts.reimbursement} reimbursement`,
```

- [ ] **Step 4: Run the tests, then the typecheck**

Run: `npx vitest run src/__tests__/kinds.test.ts src/__tests__/postings.test.ts src/__tests__/txnSelection.test.ts && npx tsc --noEmit 2>&1 | head -30`

Expected: the three test files PASS. `tsc` will list errors only in `src/client/mock.ts` (Transaction literals missing the new fields); Task 8 fixes those. Any error in another file means a fixture was missed; fix it now.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/kinds.ts src/components/Icon.tsx src/lib/txnSelection.ts src/components/TxnSelectionPanel.tsx src/__tests__
git commit -m "feat: present the reimbursement kind and its posting rule"
```

---

### Task 7: Allocation helpers

**Files:**
- Create: `src/lib/reimbursements.ts`
- Create: `src/lib/__tests__/reimbursements.test.ts`
- Modify: `src/lib/accounts.ts`
- Test: `src/lib/__tests__/reimbursements.test.ts`, `src/__tests__/accounts.test.ts`

**Interfaces:**
- Consumes: Task 6 types.
- Produces (all in `src/lib/reimbursements.ts`):
  - `apportion(total: number, weights: number[]): number[]`
  - `effectiveCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">): number`
  - `outstandingCents(t: Pick<Transaction, "expectedReimbursementCents" | "reimbursedCents">): number`
  - `remainingCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">, ownAllocatedCents?: number): number`
  - `defaultAllocationCents(t: Transaction, ownAllocatedCents?: number): number`
  - `reimbursementBadge(t: Transaction): { state: "pending" | "reimbursed"; cents: number } | null`
  - `candidateExpenses(txns: Transaction[], categories: Category[], ownAllocations: TxnAllocation[]): Transaction[]`
  - in `src/lib/accounts.ts`: `lentLabel(subtype: string, balanceCents: number): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/reimbursements.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Category, Transaction } from "../../types";
import {
  apportion,
  candidateExpenses,
  defaultAllocationCents,
  effectiveCents,
  outstandingCents,
  reimbursementBadge,
  remainingCents,
} from "../reimbursements";

const exp = (over: Partial<Transaction> = {}): Transaction => ({
  id: "e", kind: "expense", accountId: "a", toAccountId: null, categoryId: "c1",
  amountCents: 10_000, description: null, transactionDate: "2026-06-01", transactionTime: null,
  excludedFromReporting: false, splits: [], expectedReimbursementCents: null, reimbursedCents: 0,
  allocations: [], createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", ...over,
});

const cat = (over: Partial<Category>): Category => ({
  id: "c1", name: "Food", kind: "expense", emoji: "🍜", color: null, parentId: null, sortOrder: 0,
  isArchived: false, isSystem: false, createdAt: "", updatedAt: "", ...over,
});

describe("apportion", () => {
  it("splits in proportion", () => {
    expect(apportion(5_000, [6_000, 4_000])).toEqual([3_000, 2_000]);
    expect(apportion(50, [100])).toEqual([50]);
    expect(apportion(100, [1, 99])).toEqual([1, 99]);
  });

  it("gives rounding cents to the largest remainders, ties to the earliest line", () => {
    expect(apportion(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(apportion(1, [2, 2])).toEqual([1, 0]);
    expect(apportion(7, [5, 3, 2])).toEqual([4, 2, 1]);
  });

  it("handles empty, zero, and overshoot", () => {
    expect(apportion(5, [])).toEqual([]);
    expect(apportion(0, [3, 4])).toEqual([0, 0]);
    expect(apportion(99, [2, 3])).toEqual([2, 3]);
    expect(apportion(-5, [2, 3])).toEqual([0, 0]);
  });

  it("always sums to the total and never exceeds a line", () => {
    for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) for (let c = 1; c <= 4; c++) {
      const w = [a, b, c];
      const sum = a + b + c;
      for (let total = 0; total <= sum; total++) {
        const s = apportion(total, w);
        expect(s.reduce((x, y) => x + y, 0)).toBe(total);
        s.forEach((share, i) => expect(share).toBeLessThanOrEqual(w[i]));
      }
    }
  });
});

describe("amounts", () => {
  it("effective is what is left after reimbursements", () => {
    expect(effectiveCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
  });

  it("outstanding is the expectation not yet received, never negative", () => {
    expect(outstandingCents(exp())).toBe(0);
    expect(outstandingCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 2_000 }))).toBe(5_000);
    expect(outstandingCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 9_000 }))).toBe(0);
  });

  it("remaining is what can still be allocated, adding back an editing reimbursement's own share", () => {
    expect(remainingCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
    expect(remainingCents(exp({ reimbursedCents: 10_000 }))).toBe(0);
    expect(remainingCents(exp({ reimbursedCents: 10_000 }), 10_000)).toBe(10_000);
  });
});

describe("defaultAllocationCents", () => {
  it("uses what is still expected, capped at what is left", () => {
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 7_000 }))).toBe(7_000);
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 3_000 }))).toBe(4_000);
  });

  it("falls back to everything left when nothing is expected or the claim is settled", () => {
    expect(defaultAllocationCents(exp())).toBe(10_000);
    expect(defaultAllocationCents(exp({ reimbursedCents: 4_000 }))).toBe(6_000);
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 3_000, reimbursedCents: 5_000 }))).toBe(5_000);
  });

  it("counts an editing reimbursement's own share as still available", () => {
    expect(defaultAllocationCents(exp({ expectedReimbursementCents: 10_000, reimbursedCents: 10_000 }), 10_000)).toBe(10_000);
  });
});

describe("reimbursementBadge", () => {
  it("is pending while something is expected", () => {
    expect(reimbursementBadge(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 2_000 }))).toEqual({ state: "pending", cents: 5_000 });
  });

  it("is reimbursed once repaid", () => {
    expect(reimbursementBadge(exp({ expectedReimbursementCents: 7_000, reimbursedCents: 7_000 }))).toEqual({ state: "reimbursed", cents: 7_000 });
    expect(reimbursementBadge(exp({ reimbursedCents: 500 }))).toEqual({ state: "reimbursed", cents: 500 });
  });

  it("is absent for an ordinary expense", () => {
    expect(reimbursementBadge(exp())).toBeNull();
  });
});

describe("candidateExpenses", () => {
  const sys = cat({ id: "sys", name: "Adjustment", isSystem: true });
  const cats = [cat({}), sys];

  it("keeps plain expenses with something left, expected ones first then newest first", () => {
    const list = [
      exp({ id: "old", transactionDate: "2026-05-01" }),
      exp({ id: "new", transactionDate: "2026-06-20" }),
      exp({ id: "exp", transactionDate: "2026-04-01", expectedReimbursementCents: 3_000 }),
      exp({ id: "done", reimbursedCents: 10_000 }),
      exp({ id: "fix", categoryId: "sys" }),
      exp({ id: "inc", kind: "income" }),
    ];
    expect(candidateExpenses(list, cats, []).map((t) => t.id)).toEqual(["exp", "new", "old"]);
  });

  it("keeps an expense an editing reimbursement already fully repays", () => {
    const list = [exp({ id: "done", reimbursedCents: 10_000 })];
    expect(candidateExpenses(list, cats, [{ expenseId: "done", amountCents: 10_000 }]).map((t) => t.id)).toEqual(["done"]);
  });
});
```

In `src/__tests__/accounts.test.ts`, add to the import `import { balanceDisplay, lentLabel, sidebarPortfolioSummary, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";` and append:

```ts
describe("lentLabel", () => {
  it("reads 'Owes you' for a lent account that is owed money", () => {
    expect(lentLabel("lent", 50_000)).toBe("Owes you");
  });
  it("is absent for a settled lent account and for every other subtype", () => {
    expect(lentLabel("lent", 0)).toBeNull();
    expect(lentLabel("savings", 50_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/reimbursements.test.ts src/__tests__/accounts.test.ts`

Expected: FAIL (module `../reimbursements` not found; `lentLabel` not exported).

- [ ] **Step 3: Implement**

Create `src/lib/reimbursements.ts`:

```ts
// Allocation math and display helpers for reimbursements. Pure, no React.
// `apportion` mirrors src-tauri/src/apportion.rs.

import type { Category, Transaction, TxnAllocation } from "../types";
import { txnSortKey } from "./kinds";

/**
 * Split `total` across `weights` in proportion, in whole cents (largest-remainder
 * method; ties go to the earliest line). `total` is clamped into 0..sum(weights),
 * the result sums to it, and no share exceeds its weight.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sum <= 0) return weights.map(() => 0);
  const t = Math.min(Math.max(total, 0), sum);
  const shares: number[] = [];
  const rems: { i: number; rem: number }[] = [];
  weights.forEach((w, i) => {
    const num = t * w;
    const rem = num % sum;
    shares.push((num - rem) / sum); // exact integer division
    rems.push({ i, rem });
  });
  let leftover = t - shares.reduce((s, x) => s + x, 0);
  rems.sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of rems) {
    if (leftover <= 0) break;
    shares[i] += 1;
    leftover -= 1;
  }
  return shares;
}

/** What an expense really cost: its amount minus what has been reimbursed. */
export function effectiveCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">): number {
  return t.amountCents - t.reimbursedCents;
}

/** The expectation not yet received. Never negative. */
export function outstandingCents(t: Pick<Transaction, "expectedReimbursementCents" | "reimbursedCents">): number {
  return Math.max((t.expectedReimbursementCents ?? 0) - t.reimbursedCents, 0);
}

/**
 * What can still be allocated to an expense. When editing a reimbursement, pass
 * that reimbursement's own share so it counts as available again.
 */
export function remainingCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">, ownAllocatedCents = 0): number {
  return t.amountCents - t.reimbursedCents + ownAllocatedCents;
}

/** Default allocation when an expense is picked: what is still expected, capped at what is left. */
export function defaultAllocationCents(t: Transaction, ownAllocatedCents = 0): number {
  const rem = remainingCents(t, ownAllocatedCents);
  if (t.expectedReimbursementCents == null) return rem;
  const out = Math.max(t.expectedReimbursementCents - (t.reimbursedCents - ownAllocatedCents), 0);
  return out > 0 ? Math.min(out, rem) : rem;
}

export interface ReimbursementBadge {
  state: "pending" | "reimbursed";
  cents: number;
}

/** Row badge for an expense: still awaited, repaid, or nothing to show. */
export function reimbursementBadge(t: Transaction): ReimbursementBadge | null {
  const out = outstandingCents(t);
  if (out > 0) return { state: "pending", cents: out };
  if (t.reimbursedCents > 0) return { state: "reimbursed", cents: t.reimbursedCents };
  return null;
}

/**
 * Expenses a reimbursement can be allocated to: plain expenses (not balance
 * corrections) with something left. Ones with an outstanding expectation come
 * first, then newest first.
 */
export function candidateExpenses(
  txns: Transaction[],
  categories: Category[],
  ownAllocations: TxnAllocation[],
): Transaction[] {
  const system = new Set(categories.filter((c) => c.isSystem).map((c) => c.id));
  const own = new Map(ownAllocations.map((a) => [a.expenseId, a.amountCents]));
  return txns
    .filter((t) => t.kind === "expense" && !(t.categoryId && system.has(t.categoryId)) && remainingCents(t, own.get(t.id) ?? 0) > 0)
    .sort((a, b) => {
      const ra = outstandingCents(a) > 0 ? 0 : 1;
      const rb = outstandingCents(b) > 0 ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ka = txnSortKey(a);
      const kb = txnSortKey(b);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
}
```

In `src/lib/accounts.ts`, add after `toneColor`:

```ts
/** Label for an account that holds money someone owes you (the `lent` subtype). */
export function lentLabel(subtype: string, balanceCents: number): string | null {
  return subtype === "lent" && balanceCents > 0 ? "Owes you" : null;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/__tests__/reimbursements.test.ts src/__tests__/accounts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reimbursements.ts src/lib/__tests__/reimbursements.test.ts src/lib/accounts.ts src/__tests__/accounts.test.ts
git commit -m "feat: add reimbursement allocation helpers"
```

---

### Task 8: Client and mock backend

**Files:**
- Modify: `src/client/index.ts`
- Modify: `src/client/mock.ts`
- Create: `src/__tests__/mock-reimbursements.test.ts`
- Test: `src/__tests__/mock-reimbursements.test.ts`

**Interfaces:**
- Consumes: Task 6 types, Task 7 `apportion`.
- Produces:
  - `client.createReimbursement(accountId: string, amountCents: number, allocations: TxnAllocation[], description: string | null, date: string, time: string | null = null): Promise<Transaction>`
  - `client.updateReimbursement(id: string, accountId: string, amountCents: number, allocations: TxnAllocation[], description: string | null, date: string, time: string | null = null): Promise<Transaction>`
  - `client.setExpectedReimbursement(expenseId: string, expectedCents: number | null): Promise<Transaction>`
  - `client.getAwaitingReimbursement(): Promise<AwaitingReimbursement>`
  - Mock commands `create_reimbursement_transaction`, `update_reimbursement_transaction`, `set_expected_reimbursement`, `get_awaiting_reimbursement`, plus the same guards, reporting, and delete/reset behavior as Rust.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/mock-reimbursements.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, AwaitingReimbursement, Category, DashboardSummary, Transaction } from "../types";

async function account(name: string, subtype: string, opening: number, limit: number | null = null) {
  return mockInvoke<Account>("create_account", {
    name, subtype, openingBalanceCents: opening, templateKey: null, creditLimitCents: limit,
  });
}

async function expenseCats() {
  const cats = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: false });
  return cats.filter((c) => !c.isSystem && c.parentId == null);
}

async function spend(accountId: string, cents: number, date: string, excluded = false) {
  const [cat] = await expenseCats();
  return mockInvoke<Transaction>("create_expense_transaction", {
    accountId, categoryId: cat.id, amountCents: cents, description: "Dinner", date, time: null,
    excludedFromReporting: excluded, splits: null,
  });
}

const alloc = (e: Transaction, cents: number) => ({ expenseId: e.id, amountCents: cents });

async function reimburse(accountId: string, cents: number, date: string, allocations: { expenseId: string; amountCents: number }[]) {
  return mockInvoke<Transaction>("create_reimbursement_transaction", {
    accountId, amountCents: cents, description: "Back", date, time: null, allocations,
  });
}

const balanceOf = async (id: string) =>
  (await mockInvoke<Account[]>("list_accounts", {})).find((a) => a.id === id)!.balanceCents;

const txnOf = async (id: string) =>
  (await mockInvoke<Transaction[]>("list_transactions", { filters: { limit: 1000 } })).find((t) => t.id === id)!;

const month = (m: string) => mockInvoke<DashboardSummary>("get_dashboard_summary", { month: m });

const expenseUpdate = (e: Transaction, amount: number, over: Record<string, unknown> = {}) => ({
  id: e.id, kind: "expense", accountId: e.accountId, toAccountId: null, categoryId: e.categoryId,
  amountCents: amount, description: e.description, transactionDate: e.transactionDate, transactionTime: null,
  excludedFromReporting: false, splits: null, ...over,
});

describe("mock reimbursements", () => {
  it("raises the balance, hydrates both sides, and reports true cost in the original month", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 20_000, "2027-03-10");
    expect(await balanceOf(savings.id)).toBe(480_000);
    const before = await month("2027-03");

    const r = await reimburse(savings.id, 15_000, "2027-04-03", [alloc(e, 15_000)]);

    expect(r.kind).toBe("reimbursement");
    expect(r.categoryId).toBeNull();
    expect(r.allocations).toEqual([alloc(e, 15_000)]);
    expect(await balanceOf(savings.id)).toBe(495_000);
    expect((await txnOf(e.id)).reimbursedCents).toBe(15_000);

    const march = await month("2027-03");
    expect(march.expenseCents).toBe(5_000);
    expect(march.incomeCents).toBe(before.incomeCents);
    expect(march.netCashflowCents).toBe(before.incomeCents - 5_000);
    expect(march.spendingBreakdown.reduce((s, b) => s + b.totalCents, 0)).toBe(5_000);
    const april = await month("2027-04");
    expect(april.expenseCents).toBe(0);
    expect(april.incomeCents).toBe(0);
  });

  it("lets a refund land on the card that was charged", async () => {
    const card = await account("Visa", "credit-card", -80_000, 1_000_000);
    const e = await spend(card.id, 8_000, "2027-03-01");
    expect(await balanceOf(card.id)).toBe(-88_000);
    await reimburse(card.id, 8_000, "2027-03-03", [alloc(e, 8_000)]);
    expect(await balanceOf(card.id)).toBe(-80_000);
  });

  it("covers many expenses with one reimbursement and takes one expense in parts", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e1 = await spend(savings.id, 10_000, "2027-03-01");
    const e2 = await spend(savings.id, 5_000, "2027-03-02");
    await reimburse(savings.id, 15_000, "2027-03-10", [alloc(e1, 10_000), alloc(e2, 5_000)]);
    expect((await txnOf(e1.id)).reimbursedCents).toBe(10_000);
    expect((await txnOf(e2.id)).reimbursedCents).toBe(5_000);

    const e3 = await spend(savings.id, 10_000, "2027-03-03");
    await reimburse(savings.id, 3_000, "2027-03-11", [alloc(e3, 3_000)]);
    await reimburse(savings.id, 2_000, "2027-03-12", [alloc(e3, 2_000)]);
    expect((await txnOf(e3.id)).reimbursedCents).toBe(5_000);
    await expect(reimburse(savings.id, 6_000, "2027-03-13", [alloc(e3, 6_000)]))
      .rejects.toMatchObject({ code: "ValidationError", message: "Allocation exceeds what's left on that expense." });
  });

  it("rejects each bad shape with the Rust messages", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e = await spend(savings.id, 10_000, "2027-03-01");
    const e2 = await spend(savings.id, 4_000, "2027-03-02");
    const [incCat] = (await mockInvoke<Category[]>("list_categories", { kind: "income", includeArchived: false })).filter((c) => !c.isSystem);
    const income = await mockInvoke<Transaction>("create_income_transaction", {
      accountId: savings.id, categoryId: incCat.id, amountCents: 1_000, description: null, date: "2027-03-01",
      time: null, excludedFromReporting: false, splits: null,
    });
    const msg = (amount: number, allocations: { expenseId: string; amountCents: number }[]) =>
      reimburse(savings.id, amount, "2027-03-02", allocations).catch((x) => x.message);

    expect(await msg(0, [alloc(e, 1)])).toBe("Amount must be greater than zero");
    expect(await msg(100, [])).toBe("Pick at least one expense to reimburse.");
    expect(await msg(100, [alloc(e, 0)])).toBe("Each allocation must be greater than zero.");
    expect(await msg(200, [alloc(e, 100), alloc(e, 100)])).toBe("An expense can only be listed once.");
    expect(await msg(100, [alloc(income, 100)])).toBe("Only expenses can be reimbursed.");
    expect(await msg(100, [{ expenseId: "nope", amountCents: 100 }])).toBe("Only expenses can be reimbursed.");
    expect(await msg(100, [alloc(e, 60), alloc(e2, 30)])).toBe("Allocations must add up to the reimbursement amount.");
    expect(await msg(20_000, [alloc(e, 20_000)])).toBe("Allocation exceeds what's left on that expense.");
  });

  it("rejects balance corrections and archived accounts", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e = await spend(savings.id, 10_000, "2027-03-01");
    await mockInvoke("set_account_balance", { accountId: savings.id, realBalanceCents: 50_000, recordAsIncomeExpense: true });
    const cats = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: true });
    const sysId = cats.find((c) => c.isSystem)!.id;
    const all = await mockInvoke<Transaction[]>("list_transactions", { filters: { limit: 1000 } });
    const correction = all.find((t) => t.kind === "expense" && t.categoryId === sysId && t.accountId === savings.id)!;
    await expect(reimburse(savings.id, 100, "2027-03-02", [alloc(correction, 100)]))
      .rejects.toMatchObject({ message: "Only expenses can be reimbursed." });

    await mockInvoke("archive_account", { id: savings.id });
    await expect(reimburse(savings.id, 100, "2027-03-02", [alloc(e, 100)]))
      .rejects.toMatchObject({ code: "Conflict", message: "The selected account is archived" });
  });

  it("splits the offset across a split expense by largest remainder", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const [a, b] = await expenseCats();
    const e = await mockInvoke<Transaction>("create_expense_transaction", {
      accountId: savings.id, categoryId: null, amountCents: 10_000, description: null, date: "2027-05-10", time: null,
      excludedFromReporting: false,
      splits: [{ categoryId: a.id, amountCents: 6_000 }, { categoryId: b.id, amountCents: 4_000 }],
    });
    await reimburse(savings.id, 5_000, "2027-05-20", [alloc(e, 5_000)]);
    const s = await month("2027-05");
    expect(s.expenseCents).toBe(5_000);
    expect(s.spendingBreakdown.find((x) => x.categoryId === a.id)?.totalCents).toBe(3_000);
    expect(s.spendingBreakdown.find((x) => x.categoryId === b.id)?.totalCents).toBe(2_000);
  });

  it("never goes negative for fully repaid or excluded expenses", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const full = await spend(savings.id, 10_000, "2027-06-02");
    await reimburse(savings.id, 10_000, "2027-06-03", [alloc(full, 10_000)]);
    const excluded = await spend(savings.id, 7_000, "2027-06-04", true);
    await reimburse(savings.id, 7_000, "2027-06-05", [alloc(excluded, 7_000)]);
    const s = await month("2027-06");
    expect(s.expenseCents).toBe(0);
    expect(s.spendingBreakdown).toEqual([]);
  });

  it("tracks expectations and what is awaited", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const base = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    const e = await spend(savings.id, 10_000, "2027-07-01");
    const range = "Expected reimbursement must be more than zero and no more than the expense amount.";
    await expect(mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_001 })).rejects.toMatchObject({ message: range });
    await expect(mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 0 })).rejects.toMatchObject({ message: range });

    const set = await mockInvoke<Transaction>("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_000 });
    expect(set.expectedReimbursementCents).toBe(10_000);
    let s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([1, 10_000]);

    await reimburse(savings.id, 4_000, "2027-07-05", [alloc(e, 4_000)]);
    s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([1, 6_000]);

    await reimburse(savings.id, 6_000, "2027-07-06", [alloc(e, 6_000)]);
    s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([0, 0]);

    const cleared = await mockInvoke<Transaction>("set_expected_reimbursement", { expenseId: e.id, expectedCents: null });
    expect(cleared.expectedReimbursementCents).toBeNull();
  });

  it("rewrites a reimbursement and refuses to edit one through update_transaction", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const cash = await account("Wallet", "cash", 0);
    const e1 = await spend(savings.id, 20_000, "2027-08-01");
    const e2 = await spend(savings.id, 5_000, "2027-08-02");
    const r = await reimburse(savings.id, 10_000, "2027-08-05", [alloc(e1, 10_000)]);

    const u = await mockInvoke<Transaction>("update_reimbursement_transaction", {
      id: r.id, accountId: cash.id, amountCents: 6_000, description: "Fixed", date: "2027-08-09", time: null,
      allocations: [alloc(e1, 1_000), alloc(e2, 5_000)],
    });
    expect(u.amountCents).toBe(6_000);
    expect(u.accountId).toBe(cash.id);
    expect(u.allocations).toEqual([alloc(e1, 1_000), alloc(e2, 5_000)]);
    expect((await txnOf(e1.id)).reimbursedCents).toBe(1_000);
    expect(await balanceOf(cash.id)).toBe(6_000);
    expect(await balanceOf(savings.id)).toBe(475_000);

    await expect(mockInvoke("update_reimbursement_transaction", {
      id: r.id, accountId: cash.id, amountCents: 12_000, description: null, date: "2027-08-09", time: null,
      allocations: [alloc(e1, 12_000)],
    })).rejects.toMatchObject({ message: "Allocation exceeds what's left on that expense." });
    expect((await txnOf(r.id)).allocations).toEqual([alloc(e1, 1_000), alloc(e2, 5_000)]);

    await expect(mockInvoke("update_reimbursement_transaction", {
      id: e1.id, accountId: savings.id, amountCents: 100, description: null, date: "2027-08-09", time: null,
      allocations: [alloc(e1, 100)],
    })).rejects.toMatchObject({ message: "Only reimbursements can be edited here." });

    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e1, 4_000, { id: r.id, kind: "reimbursement" }) }))
      .rejects.toMatchObject({ message: "Edit a reimbursement from its own form." });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e1, 4_000, { id: r.id }) }))
      .rejects.toMatchObject({ message: "Edit a reimbursement from its own form." });
  });

  it("locks a reimbursed expense and frees it when the reimbursement is deleted", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 10_000, "2027-09-01");
    const r = await reimburse(savings.id, 6_000, "2027-09-05", [alloc(e, 6_000)]);
    const locked = "This expense has been reimbursed. Edit or delete the reimbursement first.";

    await expect(mockInvoke("delete_transaction", { id: e.id })).rejects.toMatchObject({ code: "Conflict", message: locked });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e, 5_000) }))
      .rejects.toMatchObject({ message: "Amount can't go below what's already been reimbursed." });
    await mockInvoke("update_transaction", { input: expenseUpdate(e, 6_000) });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e, 6_000, { kind: "income", categoryId: null }) }))
      .rejects.toMatchObject({ code: "Conflict", message: locked });

    await mockInvoke("delete_transaction", { id: r.id });
    expect((await txnOf(e.id)).reimbursedCents).toBe(0);
    expect(await balanceOf(savings.id)).toBe(494_000);
    await mockInvoke("delete_transaction", { id: e.id });
  });

  it("clamps the expectation when an expense shrinks and clears it when the kind changes", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 10_000, "2027-10-01");
    await mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_000 });

    const shrunk = await mockInvoke<Transaction>("update_transaction", { input: expenseUpdate(e, 8_000) });
    expect(shrunk.expectedReimbursementCents).toBe(8_000);

    const [incCat] = (await mockInvoke<Category[]>("list_categories", { kind: "income", includeArchived: false })).filter((c) => !c.isSystem);
    const flipped = await mockInvoke<Transaction>("update_transaction", {
      input: expenseUpdate(e, 8_000, { kind: "income", categoryId: incCat.id }),
    });
    expect(flipped.kind).toBe("income");
    expect(flipped.expectedReimbursementCents).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/mock-reimbursements.test.ts`

Expected: FAIL (`Unknown command: create_reimbursement_transaction`).

- [ ] **Step 3: Add the client wrappers**

In `src/client/index.ts`, extend the type import:

```ts
  Transaction,
  TransactionFilters,
  TxnAllocation,
  TxnSplit,
  UpdateTransactionInput,
  AwaitingReimbursement,
} from "../types";
```

Add after `createPayment`:

```ts
  createReimbursement: (accountId: string, amountCents: number, allocations: TxnAllocation[], description: string | null, date: string, time: string | null = null) =>
    dispatch<Transaction>("create_reimbursement_transaction", { accountId, amountCents, description, date, time, allocations }),
  updateReimbursement: (id: string, accountId: string, amountCents: number, allocations: TxnAllocation[], description: string | null, date: string, time: string | null = null) =>
    dispatch<Transaction>("update_reimbursement_transaction", { id, accountId, amountCents, description, date, time, allocations }),
  setExpectedReimbursement: (expenseId: string, expectedCents: number | null) =>
    dispatch<Transaction>("set_expected_reimbursement", { expenseId, expectedCents }),
```

and in the Dashboard group:

```ts
  getAwaitingReimbursement: () => dispatch<AwaitingReimbursement>("get_awaiting_reimbursement"),
```

- [ ] **Step 4: Mirror the rules in the mock**

In `src/client/mock.ts`:

Add `TxnAllocation` to the type import list and import the helper:

```ts
import { postingsFor } from "../lib/kinds";
import { apportion } from "../lib/reimbursements";
```

Add after `const txns: Transaction[] = [];`:

```ts
// Reimbursement links, mirroring the `reimbursement_allocations` table. Each
// Transaction's `reimbursedCents` / `allocations` are derived from these.
interface AllocRow { id: string; reimbursementId: string; expenseId: string; amountCents: number }
const allocs: AllocRow[] = [];

const reimbDefaults = () => ({
  expectedReimbursementCents: null as number | null,
  reimbursedCents: 0,
  allocations: [] as TxnAllocation[],
});

function syncDerived() {
  for (const t of txns) {
    t.reimbursedCents = allocs.filter((a) => a.expenseId === t.id).reduce((s, a) => s + a.amountCents, 0);
    t.allocations = t.kind === "reimbursement"
      ? allocs.filter((a) => a.reimbursementId === t.id).map((a) => ({ expenseId: a.expenseId, amountCents: a.amountCents }))
      : [];
  }
}

const allocatedOn = (expenseId: string, exceptReimbursementId?: string) =>
  allocs
    .filter((a) => a.expenseId === expenseId && a.reimbursementId !== exceptReimbursementId)
    .reduce((s, a) => s + a.amountCents, 0);

// Mirrors Rust service::is_plain_expense: an expense that is not a balance correction.
const isPlainExpense = (t: Transaction) =>
  t.kind === "expense" && !categories.find((c) => c.id === t.categoryId)?.isSystem;

// Mirrors Rust service::validate_allocations.
function validateAllocations(amountCents: number, list: TxnAllocation[], exceptReimbursementId?: string): void {
  if (!Array.isArray(list) || list.length === 0) return fail("ValidationError", "Pick at least one expense to reimburse.");
  const seen = new Set<string>();
  let sum = 0;
  for (const l of list) {
    if (l.amountCents <= 0) return fail("ValidationError", "Each allocation must be greater than zero.");
    if (seen.has(l.expenseId)) return fail("ValidationError", "An expense can only be listed once.");
    seen.add(l.expenseId);
    const e = txns.find((t) => t.id === l.expenseId);
    if (!e || !isPlainExpense(e)) return fail("ValidationError", "Only expenses can be reimbursed.");
    if (allocatedOn(l.expenseId, exceptReimbursementId) + l.amountCents > e.amountCents) {
      return fail("ValidationError", "Allocation exceeds what's left on that expense.");
    }
    sum += l.amountCents;
  }
  if (sum !== amountCents) fail("ValidationError", "Allocations must add up to the reimbursement amount.");
}
```

Add `...reimbDefaults()` as the last property of every `Transaction` literal that the mock builds from scratch. There are eight: the `opening` rows in `seedDemo`'s `mk` and in `create_account`; the demo `add` helper; the two `set_account_balance` inserts (income/expense and adjustment); `create_income_transaction`/`create_expense_transaction` (`tx`); `create_transfer_transaction`; `create_payment_transaction`. Example for the opening row in `create_account`:

```ts
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
```

Rename the dispatcher and wrap it so derived fields are fresh on every result. Change `export async function mockInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {` to:

```ts
export async function mockInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const result = await mockInvokeInner<T>(command, args);
  syncDerived();
  return result;
}

async function mockInvokeInner<T>(command: string, args: Record<string, unknown>): Promise<T> {
```

Add the new commands inside the `switch`, after `create_payment_transaction`:

```ts
    case "create_reimbursement_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const transactionTime = resolveTime(a.time, null);
      validateAllocations(a.amountCents, a.allocations);
      const id = uid();
      const tx: Transaction = { id, kind: "reimbursement", accountId: a.accountId, toAccountId: null, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() };
      txns.unshift(tx);
      for (const l of a.allocations as TxnAllocation[]) allocs.push({ id: uid(), reimbursementId: id, expenseId: l.expenseId, amountCents: l.amountCents });
      return tx as T;
    }
    case "update_reimbursement_transaction": {
      const i = txns.findIndex((t) => t.id === a.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind !== "reimbursement") fail("ValidationError", "Only reimbursements can be edited here.");
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const transactionTime = resolveTime(a.time, txns[i].transactionTime);
      validateAllocations(a.amountCents, a.allocations, a.id);
      txns[i] = { ...txns[i], accountId: a.accountId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, updatedAt: now() };
      for (let k = allocs.length - 1; k >= 0; k--) if (allocs[k].reimbursementId === a.id) allocs.splice(k, 1);
      for (const l of a.allocations as TxnAllocation[]) allocs.push({ id: uid(), reimbursementId: a.id, expenseId: l.expenseId, amountCents: l.amountCents });
      return txns[i] as T;
    }
    case "set_expected_reimbursement": {
      const e = txns.find((t) => t.id === a.expenseId) ?? fail("NotFound", "Transaction not found");
      if (!isPlainExpense(e)) fail("ValidationError", "Only expenses can expect a reimbursement.");
      const n: number | null = a.expectedCents ?? null;
      if (n != null && (n <= 0 || n > e.amountCents)) {
        fail("ValidationError", "Expected reimbursement must be more than zero and no more than the expense amount.");
      }
      e.expectedReimbursementCents = n;
      e.updatedAt = now();
      return e as T;
    }
    case "get_awaiting_reimbursement": {
      let count = 0;
      let totalCents = 0;
      for (const t of txns) {
        if (t.kind !== "expense" || t.expectedReimbursementCents == null) continue;
        const outstanding = t.expectedReimbursementCents - allocatedOn(t.id);
        if (outstanding > 0) { count += 1; totalCents += outstanding; }
      }
      return { count, totalCents } as T;
    }
```

In `update_transaction`, add after the adjustment guard line (`if (txns[i].kind === "adjustment" || a.input.kind === "adjustment") fail(...)`):

```ts
      if (txns[i].kind === "reimbursement" || a.input.kind === "reimbursement") fail("ValidationError", "Edit a reimbursement from its own form.");
      const reimbursed = allocatedOn(txns[i].id);
      if (reimbursed > 0) {
        if (a.input.kind !== "expense") fail("Conflict", "This expense has been reimbursed. Edit or delete the reimbursement first.");
        if (a.input.amountCents < reimbursed) fail("ValidationError", "Amount can't go below what's already been reimbursed.");
      }
```

and change the final write so the expectation is clamped or cleared:

```ts
      const prevExpected = txns[i].expectedReimbursementCents;
      const expectedReimbursementCents = a.input.kind === "expense" && prevExpected != null ? Math.min(prevExpected, a.input.amountCents) : null;
      txns[i] = { ...txns[i], ...a.input, categoryId, transactionTime, excludedFromReporting: excluded, splits, expectedReimbursementCents, updatedAt: now() };
```

(replacing the existing `txns[i] = { ...txns[i], ...a.input, categoryId, transactionTime, excludedFromReporting: excluded, splits, updatedAt: now() };` line).

In `delete_transaction`, replace `txns.splice(i, 1);` with:

```ts
      if (allocatedOn(txns[i].id) > 0) fail("Conflict", "This expense has been reimbursed. Edit or delete the reimbursement first.");
      const [removed] = txns.splice(i, 1);
      if (removed.kind === "reimbursement") {
        for (let k = allocs.length - 1; k >= 0; k--) if (allocs[k].reimbursementId === removed.id) allocs.splice(k, 1);
      }
```

In `reset_app`, add `allocs.length = 0;` next to `txns.length = 0;`.

In `get_dashboard_summary`, replace the `expense` const and the breakdown attribution. Replace:

```ts
      const expense = txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
```

with:

```ts
      const inRangeExpenses = txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t));
      const expense = inRangeExpenses.reduce((s, t) => s + t.amountCents - allocatedOn(t.id), 0);
```

and replace the block from `const attrib: ...` through the `byCat`/`breakdown` construction with:

```ts
      const attrib: { cat: string; amt: number }[] = [];
      inRangeExpenses.forEach((t) => {
        const lines = t.splits.length
          ? t.splits.map((s) => ({ cat: s.categoryId, amt: s.amountCents }))
          : t.categoryId ? [{ cat: t.categoryId, amt: t.amountCents }] : [];
        const shares = apportion(allocatedOn(t.id), lines.map((l) => l.amt));
        lines.forEach((l, k) => attrib.push({ cat: l.cat, amt: l.amt - shares[k] }));
      });
      const byCat = new Map<string, number>();
      attrib.forEach(({ cat, amt }) => { const pid = parentOf(cat); byCat.set(pid, (byCat.get(pid) ?? 0) + amt); });
      const breakdown: CategoryBreakdown[] = [...byCat.entries()]
        .filter(([, total]) => total > 0)
        .map(([cid, total]) => {
          const c = categories.find((x) => x.id === cid)!;
          return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
        })
        .sort((x, y) => y.totalCents - x.totalCents || (x.categoryName < y.categoryName ? -1 : x.categoryName > y.categoryName ? 1 : 0));
```

(keep the existing `const parentOf = ...` line above it).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/__tests__/mock-reimbursements.test.ts && npx vitest run && npx tsc --noEmit 2>&1 | head -20`

Expected: the new file PASSES, the whole Vitest suite PASSES, and `tsc` is clean.

- [ ] **Step 6: Commit**

```bash
git add src/client/index.ts src/client/mock.ts src/__tests__/mock-reimbursements.test.ts
git commit -m "feat: mirror reimbursements in the client and mock backend"
```

---

### Task 9: Reimbursement form and the expense expectation

**Files:**
- Create: `src/modals/ReimbursementForm.tsx`
- Modify: `src/modals/AddTransaction.tsx`
- Test: `npm run build` (the repo has no component tests; the logic under it is covered in Tasks 7 and 8)

**Interfaces:**
- Consumes: Task 7 helpers, Task 8 `client` wrappers.
- Produces:
  - `<ReimbursementForm accounts categories editing? presetExpenseId? onClose onDone />`
  - `AddTransaction` gains an optional prop `reimburseExpenseId?: string`; with it (or when editing a reimbursement) the modal opens on the Reimbursement segment.
  - Expense form: "Expecting reimbursement" toggle plus amount; saved through `client.setExpectedReimbursement`.

- [ ] **Step 1: Create the form**

Create `src/modals/ReimbursementForm.tsx`:

```tsx
// Record (or edit) money that came back for expenses you already booked: an
// employer claim, a friend's share of a bill, a shop refund. The amount must be
// fully allocated across one or more expenses. Rendered inside AddTransaction's
// Reimbursement segment; it owns its own state and its own Save/Cancel.

import { useEffect, useMemo, useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { fmtDate, fmtMoney, nowTimeHHMM, parseAmountToCents, todayISO } from "../lib/format";
import { kindColor } from "../lib/kinds";
import { candidateExpenses, defaultAllocationCents, outstandingCents, remainingCents } from "../lib/reimbursements";
import { useTimeSetting } from "../lib/useTimeSetting";

interface Pick { expenseId: string; amount: string }

const cents2 = (c: number) => (c / 100).toFixed(2);

export function ReimbursementForm({ accounts, categories, editing, presetExpenseId, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; presetExpenseId?: string;
  onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const accent = kindColor(t, "reimbursement");
  const [timeEnabled] = useTimeSetting();
  const active = accounts.filter((a) => !a.isArchived || a.id === editing?.accountId);

  const [expenses, setExpenses] = useState<Transaction[]>([]);
  const [amount, setAmount] = useState(editing ? cents2(editing.amountCents) : "");
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [accountId, setAccountId] = useState(editing?.accountId ?? active[0]?.id ?? "");
  const [date, setDate] = useState(editing?.transactionDate ?? todayISO());
  const [time, setTime] = useState(editing?.transactionTime ?? nowTimeHHMM());
  const [picks, setPicks] = useState<Pick[]>(
    editing ? editing.allocations.map((a) => ({ expenseId: a.expenseId, amount: cents2(a.amountCents) })) : [],
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ownAllocations = useMemo(() => editing?.allocations ?? [], [editing]);
  const ownOf = (expenseId: string) => ownAllocations.find((a) => a.expenseId === expenseId)?.amountCents ?? 0;

  useEffect(() => {
    client.listTransactions({ kind: "expense", limit: 1000 }).then(setExpenses).catch(() => {});
  }, []);

  // Quick entry from an expense: pick it and fill in what is still owed on it.
  useEffect(() => {
    if (!presetExpenseId || editing || picks.length > 0) return;
    const e = expenses.find((x) => x.id === presetExpenseId);
    if (!e) return;
    const cents = defaultAllocationCents(e);
    setPicks([{ expenseId: e.id, amount: cents2(cents) }]);
    if (!amount) setAmount(cents2(cents));
  }, [expenses]);

  const byId = useMemo(() => new Map(expenses.map((e) => [e.id, e])), [expenses]);
  const candidates = useMemo(
    () => candidateExpenses(expenses, categories, ownAllocations),
    [expenses, categories, ownAllocations],
  );
  const q = query.trim().toLowerCase();
  const shown = candidates.filter((e) => {
    if (!q) return true;
    const cat = categories.find((c) => c.id === e.categoryId)?.name ?? "";
    const acc = accounts.find((a) => a.id === e.accountId)?.name ?? "";
    return (e.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || acc.toLowerCase().includes(q);
  });

  const amountCents = parseAmountToCents(amount);
  const pickCents = picks.map((p) => parseAmountToCents(p.amount));
  const allocatedCents = pickCents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const picksValid = picks.length > 0 && picks.every((p, i) => {
    const e = byId.get(p.expenseId);
    const c = pickCents[i];
    return !!e && c != null && c <= remainingCents(e, ownOf(p.expenseId));
  });
  const balanced = amountCents != null && allocatedCents === amountCents;
  const valid = !!accountId && balanced && picksValid && (!timeEnabled || !!time);

  function toggle(e: Transaction) {
    const cents = defaultAllocationCents(e, ownOf(e.id));
    if (picks.length === 0 && !amount) setAmount(cents2(cents));
    setPicks((ps) =>
      ps.some((p) => p.expenseId === e.id)
        ? ps.filter((p) => p.expenseId !== e.id)
        : [...ps, { expenseId: e.id, amount: cents2(cents) }],
    );
  }

  async function submit() {
    if (!valid || amountCents == null) return;
    setBusy(true); setError(null);
    const allocations = picks.map((p, i) => ({ expenseId: p.expenseId, amountCents: pickCents[i] as number }));
    const txTime = timeEnabled ? time : null;
    try {
      if (editing) {
        await client.updateReimbursement(editing.id, accountId, amountCents, allocations, desc.trim() || null, date, txTime);
      } else {
        await client.createReimbursement(accountId, amountCents, allocations, desc.trim() || null, date, txTime);
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const sel = { ...inputStyle(t), appearance: "none" as const, cursor: "pointer" };

  return (
    <>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 14, top: 14, fontSize: 16, color: t.faint, fontFamily: t.mono }}>RM</span>
        <input className="sens-input" value={amount} inputMode="decimal" placeholder="0.00" aria-label="Amount received"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          style={{ ...inputStyle(t), height: 50, fontSize: 24, fontWeight: 700, fontFamily: t.mono, paddingLeft: 44, color: accent }} />
      </div>

      <input className="sens-input" value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="Who paid you back? (optional)" style={inputStyle(t)} />

      <Field label="Received in">
        <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
          {active.map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
        </select>
      </Field>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim }}>Applies to</span>
          <span style={{ fontSize: 11, color: t.faint }}>{picks.length} selected</span>
        </div>
        <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search expenses" aria-label="Search expenses" style={{ ...inputStyle(t), marginBottom: 6 }} />
        <div style={{ maxHeight: 200, overflowY: "auto", border: `0.5px solid ${t.border}`, borderRadius: 9, padding: "0 10px" }}>
          {shown.length === 0 && (
            <div style={{ fontSize: 12.5, color: t.faint, padding: "12px 0" }}>No expenses with anything left to reimburse.</div>
          )}
          {shown.map((e) => {
            const pick = picks.find((p) => p.expenseId === e.id);
            const cat = categories.find((c) => c.id === e.categoryId);
            const out = outstandingCents(e);
            const label = e.description || cat?.name || "Expense";
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `0.5px solid ${t.divider}` }}>
                <button type="button" role="checkbox" aria-checked={!!pick} aria-label={`Select ${label}`} onClick={() => toggle(e)}
                  style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 6, padding: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1.5px solid ${pick ? accent : t.borderStrong}`, background: pick ? accent : "transparent" }}>
                  {pick && <Icon name="check" size={11} color={t.onAccent} stroke={3} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                  <div style={{ fontSize: 11, color: t.faint }}>
                    {fmtDate(e.transactionDate)} · {fmtMoney(remainingCents(e, ownOf(e.id)), { cents: true })} left
                    {out > 0 ? ` · ${fmtMoney(out, { cents: true })} expected` : ""}
                  </div>
                </div>
                {pick && (
                  <input className="sens-input" aria-label={`Amount for ${label}`} value={pick.amount} inputMode="decimal"
                    onChange={(ev) => setPicks((ps) => ps.map((p) => p.expenseId === e.id ? { ...p, amount: ev.target.value.replace(/[^0-9.]/g, "") } : p))}
                    style={{ ...inputStyle(t), width: 92, height: 30, fontFamily: t.mono, textAlign: "right" }} />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, fontSize: 12.5 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: balanced ? t.dim : amountCents != null && allocatedCents > amountCents ? t.expense : t.dim }}>
            {balanced && <Icon name="check" size={13} color={t.income} stroke={2.4} />}
            Allocated <b style={{ fontFamily: t.mono }}>{fmtMoney(allocatedCents, { cents: true })}</b> of <b style={{ fontFamily: t.mono }}>{fmtMoney(amountCents ?? 0, { cents: true })}</b>
          </span>
        </div>
      </div>

      {timeEnabled ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Date"><input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} /></Field>
          <Field label="Time"><input className="sens-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} /></Field>
        </div>
      ) : (
        <Field label="Date"><input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} /></Field>
      )}

      {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={!valid || busy}
          style={{ flex: 1, justifyContent: "center", height: 38, background: accent, boxShadow: `0 1px 8px ${hexA(accent, 0.35)}` }}>
          {editing ? "Save changes" : "Add reimbursement"}
        </Btn>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Wire the fourth segment into AddTransaction**

In `src/modals/AddTransaction.tsx`:

Add the import after the `useTimeSetting` import:

```tsx
import { ReimbursementForm } from "./ReimbursementForm";
```

Change the kinds list and props:

```tsx
const FORM_KINDS: TransactionKind[] = ["expense", "income", "transfer", "reimbursement"];

export function AddTransaction({ accounts, categories, editing, payAccountId, reimburseExpenseId, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; payAccountId?: string; reimburseExpenseId?: string;
  onClose: () => void; onDone: () => void;
}) {
```

Replace the `initialKind` definition with:

```tsx
  const initialKind: TransactionKind = editing?.kind === "reimbursement" || (!editing && reimburseExpenseId)
    ? "reimbursement"
    : editing?.kind === "payment" || (!editing && payTarget && movementKind(payTarget.subtype) === "payment")
      ? "payment"
      : (editing?.kind ?? "expense");
```

Add the expectation state after the `excluded` state line:

```tsx
  const [expecting, setExpecting] = useState(editing?.expectedReimbursementCents != null);
  const [expectedStr, setExpectedStr] = useState(
    editing?.expectedReimbursementCents != null ? (editing.expectedReimbursementCents / 100).toFixed(2) : "",
  );
```

Add before `const movement = ...`:

```tsx
  const expectedCents = parseAmountToCents(expectedStr);
  const expectedOk = kind !== "expense" || !expecting || (expectedCents != null && expectedCents <= totalCents);
```

Update `valid`'s non-movement branch to include it:

```tsx
    : !!(accountId && finalItems.length >= 1 && (!timeEnabled || !!time) && expectedOk);
```

In `submit`, replace the final income/expense write block (from `if (editing) {` through the closing of the `else { await client.createExpense(...) }`) with:

```tsx
      let savedId: string | null = null;
      if (editing) {
        await client.updateTransaction({
          id: editing.id, kind, accountId, toAccountId: null,
          categoryId: split ? null : singleCat,
          amountCents: total, description: desc.trim() || null, transactionDate: date,
          transactionTime: txTime, excludedFromReporting: excluded, splits,
        });
        savedId = editing.id;
      } else if (kind === "income") {
        await client.createIncome(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
      } else {
        const created = await client.createExpense(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
        savedId = created.id;
      }
      if (kind === "expense" && savedId && (expecting || editing?.expectedReimbursementCents != null)) {
        await client.setExpectedReimbursement(savedId, expecting ? expectedCents : null);
      }
      onDone();
```

(the `onDone();` that previously followed the if/else chain is the one inside this replacement; remove the old one so it is called once).

Wrap the form body. Replace the line `        {/* amount */}` and the `<div style={{ position: "relative" }}>` that follows it with:

```tsx
        {kind === "reimbursement" ? (
          <ReimbursementForm accounts={accounts} categories={categories}
            editing={editing?.kind === "reimbursement" ? editing : undefined}
            presetExpenseId={reimburseExpenseId} onClose={onClose} onDone={onDone} />
        ) : (
        <>
        {/* amount */}
        <div style={{ position: "relative" }}>
```

Add the expectation toggle after the exclusion toggle block (`{!movement && ( <button ... exclude ... </button> )}`):

```tsx
        {kind === "expense" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" role="switch" aria-checked={expecting}
              onClick={() => { setExpecting((v) => !v); if (!expecting && !expectedStr && totalCents > 0) setExpectedStr((totalCents / 100).toFixed(2)); }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: `0.5px solid ${t.border}`, background: expecting ? hexA(t.transfer, 0.12) : t.panel2, cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", background: expecting ? t.transfer : "transparent", border: `1.5px solid ${expecting ? t.transfer : t.faint}`, flexShrink: 0 }}>
                {expecting && <Icon name="check" size={12} color={t.onAccent} stroke={3} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Expecting reimbursement</div>
                <div style={{ fontSize: 11, color: t.faint }}>Track what's still owed back to you</div>
              </span>
            </button>
            {expecting && (
              <Field label="Expected back">
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 12, top: 9, fontSize: 13, color: t.faint, fontFamily: t.mono }}>RM</span>
                  <input className="sens-input" value={expectedStr} inputMode="decimal" placeholder="0.00" aria-label="Expected reimbursement"
                    onChange={(e) => setExpectedStr(e.target.value.replace(/[^0-9.]/g, ""))}
                    style={{ ...inputStyle(t), paddingLeft: 38, fontFamily: t.mono, borderColor: expectedOk ? undefined : t.expense }} />
                </div>
                {!expectedOk && <div style={{ fontSize: 11, color: t.expense, marginTop: 4 }}>Can't be more than the expense total</div>}
              </Field>
            )}
          </div>
        )}
```

Close the fragment. Replace the end of the component:

```tsx
            {editing ? "Save changes" : "Add transaction"}
          </Btn>
        </div>
      </div>
    </Modal>
```

with:

```tsx
            {editing ? "Save changes" : "Add transaction"}
          </Btn>
        </div>
        </>
        )}
      </div>
    </Modal>
```

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -20`

Expected: `tsc` clean and `vite build` succeeds. (`noUnusedLocals` would flag an unused import such as `Icon` in the form if one were left behind; both are used.)

- [ ] **Step 4: Smoke test in the browser mock**

Run `npm run dev`, open the app, and check:
1. Add Transaction → Expense RM200 "Dinner" → toggle "Expecting reimbursement" (amount defaults to RM200.00) → change it to 150 → Add. 
2. Add Transaction → Reimbursement segment → "Dinner" is listed first with "RM150.00 expected"; tick it; the amount fills to 150.00 and the footer reads "Allocated RM150.00 of RM150.00" with a check → Add reimbursement.
3. Try a footer mismatch (change the allocation to 100): Add reimbursement stays disabled.

- [ ] **Step 5: Commit**

```bash
git add src/modals/ReimbursementForm.tsx src/modals/AddTransaction.tsx
git commit -m "feat: add the reimbursement form and expense expectation"
```

---

### Task 10: Show it: badges, detail, filter, dashboard tile, "Owes you"

**Files:**
- Modify: `src/components/TxnRow.tsx`
- Modify: `src/components/TxnDetailPanel.tsx`
- Modify: `src/screens/Transactions.tsx`
- Modify: `src/screens/Dashboard.tsx`
- Modify: `src/screens/Accounts.tsx`
- Test: `npm run build`, manual smoke in the browser mock

**Interfaces:**
- Consumes: Tasks 6–9.
- Produces: `TxnDetailPanel` props `onEdit?: () => void` and `onReimburse?: () => void`; the Transactions "Awaiting reimbursement" filter and the "Record reimbursement" quick action; the dashboard tile; the "Owes you" label.

- [ ] **Step 1: Row badge and reimbursement row**

In `src/components/TxnRow.tsx`:

Change the imports:

```tsx
import { fmtDate, fmtMoney, fmtTime } from "../lib/format";
import { reimbursementBadge } from "../lib/reimbursements";
```

After `const split = ...` block add:

```tsx
  const badge = tx.kind === "expense" ? reimbursementBadge(tx) : null;
```

Add a subtitle case. Replace

```tsx
  else if (tx.kind === "adjustment" || tx.kind === "opening") subtitle = accName(tx.accountId);
```

with

```tsx
  else if (tx.kind === "adjustment" || tx.kind === "opening") subtitle = accName(tx.accountId);
  else if (tx.kind === "reimbursement") {
    const n = tx.allocations.length;
    subtitle = `${accName(tx.accountId)} · ${n} expense${n === 1 ? "" : "s"}`;
  }
```

Extend the kind-color rule:

```tsx
  const useKindColor = (movement && !signed) || tx.kind === "adjustment" || tx.kind === "opening" || tx.kind === "reimbursement";
```

Add the badge after the Excluded badge block (inside the title row `div`):

```tsx
          {badge && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: t.transfer, background: hexA(t.transfer, 0.16), padding: "1px 5px", borderRadius: 5 }}>
              <Icon name="reimburse" size={9} color={t.transfer} stroke={2.4} />
              {badge.state === "pending" ? `${fmtMoney(badge.cents, { cents: true })} pending` : "Reimbursed"}
            </span>
          )}
```

- [ ] **Step 2: Detail panel**

In `src/components/TxnDetailPanel.tsx`:

Add the import:

```tsx
import { outstandingCents, remainingCents } from "../lib/reimbursements";
```

Change the signature to accept the two actions:

```tsx
export function TxnDetailPanel({ tx, accounts, categories, allTxns, onClose, onDuplicate, onDelete, onSaved, onEdit, onReimburse }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; allTxns: Transaction[];
  onClose: () => void; onDuplicate: () => void; onDelete: () => void; onSaved: () => void;
  onEdit?: () => void; onReimburse?: () => void;
}) {
```

After `const split = tx.splits.length >= 2;` add:

```tsx
  const system = !!categories.find((c) => c.id === tx.categoryId)?.isSystem;
  const canReimburse = tx.kind === "expense" && !system && remainingCents(tx) > 0 && !!onReimburse;
  const expenseOf = (id: string) => allTxns.find((x) => x.id === id);
```

Make the header amount use the kind color for reimbursements. Change

```tsx
            color={movement || tx.kind === "adjustment" || tx.kind === "opening" ? color : undefined} size={26} weight={700} />
```

to

```tsx
            color={movement || tx.kind === "adjustment" || tx.kind === "opening" || tx.kind === "reimbursement" ? color : undefined} size={26} weight={700} />
```

Insert before the `{error && ...}` line of the editable branch:

```tsx
            {tx.kind === "expense" && (tx.reimbursedCents > 0 || tx.expectedReimbursementCents != null) && (
              <div style={{ fontSize: 12.5, background: t.panel2, borderRadius: 8, padding: "9px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: t.dim }}>Reimbursed</span>
                  <span style={{ fontFamily: t.mono }}>{fmtMoney(tx.reimbursedCents, { cents: true })} of {fmtMoney(tx.amountCents, { cents: true })}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: t.dim }}>Net cost</span>
                  <b style={{ fontFamily: t.mono }}>{fmtMoney(tx.amountCents - tx.reimbursedCents, { cents: true })}</b>
                </div>
                {outstandingCents(tx) > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: t.dim }}>Still expected</span>
                    <span style={{ fontFamily: t.mono, color: t.transfer }}>{fmtMoney(outstandingCents(tx), { cents: true })}</span>
                  </div>
                )}
              </div>
            )}
            {canReimburse && <Btn variant="outline" icon="reimburse" size="sm" onClick={onReimburse} style={{ justifyContent: "center" }}>Record reimbursement</Btn>}
```

In the read-only (`else`) branch, replace the info box and the delete button so a reimbursement lists what it repays and can be edited:

```tsx
            {tx.kind === "reimbursement" && (
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim, marginBottom: 6 }}>
                  Repays {tx.allocations.length} expense{tx.allocations.length === 1 ? "" : "s"}
                </div>
                {tx.allocations.map((a) => {
                  const e = expenseOf(a.expenseId);
                  return (
                    <div key={a.expenseId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: `0.5px solid ${t.divider}`, fontSize: 13 }}>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e?.description || "Expense"}</span>
                      <span style={{ fontFamily: t.mono }}>{fmtMoney(a.amountCents, { cents: true })}</span>
                    </div>
                  );
                })}
                {onEdit && <Btn variant="outline" icon="pencil" size="sm" onClick={onEdit} style={{ justifyContent: "center", marginTop: 10, width: "100%" }}>Edit reimbursement</Btn>}
              </div>
            )}
            <div style={{ fontSize: 12, color: t.dim, background: t.panel2, padding: "8px 12px", borderRadius: 8, display: "flex", gap: 7, alignItems: "center" }}>
              <Icon name={meta.icon} size={14} color={color} />
              {tx.kind === "opening" ? "The opening balance is set from the account."
                : tx.kind === "reimbursement" ? "Money back for expenses you already booked. It never counts as income."
                : "Adjustments can be deleted but not edited."}
            </div>
            {tx.kind !== "opening" && <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ justifyContent: "center" }}>Delete</Btn>}
```

(this replaces the existing `<div ...>` info box through the `{tx.kind !== "opening" && <Btn variant="danger" ...>}` line in the `else` branch.)

- [ ] **Step 3: Transactions screen**

In `src/screens/Transactions.tsx`:

Import the helpers:

```tsx
import { effectiveCents, outstandingCents } from "../lib/reimbursements";
```

Add the kind filter:

```tsx
const KIND_FILTERS: TransactionKind[] = ["income", "expense", "transfer", "payment", "reimbursement", "adjustment", "opening"];
```

Add state after the `kinds` state:

```tsx
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const [reimburseFor, setReimburseFor] = useState<string | null>(null);
```

Add to the filter callback, after the `kinds` check:

```tsx
      if (awaitingOnly && !(tx.kind === "expense" && outstandingCents(tx) > 0)) return false;
```

and add `awaitingOnly` to that `useMemo` dependency array.

Count expenses at their true cost in the list totals. Replace the `totalOut` line with:

```tsx
  const totalOut = filtered.filter((x) => x.kind === "expense" && !x.excludedFromReporting).reduce((s, x) => s + effectiveCents(x), 0);
```

and in `dayNet`, change `: x.kind === "expense" && !x.excludedFromReporting ? -x.amountCents` to `: x.kind === "expense" && !x.excludedFromReporting ? -effectiveCents(x)`.

Add the filter pill and make Clear reset it. Replace

```tsx
          {kinds.size > 0 && <Pill onClick={() => setKinds(new Set())}>Clear</Pill>}
```

with

```tsx
          <Pill on={awaitingOnly} dot={kindColor(t, "reimbursement")} onClick={() => setAwaitingOnly((v) => !v)}>Awaiting reimbursement</Pill>
          {(kinds.size > 0 || awaitingOnly) && <Pill onClick={() => { setKinds(new Set()); setAwaitingOnly(false); }}>Clear</Pill>}
```

Add the quick action and hide Duplicate for reimbursements. Replace the two lines:

```tsx
                      {tx.kind !== "adjustment" && tx.kind !== "opening" && <IconBtn name="copy" icon={13} onClick={() => onDuplicate(tx)} title="Duplicate" />}
```

with

```tsx
                      {tx.kind === "expense" && <IconBtn name="reimburse" icon={13} onClick={() => setReimburseFor(tx.id)} title="Record reimbursement" />}
                      {tx.kind !== "adjustment" && tx.kind !== "opening" && tx.kind !== "reimbursement" && <IconBtn name="copy" icon={13} onClick={() => onDuplicate(tx)} title="Duplicate" />}
```

Pass the actions to the detail panel:

```tsx
        <TxnDetailPanel key={sel.id} tx={sel} accounts={accounts} categories={categories} allTxns={txns}
          onClose={() => setSelId(null)} onDuplicate={() => onDuplicate(sel)} onDelete={() => onDelete(sel.id)}
          onEdit={() => setEditing(sel)} onReimburse={() => setReimburseFor(sel.id)}
          onSaved={() => { reload(); }} />
```

Render the quick-entry modal after the existing `editing` modal line:

```tsx
      {reimburseFor && <AddTransaction accounts={accounts} categories={categories} reimburseExpenseId={reimburseFor} onClose={() => setReimburseFor(null)} onDone={() => { setReimburseFor(null); reload(); }} />}
```

- [ ] **Step 4: Dashboard tile**

In `src/screens/Dashboard.tsx`:

```tsx
import type { AwaitingReimbursement, DashboardSummary } from "../types";
import { Card, Empty, GlyphTile, Money, SectionTitle } from "../components/ui";
```

Add state next to `data`:

```tsx
  const [awaiting, setAwaiting] = useState<AwaitingReimbursement | null>(null);
```

Add an effect after the summary effect:

```tsx
  useEffect(() => {
    client.getAwaitingReimbursement().then(setAwaiting).catch(() => setAwaiting(null));
  }, [version]);
```

Add the tile right after the hero `</Card>` (before the "Spending" card):

```tsx
      {awaiting && awaiting.count > 0 && (
        <Card pad={16}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GlyphTile tone={t.transfer} size={36} icon="reimburse" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Awaiting reimbursement</div>
              <div style={{ fontSize: 11.5, color: t.faint }}>
                {awaiting.count} expense{awaiting.count === 1 ? "" : "s"} · not counted in net worth
              </div>
            </div>
            <Money cents={awaiting.totalCents} size={16} weight={700} />
            <span className="sens-link" style={{ fontSize: 12.5, fontWeight: 600 }} onClick={() => go("transactions")}>View</span>
          </div>
        </Card>
      )}
```

- [ ] **Step 5: "Owes you" on lent accounts**

In `src/screens/Accounts.tsx`, extend the import:

```tsx
import { balanceDisplay, creditReadout, lentLabel, toneColor, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
```

After `const v = balanceDisplay(a.group, a.balanceCents);` add:

```tsx
                const rowLabel = v.label ?? lentLabel(a.subtype, a.balanceCents);
```

and replace `{v.label && <span style={{ fontSize: 10, color: t.faint }}>{v.label}</span>}` with:

```tsx
                        {rowLabel && <span style={{ fontSize: 10, color: t.faint }}>{rowLabel}</span>}
```

- [ ] **Step 6: Build and run the suite**

Run: `npm run build 2>&1 | tail -15 && npm test 2>&1 | tail -8`

Expected: build clean, all Vitest tests pass.

- [ ] **Step 7: Smoke test in the browser mock**

Run `npm run dev` and check, using the data from Task 9's smoke test:
1. The Dinner expense row shows a "pending" badge; after reimbursing it shows "Reimbursed". Open its detail panel: "Reimbursed RM150.00 of RM200.00 · Net cost RM50.00".
2. The reimbursement row is labelled "Reimbursement" with a `+` amount in the transfer color and the subtitle "Maybank Savings · 1 expense". Its detail panel lists the repaid expense and "Edit reimbursement" re-opens the form with the allocation filled.
3. The Transactions toolbar shows an "Awaiting reimbursement" pill that narrows the list to expenses still owed; the Dashboard tile appears only while something is outstanding.
4. Hover an expense row: the "Record reimbursement" icon opens the form with that expense selected and the amount filled.
5. Create a `lent` account with RM500 and confirm its Accounts row reads "Owes you".
6. Deleting a reimbursed expense shows the "This expense has been reimbursed…" toast; deleting the reimbursement first works.

- [ ] **Step 8: Commit**

```bash
git add src/components/TxnRow.tsx src/components/TxnDetailPanel.tsx src/screens/Transactions.tsx src/screens/Dashboard.tsx src/screens/Accounts.tsx
git commit -m "feat: show reimbursements, pending badges, and owes-you in the UI"
```

---

### Task 11: Docs and final verification

**Files:**
- Modify: `docs/architecture/transactions.md`, `docs/architecture/accounts.md`, `docs/architecture/backend.md`, `docs/architecture/frontend.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`, `ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md` (status line)

- [ ] **Step 1: `docs/architecture/transactions.md`**

- In the **Contents** list add `- [Reimbursements](#reimbursements)` after the Card and BNPL payments entry.
- Change the kind line to `` `kind` ∈ `income | expense | transfer | payment | reimbursement | adjustment | opening` `` and add a table row after `payment`:

```md
| `reimbursement` | positive | Money back for expenses already booked. No category. Posts `+amount` to the account and `−amount` to the `expense` bucket. See [Reimbursements](#reimbursements). |
```

- Add a new section before **Dashboard & reporting rules**:

```md
## Reimbursements

A `reimbursement` records money that came back for expenses you already booked: an employer claim,
a friend's share of a bill, a shop refund. It is never income.

- **Posting:** `+amount` on the receiving account, `−amount` on the `expense` system bucket. The
  receiving account can be any active account, including the card that was charged.
- **Allocations:** the table `reimbursement_allocations(reimbursement_id, expense_id, amount_cents)`
  (migration 012) pairs a reimbursement with the expenses it repays.
  - A reimbursement's allocations sum exactly to its amount.
  - An expense's allocations sum to at most its amount.
  - Only a plain expense (not a system-category balance correction) can be repaid.
  - The same expense appears once per reimbursement; one expense can take several reimbursements.
- **Expectation:** `transactions.expected_reimbursement_cents` (expenses only, `0 < n ≤ amount`) marks an
  expense as expecting money back. `outstanding = max(expected − reimbursed, 0)`. Set it only through
  `set_expected_reimbursement`; `update_transaction` clamps it to a reduced amount and clears it when the
  row stops being an expense.
- **True-cost reporting.** An expense's effective amount is its amount minus its allocations, counted in
  **its own month and category**, so a closed month's spending can fall (and its net cashflow rise) when
  money arrives later. Excluded expenses are skipped along with their allocations.
  - A split expense's offset is spread across its lines by largest remainder (`apportion` in
    `src-tauri/src/apportion.rs` and `src/lib/reimbursements.ts`); no line goes negative.
- **Guards:** an expense with allocations cannot be deleted, retyped, or reduced below its reimbursed
  total; delete or edit the reimbursement first. A reimbursement is edited only through
  `update_reimbursement` (`update_transaction` rejects the kind) and deleting it removes its allocations.
- **Dashboard:** `get_awaiting_reimbursement` returns `{count, totalCents}` for the tile. Pending claims
  are not part of net worth.
- **Mock mirror:** `allocs` + `syncDerived` in `src/client/mock.ts`.

Spec: `docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md`.
```

- In **Dashboard & reporting rules**, change the first excluded bullet to `- transfers, card/BNPL payments, and reimbursements` and add under it: `- expenses count **net of their reimbursements** (see [Reimbursements](#reimbursements))`.
- Update the migration note under the ledger warning: `... as migration 011 does.` → `... as migrations 011 and 012 do.`
- In **Excluded from reporting**, change the use-case bullet to `- Reimbursements / claims you did not pair to an expense: money back, not new income. (Prefer the reimbursement kind; it also lowers the original expense.)`

- [ ] **Step 2: `docs/architecture/accounts.md`**

Add a short section after **Credit limit**:

```md
## Money lent (`lent`)

The `lent` subtype (type `receivable`, group `own`) is an ordinary signed asset. You lend by transferring
into it and are repaid by transferring out; neither is income or an expense. A positive balance reads
**"Owes you"** on the Accounts row (`lentLabel` in `src/lib/accounts.ts`).
```

- [ ] **Step 3: `docs/architecture/backend.md`**

- `Fresh installs run **001 → 011**` → `**001 → 012**`.
- Add after the 011 row:

```md
| 012 | **Rebuilds `transactions`** to add the `reimbursement` kind and the nullable `expected_reimbursement_cents`, then creates `reimbursement_allocations` | Copies `postings` and `transaction_splits` first (like 011); the allocations table is created after the swap |
```

- In the cascade warning, change `(as 011 does)` to `(as 011 and 012 do)`.
- Under **Factory reset**, add `reimbursement_allocations` to the list of wiped tables (it is deleted before `postings` and `transactions`).
- Where the doc lists commands, add `create_reimbursement_transaction`, `update_reimbursement_transaction`, `set_expected_reimbursement`, and `get_awaiting_reimbursement`.
- Change the line "Saving/investing, loans & debt, reimbursements/claims, and credit-card payments are intentionally **not categories**" so it reads "...loans & debt, reimbursements/claims, and card payments..." (unchanged meaning; keep wording but confirm reimbursements are described as the `reimbursement` kind).

- [ ] **Step 4: `docs/architecture/frontend.md`**

Add a section after **Itemized Add-Transaction builder**:

```md
## Reimbursement form

Add Transaction has a fourth segment, **Reimbursement**, that swaps in `src/modals/ReimbursementForm.tsx`
(own state, own Save/Cancel). Fields: amount received, note, receiving account, date/time, and an
**Applies to** picker built from `candidateExpenses` (expenses with something left, expected ones first).
Each picked expense gets an editable allocation; Save stays disabled until "Allocated X of Y" balances.

- Entry points: the segment itself, the **Record reimbursement** action on an expense row and in its
  detail panel (opens the form with that expense picked, `reimburseExpenseId`), and **Edit reimbursement**
  in a reimbursement's detail panel.
- The expense form has an optional **Expecting reimbursement** toggle with an amount; it saves through
  `client.setExpectedReimbursement` after the expense is saved.
- Rows: expenses show a `pending` / `Reimbursed` badge (`reimbursementBadge`); the Transactions toolbar has
  an **Awaiting reimbursement** filter; list totals count expenses at `effectiveCents`; the Dashboard shows
  an "Awaiting reimbursement" tile.
- Helpers: `src/lib/reimbursements.ts`.
```

- [ ] **Step 5: `AGENTS.md`**

In Hard rule 6, change `(see migration 011)` to `(see migrations 011 and 012)`. Do not edit `CLAUDE.md` (it is a symlink to `AGENTS.md`).

- [ ] **Step 6: `CHANGELOG.md` and `ROADMAP.md`**

In `CHANGELOG.md` under `[Unreleased]` → `### Added`, add above the payments entry:

```md
- **Reimbursements and claims.** Record money that came back for expenses you already booked (an employer claim, a friend's share of a bill, a shop refund) as a Reimbursement allocated to one or more expenses. It is never income, and the original expense is reported at its true cost in its own month and category. Flag an expense as "Expecting reimbursement" to see what is still owed (badge, "Awaiting reimbursement" filter, dashboard tile). A reimbursed expense can't be deleted or cut below what was repaid until the reimbursement is edited. A refund can land on the credit card that was charged. Lent-money accounts now read "Owes you".
```

Replace the earlier "Drafted the reimbursements and receivables spec" `### Documentation` bullet with:

```md
- Specified and planned reimbursements (`docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md`, `docs/superpowers/plans/2026-10-13-reimbursements.md`).
```

In `ROADMAP.md`:
- Tick the item: `- [x] Reimbursements & claims: money back that explicitly offsets an original expense (pairing),` and keep its two continuation lines (spec link without "(draft)").
- In the planned table row 1 change the status cell to `🟢 (shipped, awaiting release)` and the spec cell to `credit limit ✅ · payments ✅ · reimbursements ✅`, and move the **Credit & debt behavior** phase into *Shipped* only when the release is cut (per `RELEASING.md`); until then leave it in *Planned* with every box ticked.
- Update the **Next up** line at the top to `**Next up:** Investment value` and note under **Last shipped** that Credit & debt behavior is complete and unreleased.

In the spec, change `**Status:** Draft: awaiting review` to `**Status:** Approved — implemented per the plan`.

- [ ] **Step 7: Final verification**

Run every gate:

```bash
npm run build
npm test
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib --locked && cargo build --locked && cd ..
git diff --exit-code src/generated/seed-catalog.json && echo "seed catalog unchanged"
```

Expected: build clean, all Vitest tests pass, all Rust tests pass (including `seed_catalog_json_is_fresh`), the desktop build succeeds, and `seed catalog unchanged` prints.

Then run `npm run tauri dev` once and repeat the Task 9 smoke test against real SQLite: create an expense with an expectation, reimburse it, check the dashboard month total drops, try to delete the expense (blocked), delete the reimbursement, delete the expense. Close the app.

- [ ] **Step 8: Commit**

```bash
git add docs AGENTS.md CHANGELOG.md ROADMAP.md
git commit -m "docs: document reimbursements and mark the roadmap item shipped"
```

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| `reimbursement` kind, CHECK, postings to the `expense` bucket | 1 (CHECK), 2 (`postings_for`), 6 (TS) |
| `reimbursement_allocations` table, sum and cap invariants | 1, 2, 3 |
| `expected_reimbursement_cents` column and outstanding | 1, 3, 7 |
| Migration 012 copies `postings`/`transaction_splits` first | 1 |
| Any active account may receive, including the charged card | 2 (test), 8 (test) |
| True-cost reporting in the original month and category | 4, 8 |
| Split offset by largest remainder | 4 (`apportion`), 7, 8 |
| Excluded expenses not double-subtracted | 4, 8 |
| Reimbursement is never income, ignored by day net | 4, 10 (`effectiveCents` totals, `dayNet`) |
| Guards: delete, shrink, retype, edit-only-via-own-form | 3, 8 |
| `create`/`update_reimbursement`, `set_expected_reimbursement`, `get_awaiting_reimbursement` | 2–5, 8 |
| Add Transaction fourth segment, "Applies to" picker, balanced footer | 9 |
| Expense "Expecting reimbursement" toggle | 9 |
| Quick entry from an expense | 9, 10 |
| Badges, detail panel, filter, dashboard tile | 10 |
| `lent` "Owes you" | 7, 10 |
| Bulk actions treat a reimbursement like a transfer (delete only) | 6 |
| Factory reset clears allocations | 1 |
| Docs, CHANGELOG, ROADMAP | 11 |

Two spec items are intentionally absent: a `receivable` subtype and seed regeneration (the `lent` subtype already exists), and extending `create_expense`/`update_transaction` with the expectation (replaced by `set_expected_reimbursement`). The spec was corrected to match.

**Placeholder scan:** every code step contains the full code. The only prose-described edits are mechanical (adding `...reimbDefaults()` to eight named `Transaction` literals in the mock, and three named fixture lines in tests), each with the exact location named.

**Type consistency:** `Allocation` (Rust) ↔ `TxnAllocation` (TS) both `{expenseId, amountCents}`; `AwaitingReimbursement {count, totalCents}` matches on both sides; command names (`create_reimbursement_transaction`, `update_reimbursement_transaction`, `set_expected_reimbursement`, `get_awaiting_reimbursement`) match across `commands.rs`, `lib.rs`, `client/index.ts`, and `mock.ts`; `update_transaction_row` gains `expected_reimbursement_cents` before `now` in Task 1 and is called with that shape in Tasks 1 and 3.
