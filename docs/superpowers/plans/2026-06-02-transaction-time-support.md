# Transaction Time Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, Settings-gated time-of-day to transactions so same-day entries sort chronologically and the actual time is captured and shown.

**Architecture:** Add a nullable `transaction_time TEXT` (`"HH:MM"`, 24-hour) column to `transactions` via a plain `ALTER TABLE ADD COLUMN` (migration 007 — no table rebuild, because migration 006's `postings` FK has `ON DELETE CASCADE`). A new `transaction_time_enabled` app setting (default off) controls whether the time field is shown/required. Time is user-supplied like the date and threaded UI → client → commands → service → repo, mirrored in the dev mock. Sorting honors time as the tiebreaker between date and `created_at` in both the SQL `ORDER BY` and the frontend `txnSortKey`.

**Tech Stack:** Tauri v2 (Rust, rusqlite/SQLite), React 19 + TypeScript + Vite, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-02-transaction-time-support-design.md`

**Commands reference (Rust needs `export PATH="$HOME/.cargo/bin:$PATH"` first):**
- Frontend tests: `npx vitest run <file>`
- Frontend gate: `npm run build`
- Rust tests: `cd src-tauri && cargo test --lib`
- Rust compile: `cd src-tauri && cargo build`

---

## File Structure

**Backend (Rust):**
- `src-tauri/src/db/migrations.rs` — add `MIGRATION_007` + register it.
- `src-tauri/src/models.rs` — add `transaction_time` to `Transaction` and `UpdateTransactionInput`.
- `src-tauri/src/repo.rs` — `map_transaction`, `insert_transaction`, `update_transaction_row`, `list_transactions` ORDER BY.
- `src-tauri/src/service.rs` — thread time through create/update + `transaction_time_enabled` validation; pass `None` from opening/adjustment inserts.
- `src-tauri/src/commands.rs` — add `time` params to the three create commands.
- `src-tauri/src/lib.rs` — update existing test call sites + add new tests.

**Frontend:**
- `src/types.ts` — `transactionTime` on `Transaction` + `UpdateTransactionInput`.
- `src/client/index.ts` — pass `time` through the three create wrappers.
- `src/client/mock.ts` — mirror column, params, validation, sort.
- `src/lib/format.ts` — `fmtTime`, `nowTimeHHMM` helpers.
- `src/lib/kinds.ts` — `txnSortKey` time tiebreaker.
- `src/lib/useTimeSetting.ts` (new) — `useTimeSetting()` hook.
- `src/screens/Settings.tsx` — the toggle row.
- `src/modals/AddTransaction.tsx` — gated time input.
- `src/components/TxnDetailPanel.tsx` — gated time input.
- `src/components/TxnRow.tsx` — show time when present.

**Tests:**
- `src/__tests__/format.test.ts` — extend with `fmtTime`.
- `src/__tests__/txnTime.test.ts` (new) — `txnSortKey` tiebreaker + mock validation.

---

## Task 1: Migration 007 — add the column

**Files:**
- Modify: `src-tauri/src/db/migrations.rs:6` (the `MIGRATIONS` array) and add a new constant.
- Test: `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`).

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/lib.rs` inside `mod tests` (after the existing transaction tests):

```rust
    #[test]
    fn migration_007_adds_nullable_time_column() {
        let c = open_in_memory().unwrap();
        // Column exists and defaults to NULL for rows created without a time.
        let a = acct(&c, "Checking", 1000);
        let txns = service::list_transactions(
            &c,
            TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() },
        )
        .unwrap();
        assert!(txns.iter().all(|t| t.transaction_time.is_none()));
        // The postings backfilled by migration 006 survive (no cascade delete).
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0))
            .unwrap();
        assert!(n >= 2, "opening transaction still has its two postings");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_007_adds_nullable_time_column`
Expected: FAIL — `transaction_time` is not a field on `Transaction` (compile error). That is the expected red state for this task.

- [ ] **Step 3: Add the migration**

In `src-tauri/src/db/migrations.rs`, change line 6 to register migration 7:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007)];
```

Add this constant near the other `MIGRATION_00X` constants (e.g. directly above `const MIGRATION_006`):

```rust
// v-next — transaction time support. Adds a nullable `transaction_time` column
// ("HH:MM", 24-hour) to `transactions`. A plain ADD COLUMN is used (NOT a table
// rebuild): the column participates in no CHECK, and migration 006 added
// `postings.transaction_id ... ON DELETE CASCADE`, so a rebuild would
// cascade-delete every posting. Existing rows get NULL.
const MIGRATION_007: &str = r#"
ALTER TABLE transactions ADD COLUMN transaction_time TEXT;
"#;
```

(The `transaction_time` field referenced by the test is added in Task 2; this task is committed together with Task 2 since they compile as a unit. Proceed to Task 2 before running the suite green.)

- [ ] **Step 4: Commit happens at the end of Task 2** (the two are one compile unit).

---

## Task 2: Backend model, repo, service, commands

**Files:**
- Modify: `src-tauri/src/models.rs` (Transaction, UpdateTransactionInput)
- Modify: `src-tauri/src/repo.rs` (`map_transaction`, `insert_transaction`, `update_transaction_row`, `list_transactions`)
- Modify: `src-tauri/src/service.rs` (create_income/expense/transfer, update_transaction, opening + adjustment insert call sites, new helpers)
- Modify: `src-tauri/src/commands.rs` (three create commands)
- Modify: `src-tauri/src/lib.rs` (fix existing call sites)

- [ ] **Step 1: Add the model fields**

In `src-tauri/src/models.rs`, find the `Transaction` struct and add a field (place it right after `transaction_date`):

```rust
    pub transaction_time: Option<String>,
