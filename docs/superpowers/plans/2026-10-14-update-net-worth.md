# Update Net Worth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Update Net Worth on fixed deposit, investment, unit trust, and crypto accounts, so typing a new balance writes the difference as an ordinary income or expense.

**Architecture:** Migration 014 adds two nullable category ids on `accounts`. Create and edit save them only for those four subtypes. `update_net_worth` subtracts the current balance from the typed balance and inserts one income or expense through the existing posting path. It does not call `set_account_balance`. The mock mirrors every rule. The screen is a modal beside Correct balance, plus two optional pickers on Add and Edit account.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-14-update-net-worth-design.md`. Implement that behavior. Do not add maturity dates, interest, holdings, prices, or a stored cost basis.
- Money is integer MYR sen. The account balance stays the sum of postings.
- Qualifying subtypes, exact keys: `fixed-deposit`, `investment`, `unit-trust`, `crypto`.
- Migration 014 is append-only. Do not edit migrations 001–013. Do not rebuild `transactions`. No backfill and no seed change. Do not edit `db/seed.rs` or `src/generated/seed-catalog.json`.
- Columns `gain_category_id` and `loss_category_id` are nullable text with no foreign key and no check. Existing rows are NULL.
- A rise (`diff > 0`) is `income` for `diff`. A drop (`diff < 0`) is `expense` for `diff.abs()`. `diff == 0` writes nothing and does not validate category or time.
- The row's description is exactly `Value update`. Date is `crate::today()`. `excluded_from_reporting` is false. No splits. Opening amount is never changed by this command.
- A saved category for that side wins. A category passed with it is ignored and is not written onto the account. With nothing saved, the passed category is required and is stored only on the row.
- The new balance is `>= 0`. The form does not accept a leading minus. Zero is allowed. Do not use `parseAmountToCents` for this field; it rejects zero.
- When Record transaction times is on and `diff != 0`, time is required (`HH:MM`). When it is off, the stored time is null even if a time was sent.
- Correct balance is unchanged, including the opening-row rewrite.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- Never hardcode colors. Use `useTheme()` tokens.
- Exact error text (Rust and mock match character for character):
  - `Cannot update an archived account` — Conflict
  - `Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.` — ValidationError
  - `Balance must be zero or more.` — ValidationError
  - `Pick a category for this update.` — ValidationError
  - `Gain category must be an income category.` — ValidationError
  - `Loss category must be an expense category.` — ValidationError
  - `Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.` — ValidationError
  - `That category can't be selected.` — ValidationError (existing system-category rule)
  - `A time is required` — ValidationError (existing `resolve_time`)
  - `Category not found` — NotFound (existing)
  - `Account not found` — NotFound (existing)
  - `In use by transactions — archive it instead` — Conflict (existing `delete_category`)
  - Kind mismatch on the value-update row uses the existing `validate_category_for` text: `Category kind '{kind}' does not match transaction kind '{kind}'`
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Keep `CHANGELOG.md` and `ROADMAP.md` current (Task 7).

---

## File Structure

Backend:
- `src-tauri/src/db/migrations.rs` — `MIGRATION_014`.
- `src-tauri/src/models.rs` — `Account` fields, `ValueCategories` on `UpdateAccountInput`.
- `src-tauri/src/repo.rs` — map the columns, `set_value_categories`, `clear_value_category`.
- `src-tauri/src/service.rs` — create/update rules, `delete_category` clear, `update_net_worth`.
- `src-tauri/src/commands.rs` and `src-tauri/src/lib.rs` — command args and `update_net_worth` registered. Tests live in `lib.rs` `mod tests`.

Frontend:
- `src/types.ts`, `src/client/index.ts`, `src/client/mock.ts` — fields, wrappers, mirrored rules.
- `src/lib/accounts.ts` — `subtypeHasValueUpdate`.
- `src/components/ValueCategoryFields.tsx` (new) — the two optional pickers.
- `src/modals/AddAccount.tsx`, `src/modals/EditAccount.tsx` — show the pickers for the four subtypes.
- `src/modals/UpdateNetWorth.tsx` (new) — the modal.
- `src/screens/Accounts.tsx` — the button.
- `src/__tests__/mock-update-net-worth.test.ts` (new) — mock contract tests.
- `src/__tests__/accountStats.test.ts` — Account fixture gains the two null fields.
- `docs/architecture/accounts.md`, `docs/architecture/transactions.md`, `CHANGELOG.md`, `ROADMAP.md`.

---

### Task 1: Migration 014 and Account fields

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/repo.rs`
- Modify: `src/types.ts`
- Modify: `src/client/mock.ts`
- Modify: `src/__tests__/accountStats.test.ts`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Account.gain_category_id` / `gainCategoryId` and `loss_category_id` / `lossCategoryId`, each `Option<String>` / `string | null`. New accounts read them as null. `repo::set_value_categories` and `repo::clear_value_category` exist but no service calls them yet.

- [ ] **Step 1: Write the failing test**

Add this test inside `mod tests` in `src-tauri/src/lib.rs`, next to `migration_009_creates_splits_table`:

