# Non-cashflow Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening balances real `opening` transactions (dropping the `accounts.opening_balance_cents` column) and let any income/expense be flagged `excludedFromReporting`, so both are excluded from the dashboard's income/expense/cashflow/spending the same way `transfer`/`adjustment` already are.

**Architecture:** Hybrid model. A new structural `opening` transaction kind (exactly one per account, always-present, never-deletable, signed) replaces the stored column; `Account.openingBalanceCents` survives as a *derived* read from that row. A boolean `excluded_from_reporting` column on `transactions` covers reimbursements/repayments. The balance engine collapses to a pure sum of signed history. Spec: `docs/superpowers/specs/2026-06-01-non-cashflow-transactions-design.md`.

**Tech Stack:** Tauri v2 (Rust, rusqlite), React 19 + TypeScript + Vite, SQLite. Tests: `cargo test --lib`, Vitest.

> **Breaking change.** Migration 001 is edited in place (deliberately overriding the append-only convention — safe because there are no production users). Old local databases must be deleted before running v0.5.0; an in-app factory reset does NOT reshape tables.

> **Seam rule (CLAUDE.md):** every backend behavior change lands in BOTH the Rust chain and `src/client/mock.ts`. The frontend block enforces this.

---

## File map

**Rust (`src-tauri/src/`)**
- `db/migrations.rs` — drop `opening_balance_cents`; add `excluded_from_reporting`; new `kind` CHECK incl. `opening`.
- `models.rs` — `KIND_OPENING` const; `excluded_from_reporting` on `Transaction` + `UpdateTransactionInput`.
- `repo.rs` — `balance_expr` rewrite; derived `opening_balance_cents` in account SELECTs; `insert_account` loses the column; new `account_has_nonopening_activity` + `set_opening_amount`; `insert_transaction`/`update_transaction_row`/`map_transaction`/`sum_kind_in_range`/`spending_breakdown` gain the flag.
- `service.rs` — `create_account` inserts the opening row; `create_income`/`create_expense` accept the flag; `set_account_balance` split; `update_transaction` carries the flag.
- `commands.rs` — `create_income_transaction`/`create_expense_transaction` accept `excluded_from_reporting`.
- `lib.rs`, `db/mod.rs` — fix raw test INSERTs referencing the dropped column; add new tests.

**Frontend (`src/`)**
- `types.ts` — `TransactionKind` += `"opening"`; `excludedFromReporting` on `Transaction` + `UpdateTransactionInput`.
- `lib/kinds.ts` — `KIND_META.opening`; `signedFor` opening; `computeRunningBalances` starts at 0 (drops param).
- `components/Icon.tsx` — new `flag` glyph.
- `theme/tokens.ts` — already has the `opening` token (no change; verify).
- `client/index.ts` — `createIncome`/`createExpense` pass the flag.
- `client/mock.ts` — opening-txn parity across balance/create/update/set-balance/dashboard.
- `modals/AddTransaction.tsx` — money-movement toggle.
- `components/TxnRow.tsx` — opening label + "Excluded" badge.
- `screens/Transactions.tsx` — `KIND_FILTERS` += `"opening"`.
- `__tests__/kinds.test.ts`, `__tests__/mock.test.ts` — new/updated assertions.

---

## Task 1: Rust data layer (schema → models → repo → service → commands)

Rust will not compile until all layers agree, so this is one task ending green. Work top-down.

**Files:**
- Modify: `src-tauri/src/db/migrations.rs:83-94` (accounts), `:111-127` (transactions)
- Modify: `src-tauri/src/models.rs:10-13`, `:73-86`, `:123-135`
- Modify: `src-tauri/src/repo.rs` (balance_expr, account SELECTs, insert_account, helpers, transaction fns)
- Modify: `src-tauri/src/service.rs` (create_account, create_income/expense, set_account_balance, update_transaction, dashboard)
- Modify: `src-tauri/src/commands.rs:119-125`
- Modify: `src-tauri/src/lib.rs:468-473`, `src-tauri/src/db/mod.rs:220-228` (raw test INSERTs)

- [ ] **Step 1: Edit `accounts` CREATE — drop the column**

In `src-tauri/src/db/migrations.rs`, remove this line from the `accounts` table (line 89):

```
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 2: Edit `transactions` CREATE — add `opening` kind, the flag column, and the new CHECK**

Replace the `transactions` `CREATE TABLE` block (lines 111-127) with:

```sql
CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment', 'opening')),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL,
  description      TEXT,
  transaction_date TEXT NOT NULL,
  excluded_from_reporting INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_reporting IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (kind IN ('income', 'expense') AND amount_cents > 0  AND to_account_id IS NULL     AND category_id IS NOT NULL) OR
    (kind = 'transfer'   AND amount_cents > 0  AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0) OR
    (kind = 'opening'    AND                       to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0)
  )
);
```

(The index block immediately below — `idx_tx_date` … `idx_tx_kind` — is unchanged.)

- [ ] **Step 3: Add the `KIND_OPENING` constant**

In `src-tauri/src/models.rs`, after line 13 (`pub const KIND_ADJUSTMENT: &str = "adjustment";`) add:

```rust
pub const KIND_OPENING: &str = "opening";
```

- [ ] **Step 4: Add `excluded_from_reporting` to the `Transaction` struct**

In `src-tauri/src/models.rs`, in `struct Transaction` (lines 73-86), add the field after `transaction_date`:

```rust
    pub transaction_date: String,
    pub excluded_from_reporting: bool,
    pub created_at: String,