```

Find `UpdateTransactionInput` and add the same field after its `transaction_date`:

```rust
    pub transaction_time: Option<String>,
```

(Both structs already derive `serde` with `rename_all = "camelCase"`, so this serializes as `transactionTime`.)

- [ ] **Step 2: Map the column in repo**

In `src-tauri/src/repo.rs`, in `map_transaction` (around line 379), add after the `transaction_date` line:

```rust
        transaction_time: r.get("transaction_time")?,
```

- [ ] **Step 3: Thread time through `insert_transaction`**

In `src-tauri/src/repo.rs`, change `insert_transaction` (around line 387). Add a `transaction_time: Option<&str>` parameter after `transaction_date: &str`, and update the SQL:

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
    transaction_time: Option<&str>,
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting as i64, now],
    )
    .map_err(map_check)?;
    get_transaction(conn, id)
}
```

- [ ] **Step 4: Thread time through `update_transaction_row`**

In `src-tauri/src/repo.rs`, change `update_transaction_row` (around line 453). Add `transaction_time: Option<&str>` after `transaction_date: &str`, and update the SQL:

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
    now: &str,
) -> AppResult<Transaction> {
    let n = conn
        .execute(
            "UPDATE transactions SET kind=?2, account_id=?3, to_account_id=?4, category_id=?5,
               amount_cents=?6, description=?7, transaction_date=?8, transaction_time=?9, excluded_from_reporting=?10, updated_at=?11 WHERE id=?1",
            params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting as i64, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    get_transaction(conn, id)
}
```

- [ ] **Step 5: Update the list ORDER BY**

In `src-tauri/src/repo.rs`, `list_transactions` (line 511), change:

```rust
    sql.push_str(" ORDER BY transaction_date DESC, transaction_time DESC NULLS LAST, created_at DESC");
```

- [ ] **Step 6: Add service time helpers**

In `src-tauri/src/service.rs`, add these helpers near `validate_positive` (around line 380):

```rust
const SETTING_TIME_ENABLED: &str = "transaction_time_enabled";

fn time_enabled(conn: &Connection) -> AppResult<bool> {
    Ok(repo::get_setting(conn, SETTING_TIME_ENABLED)?.as_deref() == Some("1"))
}

fn validate_hhmm(s: &str) -> AppResult<()> {
    let bad = || AppError::Validation("Time must be in HH:MM 24-hour format".into());
    let (h, m) = s.split_once(':').ok_or_else(bad)?;
    if h.len() != 2 || m.len() != 2 {
        return Err(bad());
    }
    let h: u32 = h.parse().map_err(|_| bad())?;
    let m: u32 = m.parse().map_err(|_| bad())?;
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok(())
}

/// Resolve the time to store on a CREATE. When the setting is on, a valid time
/// is required; when off, any supplied time is ignored and NULL is stored.
fn resolve_create_time(conn: &Connection, time: Option<&str>) -> AppResult<Option<String>> {
    if !time_enabled(conn)? {
        return Ok(None);
    }
    let t = time
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation("A time is required".into()))?;
    validate_hhmm(t)?;
    Ok(Some(t.to_string()))
}
```

- [ ] **Step 7: Thread time into the create services**

In `src-tauri/src/service.rs`, update the three create functions to accept `time: Option<&str>` and resolve it. `create_income` (line 387):

```rust
pub fn create_income(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, excluded_from_reporting: bool) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_INCOME)?;
    let time = resolve_create_time(conn, time)?;
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_INCOME, account_id, None, Some(category_id), amount_cents, description, date, time.as_deref(), excluded_from_reporting, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}
```

`create_expense` (line 398) — same shape with `KIND_EXPENSE`:

```rust
pub fn create_expense(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, excluded_from_reporting: bool) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_EXPENSE)?;
    let time = resolve_create_time(conn, time)?;
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_EXPENSE, account_id, None, Some(category_id), amount_cents, description, date, time.as_deref(), excluded_from_reporting, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}
```

`create_transfer` (line 409):

```rust
pub fn create_transfer(conn: &Connection, from_account_id: &str, to_account_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    if from_account_id == to_account_id {
        return Err(AppError::Validation("Cannot transfer to the same account".into()));
    }
    ensure_active_account(conn, from_account_id, "source")?;
    ensure_active_account(conn, to_account_id, "destination")?;
    let time = resolve_create_time(conn, time)?;
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_TRANSFER, from_account_id, Some(to_account_id), None, amount_cents, description, date, time.as_deref(), false, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}
```

- [ ] **Step 8: Resolve time in `update_transaction`**

In `src-tauri/src/service.rs`, `update_transaction` (line 427). After the `let excluded = ...` line (463), resolve the time — required when on, otherwise **preserve the existing value** (so flipping the setting off never wipes stored times):

```rust
    let excluded = matches!(input.kind.as_str(), KIND_INCOME | KIND_EXPENSE) && input.excluded_from_reporting;

    let time: Option<String> = if time_enabled(conn)? {
        let t = input
            .transaction_time
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Validation("A time is required".into()))?;
        validate_hhmm(t)?;
        Some(t.to_string())
    } else {
        existing.transaction_time.clone()
    };