```rust
#[test]
fn migration_014_adds_value_category_columns() {
    let c = open_in_memory().unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('accounts') WHERE name IN ('gain_category_id', 'loss_category_id')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
    let acc = service::create_account(&c, "Stash", "investment", 10_000, None, None).unwrap();
    assert_eq!(acc.gain_category_id, None);
    assert_eq!(acc.loss_category_id, None);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_014_adds_value_category_columns`

Expected: FAIL to compile (`gain_category_id` missing) or FAIL the count assertion.

- [ ] **Step 3: Add the migration, the fields, and the repo writes**

In `src-tauri/src/db/migrations.rs`, append `(14, MIGRATION_014)` to `MIGRATIONS` and add:

```rust
const MIGRATION_014: &str = r#"
ALTER TABLE accounts ADD COLUMN gain_category_id TEXT;
ALTER TABLE accounts ADD COLUMN loss_category_id TEXT;
"#;
```

On `Account` in `src-tauri/src/models.rs`, after `credit_limit_cents`:

```rust
pub gain_category_id: Option<String>,
pub loss_category_id: Option<String>,
```

In `map_account`, read both columns the same way as `credit_limit_cents`.

Add to `repo.rs`:

```rust
pub fn set_value_categories(
    conn: &Connection,
    id: &str,
    gain_category_id: Option<&str>,
    loss_category_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET gain_category_id = ?2, loss_category_id = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, gain_category_id, loss_category_id, now],
    )?;
    Ok(())
}

pub fn clear_value_category(conn: &Connection, category_id: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET gain_category_id = NULL, updated_at = ?2 WHERE gain_category_id = ?1",
        params![category_id, now],
    )?;
    conn.execute(
        "UPDATE accounts SET loss_category_id = NULL, updated_at = ?2 WHERE loss_category_id = ?1",
        params![category_id, now],
    )?;
    Ok(())
}
```

On `src/types.ts` `Account`, after `creditLimitCents`:

```ts
gainCategoryId: string | null;
lossCategoryId: string | null;
```

Set both to `null` on the two `accounts.push` object literals in `src/client/mock.ts` (the demo seed and `create_account`). In `src/__tests__/accountStats.test.ts` `acct`, add `gainCategoryId: null, lossCategoryId: null`. If `npm run build` names any other `Account` literal, add the same two nulls there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_014_adds_value_category_columns`

Expected: PASS.

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/lib.rs src/types.ts src/client/mock.ts src/__tests__/accountStats.test.ts
git commit -m "$(cat <<'EOF'
feat: store optional value categories on accounts

EOF
)"
```

---

### Task 2: Save the two categories on create and edit

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (every `create_account` call, and every `UpdateAccountInput` literal)
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `repo::set_value_categories` from Task 1.
- Produces: `service::create_account(..., gain_category_id: Option<&str>, loss_category_id: Option<&str>)`. `UpdateAccountInput.value_categories: Option<ValueCategories>`. `ValueCategories { gain_category_id: Option<String>, loss_category_id: Option<String> }` with serde `camelCase`, so the JSON key is `valueCategories`.

- [ ] **Step 1: Write the failing tests**

Add these tests in `mod tests`. They call the 8-argument `create_account` and set `value_categories` on update, so they will not compile until Step 3.