```

- [ ] **Step 5: Add `excluded_from_reporting` to `UpdateTransactionInput`**

In `src-tauri/src/models.rs`, in `struct UpdateTransactionInput`, add (with a serde default so existing callers/tests stay valid):

```rust
    pub transaction_date: String,
    #[serde(default)]
    pub excluded_from_reporting: bool,
```

- [ ] **Step 6: Rewrite `balance_expr` (drop the column term, add `opening`)**

In `src-tauri/src/repo.rs`, replace the body of `balance_expr` (lines 10-19) with:

```rust
fn balance_expr(a: &str) -> String {
    format!(
        "COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='income'     AND account_id={a}.id),0) \
         + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='opening'    AND account_id={a}.id),0) \
         + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='transfer'   AND to_account_id={a}.id),0) \
         + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='adjustment' AND account_id={a}.id),0) \
         - COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='expense'    AND account_id={a}.id),0) \
         - COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind='transfer'   AND account_id={a}.id),0)"
    )
}
```

- [ ] **Step 7: Add a derived `opening_balance_cents` to both account SELECTs**

`map_account` still does `r.get("opening_balance_cents")`, but `a.*` no longer provides it — so the SELECTs must alias it. In `get_account` (lines 134-145), replace the SQL string with:

```rust
    let sql = format!(
        "SELECT a.*, COALESCE(s.type, 'fund') AS account_type, COALESCE(s.account_group, 'own') AS \"group\", \
         COALESCE((SELECT amount_cents FROM transactions WHERE account_id = a.id AND kind = 'opening' LIMIT 1), 0) AS opening_balance_cents, \
         ({}) AS balance_cents \
         FROM accounts a LEFT JOIN account_subtypes s ON s.key = a.subtype WHERE a.id = ?1",
        balance_expr("a")
    );
```

In `list_accounts` (lines 147-157), replace the SQL string with:

```rust
    let sql = format!(
        "SELECT a.*, COALESCE(s.type, 'fund') AS account_type, COALESCE(s.account_group, 'own') AS \"group\", \
         COALESCE((SELECT amount_cents FROM transactions WHERE account_id = a.id AND kind = 'opening' LIMIT 1), 0) AS opening_balance_cents, \
         ({}) AS balance_cents \
         FROM accounts a LEFT JOIN account_subtypes s ON s.key = a.subtype {} ORDER BY a.created_at",
        balance_expr("a"),
        if include_archived { "" } else { "WHERE a.is_archived = 0" }
    );
```

(`map_account` is unchanged — it reads the aliased `opening_balance_cents`.)

- [ ] **Step 8: `insert_account` loses the column**

In `src-tauri/src/repo.rs`, replace `insert_account` (lines 116-132) with:

```rust
pub fn insert_account(
    conn: &Connection,
    id: &str,
    template_key: Option<&str>,
    name: &str,
    subtype: &str,
    now: &str,
) -> AppResult<Account> {
    conn.execute(
        "INSERT INTO accounts
           (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'MYR', 0, ?5, ?5)",
        params![id, template_key, name, subtype, now],
    )?;
    get_account(conn, id)
}
```

- [ ] **Step 9: Replace `account_has_transactions` with `account_has_nonopening_activity`; add `set_opening_amount`**

In `src-tauri/src/repo.rs`, replace `account_has_transactions` (lines 159-165) with:

```rust
pub fn account_has_nonopening_activity(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM transactions WHERE kind <> 'opening' AND (account_id = ?1 OR to_account_id = ?1))",
        [id],
        |r| r.get(0),
    )?)
}

pub fn set_opening_amount(conn: &Connection, account_id: &str, amount_cents: i64, now: &str) -> AppResult<Account> {
    let n = conn.execute(
        "UPDATE transactions SET amount_cents = ?2, updated_at = ?3 WHERE account_id = ?1 AND kind = 'opening'",
        params![account_id, amount_cents, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Opening transaction not found".into()));
    }
    get_account(conn, account_id)
}
```

- [ ] **Step 10: `update_account_fields` edits the opening row, not a column**

In `src-tauri/src/repo.rs`, in `update_account_fields`, replace the `opening_balance_cents` branch (lines 181-183) with:

```rust
    if let Some(o) = opening_balance_cents {
        conn.execute(
            "UPDATE transactions SET amount_cents = ?2, updated_at = ?3 WHERE id = (SELECT id FROM transactions WHERE account_id = ?1 AND kind = 'opening' LIMIT 1)",
            params![id, o, now],
        )?;
    }
```

- [ ] **Step 11: Thread the flag through `insert_transaction`, `map_transaction`, `update_transaction_row`**

In `src-tauri/src/repo.rs`:

`map_transaction` (lines ~360-371) — add after `transaction_date`:

```rust
        transaction_date: r.get("transaction_date")?,
        excluded_from_reporting: r.get::<_, i64>("excluded_from_reporting")? != 0,
        created_at: r.get("created_at")?,
```

`insert_transaction` (lines 374-395) — add the param + column:

```rust
#[allow(clippy::too_many_arguments)]
pub fn insert_transaction(
    conn: &Connection,
    id: &str,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: Option<&str>,
    amount_cents: i64,
    description: Option<&str>,
    transaction_date: &str,
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting as i64, now],
    )
    .map_err(map_check)?;
    get_transaction(conn, id)
}
```

`update_transaction_row` (lines 405-429) — add the param + SET:

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
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    let n = conn
        .execute(
            "UPDATE transactions SET kind=?2, account_id=?3, to_account_id=?4, category_id=?5,
               amount_cents=?6, description=?7, transaction_date=?8, excluded_from_reporting=?9, updated_at=?10 WHERE id=?1",
            params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting as i64, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    get_transaction(conn, id)
}
```