```

Then pass `time.as_deref()` into the `repo::update_transaction_row` call (after `&input.transaction_date`):

```rust
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
        time.as_deref(),
        excluded,
        &now(),
    )?;
```

- [ ] **Step 9: Pass `None` from opening + adjustment inserts**

In `src-tauri/src/service.rs`, the `create_account` opening insert (around line 109) and the `set_account_balance` adjustment insert (around line 190) both call `repo::insert_transaction`. Add `None` for the new `transaction_time` argument (positioned right after the date argument) at both call sites. Structural rows never carry a time.

- [ ] **Step 10: Add the `time` param to the three create commands**

In `src-tauri/src/commands.rs` (lines 119–130), add `time: Option<String>` after `date: String` on each command and forward it. Example for income:

```rust
pub fn create_income_transaction(state: State<'_, DbState>, account_id: String, category_id: String, amount_cents: i64, description: Option<String>, date: String, time: Option<String>, excluded_from_reporting: bool) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_income(&c, &account_id, &category_id, amount_cents, description.as_deref(), &date, time.as_deref(), excluded_from_reporting))
}
```

Do the same for `create_expense_transaction` (forward to `create_expense`) and `create_transfer_transaction` (forward to `create_transfer`, no `excluded_from_reporting`).

- [ ] **Step 11: Fix existing Rust test call sites**

In `src-tauri/src/lib.rs`, every existing call to `service::create_income`, `create_expense` (8 args now incl. time) and `create_transfer` (7 args now) needs `None` inserted as the time argument **after the date string**. Update each call site (lines 113, 114, 123, 132, 140, 148, 164, 195–198, 209, and any others the compiler flags). Example:

```rust
        service::create_income(&c, &a.id, &income_cat(&c), 5000, None, "2026-05-10", None, false).unwrap();
        service::create_expense(&c, &a.id, &expense_cat(&c), 2000, None, "2026-05-11", None, false).unwrap();
        service::create_transfer(&c, &a.id, &b.id, 4000, None, "2026-05-10", None).unwrap();