```rust
fn value_pair(gain: Option<&str>, loss: Option<&str>) -> ValueCategories {
    ValueCategories {
        gain_category_id: gain.map(str::to_string),
        loss_category_id: loss.map(str::to_string),
    }
}

#[test]
fn create_investment_saves_gain_and_loss_categories() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let loss = expense_cat(&c);
    let acc = service::create_account(&c, "Stash", "investment", 10_000, None, None, Some(&gain), Some(&loss)).unwrap();
    assert_eq!(acc.gain_category_id.as_deref(), Some(gain.as_str()));
    assert_eq!(acc.loss_category_id.as_deref(), Some(loss.as_str()));
}

#[test]
fn create_savings_rejects_a_value_category() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let err = service::create_account(&c, "Cash", "savings", 0, None, None, Some(&gain), None).unwrap_err();
    assert_eq!(
        validation_message(err),
        "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto."
    );
}

#[test]
fn gain_category_must_be_income_and_not_system() {
    let c = open_in_memory().unwrap();
    let expense = expense_cat(&c);
    let err = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&expense), None).unwrap_err();
    assert_eq!(validation_message(err), "Gain category must be an income category.");
    let system = service::list_categories(&c, Some("income"), true).unwrap()
        .into_iter().find(|cat| cat.is_system).unwrap();
    let err = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&system.id), None).unwrap_err();
    assert_eq!(validation_message(err), "That category can't be selected.");
}

#[test]
fn loss_category_must_be_expense() {
    let c = open_in_memory().unwrap();
    let income = income_cat(&c);
    let err = service::create_account(&c, "UT", "unit-trust", 0, None, None, None, Some(&income)).unwrap_err();
    assert_eq!(validation_message(err), "Loss category must be an expense category.");
}

#[test]
fn edit_can_set_clear_and_keep_value_categories() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let loss = expense_cat(&c);
    let acc = service::create_account(&c, "Luno", "crypto", 0, None, None, None, None).unwrap();
    let set = service::update_account(&c, UpdateAccountInput {
        id: acc.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: None,
        value_categories: Some(value_pair(Some(&gain), Some(&loss))),
    }).unwrap();
    assert_eq!(set.gain_category_id.as_deref(), Some(gain.as_str()));
    let kept = service::update_account(&c, UpdateAccountInput {
        id: acc.id.clone(), name: Some("Luno 2".into()), subtype: None, opening_balance_cents: None,
        credit_limit_cents: None, value_categories: None,
    }).unwrap();
    assert_eq!(kept.gain_category_id.as_deref(), Some(gain.as_str()));
    assert_eq!(kept.loss_category_id.as_deref(), Some(loss.as_str()));
    let cleared = service::update_account(&c, UpdateAccountInput {
        id: acc.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: None,
        value_categories: Some(value_pair(None, Some(&loss))),
    }).unwrap();
    assert_eq!(cleared.gain_category_id, None);
    assert_eq!(cleared.loss_category_id.as_deref(), Some(loss.as_str()));
}

#[test]
fn leaving_the_four_subtypes_clears_value_categories() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let acc = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&gain), None).unwrap();
    let cleared = service::update_account(&c, UpdateAccountInput {
        id: acc.id.clone(), name: None, subtype: Some("savings".into()), opening_balance_cents: None,
        credit_limit_cents: None, value_categories: None,
    }).unwrap();
    assert_eq!(cleared.subtype, "savings");
    assert_eq!(cleared.gain_category_id, None);
}

#[test]
fn subcategory_and_archived_category_can_be_saved() {
    let c = open_in_memory().unwrap();
    let parent = income_cat(&c);
    let child = service::create_category(&c, "Dividends", "income", "💸", None, Some(&parent)).unwrap();
    let archived = service::create_category(&c, "Old loss", "expense", "📉", None, None).unwrap();
    service::archive_category(&c, &archived.id).unwrap();
    let acc = service::create_account(&c, "Broker", "investment", 0, None, None, Some(&child.id), Some(&archived.id)).unwrap();
    assert_eq!(acc.gain_category_id.as_deref(), Some(child.id.as_str()));
    assert_eq!(acc.loss_category_id.as_deref(), Some(archived.id.as_str()));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib create_investment_saves_gain_and_loss_categories`

Expected: FAIL to compile.

- [ ] **Step 3: Implement create and update**

Add to `models.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCategories {
    pub gain_category_id: Option<String>,
    pub loss_category_id: Option<String>,
}
```

Add this field to `UpdateAccountInput`:

```rust
#[serde(default)]
pub value_categories: Option<ValueCategories>,
```

Every existing `UpdateAccountInput { ... }` literal in `lib.rs` gains `value_categories: None`.

Change `service::create_account` to take `gain_category_id: Option<&str>` and `loss_category_id: Option<&str>` after `credit_limit_cents`. Every existing call in `lib.rs` and the `acct` helper gains `, None, None` before the closing parenthesis. The Task 1 test `migration_014_adds_value_category_columns` gains them too. `commands::create_account` gains the same two `Option<String>` arguments and passes `as_deref()`.

In `service.rs`, add:

```rust
fn is_value_subtype(subtype: &str) -> bool {
    matches!(subtype, "fixed-deposit" | "investment" | "unit-trust" | "crypto")
}

fn validate_saved_value_category(conn: &Connection, id: &str, expected_kind: &str, wrong_kind_message: &str) -> AppResult<()> {
    let cat = repo::get_category(conn, id)?;
    if cat.is_system {
        return Err(AppError::Validation("That category can't be selected.".into()));
    }
    if cat.kind != expected_kind {
        return Err(AppError::Validation(wrong_kind_message.into()));
    }
    Ok(())
}

fn resolve_value_categories(
    conn: &Connection,
    subtype: &str,
    incoming: Option<&ValueCategories>,
    existing_gain: Option<String>,
    existing_loss: Option<String>,
) -> AppResult<(Option<String>, Option<String>)> {
    let qualifying = is_value_subtype(subtype);
    match incoming {
        Some(v) if !qualifying && (v.gain_category_id.is_some() || v.loss_category_id.is_some()) => {
            Err(AppError::Validation(
                "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.".into(),
            ))
        }
        Some(_) if !qualifying => Ok((None, None)),
        Some(v) => {
            if let Some(id) = &v.gain_category_id {
                validate_saved_value_category(conn, id, "income", "Gain category must be an income category.")?;
            }
            if let Some(id) = &v.loss_category_id {
                validate_saved_value_category(conn, id, "expense", "Loss category must be an expense category.")?;
            }
            Ok((v.gain_category_id.clone(), v.loss_category_id.clone()))
        }
        None if !qualifying => Ok((None, None)),
        None => Ok((existing_gain, existing_loss)),
    }
}
```