- [ ] **Step 12: Add the flag to `sum_kind_in_range` and `spending_breakdown`**

In `src-tauri/src/repo.rs`, `sum_kind_in_range` (lines 480-487) SQL → add the flag clause:

```rust
        "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
         WHERE kind = ?1 AND excluded_from_reporting = 0 AND transaction_date >= ?2 AND transaction_date < ?3",
```

`spending_breakdown` (lines 489-497) WHERE → add the flag clause:

```rust
         WHERE t.kind = 'expense' AND t.excluded_from_reporting = 0 AND t.transaction_date >= ?1 AND t.transaction_date < ?2
```

- [ ] **Step 13: `service::create_account` inserts the opening transaction**

In `src-tauri/src/service.rs`, replace the body of `create_account` (the `repo::insert_account(...)` tail, lines 48-56) with:

```rust
    let name = require_nonempty("Account name", name)?;
    let subtype = require_nonempty("Subtype", subtype)?;
    if !repo::subtype_exists(conn, &subtype)? {
        return Err(AppError::Validation(format!("Invalid subtype: {subtype}")));
    }
    if let Some(key) = template_key {
        repo::get_template(conn, key)?; // existence (NotFound if bogus)
    }
    let account_id = new_id();
    repo::insert_account(conn, &account_id, template_key, &name, &subtype, &now())?;
    repo::insert_transaction(
        conn,
        &new_id(),
        KIND_OPENING,
        &account_id,
        None,
        None,
        opening_balance_cents,
        Some("Opening balance"),
        &crate::today(),
        false,
        &now(),
    )?;
    repo::get_account(conn, &account_id)
```

- [ ] **Step 14: `create_income` / `create_expense` accept and pass the flag; `create_transfer`/adjustment pass `false`**

In `src-tauri/src/service.rs`, replace `create_income` and `create_expense` (lines 302-314) with:

```rust
pub fn create_income(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str, excluded_from_reporting: bool) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_INCOME)?;
    repo::insert_transaction(conn, &new_id(), KIND_INCOME, account_id, None, Some(category_id), amount_cents, description, date, excluded_from_reporting, &now())
}

pub fn create_expense(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str, excluded_from_reporting: bool) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_EXPENSE)?;
    repo::insert_transaction(conn, &new_id(), KIND_EXPENSE, account_id, None, Some(category_id), amount_cents, description, date, excluded_from_reporting, &now())
}
```

In `create_transfer` (line 323), add the `false` arg before `&now()`:

```rust
    repo::insert_transaction(conn, &new_id(), KIND_TRANSFER, from_account_id, Some(to_account_id), None, amount_cents, description, date, false, &now())
```

- [ ] **Step 15: Rewrite `set_account_balance` for the opening/adjustment split**

In `src-tauri/src/service.rs`, replace `set_account_balance` (lines 95-121) with:

```rust
pub fn set_account_balance(conn: &Connection, account_id: &str, real_balance_cents: i64) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot reconcile an archived account".into()));
    }
    if !repo::account_has_nonopening_activity(conn, account_id)? {
        // Only the opening row exists — edit it so the balance equals the target.
        return repo::set_opening_amount(conn, account_id, real_balance_cents, &now());
    }
    let diff = real_balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let today = crate::today();
    repo::insert_transaction(
        conn,
        &new_id(),
        KIND_ADJUSTMENT,
        account_id,
        None,
        None,
        diff,
        Some("Balance adjustment"),
        &today,
        false,
        &now(),
    )?;
    repo::get_account(conn, account_id)
}
```

- [ ] **Step 16: `update_transaction` carries the flag (income/expense only)**

In `src-tauri/src/service.rs`, in `update_transaction`, compute the effective flag and pass it. After the `let (to_account_id, category_id) = match … ;` block (ends line 361), change the final `repo::update_transaction_row(...)` call (lines 363-374) to:

```rust
    let excluded = matches!(input.kind.as_str(), KIND_INCOME | KIND_EXPENSE) && input.excluded_from_reporting;

    repo::update_transaction_row(
        conn,
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
    )
```

- [ ] **Step 17: Commands accept `excluded_from_reporting`**

In `src-tauri/src/commands.rs`, replace the two create commands (lines 119-125) with:

```rust
#[tauri::command]
pub fn create_income_transaction(state: State<'_, DbState>, account_id: String, category_id: String, amount_cents: i64, description: Option<String>, date: String, excluded_from_reporting: bool) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_income(&c, &account_id, &category_id, amount_cents, description.as_deref(), &date, excluded_from_reporting))
}

#[tauri::command]
pub fn create_expense_transaction(state: State<'_, DbState>, account_id: String, category_id: String, amount_cents: i64, description: Option<String>, date: String, excluded_from_reporting: bool) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_expense(&c, &account_id, &category_id, amount_cents, description.as_deref(), &date, excluded_from_reporting))
}
```

(Keep the `#[tauri::command]` attribute exactly as it appears above each fn in the file.)

- [ ] **Step 18: Fix the two raw test INSERTs that name the dropped column**

In `src-tauri/src/db/mod.rs`, the migration_002 test (lines 220-228) inserts with `opening_balance_cents`. Replace the `execute_batch` block with the column removed:

```rust
        conn.execute_batch(
            "INSERT INTO accounts (id,template_key,name,account_type,subtype,currency,is_archived,created_at,updated_at) VALUES
               ('1',NULL,'Bank','bank','savings','MYR',0,'t','t'),
               ('2',NULL,'BNPL','bnpl','bnpl','MYR',0,'t','t'),
               ('3',NULL,'Wallet','ewallet','ewallet','MYR',0,'t','t'),
               ('4',NULL,'Inv','investment','investment','MYR',0,'t','t'),
               ('5',NULL,'Weird','custom','totally-custom','MYR',0,'t','t'),
               ('6',NULL,'OldDigital','digital_bank','legacy-thing','MYR',0,'t','t');",
        )
        .unwrap();
```

In `src-tauri/src/lib.rs`, the `account_with_unknown_subtype_still_lists` test (lines 467-480) inserts an account with `opening_balance_cents, 100` and expects balance 100. Replace the `c.execute(...)` insert (lines 468-473) with an insert that omits the column plus an explicit opening transaction so the balance is still 100:

```rust
        c.execute(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
             VALUES ('orphan', NULL, 'Mystery', 'gone-subtype', 'MYR', 0, 't', 't')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
             VALUES ('orphan-open', 'opening', 'orphan', NULL, NULL, 100, 'Opening balance', '2026-05-01', 0, 't', 't')",
            [],
        )
        .unwrap();
```

- [ ] **Step 19: Build and run existing Rust tests**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo build 2>&1 | tail -20 && cargo test --lib 2>&1 | tail -30
```
Expected: compiles clean; all existing tests PASS. In particular `balance_correction_no_txns_edits_opening` and `balance_correction_with_txns_inserts_adjustment` still pass (the derived `opening_balance_cents` equals the opening row's amount).

- [ ] **Step 20: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src-tauri/
git commit -m "feat(backend): opening balance as a transaction + excluded_from_reporting flag

Breaking schema change (migration 001 edited): drop accounts.opening_balance_cents,
add transactions.excluded_from_reporting, add the 'opening' kind. Balance engine sums
signed history; opening_balance_cents is now derived. set_account_balance edits the
opening row on fresh accounts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust tests for the new behavior

**Files:**
- Modify: `src-tauri/src/lib.rs` (append tests inside the existing `#[cfg(test)] mod tests` block, before its closing brace near line 252)

- [ ] **Step 1: Add the new tests**

Add these tests after `balance_correction_with_txns_inserts_adjustment` (or anywhere inside `mod tests`):

```rust
    #[test]
    fn create_account_inserts_one_opening_transaction() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 10000);
        let txns = service::list_transactions(&c, TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() }).unwrap();
        let openings: Vec<_> = txns.iter().filter(|t| t.kind == "opening").collect();
        assert_eq!(openings.len(), 1, "exactly one opening transaction");
        assert_eq!(openings[0].amount_cents, 10000);
        assert_eq!(a.opening_balance_cents, 10000); // derived
        assert_eq!(a.balance_cents, 10000);
    }

    #[test]
    fn owe_account_opening_is_negative() {
        let c = open_in_memory().unwrap();
        // credit-card is an 'owe' subtype; a negative opening means money owed.
        let a = service::create_account(&c, "Visa", "credit-card", -50000, None).unwrap();
        assert_eq!(a.group, "owe");
        assert_eq!(a.balance_cents, -50000);
        assert_eq!(service::get_dashboard_summary(&c, "2026-05").unwrap().liabilities_cents, -50000);
    }

    #[test]
    fn excluded_income_and_expense_skip_the_dashboard() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        // a real income, plus a reimbursement flagged as non-cashflow
        service::create_income(&c, &a.id, &income_cat(&c), 5000, None, "2026-05-10", false).unwrap();
        service::create_income(&c, &a.id, &income_cat(&c), 1200, None, "2026-05-11", true).unwrap();
        // a real expense, plus a repayment flagged as non-cashflow
        service::create_expense(&c, &a.id, &expense_cat(&c), 700, None, "2026-05-12", false).unwrap();
        service::create_expense(&c, &a.id, &expense_cat(&c), 300, None, "2026-05-13", true).unwrap();
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.income_cents, 5000, "flagged income excluded");
        assert_eq!(s.expense_cents, 700, "flagged expense excluded");
        // but balances still reflect every row: 0 +5000 +1200 -700 -300 = 5200
        assert_eq!(s.net_worth_cents, 5200);
    }

    #[test]
    fn check_rejects_flag_on_non_income_expense() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let b = acct(&c, "Savings", 0);
        // Raw insert bypassing the service: a transfer with the flag set must violate the CHECK.
        let res = c.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
             VALUES ('x', 'transfer', ?1, ?2, NULL, 100, NULL, '2026-05-10', 1, 't', 't')",
            rusqlite::params![a.id, b.id],
        );
        assert!(res.is_err(), "flag on a transfer must be rejected by the CHECK");
    }

    #[test]
    fn editing_opening_balance_moves_the_balance_without_new_rows() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 1000);
        let updated = service::update_account(&c, UpdateAccountInput {
            id: a.id.clone(), name: None, subtype: None, opening_balance_cents: Some(7500),
        }).unwrap();
        assert_eq!(updated.opening_balance_cents, 7500);
        assert_eq!(updated.balance_cents, 7500);
        let txns = service::list_transactions(&c, TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() }).unwrap();
        assert_eq!(txns.iter().filter(|t| t.kind == "opening").count(), 1, "still exactly one opening row");
        assert_eq!(txns.len(), 1, "no extra rows created");
    }
```

- [ ] **Step 2: Run the new tests**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib 2>&1 | tail -30
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src-tauri/src/lib.rs
git commit -m "test(backend): opening transaction + excluded_from_reporting coverage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend — types, kinds, icon