```

Let the compiler enumerate the rest: `cargo build` will list each arity mismatch.

- [ ] **Step 12: Run the suite green**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS, including `migration_007_adds_nullable_time_column`.

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add transaction_time column, settings-gated time on transactions"
```

---

## Task 3: Backend validation tests (required-when-on, format, preserve-on-off)

**Files:**
- Test: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/lib.rs` inside `mod tests`:

```rust
    fn enable_time(conn: &rusqlite::Connection) {
        service::set_setting(conn, "transaction_time_enabled", "1").unwrap();
    }

    #[test]
    fn time_required_when_setting_on() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        enable_time(&c);
        // Missing time → rejected.
        assert!(service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", None, false).is_err());
        // Valid time → stored.
        let t = service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", Some("08:15"), false).unwrap();
        assert_eq!(t.transaction_time.as_deref(), Some("08:15"));
        // Bad format → rejected.
        assert!(service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", Some("8:1"), false).is_err());
        assert!(service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", Some("25:00"), false).is_err());
    }

    #[test]
    fn time_ignored_when_setting_off() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        // Setting off (default): supplied time is dropped to NULL.
        let t = service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", Some("08:15"), false).unwrap();
        assert_eq!(t.transaction_time, None);
    }

    #[test]
    fn update_preserves_time_when_setting_off() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        enable_time(&c);
        let t = service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10", Some("08:15"), false).unwrap();
        // Turn the setting off, then edit without a time → existing time preserved.
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        let updated = service::update_transaction(&c, UpdateTransactionInput {
            id: t.id.clone(), kind: "expense".into(), account_id: a.id.clone(), to_account_id: None,
            category_id: Some(expense_cat(&c)), amount_cents: 200, description: None,
            transaction_date: "2026-05-10".into(), transaction_time: None, excluded_from_reporting: false,
        }).unwrap();
        assert_eq!(updated.transaction_time.as_deref(), Some("08:15"));
    }
```

- [ ] **Step 2: Run to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib time_`
Expected: PASS (implementation from Task 2 already satisfies these). If `update_preserves_time_when_setting_off` fails, re-check Step 8 of Task 2.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "test(backend): cover transaction time validation and preservation"
```

---

## Task 4: Frontend types + client wrappers

**Files:**
- Modify: `src/types.ts:66` and `:90`
- Modify: `src/client/index.ts:51-56`

- [ ] **Step 1: Add the type fields**

In `src/types.ts`, add to `Transaction` after `transactionDate: string;` (line 66):

```typescript
  transactionTime: string | null;
```

Add the same line to `UpdateTransactionInput` after its `transactionDate: string;` (line 90):

```typescript
  transactionTime: string | null;
```

- [ ] **Step 2: Thread time through the create wrappers**

In `src/client/index.ts`, update the three create wrappers (lines 51–56) to accept and forward `time`:

```typescript
  createIncome: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string, time: string | null = null, excludedFromReporting = false) =>
    dispatch<Transaction>("create_income_transaction", { accountId, categoryId, amountCents, description, date, time, excludedFromReporting }),
  createExpense: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string, time: string | null = null, excludedFromReporting = false) =>
    dispatch<Transaction>("create_expense_transaction", { accountId, categoryId, amountCents, description, date, time, excludedFromReporting }),
  createTransfer: (fromAccountId: string, toAccountId: string, amountCents: number, description: string | null, date: string, time: string | null = null) =>
    dispatch<Transaction>("create_transfer_transaction", { fromAccountId, toAccountId, amountCents, description, date, time }),
```

> NOTE: `createIncome`/`createExpense` now take `time` BEFORE `excludedFromReporting`. The existing call in `src/screens/Transactions.tsx` (the duplicate action, lines 191–195) passes `excludedFromReporting` positionally and MUST be updated in Task 9 — keep that in mind; the build will flag it.

- [ ] **Step 3: Verify typecheck (expected to fail at known call sites)**

Run: `npm run build`
Expected: FAIL — `mock.ts` and the duplicate-action call sites don't yet match. These are fixed in Tasks 5 & 9. Do not commit yet; this task is committed together with Task 5.

---

## Task 5: Mock parity

**Files:**
- Modify: `src/client/mock.ts` (tx creation seeds, `createIncome`/`createExpense`/`createTransfer` handlers, `listTransactions` sort, `updateTransaction`, plus the validation helper)

- [ ] **Step 1: Add `transactionTime` to every seeded/created transaction object**

In `src/client/mock.ts`, every object literal that builds a transaction currently omits `transactionTime`. Add `transactionTime: null` to the seed/opening/adjustment literals at lines 139, 146, 171, 205. For example line 139 becomes:

```typescript
    txns.push({ id: uid(), kind: "opening", accountId: id, toAccountId: null, categoryId: null, amountCents: opening, description: "Opening balance", transactionDate: "2026-01-01", transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false });