`create_account` calls `resolve_value_categories(conn, &subtype, Some(&ValueCategories { gain_category_id: gain_category_id.map(str::to_string), loss_category_id: loss_category_id.map(str::to_string) }), None, None)?` before opening the write transaction. Inside that transaction, after `insert_account`, call `repo::set_value_categories` with the resolved ids.

`update_account` calls `resolve_value_categories` with `input.value_categories.as_ref()`, `existing.gain_category_id.clone()`, and `existing.loss_category_id.clone()`, using `resulting_subtype`. Inside the existing write transaction, after `set_credit_limit`, call `repo::set_value_categories` with the resolved pair. A rejected resolve returns before the transaction, so a failed edit leaves the account untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib -- 'create_investment_saves|create_savings_rejects|gain_category_must_be|loss_category_must_be|edit_can_set_clear|leaving_the_four|subcategory_and_archived|migration_014'`

Expected: PASS. Then `cargo test --lib` compiles the rest of the suite. Expected: the pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: save gain and loss categories on value accounts

EOF
)"
```

---

### Task 3: Deleting a category clears it from accounts

**Files:**
- Modify: `src-tauri/src/service.rs` (`delete_category`)
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `repo::clear_value_category` from Task 1. Saved categories from Task 2.
- Produces: `delete_category` clears both columns when the delete proceeds, and leaves them when a transaction still uses the category.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn deleting_an_unused_saved_category_clears_the_account() {
    let c = open_in_memory().unwrap();
    let gain = service::create_category(&c, "Growth", "income", "📈", None, None).unwrap();
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain.id), None).unwrap();
    service::delete_category(&c, &gain.id).unwrap();
    let after = service::get_account(&c, &acc.id).unwrap();
    assert_eq!(after.gain_category_id, None);
}
```

The in-use case is a test in Task 4, because it calls `update_net_worth`.

- [ ] **Step 2: Run the unused-category test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib deleting_an_unused_saved_category_clears_the_account`

Expected: FAIL because the column is still set.

- [ ] **Step 3: Clear inside the delete**

`delete_category` already returns the in-use conflict before any write. After that check passes, open `conn.unchecked_transaction()`, call `repo::clear_value_category(&tx, id, &now())`, then `repo::delete_category(&tx, id)`, then commit. A failed delete rolls the clear back.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib deleting_an_unused_saved_category_clears_the_account`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: clear saved value categories when the category is deleted

EOF
)"
```

---

### Task 4: The update_net_worth command

**Files:**
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register the command, and the tests)
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `is_value_subtype`, `validate_category_for`, `resolve_time`, `repo::insert_transaction`, `materialize_postings`.
- Produces: `service::update_net_worth(conn, account_id, balance_cents, category_id: Option<&str>, time: Option<&str>) -> AppResult<Account>`. Tauri command `update_net_worth` with those arguments, registered immediately after `commands::set_account_balance`.

- [ ] **Step 1: Write the failing tests**