This and Tasks 4-5 form the frontend block; `npm run build` is gated at the end of Task 5 (the `opening`/flag type changes ripple through mock + modal first).

**Files:**
- Modify: `src/types.ts:5`, `:58-69`, `:81-90`
- Modify: `src/lib/kinds.ts:9-22`, `:28-35`, `:52-71`
- Modify: `src/components/Icon.tsx:6-11`, paths object
- Verify (no change): `src/theme/tokens.ts` already defines the `opening` token.

- [ ] **Step 1: `types.ts` — new kind + flag**

Line 5:
```typescript
export type TransactionKind = "income" | "expense" | "transfer" | "adjustment" | "opening";
```

In `interface Transaction` (lines 58-69), add after `transactionDate`:
```typescript
  transactionDate: string;
  excludedFromReporting: boolean;
  createdAt: string;
```

In `interface UpdateTransactionInput` (lines 81-90), add after `transactionDate`:
```typescript
  transactionDate: string;
  excludedFromReporting: boolean;
```

- [ ] **Step 2: `Icon.tsx` — add the `flag` glyph**

In `src/components/Icon.tsx`, add `"flag"` to the `IconName` union (line 11, end):
```typescript
  | "alertCircle" | "info" | "flag";
```

In the `paths` object (after the `sliders` entry, line 36), add:
```tsx
    flag: <path {...P} d="M6 21V4M6 4h11l-2.2 4L17 12H6" />,
```

- [ ] **Step 3: `kinds.ts` — KIND_META, signedFor, running balances**

In `src/lib/kinds.ts`, widen the `colorKey` type (line 12):
```typescript
  colorKey: keyof Pick<Theme, "income" | "expense" | "transfer" | "adjustment" | "opening">;
```

Add the `opening` entry to `KIND_META` (after the `adjustment` line, line 21):
```typescript
  adjustment: { label: "Balance adjustment", icon: "sliders", colorKey: "adjustment", sign: 0 },
  opening: { label: "Opening balance", icon: "flag", colorKey: "opening", sign: 0 },
```

In `signedFor` (lines 29-35), add an `opening` case alongside `adjustment`:
```typescript
export function signedFor(kind: TransactionKind, amountCents: number, isDestination = false): number {
  if (kind === "income") return amountCents;
  if (kind === "expense") return -amountCents;
  if (kind === "adjustment" || kind === "opening") return amountCents; // already signed
  // transfer
  return isDestination ? amountCents : -amountCents;
}
```

Change `computeRunningBalances` (lines 52-71) to drop the `openingBalanceCents` param and start at 0 (the opening row is now part of `txns`):
```typescript
export function computeRunningBalances(
  txns: Transaction[],
  accountId: string,
): Map<string, number> {
  const sorted = [...txns].sort((a, b) => {
    const ka = txnSortKey(a);
    const kb = txnSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const map = new Map<string, number>();
  let running = 0;
  for (const tx of sorted) {
    const isDest = tx.toAccountId === accountId;
    running += signedFor(tx.kind, tx.amountCents, isDest);
    map.set(tx.id, running);
  }
  return map;
}
```
Also update the doc comment above it (lines 42-50): replace the "Start from the account's openingBalanceCents" bullet with "Start from 0 — the account's `opening` transaction is the first row and carries the starting balance."

- [ ] **Step 4: Update `computeRunningBalances` callers**

Find every caller and remove the third argument:
```bash
grep -rn "computeRunningBalances" src
```
Each call site (e.g. in `src/screens/Accounts.tsx` and/or `src/screens/Transactions.tsx`) currently passes `(txns, accountId, account.openingBalanceCents)` — change to `(txns, accountId)`. Ensure the `txns` passed includes that account's `opening` row (the existing per-account fetch already returns all of its transactions, so no change beyond dropping the arg).

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/types.ts src/lib/kinds.ts src/components/Icon.tsx src/screens/
git commit -m "feat(frontend): opening kind + excludedFromReporting types, KIND_META, flag icon

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — mock backend parity

Mirror every Task 1 behavior in `src/client/mock.ts`.

**Files:**
- Modify: `src/client/mock.ts:115-155` (balanceOf, hydrate, seedDemo), `:165-203` (create/update/set-balance), `:293-368` (txn create/dashboard)

- [ ] **Step 1: `balanceOf` + `hydrate` use the opening row**

Replace `balanceOf` (lines 115-127) and the `hydrate`/`hasTxns` helpers (lines 128-132) with:

```typescript
function balanceOf(a: Account): number {
  let b = 0;
  for (const t of txns) {
    if (t.kind === "opening" && t.accountId === a.id) b += t.amountCents;
    else if (t.kind === "income" && t.accountId === a.id) b += t.amountCents;
    else if (t.kind === "expense" && t.accountId === a.id) b -= t.amountCents;
    else if (t.kind === "adjustment" && t.accountId === a.id) b += t.amountCents;
    else if (t.kind === "transfer") {
      if (t.accountId === a.id) b -= t.amountCents;
      if (t.toAccountId === a.id) b += t.amountCents;
    }
  }
  return b;
}
const openingOf = (id: string): number => txns.find((t) => t.kind === "opening" && t.accountId === id)?.amountCents ?? 0;
const hydrate = (a: Account): Account => {
  const s = subtypeOf(a.subtype);
  return { ...a, accountType: s?.type ?? "fund", group: s?.group ?? "own", openingBalanceCents: openingOf(a.id), balanceCents: balanceOf(a) };
};
const hasActivity = (id: string) => txns.some((t) => t.kind !== "opening" && (t.accountId === id || t.toAccountId === id));
```

- [ ] **Step 2: `seedDemo` creates opening rows**