```

Apply the same `transactionTime: null` addition to lines 146, 171, and 205.

- [ ] **Step 2: Add a time-resolution helper**

In `src/client/mock.ts`, near the top (after the `settings` map at line 114), add:

```typescript
function timeEnabled(): boolean {
  return settings.get("transaction_time_enabled") === "1";
}
function isHHMM(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59;
}
function resolveCreateTime(time: unknown): string | null {
  if (!timeEnabled()) return null;
  const t = typeof time === "string" ? time.trim() : "";
  if (!t) throw appError("ValidationError", "A time is required");
  if (!isHHMM(t)) throw appError("ValidationError", "Time must be in HH:MM 24-hour format");
  return t;
}
```

> Use whatever the file's existing error-throwing helper is named. Search the file for how other validations throw (e.g. an `appError`/`err`/`throwApp` function or a thrown object `{ code, message }`) and match it exactly.

- [ ] **Step 3: Resolve time in the create handlers**

In the `createIncome`/`createExpense` handler (the block building `tx` at line 308) and the `createTransfer` handler (line 315), compute the time and set it on the object:

```typescript
      const transactionTime = resolveCreateTime(a.time);
      const tx: Transaction = { id: uid(), kind, accountId: a.accountId, toAccountId: null, categoryId: a.categoryId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: !!a.excludedFromReporting };
```

And for the transfer handler (line 315):

```typescript
      const transactionTime = resolveCreateTime(a.time);
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false };
```

- [ ] **Step 4: Preserve/require time in `updateTransaction`**

In the `updateTransaction` handler (line 338–339), replace the merge with logic that requires when on and preserves when off:

```typescript
      const excluded = (a.input.kind === "income" || a.input.kind === "expense") && !!a.input.excludedFromReporting;
      let transactionTime = txns[i].transactionTime;
      if (timeEnabled()) {
        const t = typeof a.input.transactionTime === "string" ? a.input.transactionTime.trim() : "";
        if (!t) throw appError("ValidationError", "A time is required");
        if (!isHHMM(t)) throw appError("ValidationError", "Time must be in HH:MM 24-hour format");
        transactionTime = t;
      }
      txns[i] = { ...txns[i], ...a.input, transactionTime, excludedFromReporting: excluded, updatedAt: now() };
```

- [ ] **Step 5: Update `listTransactions` sort to honor time**

In `src/client/mock.ts`, the sort at line 326 currently keys on `transactionDate + createdAt`. Change it to include time (empty string for null sorts earliest, matching SQL `NULLS LAST` under DESC):

```typescript
      const key = (t: Transaction) => t.transactionDate + "\x00" + (t.transactionTime ?? "") + "\x00" + t.createdAt;
      out.sort((x, y) => (key(y) < key(x) ? -1 : 1));
```

- [ ] **Step 6: Verify typecheck**

Run: `npm run build`
Expected: FAIL only at `src/screens/Transactions.tsx` duplicate-action call (fixed in Task 9) and possibly modal/panel files (Tasks 7–8). The mock and types errors should be gone. If mock errors remain, fix them now.

- [ ] **Step 7: Commit (Tasks 4 + 5 together)**

```bash
git add src/types.ts src/client/index.ts src/client/mock.ts
git commit -m "feat(frontend): add transactionTime to types, client, and mock"
```

---

## Task 6: format helpers + sort key (with tests)

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/lib/kinds.ts:71-73`
- Test: `src/__tests__/format.test.ts`, `src/__tests__/txnTime.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/format.test.ts`:

```typescript
import { fmtTime, nowTimeHHMM } from "../lib/format";

describe("fmtTime", () => {
  it("formats 24h HH:MM as 12h with am/pm", () => {
    expect(fmtTime("08:15")).toBe("8:15 am");
    expect(fmtTime("00:00")).toBe("12:00 am");
    expect(fmtTime("12:00")).toBe("12:00 pm");
    expect(fmtTime("13:05")).toBe("1:05 pm");
    expect(fmtTime("23:59")).toBe("11:59 pm");
  });
  it("returns empty string for null", () => {
    expect(fmtTime(null)).toBe("");
  });
  it("nowTimeHHMM returns a valid HH:MM", () => {
    expect(/^\d{2}:\d{2}$/.test(nowTimeHHMM())).toBe(true);
  });
});
```

Create `src/__tests__/txnTime.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { txnSortKey } from "../lib/kinds";
import type { Transaction } from "../types";

function tx(p: Partial<Transaction>): Transaction {
  return {
    id: "x", kind: "expense", accountId: "a", toAccountId: null, categoryId: "c",
    amountCents: 100, description: null, transactionDate: "2026-05-10",
    transactionTime: null, createdAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z", excludedFromReporting: false, ...p,
  };
}

describe("txnSortKey time tiebreaker", () => {
  it("orders same-day rows by time ascending, nulls first", () => {
    const a = tx({ id: "a", transactionTime: null, createdAt: "2026-05-10T01:00:00Z" });
    const b = tx({ id: "b", transactionTime: "08:00", createdAt: "2026-05-10T02:00:00Z" });
    const c = tx({ id: "c", transactionTime: "20:00", createdAt: "2026-05-10T03:00:00Z" });
    const sorted = [c, b, a].sort((x, y) => (txnSortKey(x) < txnSortKey(y) ? -1 : 1));
    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
  it("falls back to createdAt when times are equal/absent", () => {
    const a = tx({ id: "a", transactionTime: null, createdAt: "2026-05-10T01:00:00Z" });
    const b = tx({ id: "b", transactionTime: null, createdAt: "2026-05-10T02:00:00Z" });
    const sorted = [b, a].sort((x, y) => (txnSortKey(x) < txnSortKey(y) ? -1 : 1));
    expect(sorted.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/__tests__/format.test.ts src/__tests__/txnTime.test.ts`
Expected: FAIL — `fmtTime`/`nowTimeHHMM` not exported; `txnSortKey` ignores time.

- [ ] **Step 3: Implement the format helpers**

In `src/lib/format.ts`, add:

```typescript
/** Format a 24-hour "HH:MM" string as 12-hour "h:mm am/pm". "" for null/blank. */
export function fmtTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  if (Number.isNaN(h)) return "";
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}

/** Current local time as a 24-hour "HH:MM" string. */
export function nowTimeHHMM(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

- [ ] **Step 4: Update `txnSortKey`**

In `src/lib/kinds.ts` (lines 70–73):

```typescript
/** Stable ascending sort key: date, then time (nulls earliest), then createdAt. */
export function txnSortKey(tx: Transaction): string {
  return tx.transactionDate + "\x00" + (tx.transactionTime ?? "") + "\x00" + tx.createdAt;
}
```

- [ ] **Step 5: Run tests green**

Run: `npx vitest run src/__tests__/format.test.ts src/__tests__/txnTime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts src/lib/kinds.ts src/__tests__/format.test.ts src/__tests__/txnTime.test.ts
git commit -m "feat(frontend): fmtTime/nowTimeHHMM helpers and time-aware txnSortKey"
```

---

## Task 7: `useTimeSetting` hook + Settings toggle

**Files:**
- Create: `src/lib/useTimeSetting.ts`
- Modify: `src/screens/Settings.tsx`

- [ ] **Step 1: Create the hook**

Create `src/lib/useTimeSetting.ts`:

```typescript
import { useEffect, useState } from "react";
import { client } from "../client";

/** Reads the `transaction_time_enabled` setting (default OFF). Returns [enabled, loaded]. */
export function useTimeSetting(): [boolean, boolean] {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => { setEnabled(v === "1"); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  return [enabled, loaded];
}
```

> Confirm the client import path matches the existing convention in Settings.tsx (it imports `client` — match that import exactly).

- [ ] **Step 2: Add the toggle to Settings**

In `src/screens/Settings.tsx`, mirror the existing `bulk_action_preview` pattern. After `handleBulkPreviewToggle` (line 229) add:

```typescript
  // transaction_time_enabled preference — default off (unset = off)
  const [timeEnabled, setTimeEnabled] = useState(false);

  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => setTimeEnabled(v === "1"))
      .catch(() => {});
  }, []);

  function handleTimeToggle(val: boolean) {
    setTimeEnabled(val);
    client.setSetting("transaction_time_enabled", val ? "1" : "0").catch(() => {});
  }
