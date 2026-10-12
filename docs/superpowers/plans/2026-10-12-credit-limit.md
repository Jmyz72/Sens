# Credit Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a required positive credit limit on credit-card and BNPL accounts, and show available credit and utilization from the signed balance without blocking over-limit charges.

**Architecture:** Migration 010 adds nullable `accounts.credit_limit_cents`. The Rust service (mirrored in `src/client/mock.ts`) accepts the limit only for subtypes `credit-card` and `bnpl`, requires it there, and clears it when the subtype changes away. The UI derives available credit and a whole-number percent in `src/lib/accounts.ts`. Balances, postings, and dashboard totals do not read the limit.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Limit subtypes are exactly `credit-card` and `bnpl`. No other subtype stores a limit.
- Money is integer MYR sen. The limit is an integer greater than zero.
- Missing or null limit on a limit subtype: `ValidationError` message `Credit limit is required for this account.`
- Zero or negative limit on a limit subtype: `ValidationError` message `Credit limit must be greater than zero.`
- A number sent for any other subtype: `ValidationError` message `Credit limit only applies to credit cards and BNPL.`
- Available credit is exact sen, never below 0, and never above the limit. Do not compute it as `creditLimitCents + balanceCents`.
- `overLimit` is `usedPercent > 100`. Exactly 100% is not over the limit.
- An expense past the limit is saved. The limit column stays unchanged.
- Dashboard, net worth, sidebar totals, and the transaction form do not show or enforce the limit.
- `AccountBalance` and `DashboardSummary` do not gain a limit field.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Spec: `docs/superpowers/specs/2026-10-12-credit-limit-design.md`.

---

## File Structure

- `src/lib/accounts.ts` — `subtypeHasCreditLimit` and `creditReadout`. Presentation only.
- `src/lib/__tests__/creditLimit.test.ts` — the readout table.
- `src-tauri/src/db/migrations.rs` — migration 010, plain `ALTER TABLE`.
- `src-tauri/src/models.rs` — `Account.credit_limit_cents`, `UpdateAccountInput.credit_limit_cents`.
- `src-tauri/src/repo.rs` — map the column, write it on insert, set or clear it on update.
- `src-tauri/src/service.rs` — `resolve_credit_limit`; `create_account` and `update_account` enforce the tables in the spec.
- `src-tauri/src/commands.rs` — thread `credit_limit_cents` into `create_account`.
- `src-tauri/src/lib.rs` — call-site updates and service tests.
- `src/types.ts` — `Account.creditLimitCents`.
- `src/client/index.ts` — client args.
- `src/client/mock.ts` — same validation and storage as Rust.
- `src/__tests__/mock-accounts.test.ts` — mock validation table.
- `src/__tests__/accountStats.test.ts` — account fixture includes the new field.
- `src/modals/AddAccount.tsx` — required Credit limit field on step 2.
- `src/modals/EditAccount.tsx` — same field, prefilled; omitted when the subtype is not a limit subtype.
- `src/screens/Accounts.tsx` — row line and expanded bar.
- `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `ROADMAP.md` — document the slice.

---

### Task 1: Credit readout helper

**Files:**
- Create: `src/lib/__tests__/creditLimit.test.ts`
- Modify: `src/lib/accounts.ts`
- Test: `src/lib/__tests__/creditLimit.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `subtypeHasCreditLimit(subtype: string): boolean` and `creditReadout(balanceCents: number, creditLimitCents: number): { availableCents: number; usedPercent: number; overLimit: boolean }`. Later tasks call these names.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/creditLimit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { creditReadout, subtypeHasCreditLimit } from "../accounts";

const LIMIT = 1_000_000; // RM 10,000

describe("subtypeHasCreditLimit", () => {
  it("is true only for credit-card and bnpl", () => {
    expect(subtypeHasCreditLimit("credit-card")).toBe(true);
    expect(subtypeHasCreditLimit("bnpl")).toBe(true);
    expect(subtypeHasCreditLimit("personal-loan")).toBe(false);
    expect(subtypeHasCreditLimit("savings")).toBe(false);
  });
});