Replace `mk` and the demo transaction literals in `seedDemo` (lines 136-153) with versions that (a) create an opening row per account and (b) carry `excludedFromReporting`:

```typescript
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    const s = subtypeOf(t.defaultSubtype)!;
    const id = uid();
    accounts.push({ id, templateKey: key, name, accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: opening, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
    txns.push({ id: uid(), kind: "opening", accountId: id, toAccountId: null, categoryId: null, amountCents: opening, description: "Opening balance", transactionDate: "2026-01-01", createdAt: now(), updatedAt: now(), excludedFromReporting: false });
  };
  mk("maybank", "Maybank Savings", 842000);
  mk("tng-ewallet", "Touch 'n Go", 12750);
  mk("stashaway", "StashAway", 1860000);
  const cat = (n: string) => categories.find((c) => c.name === n)!.id;
  const add = (kind: Transaction["kind"], acc: number, amt: number, catName: string | null, desc: string, date: string, to?: number) =>
    txns.push({ id: uid(), kind, accountId: accounts[acc].id, toAccountId: to != null ? accounts[to].id : null, categoryId: catName ? cat(catName) : null, amountCents: amt, description: desc, transactionDate: date, createdAt: now(), updatedAt: now(), excludedFromReporting: false });
```

(The `d(...)` date helper and the six `add(...)` demo rows below are unchanged.)

- [ ] **Step 3: `create_account` inserts an opening row**

Replace the `create_account` case (lines 165-172) with:

```typescript
    case "create_account": {
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const s = subtypeOf(a.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.subtype}`);
      if (a.templateKey != null && !templates.find((x) => x.key === a.templateKey)) fail("NotFound", "Account template not found");
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), createdAt: now(), updatedAt: now(), excludedFromReporting: false });
      return hydrate(acc) as T;
    }
```

- [ ] **Step 4: `update_account` edits the opening row**

In the `update_account` case, replace the opening-balance line (line 184) with:

```typescript
      if (a.input.openingBalanceCents != null) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.input.openingBalanceCents;
      }
```

- [ ] **Step 5: `set_account_balance` split**

Replace the `set_account_balance` case (lines 194-203) with:

```typescript
    case "set_account_balance": {
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (!hasActivity(acc.id)) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.realBalanceCents;
      } else {
        const diff = a.realBalanceCents - balanceOf(acc);
        if (diff !== 0) txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), createdAt: now(), updatedAt: now(), excludedFromReporting: false });
      }
      return hydrate(acc) as T;
    }
```

- [ ] **Step 6: Transaction create handlers carry the flag**

Replace the income/expense and transfer create cases (lines 293-309) with:

```typescript
    case "create_income_transaction":
    case "create_expense_transaction": {
      const kind = command === "create_income_transaction" ? "income" : "expense";
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const tx: Transaction = { id: uid(), kind, accountId: a.accountId, toAccountId: null, categoryId: a.categoryId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now(), excludedFromReporting: !!a.excludedFromReporting };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_transfer_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot transfer to the same account");
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now(), excludedFromReporting: false };
      txns.unshift(tx);
      return tx as T;
    }
```

- [ ] **Step 7: `update_transaction` guards opening + normalizes the flag**

Replace the `update_transaction` case (lines 320-326) with:

```typescript
    case "update_transaction": {
      const i = txns.findIndex((t) => t.id === a.input.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind === "adjustment" || txns[i].kind === "opening" || a.input.kind === "adjustment" || a.input.kind === "opening") fail("ValidationError", "Adjustments cannot be edited");
      const excluded = (a.input.kind === "income" || a.input.kind === "expense") && !!a.input.excludedFromReporting;
      txns[i] = { ...txns[i], ...a.input, excludedFromReporting: excluded, updatedAt: now() };
      return txns[i] as T;
    }
```

- [ ] **Step 8: Dashboard excludes flagged income/expense**

In the `get_dashboard_summary` case, update the income, expense, and breakdown filters (lines 344-351):

```typescript
      const income = txns.filter((t) => t.kind === "income" && !t.excludedFromReporting && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const expense = txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const parentOf = (cid: string) => categories.find((x) => x.id === cid)?.parentId ?? cid;
      const byCat = new Map<string, number>();
      txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).forEach((t) => {
        const pid = parentOf(t.categoryId!);
        byCat.set(pid, (byCat.get(pid) ?? 0) + t.amountCents);
      });
```

- [ ] **Step 9: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/client/mock.ts
git commit -m "feat(mock): opening-transaction + excludedFromReporting parity with Rust

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — client wrapper, Add/Edit modal, row badge, filter

**Files:**
- Modify: `src/client/index.ts:51-54`
- Modify: `src/modals/AddTransaction.tsx`
- Modify: `src/components/TxnRow.tsx:21-27`, render
- Modify: `src/screens/Transactions.tsx:17`

- [ ] **Step 1: `client/index.ts` — pass the flag**

Replace `createIncome`/`createExpense` (lines 51-54) with:

```typescript
  createIncome: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string, excludedFromReporting = false) =>
    dispatch<Transaction>("create_income_transaction", { accountId, categoryId, amountCents, description, date, excludedFromReporting }),
  createExpense: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string, excludedFromReporting = false) =>
    dispatch<Transaction>("create_expense_transaction", { accountId, categoryId, amountCents, description, date, excludedFromReporting }),
```

- [ ] **Step 2: `AddTransaction.tsx` — money-movement toggle**

Add a state hook after the `desc` state (line 25):
```typescript
  const [excluded, setExcluded] = useState(editing?.excludedFromReporting ?? false);