```

Then add a `SettingRow` next to the bulk-preview row (near line 284), matching the existing JSX shape:

```tsx
        <SettingRow
          label="Record transaction times"
          hint="Show a required time-of-day field when adding or editing transactions, and sort same-day transactions chronologically."
          right={<Toggle on={timeEnabled} onChange={handleTimeToggle} />}
        />
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run build`
Expected: still FAILs only at the modal/panel/duplicate call sites (Tasks 8–9). Settings should compile.

- [ ] **Step 4: Commit**

```bash
git add src/lib/useTimeSetting.ts src/screens/Settings.tsx
git commit -m "feat(frontend): settings toggle + hook for transaction times"
```

---

## Task 8: AddTransaction modal time field

**Files:**
- Modify: `src/modals/AddTransaction.tsx`

- [ ] **Step 1: Add state + the setting**

In `src/modals/AddTransaction.tsx`, import the helpers/hook at the top:

```typescript
import { parseAmountToCents, todayISO, nowTimeHHMM } from "../lib/format";
import { useTimeSetting } from "../lib/useTimeSetting";
```

(Adjust the existing `format` import to include `nowTimeHHMM`.) Add state next to the `date` state (line 27):

```typescript
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(editing?.transactionTime ?? nowTimeHHMM());
```

- [ ] **Step 2: Pass time to create/update calls**

In `submit()` (lines 45–59), pass `time` when the setting is on, else `null`. Define a local first:

```typescript
    const txTime = timeEnabled ? time : null;
```

Update the calls:

```typescript
      if (editing) {
        await client.updateTransaction({
          id: editing.id, kind, accountId,
          toAccountId: kind === "transfer" ? toAccountId : null,
          categoryId: kind === "transfer" ? null : effectiveCat,
          amountCents: cents, description: desc.trim() || null, transactionDate: date,
          transactionTime: txTime,
          excludedFromReporting: kind === "transfer" ? false : excluded,
        });
      } else if (kind === "income") {
        await client.createIncome(accountId, effectiveCat, cents, desc.trim() || null, date, txTime, excluded);
      } else if (kind === "expense") {
        await client.createExpense(accountId, effectiveCat, cents, desc.trim() || null, date, txTime, excluded);
      } else {
        await client.createTransfer(accountId, toAccountId, cents, desc.trim() || null, date, txTime);
      }
```

- [ ] **Step 3: Render the time input next to the date field**

At the date `<input>` (line 140), wrap date + time so the time input shows only when enabled. Match the surrounding markup/`inputStyle(t)`:

```tsx
          <input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} />
          {timeEnabled && (
            <input className="sens-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} />
          )}
```

> A native `<input type="time">` yields `"HH:MM"` (24-hour) — exactly the stored format. The browser renders it in the user's locale automatically.

- [ ] **Step 4: Verify typecheck**

Run: `npm run build`
Expected: FAILs only at `src/screens/Transactions.tsx` now.

- [ ] **Step 5: Commit**

```bash
git add src/modals/AddTransaction.tsx
git commit -m "feat(frontend): time field in Add/Edit Transaction modal"
```

---

## Task 9: TxnDetailPanel field, TxnRow display, and Transactions duplicate-call fix

**Files:**
- Modify: `src/components/TxnDetailPanel.tsx`
- Modify: `src/components/TxnRow.tsx`
- Modify: `src/screens/Transactions.tsx` (duplicate action call sites, lines 141 + 191–195)

- [ ] **Step 1: TxnDetailPanel — state, setting, input, save**

In `src/components/TxnDetailPanel.tsx`:

Imports:

```typescript
import { fmtDate, fmtMoney, fmtTime, nowTimeHHMM } from "../lib/format";
import { useTimeSetting } from "../lib/useTimeSetting";
```

State next to `date` (line 26):

```typescript
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(tx.transactionTime ?? nowTimeHHMM());
```

In the `updateTransaction` call (line 41–45), add the field:

```typescript
        amountCents: tx.amountCents, description: desc.trim() || null, transactionDate: date,
        transactionTime: timeEnabled ? time : tx.transactionTime,