```rust
fn value_rows(c: &rusqlite::Connection, account_id: &str) -> Vec<Transaction> {
    service::list_transactions(c, TransactionFilters {
        account_id: Some(account_id.to_string()),
        ..TransactionFilters::default()
    }).unwrap().into_iter().filter(|t| t.description.as_deref() == Some("Value update")).collect()
}

#[test]
fn update_net_worth_rise_uses_the_saved_gain_category() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let other = service::create_category(&c, "Other income", "income", "💵", None, None).unwrap();
    let acc = service::create_account(&c, "Stash", "unit-trust", 10_000, None, None, Some(&gain), None).unwrap();
    let opening = acc.opening_balance_cents;
    let after = service::update_net_worth(&c, &acc.id, 10_500, Some(&other.id), None).unwrap();
    assert_eq!(after.balance_cents, 10_500);
    assert_eq!(after.opening_balance_cents, opening);
    assert_eq!(after.gain_category_id.as_deref(), Some(gain.as_str()));
    let rows = value_rows(&c, &acc.id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "income");
    assert_eq!(rows[0].amount_cents, 500);
    assert_eq!(rows[0].category_id.as_deref(), Some(gain.as_str()));
    assert_eq!(rows[0].transaction_date, crate::today());
    assert_eq!(rows[0].transaction_time, None);
    assert!(!rows[0].excluded_from_reporting);
    assert!(rows[0].splits.is_empty());
    assert_books_balance(&c);
}

#[test]
fn update_net_worth_drop_uses_the_saved_loss_category() {
    let c = open_in_memory().unwrap();
    let loss = expense_cat(&c);
    let acc = service::create_account(&c, "FD", "fixed-deposit", 8_000, None, None, None, Some(&loss)).unwrap();
    let after = service::update_net_worth(&c, &acc.id, 7_250, None, None).unwrap();
    assert_eq!(after.balance_cents, 7_250);
    let rows = value_rows(&c, &acc.id);
    assert_eq!(rows[0].kind, "expense");
    assert_eq!(rows[0].amount_cents, 750);
    assert_eq!(rows[0].category_id.as_deref(), Some(loss.as_str()));
    assert_books_balance(&c);
}

#[test]
fn update_net_worth_with_only_an_opening_does_not_rewrite_it() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let acc = service::create_account(&c, "Luno", "crypto", 2_000, None, None, Some(&gain), None).unwrap();
    service::update_net_worth(&c, &acc.id, 2_100, None, None).unwrap();
    let opening = service::list_transactions(&c, TransactionFilters {
        account_id: Some(acc.id.clone()),
        ..TransactionFilters::default()
    }).unwrap().into_iter().find(|t| t.kind == "opening").unwrap();
    assert_eq!(opening.amount_cents, 2_000);
}

#[test]
fn update_net_worth_zero_diff_writes_nothing() {
    let c = open_in_memory().unwrap();
    let acc = service::create_account(&c, "Stash", "investment", 5_000, None, None, None, None).unwrap();
    let after = service::update_net_worth(&c, &acc.id, 5_000, None, None).unwrap();
    assert_eq!(after.balance_cents, 5_000);
    assert!(value_rows(&c, &acc.id).is_empty());
}

#[test]
fn update_net_worth_without_a_saved_category_uses_the_passed_one_once() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
    let after = service::update_net_worth(&c, &acc.id, 1_200, Some(&gain), None).unwrap();
    assert_eq!(after.gain_category_id, None);
    assert_eq!(value_rows(&c, &acc.id)[0].category_id.as_deref(), Some(gain.as_str()));
}

#[test]
fn update_net_worth_requires_a_category_when_none_is_saved() {
    let c = open_in_memory().unwrap();
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
    let err = service::update_net_worth(&c, &acc.id, 1_100, None, None).unwrap_err();
    assert_eq!(validation_message(err), "Pick a category for this update.");
}

#[test]
fn update_net_worth_rejects_the_wrong_kind_and_a_system_category() {
    let c = open_in_memory().unwrap();
    let expense = expense_cat(&c);
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
    let err = service::update_net_worth(&c, &acc.id, 1_100, Some(&expense), None).unwrap_err();
    assert_eq!(validation_message(err), "Category kind 'expense' does not match transaction kind 'income'");
    let system = service::list_categories(&c, Some("income"), true).unwrap().into_iter().find(|cat| cat.is_system).unwrap();
    let err = service::update_net_worth(&c, &acc.id, 1_100, Some(&system.id), None).unwrap_err();
    assert_eq!(validation_message(err), "That category can't be selected.");
}

#[test]
fn update_net_worth_rejects_bad_targets_and_accounts() {
    let c = open_in_memory().unwrap();
    let missing = service::update_net_worth(&c, "nope", 1, None, None).unwrap_err();
    assert!(matches!(missing, AppError::NotFound(m) if m == "Account not found"));
    let cash = service::create_account(&c, "Cash", "savings", 1_000, None, None, None, None).unwrap();
    let err = service::update_net_worth(&c, &cash.id, 1_100, None, None).unwrap_err();
    assert_eq!(validation_message(err), "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.");
    let acc = service::create_account(&c, "FD", "fixed-deposit", 1_000, None, None, None, None).unwrap();
    let err = service::update_net_worth(&c, &acc.id, -1, None, None).unwrap_err();
    assert_eq!(validation_message(err), "Balance must be zero or more.");
    service::archive_account(&c, &acc.id).unwrap();
    let err = service::update_net_worth(&c, &acc.id, 1_000, None, None).unwrap_err();
    assert!(matches!(err, AppError::Conflict(m) if m == "Cannot update an archived account"));
}

#[test]
fn update_net_worth_requires_time_only_when_the_setting_is_on() {
    let c = open_in_memory().unwrap();
    let gain = income_cat(&c);
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain), None).unwrap();
    service::update_net_worth(&c, &acc.id, 1_100, None, None).unwrap();
    assert_eq!(value_rows(&c, &acc.id)[0].transaction_time, None);
    service::set_setting(&c, "transaction_time_enabled", "1").unwrap();
    let err = service::update_net_worth(&c, &acc.id, 1_250, None, None).unwrap_err();
    assert_eq!(validation_message(err), "A time is required");
    service::update_net_worth(&c, &acc.id, 1_250, None, Some("09:30")).unwrap();
    let timed = value_rows(&c, &acc.id).into_iter().find(|t| t.amount_cents == 150).unwrap();
    assert_eq!(timed.transaction_time.as_deref(), Some("09:30"));
    service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
    service::update_net_worth(&c, &acc.id, 1_300, None, Some("11:00")).unwrap();
    let ignored = value_rows(&c, &acc.id).into_iter().find(|t| t.amount_cents == 50).unwrap();
    assert_eq!(ignored.transaction_time, None);
}

#[test]
fn correct_balance_still_rewrites_an_opening_only_investment() {
    let c = open_in_memory().unwrap();
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
    service::set_account_balance(&c, &acc.id, 4_000, true).unwrap();
    let after = service::get_account(&c, &acc.id).unwrap();
    assert_eq!(after.opening_balance_cents, 4_000);
    assert_eq!(after.balance_cents, 4_000);
    assert!(value_rows(&c, &acc.id).is_empty());
}

#[test]
fn deleting_a_category_used_by_a_value_update_keeps_the_column() {
    let c = open_in_memory().unwrap();
    let gain = service::create_category(&c, "Growth", "income", "📈", None, None).unwrap();
    let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain.id), None).unwrap();
    service::update_net_worth(&c, &acc.id, 1_500, None, None).unwrap();
    let err = service::delete_category(&c, &gain.id).unwrap_err();
    assert!(matches!(err, AppError::Conflict(m) if m == "In use by transactions — archive it instead"));
    assert_eq!(service::get_account(&c, &acc.id).unwrap().gain_category_id.as_deref(), Some(gain.id.as_str()));
}
```