describe("creditReadout", () => {
  it("matches the spec table", () => {
    expect(creditReadout(-400_000, LIMIT)).toEqual({ availableCents: 600_000, usedPercent: 40, overLimit: false });
    expect(creditReadout(0, LIMIT)).toEqual({ availableCents: LIMIT, usedPercent: 0, overLimit: false });
    expect(creditReadout(20_000, LIMIT)).toEqual({ availableCents: LIMIT, usedPercent: 0, overLimit: false });
    expect(creditReadout(-1_000_000, LIMIT)).toEqual({ availableCents: 0, usedPercent: 100, overLimit: false });
    expect(creditReadout(-1_200_000, LIMIT)).toEqual({ availableCents: 0, usedPercent: 120, overLimit: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/creditLimit.test.ts`

Expected: FAIL. `creditReadout` is not exported from `src/lib/accounts.ts`.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/accounts.ts`:

```ts
/** Subtypes that store a required credit limit. */
export function subtypeHasCreditLimit(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}

export interface CreditReadout {
  availableCents: number;
  usedPercent: number;
  overLimit: boolean;
}

/**
 * Available credit and utilization for a card or BNPL account.
 * Call only when `creditLimitCents` is a positive integer.
 * In credit (balance >= 0) reports the full limit and 0% used.
 * Past the limit, available credit stays 0 and `overLimit` is true.
 */
export function creditReadout(balanceCents: number, creditLimitCents: number): CreditReadout {
  const owed = balanceCents < 0 ? -balanceCents : 0;
  const availableCents = balanceCents < 0 ? Math.max(0, creditLimitCents - owed) : creditLimitCents;
  const usedPercent = Math.round((owed * 100) / creditLimitCents);
  return { availableCents, usedPercent, overLimit: usedPercent > 100 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/creditLimit.test.ts`

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts.ts src/lib/__tests__/creditLimit.test.ts
git commit -m "$(cat <<'EOF'
feat: derive credit utilization from balance and limit

EOF
)"
```

---

### Task 2: Persist and validate the limit in Rust

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/repo.rs`
- Modify: `src-tauri/src/service.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `Account.credit_limit_cents: Option<i64>` (JSON `creditLimitCents`). `create_account(..., template_key: Option<&str>, credit_limit_cents: Option<i64>)`. `UpdateAccountInput.credit_limit_cents: Option<i64>` with `#[serde(default)]`.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/lib.rs`, inside `mod tests`, add this helper next to `fn acct` and add the tests at the end of the module:

```rust
fn validation_message(err: AppError) -> String {
    match err {
        AppError::Validation(m) => m,
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[test]
fn credit_card_and_bnpl_roundtrip_a_positive_limit() {
    let c = open_in_memory().unwrap();
    let card = service::create_account(&c, "Visa", "credit-card", -200_000, None, Some(1_000_000)).unwrap();
    let bnpl = service::create_account(&c, "Atome", "bnpl", -50_000, None, Some(300_000)).unwrap();
    assert_eq!(card.credit_limit_cents, Some(1_000_000));
    assert_eq!(card.balance_cents, -200_000);
    assert_eq!(bnpl.credit_limit_cents, Some(300_000));
    let again = service::list_accounts(&c, false).unwrap();
    assert_eq!(again.iter().find(|a| a.id == card.id).unwrap().credit_limit_cents, Some(1_000_000));
}

#[test]
fn limit_subtype_rejects_a_missing_zero_or_negative_limit() {
    let c = open_in_memory().unwrap();
    let missing = service::create_account(&c, "Visa", "credit-card", 0, None, None).unwrap_err();
    assert_eq!(validation_message(missing), "Credit limit is required for this account.");
    let zero = service::create_account(&c, "Visa", "bnpl", 0, None, Some(0)).unwrap_err();
    assert_eq!(validation_message(zero), "Credit limit must be greater than zero.");
    let neg = service::create_account(&c, "Visa", "credit-card", 0, None, Some(-1)).unwrap_err();
    assert_eq!(validation_message(neg), "Credit limit must be greater than zero.");
}

#[test]
fn non_limit_subtype_rejects_a_limit_and_stores_null_without_one() {
    let c = open_in_memory().unwrap();
    let rejected = service::create_account(&c, "Cash", "savings", 100, None, Some(500)).unwrap_err();
    assert_eq!(validation_message(rejected), "Credit limit only applies to credit cards and BNPL.");
    let savings = service::create_account(&c, "Cash", "savings", 100, None, None).unwrap();
    assert_eq!(savings.credit_limit_cents, None);
}

#[test]
fn update_replaces_keeps_clears_or_requires_the_limit() {
    let c = open_in_memory().unwrap();
    let card = service::create_account(&c, "Visa", "credit-card", -100, None, Some(1_000_000)).unwrap();
    let replaced = service::update_account(&c, UpdateAccountInput {
        id: card.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: Some(2_000_000),
    }).unwrap();
    assert_eq!(replaced.credit_limit_cents, Some(2_000_000));

    let kept = service::update_account(&c, UpdateAccountInput {
        id: card.id.clone(), name: Some("Visa Gold".into()), subtype: None, opening_balance_cents: None, credit_limit_cents: None,
    }).unwrap();
    assert_eq!(kept.credit_limit_cents, Some(2_000_000));

    let cleared = service::update_account(&c, UpdateAccountInput {
        id: card.id.clone(), name: None, subtype: Some("savings".into()), opening_balance_cents: None, credit_limit_cents: None,
    }).unwrap();
    assert_eq!(cleared.subtype, "savings");
    assert_eq!(cleared.credit_limit_cents, None);

    let savings = service::create_account(&c, "Cash", "savings", 0, None, None).unwrap();
    let need = service::update_account(&c, UpdateAccountInput {
        id: savings.id.clone(), name: None, subtype: Some("credit-card".into()), opening_balance_cents: None, credit_limit_cents: None,
    }).unwrap_err();
    assert_eq!(validation_message(need), "Credit limit is required for this account.");

    let switched = service::update_account(&c, UpdateAccountInput {
        id: savings.id.clone(), name: None, subtype: Some("bnpl".into()), opening_balance_cents: None, credit_limit_cents: Some(400_000),
    }).unwrap();
    assert_eq!(switched.credit_limit_cents, Some(400_000));

    let wrong = service::update_account(&c, UpdateAccountInput {
        id: switched.id.clone(), name: None, subtype: Some("cash".into()), opening_balance_cents: None, credit_limit_cents: Some(10),
    }).unwrap_err();
    assert_eq!(validation_message(wrong), "Credit limit only applies to credit cards and BNPL.");
}

#[test]
fn expense_past_the_limit_still_posts_and_keeps_the_limit() {
    let c = open_in_memory().unwrap();
    let card = service::create_account(&c, "Visa", "credit-card", -800_000, None, Some(1_000_000)).unwrap();
    service::create_expense(&c, &card.id, Some(&expense_cat(&c)), 500_000, None, "2026-10-12", None, false, None).unwrap();
    let after = service::list_accounts(&c, true).unwrap().into_iter().find(|a| a.id == card.id).unwrap();
    assert_eq!(after.balance_cents, -1_300_000);
    assert_eq!(after.credit_limit_cents, Some(1_000_000));
}
```

Also change the two existing credit-card creates so they pass a limit once the signature grows. In `owe_account_opening_is_negative`:

```rust
let a = service::create_account(&c, "Visa", "credit-card", -50000, None, Some(1_000_000)).unwrap();
```

In `owe_account_stores_signed_and_nets_worth`:

```rust
let card = service::create_account(&c, "CIMB Card", "credit-card", -5_000_00, None, Some(1_000_000)).unwrap();
```

Leave every other `create_account` call unchanged in this step. They will fail to compile until Step 3 appends `None`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib credit_card_and_bnpl_roundtrip_a_positive_limit -- --nocapture`

Expected: FAIL to compile. `create_account` does not take the limit argument, and `Account` has no `credit_limit_cents`.

- [ ] **Step 3: Add the column, the fields, and the rules**

In `src-tauri/src/db/migrations.rs`, append `(10, MIGRATION_010)` to `MIGRATIONS`:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007), (8, MIGRATION_008), (9, MIGRATION_009), (10, MIGRATION_010)];
```

Add this constant after `MIGRATION_009`. Plain `ALTER TABLE`, not an accounts rebuild (`postings.account_id` references `accounts`):

```rust
const MIGRATION_010: &str = r#"
ALTER TABLE accounts ADD COLUMN credit_limit_cents INTEGER
  CHECK (credit_limit_cents IS NULL OR credit_limit_cents > 0);
"#;
```

In `src-tauri/src/models.rs`, add the field to `Account` after `opening_balance_cents`:

```rust
    pub opening_balance_cents: i64,
    pub credit_limit_cents: Option<i64>,
    pub currency: String,
```

Add the field to `UpdateAccountInput`:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccountInput {
    pub id: String,
    pub name: Option<String>,
    pub subtype: Option<String>,
    pub opening_balance_cents: Option<i64>,
    #[serde(default)]
    pub credit_limit_cents: Option<i64>,
}
```

In `src-tauri/src/repo.rs`, `map_account` reads it after `opening_balance_cents`:

```rust
        opening_balance_cents: r.get("opening_balance_cents")?,
        credit_limit_cents: r.get("credit_limit_cents")?,
        currency: r.get("currency")?,
```

Change `insert_account` to take `credit_limit_cents: Option<i64>` and write the column:

```rust
pub fn insert_account(
    conn: &Connection,
    id: &str,
    template_key: Option<&str>,
    name: &str,
    subtype: &str,
    credit_limit_cents: Option<i64>,
    now: &str,
) -> AppResult<Account> {
    conn.execute(
        "INSERT INTO accounts
           (id, template_key, name, subtype, currency, is_archived, credit_limit_cents, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'MYR', 0, ?5, ?6, ?6)",
        params![id, template_key, name, subtype, credit_limit_cents, now],
    )?;
    get_account(conn, id)
}
```

Add this function next to `update_account_fields`. It always writes the column, including NULL:

```rust
pub fn set_credit_limit(conn: &Connection, id: &str, credit_limit_cents: Option<i64>, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET credit_limit_cents = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, credit_limit_cents, now],
    )?;
    Ok(())
}
```

In `src-tauri/src/service.rs`, add the resolver above `create_account`:

```rust
fn is_credit_limit_subtype(subtype: &str) -> bool {
    subtype == "credit-card" || subtype == "bnpl"
}

fn resolve_credit_limit(subtype: &str, incoming: Option<i64>, existing: Option<i64>) -> AppResult<Option<i64>> {
    if is_credit_limit_subtype(subtype) {
        match incoming {
            Some(n) if n > 0 => Ok(Some(n)),
            Some(_) => Err(AppError::Validation("Credit limit must be greater than zero.".into())),
            None => match existing {
                Some(n) if n > 0 => Ok(Some(n)),
                _ => Err(AppError::Validation("Credit limit is required for this account.".into())),
            },
        }
    } else if incoming.is_some() {
        Err(AppError::Validation("Credit limit only applies to credit cards and BNPL.".into()))
    } else {
        Ok(None)
    }
}
```

Change `create_account` to take `credit_limit_cents: Option<i64>` after `template_key`, resolve it with `existing = None`, and pass the result into `insert_account`:

```rust
pub fn create_account(
    conn: &Connection,
    name: &str,
    subtype: &str,
    opening_balance_cents: i64,
    template_key: Option<&str>,
    credit_limit_cents: Option<i64>,
) -> AppResult<Account> {
    let name = require_nonempty("Account name", name)?;
    let subtype = require_nonempty("Subtype", subtype)?;
    if !repo::subtype_exists(conn, &subtype)? {
        return Err(AppError::Validation(format!("Invalid subtype: {subtype}")));
    }
    if let Some(key) = template_key {
        repo::get_template(conn, key)?;
    }
    let limit = resolve_credit_limit(&subtype, credit_limit_cents, None)?;
    let account_id = new_id();
    let tx = conn.unchecked_transaction()?;
    repo::insert_account(&tx, &account_id, template_key, &name, &subtype, limit, &now())?;
    let opening = repo::insert_transaction(
        &tx,
        &new_id(),
        KIND_OPENING,
        &account_id,
        None,
        None,
        opening_balance_cents,
        Some("Opening balance"),
        &crate::today(),
        None,
        false,
        &now(),
    )?;
    materialize_postings(&tx, &opening)?;
    tx.commit()?;
    repo::get_account(conn, &account_id)
}
```

In `update_account`, load the existing account, resolve the limit against the subtype after the edit, then write fields and the limit inside the same transaction:

```rust
pub fn update_account(conn: &Connection, input: UpdateAccountInput) -> AppResult<Account> {
    let existing = repo::get_account(conn, &input.id)?;
    let name = match &input.name {
        Some(n) => Some(require_nonempty("Account name", n)?),
        None => None,
    };
    if let Some(s) = &input.subtype {
        if !repo::subtype_exists(conn, s)? {
            return Err(AppError::Validation(format!("Invalid subtype: {s}")));
        }
    }
    let resulting_subtype = input.subtype.as_deref().unwrap_or(existing.subtype.as_str());
    let limit = resolve_credit_limit(resulting_subtype, input.credit_limit_cents, existing.credit_limit_cents)?;
    let tx = conn.unchecked_transaction()?;
    repo::update_account_fields(
        &tx,
        &input.id,
        name.as_deref(),
        input.subtype.as_deref(),
        input.opening_balance_cents,
        &now(),
    )?;
    repo::set_credit_limit(&tx, &input.id, limit, &now())?;
    if input.opening_balance_cents.is_some() {
        let opening = repo::get_opening_transaction(&tx, &input.id)?;
        materialize_postings(&tx, &opening)?;
    }
    tx.commit()?;
    repo::get_account(conn, &input.id)
}
```

In `src-tauri/src/commands.rs`, add the argument and forward it:

```rust
pub fn create_account(
    state: State<'_, DbState>,
    name: String,
    subtype: String,
    opening_balance_cents: i64,
    template_key: Option<String>,
    credit_limit_cents: Option<i64>,
) -> AppResult<Account> {
    with_conn!(state, c => service::create_account(&c, &name, &subtype, opening_balance_cents, template_key.as_deref(), credit_limit_cents))
}
```

Update call sites in `src-tauri/src/lib.rs`. The helper becomes:

```rust
fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
    service::create_account(conn, name, "savings", opening, None, None).unwrap()
}
```

Every other `create_account` call that is not a credit card or BNPL gains a trailing `, None` (the new limit argument, after the existing template-key argument). The two credit-card calls already gained `Some(1_000_000)` in Step 1. Both `UpdateAccountInput { ... }` literals in this file (`editing_opening_balance_moves_the_balance_without_new_rows` and `update_account_opening_balance_remateralizes_postings`) gain `credit_limit_cents: None`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib`

Expected: PASS, including `credit_card_and_bnpl_roundtrip_a_positive_limit`, `limit_subtype_rejects_a_missing_zero_or_negative_limit`, `non_limit_subtype_rejects_a_limit_and_stores_null_without_one`, `update_replaces_keeps_clears_or_requires_the_limit`, and `expense_past_the_limit_still_posts_and_keeps_the_limit`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: require a credit limit on credit cards and BNPL

EOF
)"
```

---

### Task 3: Mirror the limit in the mock and the TypeScript client

**Files:**
- Modify: `src/types.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/mock.ts`
- Modify: `src/__tests__/accountStats.test.ts`
- Modify: `src/__tests__/mock-accounts.test.ts`
- Test: `src/__tests__/mock-accounts.test.ts`

**Interfaces:**
- Consumes: Task 2's JSON field `creditLimitCents: number | null` and the three validation messages
- Produces: `client.createAccount(name, subtype, openingBalanceCents, templateKey, creditLimitCents)` and `client.updateAccount({ ..., creditLimitCents? })`. Omitting `creditLimitCents` on update means no new number.

- [ ] **Step 1: Write the failing mock tests**

In `src/__tests__/mock-accounts.test.ts`, change the existing credit-card create so it passes a limit:

```ts
const acc = await mockInvoke<Account>("create_account", {
  name: "Card", subtype: "credit-card", openingBalanceCents: -50000, templateKey: null, creditLimitCents: 1_000_000,
});
expect(acc.creditLimitCents).toBe(1_000_000);
```

Add this test in the same `describe`:

```ts
it("requires a positive limit only on credit-card and bnpl", async () => {
  const card = await mockInvoke<Account>("create_account", {
    name: "Visa", subtype: "credit-card", openingBalanceCents: -200000, templateKey: null, creditLimitCents: 1_000_000,
  });
  expect(card.creditLimitCents).toBe(1_000_000);
  const bnpl = await mockInvoke<Account>("create_account", {
    name: "Atome", subtype: "bnpl", openingBalanceCents: -50000, templateKey: null, creditLimitCents: 300_000,
  });
  expect(bnpl.creditLimitCents).toBe(300_000);

  await expect(mockInvoke("create_account", { name: "Visa", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: null }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit is required for this account." });
  await expect(mockInvoke("create_account", { name: "Visa", subtype: "bnpl", openingBalanceCents: 0, templateKey: null, creditLimitCents: 0 }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit must be greater than zero." });
  await expect(mockInvoke("create_account", { name: "Visa", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: -1 }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit must be greater than zero." });
  await expect(mockInvoke("create_account", { name: "Cash", subtype: "savings", openingBalanceCents: 100, templateKey: null, creditLimitCents: 500 }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit only applies to credit cards and BNPL." });
  const savings = await mockInvoke<Account>("create_account", { name: "Cash", subtype: "savings", openingBalanceCents: 100, templateKey: null, creditLimitCents: null });
  expect(savings.creditLimitCents).toBeNull();

  const replaced = await mockInvoke<Account>("update_account", { input: { id: card.id, creditLimitCents: 2_000_000 } });
  expect(replaced.creditLimitCents).toBe(2_000_000);
  const kept = await mockInvoke<Account>("update_account", { input: { id: card.id, name: "Visa Gold" } });
  expect(kept.creditLimitCents).toBe(2_000_000);
  const cleared = await mockInvoke<Account>("update_account", { input: { id: card.id, subtype: "savings" } });
  expect(cleared.creditLimitCents).toBeNull();

  await expect(mockInvoke("update_account", { input: { id: savings.id, subtype: "credit-card" } }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit is required for this account." });
  const switched = await mockInvoke<Account>("update_account", { input: { id: savings.id, subtype: "bnpl", creditLimitCents: 400_000 } });
  expect(switched.creditLimitCents).toBe(400_000);
  await expect(mockInvoke("update_account", { input: { id: switched.id, subtype: "cash", creditLimitCents: 10 } }))
    .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit only applies to credit cards and BNPL." });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/mock-accounts.test.ts`

Expected: FAIL. Created accounts have no `creditLimitCents`, and a card can still be created without a limit.

- [ ] **Step 3: Thread the field through types, the client, and the mock**

In `src/types.ts`, add the field to `Account` after `openingBalanceCents`:

```ts
  openingBalanceCents: number;
  creditLimitCents: number | null;
  currency: string;
```

In `src/client/index.ts`:

```ts
  createAccount: (name: string, subtype: string, openingBalanceCents: number, templateKey: string | null, creditLimitCents: number | null = null) =>
    dispatch<Account>("create_account", { name, subtype, openingBalanceCents, templateKey, creditLimitCents }),
  updateAccount: (input: { id: string; name?: string; subtype?: string; openingBalanceCents?: number; creditLimitCents?: number }) =>
    dispatch<Account>("update_account", { input }),
```

In `src/__tests__/accountStats.test.ts`, add the field to the `acct` helper so `Account` object literals still typecheck:

```ts
    currency: "MYR", isArchived: p.isArchived ?? false, creditLimitCents: p.creditLimitCents ?? null,
    createdAt: "2026-01-01T00:00:00",
```

In `src/client/mock.ts`, add this helper next to `subtypeOf`. `incoming == null` means "no new number" (`null` or `undefined`): a limit subtype keeps `existing` when that value is already positive, and a non-limit subtype clears the column. Create always passes `null` as `existing`, so a missing create arg cannot keep a previous limit.

```ts
function limitSubtype(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}

function resolveCreditLimit(subtype: string, incoming: number | null | undefined, existing: number | null): number | null {
  if (limitSubtype(subtype)) {
    if (incoming == null) {
      if (existing != null && existing > 0) return existing;
      fail("ValidationError", "Credit limit is required for this account.");
    }
    if (incoming <= 0) fail("ValidationError", "Credit limit must be greater than zero.");
    return incoming;
  }
  if (incoming != null) fail("ValidationError", "Credit limit only applies to credit cards and BNPL.");
  return null;
}
```

`seedDemo`'s `accounts.push({...})` gains `creditLimitCents: null`.

The `create_account` case resolves the limit before building the account. The third argument is `null` because nothing is stored yet:

```ts
    case "create_account": {
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const s = subtypeOf(a.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.subtype}`);
      if (a.templateKey != null && !templates.find((x) => x.key === a.templateKey)) fail("NotFound", "Account template not found");
      const creditLimitCents = resolveCreditLimit(s.key, a.creditLimitCents ?? null, null);
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, creditLimitCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
      return hydrate(acc) as T;
    }
```

The `update_account` case applies the subtype edit first, then resolves the limit. A missing key or JSON `null` is "no new number" (`null`), matching Rust `Option` plus `#[serde(default)]`. A JSON number is a new limit.

```ts
    case "update_account": {
      const acc = accounts.find((x) => x.id === a.input.id) ?? fail("NotFound", "Account not found");
      if (a.input.name != null) acc.name = String(a.input.name).trim();
      if (a.input.subtype != null) {
        const s = subtypeOf(a.input.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.input.subtype}`);
        acc.subtype = s.key;
        acc.accountType = s.type;
        acc.group = s.group;
      }
      const sent = Object.prototype.hasOwnProperty.call(a.input, "creditLimitCents") ? a.input.creditLimitCents : null;
      acc.creditLimitCents = resolveCreditLimit(acc.subtype, sent ?? null, acc.creditLimitCents);
      if (a.input.openingBalanceCents != null) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.input.openingBalanceCents;
      }
      acc.updatedAt = now();
      return hydrate(acc) as T;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/mock-accounts.test.ts src/__tests__/accountStats.test.ts src/lib/__tests__/creditLimit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/client/index.ts src/client/mock.ts src/__tests__/accountStats.test.ts src/__tests__/mock-accounts.test.ts
git commit -m "$(cat <<'EOF'
feat: mirror credit-limit rules in the browser mock

EOF
)"
```

---

### Task 4: Enter the limit and show utilization

**Files:**
- Modify: `src/modals/AddAccount.tsx`
- Modify: `src/modals/EditAccount.tsx`
- Modify: `src/screens/Accounts.tsx`

**Interfaces:**
- Consumes: `subtypeHasCreditLimit`, `creditReadout` from Task 1. `client.createAccount(..., creditLimitCents)` and `client.updateAccount({ creditLimitCents? })` from Task 3. `Account.creditLimitCents`.
- Produces: the New account field, the Edit account field, the accounts-row line, and the expanded bar.

- [ ] **Step 1: Add the field to New account**

In `src/modals/AddAccount.tsx`, import `parseAmountToCents` from `../lib/format` and `subtypeHasCreditLimit` from `../lib/accounts`.

Add state next to `opening`:

```ts
const [limit, setLimit] = useState("");
```

Replace `submit` with this function. A blank or non-positive limit on a card or BNPL account sets the required message and does not call the client. `finally` still clears `busy`.

```ts
  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const needsLimit = subtypeHasCreditLimit(subtype);
      const limitCents = needsLimit ? parseAmountToCents(limit) : null;
      if (needsLimit && limitCents == null) {
        setError("Credit limit is required for this account.");
        return;
      }
      await client.createAccount(name.trim(), subtype, signedOpening, provider?.key ?? null, limitCents);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not create account");
    } finally { setBusy(false); }
  }
```

Render this field immediately after the Amount owed / Opening balance field. It is absent for every other subtype:

```tsx
{subtypeHasCreditLimit(subtype) && (
  <Field label="Credit limit (RM)">
    <input className="sens-input" value={limit} inputMode="decimal" placeholder="0.00"
      onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
      style={{ ...inputStyle(t), fontFamily: t.mono }} />
  </Field>
)}
```

`canCreate` stays name-and-subtype. The limit check runs in `submit` so a blank limit shows the required message.

- [ ] **Step 2: Add the field to Edit account**

In `src/modals/EditAccount.tsx`, import `parseAmountToCents` from `../lib/format` and `subtypeHasCreditLimit` from `../lib/accounts`.

```ts
const [limit, setLimit] = useState(
  account.creditLimitCents != null ? (account.creditLimitCents / 100).toFixed(2) : "",
);
```

Replace `submit` so a limit subtype always sends the parsed number, and any other subtype omits the field:

```ts
async function submit() {
  if (!name.trim()) return;
  setBusy(true); setError(null);
  try {
    const needsLimit = subtypeHasCreditLimit(subtype);
    if (needsLimit) {
      const limitCents = parseAmountToCents(limit);
      if (limitCents == null) {
        setError("Credit limit is required for this account.");
        return;
      }
      await client.updateAccount({ id: account.id, name: name.trim(), subtype, creditLimitCents: limitCents });
    } else {
      await client.updateAccount({ id: account.id, name: name.trim(), subtype });
    }
    onDone();
  } catch (e) {
    setError((e as { message?: string })?.message ?? "Could not save");
  } finally { setBusy(false); }
}
```

The `return` inside `try` must still reach `finally` so `busy` clears. It does: `finally` runs on `return`.

Render the field under the type/subtype grid, only while the chosen subtype needs a limit:

```tsx
{subtypeHasCreditLimit(subtype) && (
  <Field label="Credit limit (RM)">
    <input className="sens-input" value={limit} inputMode="decimal" placeholder="0.00"
      onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ""))}
      style={{ ...inputStyle(t), fontFamily: t.mono }} />
  </Field>
)}
```

- [ ] **Step 3: Show the readout on the Accounts screen**

In `src/screens/Accounts.tsx`, import `creditReadout` from `../lib/accounts`. `fmtMoney` is already imported.

Inside the account row callback, after `balanceDisplay`:

```tsx
const readout = a.creditLimitCents != null && a.creditLimitCents > 0
  ? creditReadout(a.balanceCents, a.creditLimitCents)
  : null;
```

Under the `<Money>` and `<Delta>` in the right-hand column, when `readout` is set:

```tsx
{readout && (
  <span style={{ fontSize: 10.5, fontFamily: t.mono, color: readout.overLimit ? t.expense : t.dim }}>
    {readout.overLimit
      ? `Over limit · ${readout.usedPercent}%`
      : `${fmtMoney(readout.availableCents, { cents: true })} available · ${readout.usedPercent}%`}
  </span>
)}
```

In the expanded panel, above the In / Out / Net tiles, when `readout` is set:

```tsx
{readout && (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 6, color: readout.overLimit ? t.expense : t.dim }}>
      <span>{fmtMoney(readout.availableCents, { cents: true })} available</span>
      <span>{readout.overLimit ? `Over limit · ${readout.usedPercent}%` : `${readout.usedPercent}%`}</span>
    </div>
    <div style={{ height: 6, borderRadius: 99, background: t.panel3, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(readout.usedPercent, 100)}%`, height: "100%", borderRadius: 99, background: readout.overLimit ? t.expense : t.accent }} />
    </div>
  </div>
)}
```

A null limit renders neither the line nor the bar. At 100% the row keeps the available amount and `100%`. The bar fill caps at 100% width; the label still shows `120%` when `usedPercent` is 120.

- [ ] **Step 4: Typecheck and run the frontend tests**

Run: `npm test && npm run build`

Expected: PASS. `npm run build` is `tsc` plus Vite, so a missing `creditLimitCents` on an `Account` literal fails here.

- [ ] **Step 5: Commit**

```bash
git add src/modals/AddAccount.tsx src/modals/EditAccount.tsx src/screens/Accounts.tsx
git commit -m "$(cat <<'EOF'
feat: show credit limit, available credit, and utilization

EOF
)"
```

---

### Task 5: Document the slice

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: the behavior from Tasks 1–4
- Produces: docs that name the limit without marking loan schedules, interest, guided repayments, or reimbursement pairing as shipped

- [ ] **Step 1: Update the agent docs**

`CLAUDE.md` and `AGENTS.md` are the same guide. After the signed-liabilities bullet in both files, add:

```markdown
- **Credit limit (credit-card and BNPL):** those two subtypes store a required `creditLimitCents` (positive sen, migration 010). Every other subtype leaves it null; switching away clears it and switching in requires one, both enforced in the service and the mock. Utilization and available credit are derived in `creditReadout` (`src/lib/accounts.ts`): amount owed is the negative balance, available credit floors at zero and never exceeds the limit (a card in credit shows the full limit and 0%), and `overLimit` is a whole-number percent above 100. Over-limit charges still save. The Accounts row and expanded panel show the readout. Dashboard totals do not.
```

- [ ] **Step 2: Update the changelog**

Under `## [Unreleased]` in `CHANGELOG.md`, add an Added section (keep the existing Documentation section):

```markdown
### Added
- **Credit limit on credit cards and BNPL.** Creating or editing either account requires a limit. The Accounts screen shows available credit and utilization. A charge past the limit is still saved; available credit stays at zero and the row reads "Over limit".
```

- [ ] **Step 3: Update the roadmap**

In `ROADMAP.md`, under `### ⚪ Credit & debt behavior`, check only the limit item and point it at this spec. Leave the other boxes open. Delete the phase's trailing spec line (`spec:` followed by an underscore placeholder) and use this list instead:

```markdown
- [x] credit limit + utilization % + available credit — spec: `docs/superpowers/specs/2026-10-12-credit-limit-design.md`
- [ ] installment / payoff schedules
- [ ] interest + principal-vs-interest split
- [ ] credit-card payments and loan/BNPL repayments recorded as money movement rather
      than income/expense (own→owe transfers are already excluded; the `excludedFromReporting`
      flag covers external-party cases) — carried over from v0.5.0
- [ ] reimbursements & claims — money back that explicitly offsets an original expense
      (pairing), beyond the v0.5.0 flag that already excludes it from income
```

Do not add a Shipped-table row. That row is written when the version tag ships.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md CHANGELOG.md ROADMAP.md
git commit -m "$(cat <<'EOF'
docs: describe credit limits for cards and BNPL

EOF
)"
```

---

## Self-review notes

Spec coverage: migration 010 and the CHECK live in Task 2. Create and update tables live in Task 2 (Rust) and Task 3 (mock), including the three messages, subtype switch, and the over-limit expense. The readout table, the 100% boundary, and `overLimit` live in Task 1. New account, edit account, the row line, and the expanded bar live in Task 4. Docs live in Task 5. Dashboard and `AccountBalance` are left unchanged on purpose.

Out of scope, and not in any task: statement dates, APR, minimum payments, installment schedules, limits on loans, refusing a transaction, a dashboard utilization total, and a first-launch limit screen.