```

Add a time input after the date `<input>` (line 104):

```tsx
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
              {timeEnabled && (
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={fieldStyle} />
              )}
```

In the read-only summary row (line 129), append the time when present:

```tsx
              <span style={{ color: t.dim }}>Date</span><span style={{ fontWeight: 600 }}>{fmtDate(tx.transactionDate)}{tx.transactionTime ? ` · ${fmtTime(tx.transactionTime)}` : ""}</span>
```

- [ ] **Step 2: TxnRow — show the time in the subtitle when present**

In `src/components/TxnRow.tsx`:

Import:

```typescript
import { fmtDate, fmtTime } from "../lib/format";
```

At the subtitle line (line 69), append time after the date when present:

```tsx
          {subtitle}{showDate ? ` · ${fmtDate(tx.transactionDate)}` : ""}{tx.transactionTime ? ` · ${fmtTime(tx.transactionTime)}` : ""}
```

> Time shows whenever the row HAS a time, independent of `showDate` — a row created while the setting was on still reads correctly even if the user later views it. No setting read needed here.

- [ ] **Step 3: Fix the Transactions duplicate-action call**

In `src/screens/Transactions.tsx`, the duplicate handler (lines 191–195) calls `createIncome`/`createExpense` with `excludedFromReporting` in the old positional slot. Insert `tx.transactionTime` before it:

```typescript
      await client.createIncome(tx.accountId, tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, tx.transactionTime, tx.excludedFromReporting);
      // (expense branch)
      await client.createExpense(tx.accountId, tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, tx.transactionTime, tx.excludedFromReporting);
      // (transfer branch)
      await client.createTransfer(tx.accountId, tx.toAccountId, tx.amountCents, tx.description, tx.transactionDate, tx.transactionTime);
```

Also check the inline edit object at line 141 (`transactionDate: tx.transactionDate, excludedFromReporting: tx.excludedFromReporting`) — add `transactionTime: tx.transactionTime,` so the `UpdateTransactionInput` it builds is complete:

```typescript
          transactionDate: tx.transactionDate, transactionTime: tx.transactionTime, excludedFromReporting: tx.excludedFromReporting,
```

- [ ] **Step 4: Full typecheck + test gate**

Run: `npm run build`
Expected: PASS (clean tsc + vite build).

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/components/TxnDetailPanel.tsx src/components/TxnRow.tsx src/screens/Transactions.tsx
git commit -m "feat(frontend): display + edit transaction time in detail panel, row, and duplicate"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update CLAUDE.md**

In the "Money, balances, and transaction kinds" section, add a bullet documenting transaction time: the nullable `transaction_time` column (`HH:MM`, 24-hour) added by **migration 007** via plain `ADD COLUMN` (note why no rebuild: postings `ON DELETE CASCADE`), the `transaction_time_enabled` app setting (default off; required-when-on, ignored-when-off, preserved-on-edit-when-off), the `ORDER BY ... transaction_time DESC NULLS LAST ...` sort and matching `txnSortKey`, and that `opening`/`adjustment` rows never carry a time. Update the migrations paragraph to mention migration 007.

- [ ] **Step 2: Update CHANGELOG.md**

Add under `[Unreleased]`:

```markdown
### Added
- Optional time-of-day on transactions, gated by a new Settings toggle ("Record transaction times", default off). When enabled, a required time field appears in Add/Edit Transaction (pre-filled with the current time) and same-day transactions sort chronologically.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: document transaction time support"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** column + migration (T1/T2), default-off setting (T7), required-when-on / ignored-when-off / format validation (T2/T3/T5), preserve-on-toggle-off (T2 step 8, T3, T5 step 4), sort tiebreaker SQL + frontend (T2 step 5, T6), 12h display / `fmtTime` (T6), prefill-now (T8/T9), gated inputs (T8/T9), opening/adjustment NULL time (T2 step 9), mock parity (T4/T5), tests (T3/T6), docs (T10). All covered.
- **Type consistency:** `transaction_time`/`transactionTime` used consistently; `time: Option<&str>` param order is always immediately after the date arg in Rust; client wrappers put `time` before `excludedFromReporting`, and the only existing positional caller (Transactions duplicate) is fixed in T9.
- **Known transient build failures** between tasks are called out explicitly (T3 step 3, T5 step 6, T7/T8) and resolved by T9 step 4.