`TransactionFilters` has `account_id: Option<String>` and derives `Default`. `service::set_setting(conn, key, value)` is the settings writer. `list_transactions` hydrates `splits`, so a value update's `splits` is empty.

- [ ] **Step 2: Run a test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib update_net_worth_rise_uses_the_saved_gain_category`

Expected: FAIL to compile (`update_net_worth` not found).

- [ ] **Step 3: Implement the command**

Add to `service.rs`:

```rust
pub fn update_net_worth(
    conn: &Connection,
    account_id: &str,
    balance_cents: i64,
    category_id: Option<&str>,
    time: Option<&str>,
) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot update an archived account".into()));
    }
    if !is_value_subtype(&acc.subtype) {
        return Err(AppError::Validation(
            "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.".into(),
        ));
    }
    if balance_cents < 0 {
        return Err(AppError::Validation("Balance must be zero or more.".into()));
    }
    let diff = balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let kind = if diff > 0 { KIND_INCOME } else { KIND_EXPENSE };
    let saved = if diff > 0 { acc.gain_category_id.clone() } else { acc.loss_category_id.clone() };
    let cat = match saved {
        Some(id) => id,
        None => category_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| AppError::Validation("Pick a category for this update.".into()))?,
    };
    validate_category_for(conn, &cat, kind)?;
    let time = resolve_time(conn, time, None)?;
    let today = crate::today();
    let tx = conn.unchecked_transaction()?;
    let txn = repo::insert_transaction(
        &tx, &new_id(), kind, account_id, None, Some(&cat), diff.abs(),
        Some("Value update"), &today, time.as_deref(), false, &now(),
    )?;
    materialize_postings(&tx, &txn)?;
    tx.commit()?;
    repo::get_account(conn, account_id)
}
```

Add the Tauri command beside `set_account_balance`, and add `commands::update_net_worth` to `generate_handler!` immediately after `commands::set_account_balance`.

Do not call `set_account_balance`. Do not write `gain_category_id` or `loss_category_id` in this function.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib -- 'update_net_worth|correct_balance_still_rewrites_an_opening|deleting_a_category_used_by_a_value_update'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: record a value update as income or expense

EOF
)"
```

---

### Task 5: Client wrapper and mock

**Files:**
- Modify: `src/client/index.ts`
- Modify: `src/client/mock.ts`
- Create: `src/__tests__/mock-update-net-worth.test.ts`

**Interfaces:**
- Consumes: the Rust command and error strings from Tasks 2–4.
- Produces: `client.createAccount(..., gainCategoryId = null, lossCategoryId = null)`, `client.updateAccount` input `valueCategories?: { gainCategoryId: string | null; lossCategoryId: string | null }`, and `client.updateNetWorth(accountId, balanceCents, categoryId: string | null, time: string | null)`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/mock-update-net-worth.test.ts`. Import `mockInvoke` from `../client/mock`. Each test creates its own account. Cover these cases with `expect(...).rejects.toMatchObject({ message })` for errors:

- Create an `investment` with a gain and a loss category. The returned account has those ids.
- Create a `savings` account with `gainCategoryId` set. Message is `Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.`
- Update the investment with `valueCategories: { gainCategoryId: null, lossCategoryId: <expense id> }`. Gain becomes null, loss is kept. A later `update_account` that only renames leaves both as they are.
- Change that account's subtype to `savings` without `valueCategories`. Both ids are null.
- `update_net_worth` from 100000 to 105000 with a saved gain category writes one income of 5000, description `Value update`, `excludedFromReporting: false`, and the balance is 105000. The opening transaction amount is still 100000. The account's `gainCategoryId` is unchanged even if `categoryId` is a different income category.
- A drop from 100000 to 99000 with a saved loss category writes an expense of 1000.
- No saved category: the passed `categoryId` is used, and the account's column stays null.
- No saved category and `categoryId: null` rejects with `Pick a category for this update.`
- Target `-1` rejects with `Balance must be zero or more.`
- A `savings` account rejects with `Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.`
- Archive the investment, then update rejects with `Cannot update an archived account`.
- Equal balance writes no `Value update` row.
- `set_setting` `transaction_time_enabled` to `1`, then a rise without `time` rejects with `A time is required`. With `time: "09:30"` the row's `transactionTime` is `09:30`. Set the setting back to `0` and a further rise sent with `time: "11:00"` stores `transactionTime: null`.
- Delete a category that is only saved on the account. The account column becomes null.
- After a value update uses a category, `delete_category` rejects with `In use by transactions — archive it instead` and the column stays.
- `set_account_balance` on an investment that has only its opening, with `recordAsIncomeExpense: true` and target 400000, changes `openingBalanceCents` to 400000 and writes no `Value update` row.

Read categories with `list_categories`. Read rows with `list_transactions` filtered by `accountId`. Use sen amounts, not ringgit.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/mock-update-net-worth.test.ts`