```

In `submit()`, pass the flag. Replace the `editing` / income / expense branches (lines 44-57) with:
```typescript
      if (editing) {
        await client.updateTransaction({
          id: editing.id, kind, accountId,
          toAccountId: kind === "transfer" ? toAccountId : null,
          categoryId: kind === "transfer" ? null : effectiveCat,
          amountCents: cents, description: desc.trim() || null, transactionDate: date,
          excludedFromReporting: kind === "transfer" ? false : excluded,
        });
      } else if (kind === "income") {
        await client.createIncome(accountId, effectiveCat, cents, desc.trim() || null, date, excluded);
      } else if (kind === "expense") {
        await client.createExpense(accountId, effectiveCat, cents, desc.trim() || null, date, excluded);
      } else {
        await client.createTransfer(accountId, toAccountId, cents, desc.trim() || null, date);
      }
```

Add the toggle UI for income/expense only, immediately before the `{error && ...}` line (line 141):
```tsx
        {kind !== "transfer" && (
          <button type="button" onClick={() => setExcluded((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: `0.5px solid ${t.border}`, background: excluded ? hexA(t.opening, 0.12) : t.panel2, cursor: "pointer", textAlign: "left" }}>
            <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", background: excluded ? t.opening : "transparent", border: `1.5px solid ${excluded ? t.opening : t.faint}`, flexShrink: 0 }}>
              {excluded && <Icon name="check" size={12} color="#fff" stroke={3} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Money movement</div>
              <div style={{ fontSize: 11, color: t.faint }}>Affects balances but excluded from income/expense reports</div>
            </span>
          </button>
        )}
```

- [ ] **Step 3: `TxnRow.tsx` — opening label/subtitle + Excluded badge**

In `TxnRow`, update the subtitle branch (lines 24-27) so `opening` shows the account name like `adjustment`:
```tsx
  let subtitle: string;
  if (tx.kind === "transfer") subtitle = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`;
  else if (tx.kind === "adjustment" || tx.kind === "opening") subtitle = accName(tx.accountId);
  else subtitle = `${cat?.name ?? ""} · ${accName(tx.accountId)}`;
```

Render an "Excluded" badge next to the title when flagged. Replace the title `<div>` (line 41) with:
```tsx
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
          {tx.excludedFromReporting && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: t.opening, background: hexA(t.opening, 0.14), padding: "1px 5px", borderRadius: 5 }}>
              <Icon name="flag" size={9} color={t.opening} stroke={2.4} /> Excluded
            </span>
          )}
        </div>
```
Add the imports this needs at the top of the file:
```tsx
import { Icon } from "./Icon";
import { hexA } from "../theme/tokens";
```

- [ ] **Step 4: `Transactions.tsx` — filterable opening kind**

Line 17:
```typescript
const KIND_FILTERS: TransactionKind[] = ["income", "expense", "transfer", "adjustment", "opening"];
```

- [ ] **Step 5: Build + typecheck + run frontend tests**

```bash
cd /Users/jimmyhew/Documents/Sens
npm run build 2>&1 | tail -20
npm test 2>&1 | tail -30
```
Expected: `tsc` clean (strict, no unused), `vite build` succeeds. Vitest: existing tests may need the Task 6 updates — if any fail purely due to the new `excludedFromReporting` field or the `computeRunningBalances` signature, proceed to Task 6 and re-run there. A clean build is the gate for this task.

- [ ] **Step 6: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/client/index.ts src/modals/AddTransaction.tsx src/components/TxnRow.tsx src/screens/Transactions.tsx
git commit -m "feat(frontend): money-movement toggle, opening row label, Excluded badge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend tests

**Files:**
- Modify: `src/__tests__/kinds.test.ts`
- Modify: `src/__tests__/mock.test.ts`

- [ ] **Step 1: Inspect the existing tests for signature drift**

```bash
grep -n "computeRunningBalances\|openingBalanceCents\|signedFor" src/__tests__/kinds.test.ts
grep -n "set_account_balance\|setAccountBalance\|opening\|excluded" src/__tests__/mock.test.ts
```
Update any `computeRunningBalances(txns, accId, opening)` call to drop the third arg. Because the per-account txn list in these tests must now include an `opening` row to reproduce a starting balance, add one where a test previously relied on `openingBalanceCents`.

- [ ] **Step 2: Add `kinds.test.ts` cases**

Append:
```typescript
import { signedFor, computeRunningBalances } from "../lib/kinds";
import type { Transaction } from "../types";

function tx(partial: Partial<Transaction>): Transaction {
  return { id: Math.random().toString(36).slice(2), kind: "expense", accountId: "a", toAccountId: null, categoryId: "c", amountCents: 0, description: null, transactionDate: "2026-05-01", excludedFromReporting: false, createdAt: "t", updatedAt: "t", ...partial };
}

describe("opening kind", () => {
  it("signedFor returns the opening amount as-is (already signed)", () => {
    expect(signedFor("opening", 5000)).toBe(5000);
    expect(signedFor("opening", -5000)).toBe(-5000);
  });

  it("computeRunningBalances starts at 0 with the opening row first", () => {
    const txns = [
      tx({ id: "open", kind: "opening", categoryId: null, amountCents: 10000, transactionDate: "2026-05-01", createdAt: "1" }),
      tx({ id: "inc", kind: "income", categoryId: "c", amountCents: 2500, transactionDate: "2026-05-02", createdAt: "2" }),
      tx({ id: "exp", kind: "expense", categoryId: "c", amountCents: 500, transactionDate: "2026-05-03", createdAt: "3" }),
    ];
    const map = computeRunningBalances(txns, "a");
    expect(map.get("open")).toBe(10000);
    expect(map.get("inc")).toBe(12500);
    expect(map.get("exp")).toBe(12000);
  });
});
```

- [ ] **Step 3: Add a `mock.test.ts` case for the flag exclusion**

Append a test that a flagged expense affects balance but not the dashboard (adapt the file's existing `client`/`freshAccount` helpers):
```typescript
describe("excludedFromReporting", () => {
  it("a flagged expense moves balance but is excluded from the dashboard", async () => {
    const acc = await freshAccount("Flagged", 10000);
    const cats = await client.listCategories("expense", false);
    await client.createExpense(acc.id, cats[0].id, 700, null, "2026-05-10", false);
    await client.createExpense(acc.id, cats[0].id, 300, null, "2026-05-11", true); // money movement
    const refreshed = (await client.listAccounts(false)).find((x) => x.id === acc.id)!;
    expect(refreshed.balanceCents).toBe(9000); // 10000 - 700 - 300
    const s = await client.getDashboardSummary("2026-05");
    expect(s.expenseCents).toBe(700); // flagged 300 excluded
  });
});
```
Adjust `client.listCategories` / `client.listAccounts` / `client.getDashboardSummary` names to match the actual wrappers in `src/client/index.ts` (check with `grep -n "listCategories\|listAccounts\|getDashboardSummary" src/client/index.ts`).

- [ ] **Step 4: Run frontend tests**

```bash
cd /Users/jimmyhew/Documents/Sens
npm test 2>&1 | tail -30
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/__tests__/
git commit -m "test(frontend): opening running-balance + excludedFromReporting exclusion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Docs + full-stack verification

**Files:**
- Modify: `CLAUDE.md` (money/balances section)
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `CLAUDE.md`**

In the "Money, balances, and transaction kinds" section, update:
- `kind` set: `income | expense | transfer | adjustment | opening`.
- State that **opening balance is a transaction** (the `opening` kind — exactly one per account, signed, never-deletable) and that `accounts.opening_balance_cents` was **dropped**; `Account.openingBalanceCents` is now **derived** from the opening row. Balances are opening + signed history with no stored column.
- Add the **`excludedFromReporting`** flag: an `income`/`expense` row flagged as money movement is excluded from dashboard income/expense/net-cashflow/spending, like transfer/adjustment.
- Note `set_account_balance` now edits the opening row on accounts with no non-opening activity, else inserts an adjustment.
- Add a note that **v0.5.0 is a breaking schema change** (migration 001 edited in place; old DBs must be deleted).

- [ ] **Step 2: Update `ROADMAP.md`**

- Flip `v0.5.0` to 🟢 in the table and the "Shipped" list with the spec link `docs/superpowers/specs/2026-06-01-non-cashflow-transactions-design.md`.
- Update the header "Last shipped / Next" line.
- Tick the `v0.5.0` checklist items that this delivers (non-cashflow flag; dashboard honors it). Note that opening-balance-as-transaction shipped as the foundational pillar.

- [ ] **Step 3: Update `CHANGELOG.md`**

Add a `[Unreleased]` entry (the release script rolls it):
```markdown
### Added
- Opening balances are now real `opening` transactions, so every account's history
  fully reconciles to its balance.
- Income/expense can be flagged **money movement** (`excludedFromReporting`) — affects
  balances but excluded from income/expense/cashflow/spending reports.

### Changed
- **BREAKING (schema):** dropped `accounts.opening_balance_cents`; added the `opening`
  transaction kind and `transactions.excluded_from_reporting`. No upgrade path from
  pre-0.5.0 — delete the local database (an in-app factory reset does not reshape
  tables) before running this version.
```

- [ ] **Step 4: Full verification**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/jimmyhew/Documents/Sens
npm run build 2>&1 | tail -15
npm test 2>&1 | tail -15
cd src-tauri && cargo test --lib 2>&1 | tail -15 && cargo build 2>&1 | tail -5
```
Expected: frontend build clean, Vitest green, Rust tests green, desktop binary compiles (validates Tauri command registration with the new `excluded_from_reporting` args).

- [ ] **Step 5: Manual smoke (optional, real app)**

`npm run tauri dev`, then: create an account with an opening balance → confirm one "Opening balance" row appears in its history and the balance reconciles; add an expense flagged "Money movement" → confirm the dashboard expense total ignores it but the account balance drops.

- [ ] **Step 6: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add CLAUDE.md ROADMAP.md CHANGELOG.md
git commit -m "docs: v0.5.0 non-cashflow transactions (CLAUDE.md, ROADMAP, CHANGELOG)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (coverage)

- **Pillar 1 (opening kind):** Task 1 steps 1-2, 6-15; tests in Task 2; frontend in Tasks 3-5.
- **Pillar 2 (flag):** Task 1 steps 2, 4-5, 11-12, 14, 16-17; tests in Task 2/6; UI in Task 5.
- **Derived `openingBalanceCents`:** Task 1 step 7 (Rust) + Task 4 step 1 (mock).
- **Breaking migration:** Task 1 steps 1-2, 18; docs in Task 7.
- **Seam parity:** Task 4 mirrors every Task 1 backend behavior.
- **Type consistency:** `excluded_from_reporting`/`excludedFromReporting` and `KIND_OPENING`/`"opening"` used consistently across layers; `insert_transaction` gains its flag param everywhere it is called (create_income/expense/transfer in service, create_account + set_account_balance adjustment).
- **Release** (separate, user-triggered): cut `v0.5.0` via the `release` skill after this lands.