Expected: FAIL because `update_net_worth` is not a mock command, or the create args are ignored.

- [ ] **Step 3: Mirror the rules in the client and the mock**

`createAccount` gains two optional trailing args defaulting to `null` and sends `gainCategoryId` and `lossCategoryId`.

`updateAccount`'s input type gains optional `valueCategories`.

Add:

```ts
updateNetWorth: (accountId: string, balanceCents: number, categoryId: string | null, time: string | null) =>
  dispatch<Account>("update_net_worth", { accountId, balanceCents, categoryId, time }),
```

In `mock.ts`, copy the Rust rules with the same messages:

- `isValueSubtype` matches the four keys.
- `resolveValueCategories(subtype, incoming, existingGain, existingLoss)` follows Task 2, including the system-category and kind checks. A missing category id calls `fail("NotFound", "Category not found")`.
- `create_account` resolves the pair from `a.gainCategoryId` and `a.lossCategoryId` before pushing the account, and stores the result on it.
- `update_account` resolves from `a.input.valueCategories` when `hasOwnProperty` says the key is present, otherwise `incoming` is absent. Then it writes the resolved pair. A subtype change away from the four clears both.
- `delete_category`, only after the existing in-use check, sets `gainCategoryId` and `lossCategoryId` to null on any account that points at `a.id`.
- `update_net_worth` implements Task 4, including `resolveTime(a.time, null)`, description `Value update`, and `excludedFromReporting: false`. Use `balanceOf` for the current balance. Do not change the opening row. Do not write the passed category onto the account when a saved one exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/mock-update-net-worth.test.ts && npm test && npm run build`

Expected: the new file passes, the existing suite passes, and the build is clean.

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts src/client/mock.ts src/__tests__/mock-update-net-worth.test.ts
git commit -m "$(cat <<'EOF'
feat: mirror Update Net Worth in the browser mock

EOF
)"
```

---

### Task 6: The account screen

**Files:**
- Modify: `src/lib/accounts.ts`
- Create: `src/components/ValueCategoryFields.tsx`
- Create: `src/modals/UpdateNetWorth.tsx`
- Modify: `src/modals/AddAccount.tsx`
- Modify: `src/modals/EditAccount.tsx`
- Modify: `src/screens/Accounts.tsx`

**Interfaces:**
- Consumes: `client.updateNetWorth`, `client.createAccount`'s two new args, `client.updateAccount`'s `valueCategories`, `categoryPickerItems`, `useTimeSetting`, `nowTimeHHMM`, `fmtMoney`.
- Produces: the Update Net Worth button and modal, and the two pickers on Add and Edit.

- [ ] **Step 1: Add the subtype helper**

In `src/lib/accounts.ts`:

```ts
export function subtypeHasValueUpdate(subtype: string): boolean {
  return subtype === "fixed-deposit" || subtype === "investment" || subtype === "unit-trust" || subtype === "crypto";
}
```

- [ ] **Step 2: Add the shared pickers**

Create `src/components/ValueCategoryFields.tsx`. It takes `categories: Category[]`, `gainId: string`, `lossId: string`, `onGain`, `onLoss`. It renders two `Field` selects, labels **Gain category** and **Loss category**. Each select's first option is `value=""` and the text `Ask each time`. The rest come from `categoryPickerItems(categories, "income")` and `categoryPickerItems(categories, "expense")`. Indent `depth === 1` options with a prefix of two spaces. Style the select like the subtype select in `EditAccount.tsx` (`sens-input`, `inputStyle`, `appearance: "none"`).

- [ ] **Step 3: Wire Add and Edit**

Both modals load categories once with `client.listCategories(undefined, true)`.

Show `ValueCategoryFields` only when `subtypeHasValueUpdate(subtype)` is true.

Add account: state starts as `""`. `createAccount` receives `gainId || null` and `lossId || null` as the two new arguments.

Edit account: state starts as `account.gainCategoryId ?? ""` and `account.lossCategoryId ?? ""`. When the subtype is one of the four, `updateAccount` sends `valueCategories: { gainCategoryId: gainId || null, lossCategoryId: lossId || null }` along with the existing name, subtype, and credit limit. When it is not, omit `valueCategories`.

- [ ] **Step 4: Add the modal and the button**

Create `src/modals/UpdateNetWorth.tsx`. Props: `{ account: Account; onClose: () => void; onDone: () => void }`.

- Title `Update Net Worth`. Width 400, same shell as `SetBalance`.
- Load categories with `client.listCategories(undefined, true)` and read time with `useTimeSetting()`. Time state starts at `nowTimeHHMM()`.
- Show the account name and the current balance using `balanceDisplay` and `Money`, as Correct balance does.
- **Worth now (RM)** starts as `(Math.max(account.balanceCents, 0) / 100).toFixed(2)`. The input keeps digits and `.` only. Parse with the same magnitude rule as `SetBalance`'s `parseMagnitude` (blank is null, zero is allowed). `targetCents` is that magnitude. There is no leading-minus path.
- `diff = targetCents - account.balanceCents` when `targetCents != null`.
- Preview, using `fmtMoney(Math.abs(diff), { cents: true })`:
  - `diff === 0`: `Already at this balance`
  - `diff > 0` and the category name is known: `Records ${money} as income in ${name}`
  - `diff < 0` and the name is known: `Records ${money} as expense in ${name}`
  - `diff !== 0` and no category yet: `Records ${money} as income` or `as expense`, with no `in` clause
- The category is the saved `gainCategoryId` on a rise and `lossCategoryId` on a drop. When that id is set, show no picker. Look up the name in the loaded list, including archived categories. When it is not set and `diff !== 0`, show one select of `categoryPickerItems` for `income` or `expense`. That choice is only local state.
- Show the time field only when the setting is on and `diff !== 0`. It is the same `type="time"` input Add Transaction uses. There is no date field. The command dates the row.
- Save is disabled when the amount is null, or when `diff !== 0` and no category id is known, or while busy. When `diff === 0`, Save calls `onDone()` and does not call the command. Otherwise call `client.updateNetWorth(account.id, targetCents, savedId ? null : pickedId, timeEnabled ? time : null)`. Show `e.message` in the modal. On success call `onDone()`.

In `Accounts.tsx`, add state `updating`. In the action row, immediately after Correct balance and before Edit:

```tsx
{subtypeHasValueUpdate(a.subtype) && !a.isArchived && (
  <Btn variant="outline" size="sm" onClick={() => setUpdating(a)}>Update Net Worth</Btn>
)}
```

Render `<UpdateNetWorth account={updating} onClose=... onDone=... />` beside the other modals. `onDone` clears the state and calls `afterMutation()`.

- [ ] **Step 5: Verify the build**

Run: `npm run build`

Expected: exit 0.

There is no new screen test. Open `npm run dev` is not required for this task's gate. The build is the gate.

- [ ] **Step 6: Commit**

```bash
git add src/lib/accounts.ts src/components/ValueCategoryFields.tsx src/modals/UpdateNetWorth.tsx src/modals/AddAccount.tsx src/modals/EditAccount.tsx src/screens/Accounts.tsx
git commit -m "$(cat <<'EOF'
feat: add Update Net Worth on investment accounts

EOF
)"
```

---

### Task 7: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify: `docs/architecture/accounts.md`
- Modify: `docs/architecture/transactions.md`

**Interfaces:**
- Consumes: the behavior from Tasks 4 and 6.
- Produces: the changelog entry and the architecture notes a later change will rely on.

- [ ] **Step 1: Write the notes**

Under `CHANGELOG.md` `[Unreleased]`, add an **Added** entry:

> **Update Net Worth.** On a fixed deposit, investment, unit trust, or crypto account, enter what it is worth now. The difference is saved as income or expense, dated today, described "Value update", and counted in income, spending, and budgets. The account can remember an income category for a rise and an expense category for a drop. When it has no category for that side, the update asks once and does not save the choice. Correct balance is unchanged.

In `ROADMAP.md`, tick the three Update Net Worth checklist items. Leave the phase ⚪ and leave **Next up** as Update Net Worth. Do not move the phase to Shipped.

In `docs/architecture/accounts.md`, replace the "not built yet" deferral with a short section **Update Net Worth**: the four subtypes, the two columns, the command name `update_net_worth`, and that Correct balance is separate. Point at the spec.

In `docs/architecture/transactions.md`, add a contents link and a section **Update Net Worth** immediately after **Balance correction**. State: the command writes one ordinary income or expense; it does not rewrite the opening row; `diff == 0` writes nothing; a saved category wins; the row is editable because it is ordinary; reporting and budgets already count it.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md ROADMAP.md docs/architecture/accounts.md docs/architecture/transactions.md
git commit -m "$(cat <<'EOF'
docs: describe Update Net Worth

EOF
)"
```

---

## Self-review notes

Spec coverage: columns and migration (Task 1), create/edit/clear/kind/system/subcategory/archived (Task 2), delete (Task 3 and the in-use test in Task 4), the command including time, zero diff, opening, and Correct balance (Task 4), mock parity (Task 5), button, modal, and pickers (Task 6), changelog and architecture (Task 7).

The preview line before a category is chosen omits `in {name}`. The spec only defines the line once the name is known. Save stays disabled until a category is known, which matches the spec.
