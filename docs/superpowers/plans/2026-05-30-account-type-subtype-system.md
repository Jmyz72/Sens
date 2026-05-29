# Account Type & Subtype System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account classification real — each account has a `subtype` mapping to a `type` and a `group` (own/owe), driving net worth across balances, dashboard, and account lists, with provider templates decoupled from classification.

**Architecture:** A new `account_subtypes` reference table is the canonical taxonomy (16 subtypes → 5 types → 2 groups). `subtype` is the only stored classifier; `type`/`group` are derived via JOIN on read. Liabilities use signed balances (owe = negative), so the transaction/balance engine is untouched — `type` is pure classification + presentation. The sign adapter ("Amount owed" → negative; display as positive) lives only at the frontend edge.

**Tech Stack:** Tauri v2 (Rust) + rusqlite/SQLite, React 19 + TypeScript + Vite, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-05-30-account-type-subtype-system-design.md`

**Conventions reminder:**
- Rust not on default PATH: prefix with `export PATH="$HOME/.cargo/bin:$PATH"`.
- The Tauri/mock seam: every backend behavior/signature change lands in BOTH the Rust chain and `src/client/mock.ts`.
- Frontend gate: `npm run build` (strict TS, `noUnusedLocals`/`noUnusedParameters`).

---

## Task 1: Rust backend switchover (taxonomy, create_account, derived type/group, net worth)

This is one atomic change: the migration drops `accounts.account_type`, so models/repo/service/commands must change together to keep the build green. Implement all steps, then run the test suite once at the end.

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (add MIGRATION_002)
- Modify: `src-tauri/src/db/mod.rs` (add migration-002 test module)
- Modify: `src-tauri/src/db/seed.rs` (add Crypto group + Luno to catalog)
- Modify: `src-tauri/src/models.rs` (AccountSubtype; Account.group; AccountBalance.group; DashboardSummary net-worth fields)
- Modify: `src-tauri/src/repo.rs` (joins for type/group; insert_account; list_account_subtypes; account_balances)
- Modify: `src-tauri/src/service.rs` (create_account; subtype validation; delete account_type_for_group; dashboard net worth; list_account_subtypes)
- Modify: `src-tauri/src/commands.rs` (create_account; list_account_subtypes)
- Modify: `src-tauri/src/lib.rs` (handler registration; existing tests)

- [ ] **Step 1: Add MIGRATION_002 in `src-tauri/src/db/migrations.rs`**

Change the list and append the constant:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002)];
```

```rust
const MIGRATION_002: &str = r#"
CREATE TABLE account_subtypes (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('fund','financial','receivable','payable','credit')),
  account_group TEXT NOT NULL CHECK (account_group IN ('own','owe')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

INSERT INTO account_subtypes (key, label, type, account_group, sort_order) VALUES
  ('cash',          'Cash',                     'fund',       'own', 0),
  ('ewallet',       'E-wallet',                 'fund',       'own', 1),
  ('savings',       'Savings account',          'fund',       'own', 2),
  ('current',       'Current / Checking',       'fund',       'own', 3),
  ('fixed-deposit', 'Fixed deposit',            'financial',  'own', 4),
  ('investment',    'Investment / Brokerage',   'financial',  'own', 5),
  ('unit-trust',    'Unit trust / ASNB',        'financial',  'own', 6),
  ('crypto',        'Crypto',                   'financial',  'own', 7),
  ('lent',          'Lent to someone (IOU)',    'receivable', 'own', 8),
  ('borrowed',      'Borrowed from someone',    'payable',    'owe', 9),
  ('credit-card',   'Credit card',              'credit',     'owe', 10),
  ('bnpl',          'BNPL',                     'credit',     'owe', 11),
  ('personal-loan', 'Personal loan',            'credit',     'owe', 12),
  ('mortgage',      'Mortgage',                 'credit',     'owe', 13),
  ('car-loan',      'Car / Hire-purchase loan', 'credit',     'owe', 14),
  ('other-debt',    'Other debt',               'credit',     'owe', 15);

UPDATE accounts SET subtype = CASE
  WHEN subtype IN ('cash','ewallet','savings','current','fixed-deposit','investment',
                   'unit-trust','crypto','lent','borrowed','credit-card','bnpl',
                   'personal-loan','mortgage','car-loan','other-debt') THEN subtype
  WHEN account_type IN ('bank','digital_bank') THEN 'savings'
  WHEN account_type = 'ewallet'        THEN 'ewallet'
  WHEN account_type = 'global_fintech' THEN 'ewallet'
  WHEN account_type = 'bnpl'           THEN 'bnpl'
  WHEN account_type = 'investment'     THEN 'investment'
  ELSE 'cash'
END;

INSERT OR IGNORE INTO account_templates
  (key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active)
  VALUES ('luno', 'Luno', 'Crypto', 'crypto', 'luno', NULL, 49, 1);

ALTER TABLE accounts DROP COLUMN account_type;
"#;
```

- [ ] **Step 2: Add Crypto + Luno to the fresh-install catalog in `src-tauri/src/db/seed.rs`**

After the `fintech` array (before `let mut out = Vec::new();`), add:

```rust
    let crypto = [("luno", "Luno")];
```

After the `push(&fintech, "Global fintech", "ewallet", &mut order);` line, add:

```rust
    push(&crypto, "Crypto", "crypto", &mut order);
```

(`account_subtypes` is seeded only by migration 002 — runs for both fresh and existing DBs — so `seed.rs` does not touch it.)

- [ ] **Step 3: Update `src-tauri/src/models.rs`**

Add the new struct after `AccountTemplate`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSubtype {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub group: String,
    pub sort_order: i64,
    pub is_active: bool,
}
```

In `Account`, the `account_type` field now holds the derived type; add a `group` field right after it:

```rust
    pub account_type: String, // derived type: fund|financial|receivable|payable|credit
    pub group: String,        // derived: own|owe
```

In `AccountBalance`, add `group` after `account_type`:

```rust
    pub account_type: String,
    pub group: String,
```

In `DashboardSummary`, replace `total_balance_cents` with the three net-worth fields:

```rust
    pub net_worth_cents: i64,
    pub assets_cents: i64,
    pub liabilities_cents: i64,
```

- [ ] **Step 4: Update `src-tauri/src/repo.rs`**

Replace `map_account` so it reads the joined `account_type`/`group` aliases (note `a.*` no longer contains `account_type`):

```rust
fn map_account(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get("id")?,
        template_key: r.get("template_key")?,
        name: r.get("name")?,
        account_type: r.get("account_type")?, // aliased from s.type
        group: r.get("group")?,               // aliased from s.account_group
        subtype: r.get("subtype")?,
        opening_balance_cents: r.get("opening_balance_cents")?,
        currency: r.get("currency")?,
        is_archived: r.get::<_, i64>("is_archived")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        balance_cents: r.get("balance_cents")?,
    })
}
```

Update `get_account` and `list_accounts` to JOIN the taxonomy:

```rust
pub fn get_account(conn: &Connection, id: &str) -> AppResult<Account> {
    let sql = format!(
        "SELECT a.*, s.type AS account_type, s.account_group AS \"group\", ({}) AS balance_cents \
         FROM accounts a JOIN account_subtypes s ON s.key = a.subtype WHERE a.id = ?1",
        balance_expr("a")
    );
    conn.query_row(&sql, [id], map_account)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Account not found".into()),
            other => other.into(),
        })
}

pub fn list_accounts(conn: &Connection, include_archived: bool) -> AppResult<Vec<Account>> {
    let sql = format!(
        "SELECT a.*, s.type AS account_type, s.account_group AS \"group\", ({}) AS balance_cents \
         FROM accounts a JOIN account_subtypes s ON s.key = a.subtype {} ORDER BY a.created_at",
        balance_expr("a"),
        if include_archived { "" } else { "WHERE a.is_archived = 0" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_account)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

Change `insert_account` to drop the `account_type` parameter and column:

```rust
pub fn insert_account(
    conn: &Connection,
    id: &str,
    template_key: Option<&str>,
    name: &str,
    subtype: &str,
    opening_balance_cents: i64,
    now: &str,
) -> AppResult<Account> {
    conn.execute(
        "INSERT INTO accounts
           (id, template_key, name, subtype, opening_balance_cents, currency, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'MYR', 0, ?6, ?6)",
        params![id, template_key, name, subtype, opening_balance_cents, now],
    )?;
    get_account(conn, id)
}
```

Add a taxonomy reader and a subtype existence check (place after `get_template`):

```rust
pub fn list_account_subtypes(conn: &Connection) -> AppResult<Vec<AccountSubtype>> {
    let mut stmt = conn.prepare(
        "SELECT key, label, type, account_group, sort_order, is_active
         FROM account_subtypes WHERE is_active = 1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AccountSubtype {
                key: r.get(0)?,
                label: r.get(1)?,
                type_: r.get(2)?,
                group: r.get(3)?,
                sort_order: r.get(4)?,
                is_active: r.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn subtype_exists(conn: &Connection, key: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM account_subtypes WHERE key = ?1)",
        [key],
        |r| r.get(0),
    )?)
}
```

Update `account_balances` to join and populate `group`:

```rust
pub fn account_balances(conn: &Connection) -> AppResult<Vec<AccountBalance>> {
    let sql = format!(
        "SELECT a.id, a.name, s.type AS account_type, s.account_group AS \"group\", ({}) AS balance_cents \
         FROM accounts a JOIN account_subtypes s ON s.key = a.subtype \
         WHERE a.is_archived = 0 ORDER BY a.created_at",
        balance_expr("a")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AccountBalance {
                account_id: r.get(0)?,
                name: r.get(1)?,
                account_type: r.get(2)?,
                group: r.get(3)?,
                balance_cents: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

`total_balance` is unchanged (sums `account_balances`).

- [ ] **Step 5: Update `src-tauri/src/service.rs`**

Delete the `account_type_for_group` function (lines ~22-33) entirely.

Replace `create_account_from_template` and `create_custom_account` with one function:

```rust
pub fn list_account_subtypes(conn: &Connection) -> AppResult<Vec<AccountSubtype>> {
    repo::list_account_subtypes(conn)
}

pub fn create_account(
    conn: &Connection,
    name: &str,
    subtype: &str,
    opening_balance_cents: i64,
    template_key: Option<&str>,
) -> AppResult<Account> {
    let name = require_nonempty("Account name", name)?;
    let subtype = require_nonempty("Subtype", subtype)?;
    if !repo::subtype_exists(conn, &subtype)? {
        return Err(AppError::Validation(format!("Invalid subtype: {subtype}")));
    }
    if let Some(key) = template_key {
        repo::get_template(conn, key)?; // existence (NotFound if bogus)
    }
    repo::insert_account(conn, &new_id(), template_key, &name, &subtype, opening_balance_cents, &now())
}
```

In `update_account`, validate a provided subtype before writing (insert after the `name` block, before `repo::update_account_fields`):

```rust
    if let Some(s) = &input.subtype {
        if !repo::subtype_exists(conn, s)? {
            return Err(AppError::Validation(format!("Invalid subtype: {s}")));
        }
    }
```

Update `get_dashboard_summary` to compute net worth from `account_balances`. Read the current function body and replace the `total_balance` usage: compute the three figures and put them in the returned struct.

```rust
    let balances = repo::account_balances(conn)?;
    let assets_cents: i64 = balances.iter().filter(|b| b.group == "own").map(|b| b.balance_cents).sum();
    let liabilities_cents: i64 = balances.iter().filter(|b| b.group == "owe").map(|b| b.balance_cents).sum();
    let net_worth_cents = assets_cents + liabilities_cents;
```

In the `DashboardSummary { … }` literal, replace `total_balance_cents: …` with:

```rust
        net_worth_cents,
        assets_cents,
        liabilities_cents,
        account_balances: balances,
```

(Reuse the already-fetched `balances` for `account_balances` instead of calling `account_balances` twice.)

- [ ] **Step 6: Update `src-tauri/src/commands.rs`**

Replace the two create commands with one and add the taxonomy list:

```rust
#[tauri::command]
pub fn list_account_subtypes(state: State<'_, DbState>) -> AppResult<Vec<AccountSubtype>> {
    with_conn!(state, c => service::list_account_subtypes(&c))
}

#[tauri::command]
pub fn create_account(
    state: State<'_, DbState>,
    name: String,
    subtype: String,
    opening_balance_cents: i64,
    template_key: Option<String>,
) -> AppResult<Account> {
    with_conn!(state, c => service::create_account(&c, &name, &subtype, opening_balance_cents, template_key.as_deref()))
}
```

- [ ] **Step 7: Update handler registration in `src-tauri/src/lib.rs`**

In `tauri::generate_handler![ … ]` replace `commands::create_account_from_template,` and `commands::create_custom_account,` with:

```rust
            commands::list_account_subtypes,
            commands::create_account,
```

- [ ] **Step 8: Update existing Rust tests in `src-tauri/src/lib.rs`**

Update the `acct` helper and affected tests:

```rust
    fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
        service::create_account(conn, name, "savings", opening, None).unwrap()
    }
```

Replace `seeds_templates_and_categories`'s count and `create_account_from_template_derives_type`:

```rust
    #[test]
    fn seeds_templates_and_categories() {
        let c = open_in_memory().unwrap();
        assert_eq!(service::list_account_templates(&c).unwrap().len(), 50); // +Luno
        assert!(!service::list_categories(&c, Some("expense"), false).unwrap().is_empty());
    }

    #[test]
    fn create_account_derives_type_and_group() {
        let c = open_in_memory().unwrap();
        let a = service::create_account(&c, "My Maybank", "savings", 10000, Some("maybank")).unwrap();
        assert_eq!(a.account_type, "fund");
        assert_eq!(a.group, "own");
        assert_eq!(a.balance_cents, 10000);
    }
```

Scan the rest of the test module for any other `create_custom_account` / `create_account_from_template` calls and replace them with `create_account(conn, name, "savings", opening, None)` (or an appropriate subtype). The `acct` helper covers most.

- [ ] **Step 9: Add new backend tests in `src-tauri/src/lib.rs`** (in the `tests` module)

```rust
    #[test]
    fn lists_sixteen_subtypes() {
        let c = open_in_memory().unwrap();
        assert_eq!(service::list_account_subtypes(&c).unwrap().len(), 16);
    }

    #[test]
    fn rejects_invalid_subtype() {
        let c = open_in_memory().unwrap();
        let err = service::create_account(&c, "Bad", "not-a-subtype", 0, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn owe_account_stores_signed_and_nets_worth() {
        let c = open_in_memory().unwrap();
        service::create_account(&c, "Cash", "cash", 30_000_00, None).unwrap();
        let card = service::create_account(&c, "CIMB Card", "credit-card", -5_000_00, None).unwrap();
        assert_eq!(card.group, "owe");
        let d = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(d.assets_cents, 30_000_00);
        assert_eq!(d.liabilities_cents, -5_000_00);
        assert_eq!(d.net_worth_cents, 25_000_00);
    }
```

(Add `use crate::error::AppError;` to the test module's `use` block if not present.)

- [ ] **Step 10: Add the migration-002 remap test in `src-tauri/src/db/mod.rs`**

At the bottom of the file:

```rust
#[cfg(test)]
mod migration_tests {
    use super::migrations::MIGRATIONS;
    use rusqlite::Connection;

    #[test]
    fn migration_002_remaps_legacy_subtypes_and_drops_account_type() {
        let conn = Connection::open_in_memory().unwrap();
        // v1 schema only.
        conn.execute_batch(MIGRATIONS[0].1).unwrap();
        // Legacy rows spanning the old account_type values.
        conn.execute_batch(
            "INSERT INTO accounts (id,template_key,name,account_type,subtype,opening_balance_cents,currency,is_archived,created_at,updated_at) VALUES
               ('1',NULL,'Bank','bank','savings',0,'MYR',0,'t','t'),
               ('2',NULL,'BNPL','bnpl','bnpl',0,'MYR',0,'t','t'),
               ('3',NULL,'Wallet','ewallet','ewallet',0,'MYR',0,'t','t'),
               ('4',NULL,'Inv','investment','investment',0,'MYR',0,'t','t'),
               ('5',NULL,'Weird','custom','totally-custom',0,'MYR',0,'t','t');",
        )
        .unwrap();
        // Apply v1.1.
        conn.execute_batch(MIGRATIONS[1].1).unwrap();

        let sub = |id: &str| -> String {
            conn.query_row("SELECT subtype FROM accounts WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(sub("1"), "savings");
        assert_eq!(sub("2"), "bnpl");
        assert_eq!(sub("3"), "ewallet");
        assert_eq!(sub("4"), "investment");
        assert_eq!(sub("5"), "cash"); // unknown → cash
        assert_eq!(super::super::db::tests_subtype_count(&conn), 16);

        // account_type column is gone.
        let has_col: bool = conn
            .prepare("SELECT account_type FROM accounts")
            .is_ok();
        assert!(!has_col, "account_type column should be dropped");
    }
}
```

Add this tiny helper above the test module (or inline the count query in the test to avoid it):

```rust
#[cfg(test)]
pub fn tests_subtype_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM account_subtypes", [], |r| r.get(0)).unwrap()
}
```

To use the private `migrations::MIGRATIONS` from the test, ensure `mod migrations;` exposes the const (it is already `pub const MIGRATIONS`). `super::migrations::MIGRATIONS` resolves because the test module is nested in `db`.

- [ ] **Step 11: Run the full Rust suite**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib`
Expected: PASS — all existing tests plus the 4 new ones and the migration remap test. Build is clean.

- [ ] **Step 12: Commit**

```bash
git add src-tauri
git commit -m "feat(accounts): subtype taxonomy, derived type/group, net worth, migration 002"
```

---

## Task 2: TypeScript types, client, and mock parity

**Files:**
- Modify: `src/types.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/mock.ts`
- Test: `src/__tests__/mock.test.ts` (existing — extend) or new `src/__tests__/mock-accounts.test.ts`

- [ ] **Step 1: Write failing mock tests** in `src/__tests__/mock-accounts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, AccountSubtype, DashboardSummary } from "../types";

describe("mock taxonomy + net worth", () => {
  it("lists 16 subtypes with type+group", async () => {
    const subs = await mockInvoke<AccountSubtype[]>("list_account_subtypes", {});
    expect(subs).toHaveLength(16);
    const card = subs.find((s) => s.key === "credit-card")!;
    expect(card.type).toBe("credit");
    expect(card.group).toBe("owe");
  });

  it("create_account derives type/group and rejects bad subtype", async () => {
    const acc = await mockInvoke<Account>("create_account", { name: "Card", subtype: "credit-card", openingBalanceCents: -50000, templateKey: null });
    expect(acc.accountType).toBe("credit");
    expect(acc.group).toBe("owe");
    await expect(mockInvoke("create_account", { name: "X", subtype: "nope", openingBalanceCents: 0, templateKey: null }))
      .rejects.toMatchObject({ code: "ValidationError" });
  });

  it("dashboard reports net worth = assets + liabilities", async () => {
    await mockInvoke("create_account", { name: "Cash", subtype: "cash", openingBalanceCents: 1000000, templateKey: null });
    await mockInvoke("create_account", { name: "Loan", subtype: "personal-loan", openingBalanceCents: -300000, templateKey: null });
    const d = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-05" });
    expect(d.netWorthCents).toBe(d.assetsCents + d.liabilitiesCents);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/mock-accounts.test.ts`
Expected: FAIL (unknown command `list_account_subtypes` / `create_account`; missing types).

- [ ] **Step 3: Update `src/types.ts`**

Add the subtype interface and the `group` union; update `Account`, `AccountBalance`, `DashboardSummary`:

```ts
export type AccountGroup = "own" | "owe";
export type AccountTypeName = "fund" | "financial" | "receivable" | "payable" | "credit";

export interface AccountSubtype {
  key: string;
  label: string;
  type: AccountTypeName;
  group: AccountGroup;
  sortOrder: number;
  isActive: boolean;
}
```

In `Account`: change `accountType: string;` to `accountType: AccountTypeName;` and add `group: AccountGroup;` right after it.

In `AccountBalance`: change `accountType: string;` to `accountType: AccountTypeName;` and add `group: AccountGroup;`.

In `DashboardSummary`: replace `totalBalanceCents: number;` with:

```ts
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
```

- [ ] **Step 4: Update `src/client/index.ts`**

Add the import `AccountSubtype` to the type import block. Replace the two create wrappers and add the taxonomy reader:

```ts
  listAccountSubtypes: () => dispatch<AccountSubtype[]>("list_account_subtypes"),
  createAccount: (name: string, subtype: string, openingBalanceCents: number, templateKey: string | null) =>
    dispatch<Account>("create_account", { name, subtype, openingBalanceCents, templateKey }),
```

Remove `createAccountFromTemplate` and `createCustomAccount`.

- [ ] **Step 5: Update `src/client/mock.ts`**

Add the taxonomy mirror near the top (after `uid`/`now` helpers):

```ts
const SUBTYPES: AccountSubtype[] = [
  ["cash","Cash","fund","own"],["ewallet","E-wallet","fund","own"],
  ["savings","Savings account","fund","own"],["current","Current / Checking","fund","own"],
  ["fixed-deposit","Fixed deposit","financial","own"],["investment","Investment / Brokerage","financial","own"],
  ["unit-trust","Unit trust / ASNB","financial","own"],["crypto","Crypto","financial","own"],
  ["lent","Lent to someone (IOU)","receivable","own"],["borrowed","Borrowed from someone","payable","owe"],
  ["credit-card","Credit card","credit","owe"],["bnpl","BNPL","credit","owe"],
  ["personal-loan","Personal loan","credit","owe"],["mortgage","Mortgage","credit","owe"],
  ["car-loan","Car / Hire-purchase loan","credit","owe"],["other-debt","Other debt","credit","owe"],
].map(([key, label, type, group], i) => ({ key, label, type, group, sortOrder: i, isActive: true } as AccountSubtype));
const subtypeOf = (key: string) => SUBTYPES.find((s) => s.key === key);
```

Add `AccountSubtype` to the type imports.

Add Crypto/Luno to the mock template catalog and delete `GROUP_TYPE`. In `TPL_GROUPS` append a group entry:

```ts
  ["Crypto", "crypto", [["luno", "Luno"]]],
```

Delete the `GROUP_TYPE` constant. Anywhere it was used to set `accountType`, derive from subtype instead.

Replace `seedDemo`'s `mk` to derive type/group:

```ts
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    const s = subtypeOf(t.defaultSubtype)!;
    accounts.push({ id: uid(), templateKey: key, name, accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: opening, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
  };
```

Update `hydrate` to keep type/group in sync with subtype:

```ts
const hydrate = (a: Account): Account => {
  const s = subtypeOf(a.subtype);
  return { ...a, accountType: s?.type ?? a.accountType, group: s?.group ?? a.group, balanceCents: balanceOf(a) };
};
```

Replace the `create_account_from_template` and `create_custom_account` cases with one, and add `list_account_subtypes`:

```ts
    case "list_account_subtypes":
      return SUBTYPES as T;
    case "create_account": {
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const s = subtypeOf(a.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.subtype}`);
      if (a.templateKey != null && !templates.find((x) => x.key === a.templateKey)) fail("NotFound", "Account template not found");
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      return hydrate(acc) as T;
    }
```

In `update_account`, after setting subtype, the `hydrate` call already re-derives type/group — no extra change needed beyond keeping the existing subtype assignment.

Update `get_account_balances` to include `group`:

```ts
    case "get_account_balances":
      return accounts.filter((x) => !x.isArchived).map((x) => { const s = subtypeOf(x.subtype); return { accountId: x.id, name: x.name, accountType: s?.type ?? x.accountType, group: s?.group ?? x.group, balanceCents: balanceOf(x) } as AccountBalance; }) as T;
```

Update the `get_dashboard_summary` case: compute net worth and replace `totalBalanceCents`:

```ts
      const withGroup = active.map((x) => ({ x, s: subtypeOf(x.subtype), bal: balanceOf(x) }));
      const assetsCents = withGroup.filter((r) => (r.s?.group ?? "own") === "own").reduce((sum, r) => sum + r.bal, 0);
      const liabilitiesCents = withGroup.filter((r) => (r.s?.group ?? "own") === "owe").reduce((sum, r) => sum + r.bal, 0);
      const summary: DashboardSummary = {
        month: a.month,
        netWorthCents: assetsCents + liabilitiesCents,
        assetsCents, liabilitiesCents,
        incomeCents: income, expenseCents: expense, netCashflowCents: income - expense,
        spendingBreakdown: breakdown,
        accountBalances: active.map((x) => { const s = subtypeOf(x.subtype); return { accountId: x.id, name: x.name, accountType: s?.type ?? x.accountType, group: s?.group ?? x.group, balanceCents: balanceOf(x) }; }),
        recentTransactions: txns.slice().sort((x, y) => (y.transactionDate < x.transactionDate ? -1 : 1)).slice(0, 8),
      };
```

- [ ] **Step 6: Update the existing `src/__tests__/mock.test.ts`** for the renamed command/fields

The `freshAccount` helper and one test call the removed `create_custom_account`; two assertions use `totalBalanceCents`. Apply:

Replace the `freshAccount` helper:

```ts
async function freshAccount(name = "Test Account", opening = 0): Promise<Account> {
  return mockInvoke<Account>("create_account", {
    name,
    subtype: "savings",
    openingBalanceCents: opening,
    templateKey: null,
  });
}
```

Replace the empty-name test body's `mockInvoke` call:

```ts
      mockInvoke("create_account", {
        name: "   ",
        subtype: "savings",
        openingBalanceCents: 0,
        templateKey: null,
      }),
```

Replace both `totalBalanceCents` references in the adjustment test with `netWorthCents`:

```ts
    // netWorthCents reflects all accounts' current balances
    expect(after.netWorthCents).toBeGreaterThan(before.netWorthCents);
```

(The `describe("create_custom_account + list_accounts", …)` title is cosmetic — leave it or rename to `create_account + list_accounts`.)

- [ ] **Step 7: Run TS tests**

Run: `npx vitest run src/__tests__/mock-accounts.test.ts src/__tests__/mock.test.ts`
Expected: PASS.

Note: a full `npm run build` will still FAIL here because `src/screens/*` and `src/modals/*` use old fields/commands — that is expected and restored in Tasks 6-7. This is a feature branch; do not merge until Task 9's build passes.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/client src/__tests__/mock-accounts.test.ts src/__tests__/mock.test.ts
git commit -m "feat(client): account subtype taxonomy, createAccount, net worth in mock"
```

---

## Task 3: Frontend taxonomy/display helpers (`src/lib/accounts.ts`)

**Files:**
- Create: `src/lib/accounts.ts`
- Test: `src/__tests__/accounts.test.ts`

- [ ] **Step 1: Write failing test** in `src/__tests__/accounts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { balanceDisplay, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

describe("balanceDisplay", () => {
  it("own shows signed value as-is", () => {
    expect(balanceDisplay("own", 5000)).toMatchObject({ magnitude: 5000, tone: "text", label: null });
    expect(balanceDisplay("own", -5000)).toMatchObject({ magnitude: -5000, tone: "negative" });
  });
  it("owe with debt shows positive magnitude, negative tone, owe label", () => {
    expect(balanceDisplay("owe", -50000)).toMatchObject({ magnitude: 50000, tone: "negative", label: "You owe" });
  });
  it("owe in credit shows positive, in-credit label", () => {
    expect(balanceDisplay("owe", 2000)).toMatchObject({ magnitude: 2000, tone: "income", label: "In credit" });
  });
});

describe("type metadata", () => {
  it("labels all five types and orders them own→owe", () => {
    expect(TYPE_LABEL.fund).toBe("Cash & funds");
    expect(TYPE_ORDER).toEqual(["fund", "financial", "receivable", "payable", "credit"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/accounts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/lib/accounts.ts`**

```ts
// Account taxonomy display helpers. The backend supplies each account's derived
// `type` and `group`; this module owns the *presentation* of that classification
// (section labels, ordering) and the sign adapter for owe (liability) balances —
// the one place that knows "a liability shows as a positive amount you owe".

import type { AccountGroup, AccountTypeName } from "../types";

export const TYPE_LABEL: Record<AccountTypeName, string> = {
  fund: "Cash & funds",
  financial: "Investments",
  receivable: "Receivables",
  payable: "Payables",
  credit: "Credit & loans",
};

export const TYPE_ORDER: AccountTypeName[] = ["fund", "financial", "receivable", "payable", "credit"];

export type BalanceTone = "text" | "negative" | "income";

export interface BalanceView {
  /** Value to render via <Money cents={magnitude}>. Always already sign-adjusted. */
  magnitude: number;
  tone: BalanceTone;
  /** Prefix label for owe accounts ("You owe" / "In credit"), else null. */
  label: string | null;
}

/**
 * Map an account's (group, signed balance) to how it should be displayed.
 *   own:                 signed as-is (negative = overdraft, red)
 *   owe & balance <= 0:  abs, red,   "You owe"
 *   owe & balance  > 0:  positive,   "In credit" (overpaid)
 */
export function balanceDisplay(group: AccountGroup, balanceCents: number): BalanceView {
  if (group === "owe") {
    if (balanceCents <= 0) return { magnitude: Math.abs(balanceCents), tone: "negative", label: "You owe" };
    return { magnitude: balanceCents, tone: "income", label: "In credit" };
  }
  return { magnitude: balanceCents, tone: balanceCents < 0 ? "negative" : "text", label: null };
}

/** Resolve a BalanceTone to a theme color. */
export function toneColor(tone: BalanceTone, t: { text: string; negative: string; income: string }): string {
  return tone === "negative" ? t.negative : tone === "income" ? t.income : t.text;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts.ts src/__tests__/accounts.test.ts
git commit -m "feat(ui): account taxonomy display helpers + balanceDisplay"
```

---

## Task 4: Rewrite the AddAccount modal

**Files:**
- Modify: `src/modals/AddAccount.tsx` (full rewrite)

- [ ] **Step 1: Replace `src/modals/AddAccount.tsx` with the type-first flow**

```tsx
// Create an account: optionally pick a provider (branding), then choose a type
// and subtype (which determine own/owe), then name + balance. For owe accounts
// the balance field is "Amount owed" and is stored negative.

import { useEffect, useMemo, useState } from "react";
import type { AccountSubtype, AccountTemplate } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";
import { templateTone } from "../lib/brand";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

export function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [custom, setCustom] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AccountTemplate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("fund");
  const [subtype, setSubtype] = useState<string>("savings");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountTemplates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, AccountTemplate[]>();
    templates.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
      if (!map.has(x.groupName)) map.set(x.groupName, []);
      map.get(x.groupName)!.push(x);
    });
    return [...map.entries()];
  }, [templates, query]);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  const currentSubtype = subtypes.find((s) => s.key === subtype);
  const isOwe = currentSubtype?.group === "owe";

  // When the chosen type changes, keep subtype valid.
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  // Picking a provider pre-selects its default subtype + that subtype's type.
  function pick(tpl: AccountTemplate) {
    setPicked(tpl);
    if (!name) setName(tpl.name);
    const s = subtypes.find((x) => x.key === tpl.defaultSubtype);
    if (s) { setType(s.type); setSubtype(s.key); }
  }

  const openingCents = opening ? parseAmountToCents(opening) ?? 0 : 0;
  const signedOpening = isOwe ? -openingCents : openingCents;
  const canCreate = name.trim().length > 0 && (custom || !!picked) && !!currentSubtype;

  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await client.createAccount(name.trim(), subtype, signedOpening, custom ? null : picked!.key);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not create account");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={460}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>New account</span>
        <button className="sens-btn sens-btn-ghost" onClick={() => { setCustom((c) => !c); setPicked(null); }}
          style={{ height: 28, padding: "0 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, color: t.accent }}>
          {custom ? "Pick a provider" : "Custom account"}
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {!custom && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 9 }}>
              <Icon name="search" size={15} color={t.faint} />
              <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search banks, e-wallets, brokers…"
                style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
            </div>
            <div style={{ maxHeight: 220, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, margin: "0 -4px", padding: "0 4px" }}>
              {groups.map(([group, items]) => (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {items.map((tpl) => {
                      const on = picked?.key === tpl.key;
                      return (
                        <button key={tpl.key} className="sens-btn" onClick={() => pick(tpl)}
                          style={{ height: 40, justifyContent: "flex-start", gap: 9, padding: "0 10px", borderRadius: 9, fontSize: 12.5, fontWeight: 600,
                            color: t.text, background: on ? t.accentSoft : t.panel2, border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}` }}>
                          <GlyphTile tone={templateTone(tpl.key, t.accent)} size={24} emoji={tpl.name[0]} radius={7} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <Field label="Account name">
          <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Everyday Savings" style={inputStyle(t)} />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Type">
            <select className="sens-input" value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {TYPE_ORDER.map((x) => <option key={x} value={x} style={{ background: t.panel2 }}>{TYPE_LABEL[x]}</option>)}
            </select>
          </Field>
          <Field label="Subtype">
            <select className="sens-input" value={subtype} onChange={(e) => setSubtype(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {subtypesForType.map((s) => <option key={s.key} value={s.key} style={{ background: t.panel2 }}>{s.label}</option>)}
            </select>
          </Field>
        </div>

        <Field label={isOwe ? "Amount owed (RM)" : "Opening balance (RM)"}>
          <input className="sens-input" value={opening} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...inputStyle(t), fontFamily: t.mono }} />
        </Field>

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!canCreate || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Create account</Btn>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify manually + typecheck**

Run: `npm run dev` and create a `credit-card` account in the browser; confirm the balance label reads "Amount owed (RM)" and the created account shows a negative balance. (Full `npm run build` runs after Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src/modals/AddAccount.tsx
git commit -m "feat(ui): type-first AddAccount flow with owe sign adapter"
```

---

## Task 5: Update the EditAccount modal

**Files:**
- Modify: `src/modals/EditAccount.tsx` (full rewrite)

- [ ] **Step 1: Replace `src/modals/EditAccount.tsx`**

```tsx
// Edit an account's name and subtype (re-picking the subtype re-derives type/
// group). Opening-balance edits go through balance correction (SetBalance).

import { useEffect, useMemo, useState } from "react";
import type { Account, AccountSubtype } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

export function EditAccount({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<string>(account.accountType);
  const [subtype, setSubtype] = useState(account.subtype);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      await client.updateAccount({ id: account.id, name: name.trim(), subtype });
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not save");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Edit account</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Account name"><input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(t)} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Type">
            <select className="sens-input" value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {TYPE_ORDER.map((x) => <option key={x} value={x} style={{ background: t.panel2 }}>{TYPE_LABEL[x]}</option>)}
            </select>
          </Field>
          <Field label="Subtype">
            <select className="sens-input" value={subtype} onChange={(e) => setSubtype(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {subtypesForType.map((s) => <option key={s.key} value={s.key} style={{ background: t.panel2 }}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!name.trim() || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Save changes</Btn>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modals/EditAccount.tsx
git commit -m "feat(ui): EditAccount type/subtype selectors"
```

---

## Task 6: Rewrite the Accounts screen (group by type + net worth)

**Files:**
- Modify: `src/screens/Accounts.tsx`

- [ ] **Step 1: Update grouping, summary card, and balance display**

Replace the imports block top (remove the old `TYPE_LABEL` local map) and add:

```tsx
import { balanceDisplay, toneColor, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
import type { AccountTypeName } from "../types";
```

Delete the local `const TYPE_LABEL: Record<string, string> = { … }` (lines ~22-25).

Replace the totals + grouping block (the `const total = …` through the `groups` construction) with:

```tsx
  const active = all.filter((a) => !a.isArchived);
  const assets = active.filter((a) => a.group === "own").reduce((s, a) => s + a.balanceCents, 0);
  const liabilities = active.filter((a) => a.group === "owe").reduce((s, a) => s + a.balanceCents, 0);
  const netWorth = assets + liabilities;

  const groups = new Map<AccountTypeName, Account[]>();
  visible.forEach((a) => {
    if (!groups.has(a.accountType)) groups.set(a.accountType, []);
    groups.get(a.accountType)!.push(a);
  });
  const orderedGroups = TYPE_ORDER.filter((ty) => groups.has(ty)).map((ty) => [ty, groups.get(ty)!] as const);
```

Replace the summary `<Card>` (the "Total balance" card) body with a net-worth summary:

```tsx
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, color: t.dim, marginBottom: 5 }}>Net worth</div>
            <Money cents={netWorth} size={28} weight={700} color={netWorth < 0 ? t.negative : t.text} />
            <div style={{ fontSize: 12, color: t.dim, marginTop: 6 }}>
              Assets <Money cents={assets} size={12} color={t.dim} /> &nbsp;·&nbsp; Owe <Money cents={Math.abs(liabilities)} size={12} color={t.dim} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="outline" size="md" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
          </div>
        </div>
      </Card>
```

Replace the `{[...groups.entries()].map(([label, accs]) => { … })}` block header to iterate `orderedGroups` and use `TYPE_LABEL`, and per-group subtotal:

```tsx
      {orderedGroups.map(([ty, accs]) => {
        const subtotal = accs.filter((a) => !a.isArchived).reduce((s, a) => s + a.balanceCents, 0);
        return (
          <div key={ty}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px 10px" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>{TYPE_LABEL[ty]}</span>
              <Money cents={subtotal} size={13} color={subtotal < 0 ? t.negative : t.dim} />
            </div>
```

Inside the account row, replace the subtype label and the `<Money>` to use `balanceDisplay`. The subtype currently renders `a.subtype` raw; show the taxonomy label is not available on the account, so keep `a.subtype` but de-kebab it. Replace the row's `<Money cents={a.balanceCents} … />` (around line 103) with:

```tsx
                      {(() => {
                        const v = balanceDisplay(a.group, a.balanceCents);
                        return (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                            {v.label && <span style={{ fontSize: 10, color: t.faint }}>{v.label}</span>}
                            <Money cents={v.magnitude} size={15} color={toneColor(v.tone, t)} />
                          </div>
                        );
                      })()}
```

And change the subtype text line to de-kebab:

```tsx
                        <div style={{ fontSize: 11.5, color: t.faint, textTransform: "capitalize" }}>{a.subtype.replace(/-/g, " ")}</div>
```

In the expanded activity, the running-balance column is rendered by `TxnRow` via `balanceAfterCents`. That value remains the signed running balance — acceptable for v1.1 (owe accounts show the signed running figure). No change required here.

- [ ] **Step 2: Verify manually**

Run: `npm run dev`; confirm accounts are grouped under "Cash & funds", "Credit & loans", etc., the summary shows Net worth/Assets/Owe, and credit accounts show "You owe".

- [ ] **Step 3: Commit**

```bash
git add src/screens/Accounts.tsx
git commit -m "feat(ui): Accounts screen grouped by type with net worth + owe display"
```

---

## Task 7: Update the Dashboard screen (net worth card + grouped mini-list)

**Files:**
- Modify: `src/screens/Dashboard.tsx`

- [ ] **Step 1: Replace the KPI tiles and accounts mini-list**

Add imports:

```tsx
import { balanceDisplay, toneColor } from "../lib/accounts";
```

Replace the `kpis` array (the `const kpis = [ … ]`) with monthly KPIs only (net worth gets its own card):

```tsx
  const kpis = [
    { label: "Income", cents: data.incomeCents, color: t.income, signed: false },
    { label: "Expenses", cents: data.expenseCents, color: t.expense, signed: false },
    { label: "Net Cashflow", cents: data.netCashflowCents, color: data.netCashflowCents >= 0 ? t.income : t.expense, signed: true },
  ];
```

Add a net-worth hero card immediately before the KPI grid (after the `{empty && …}` block):

```tsx
      <Card>
        <div style={{ fontSize: 11, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>Net worth</div>
        <div style={{ marginTop: 10 }}>
          <Money cents={data.netWorthCents} color={data.netWorthCents < 0 ? t.negative : t.text} size={28} weight={700} showCents={false} />
        </div>
        <div style={{ fontSize: 12.5, color: t.dim, marginTop: 8, display: "flex", gap: 16 }}>
          <span>Assets <Money cents={data.assetsCents} size={12.5} color={t.dim} /></span>
          <span>Owe <Money cents={Math.abs(data.liabilitiesCents)} size={12.5} color={t.dim} /></span>
        </div>
      </Card>
```

In the Accounts mini-list card, replace the per-account `<Money cents={a.balanceCents} … />` (around line 157) with the `balanceDisplay` treatment:

```tsx
                  {(() => {
                    const v = balanceDisplay(a.group, a.balanceCents);
                    return <Money cents={v.magnitude} size={13} color={toneColor(v.tone, t)} />;
                  })()}
```

(The dashboard mini-list keeps the flat ordering from the backend; owe rows now read correctly via the adapter. Grouping into Assets/Liabilities sub-headers is optional and omitted to keep the card compact — accounts already convey group via the owe styling.)

- [ ] **Step 2: Verify manually + full build**

Run: `npm run dev`; confirm the net-worth card shows and owe accounts display correctly in the mini-list.
Run: `npm run build`
Expected: PASS — TypeScript compiles clean across the whole app now that all consumers are updated.

- [ ] **Step 3: Commit**

```bash
git add src/screens/Dashboard.tsx
git commit -m "feat(ui): Dashboard net worth card + owe-aware account list"
```

---

## Task 8: One-time "accounts now treated as debts" notice

Shown once if migration reclassified any account into an owe group. `App.tsx` already has `accounts` state, `notify` (from `useToast`), `client`, and `useEffect` imported — no new imports needed. `ToastKind` includes `"info"`.

**Files:**
- Modify: `src/App.tsx` (mount-time check)

- [ ] **Step 1: Add the one-time notice effect in `src/App.tsx`**

Insert this effect immediately after the existing `useEffect(() => { reload(); }, [reload]);` line (around line 79). It waits until accounts are loaded (`loading === false`) so the check sees real data, fires the toast once, and persists a flag so it never repeats:

```tsx
  // One-time notice after the v1.1 migration reclassified accounts into owe
  // groups (credit/loans/borrowed). Suppressed forever after first display.
  const oweNoticeChecked = useRef(false);
  useEffect(() => {
    if (loading || oweNoticeChecked.current) return;
    oweNoticeChecked.current = true;
    client.getSetting("owe_notice_shown").then((seen) => {
      if (seen) return;
      if (accounts.some((a) => a.group === "owe")) {
        notify("Some accounts are now treated as debts — review their balances.", "info");
      }
      void client.setSetting("owe_notice_shown", "1");
    }).catch(() => {});
  }, [loading, accounts, notify]);
```

(`useRef` is already imported in `App.tsx`. The `oweNoticeChecked` guard prevents re-running on every `reload()`-driven `accounts` change within a session; the persisted `owe_notice_shown` setting prevents it across sessions.)

- [ ] **Step 2: Verify + build**

Run: `npm run build`
Expected: PASS.
Run: `npm run dev`; with a seeded owe account present, confirm the info toast appears once and not on reload (the setting suppresses it).

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): one-time notice when accounts are reclassified as debts"
```

---

## Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 2: Rust build (validates Tauri command registration)**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: PASS.

- [ ] **Step 3: Frontend tests + build**

Run: `npm test`
Expected: PASS (format, kinds, brand, mock, accounts, mock-accounts suites).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke (desktop)**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri dev`
Verify: create a `credit-card` account (enter 500 as "Amount owed") → shows "You owe RM500"; net worth on Dashboard and Accounts = assets − owe; accounts grouped by type; existing data still loads (migration ran).

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test: verification fixups for account type/subtype system"
```

---

## Self-review notes (coverage map)

- Taxonomy table + seed → Task 1 (migration 002, steps 1, 3-4).
- Provider decoupling + unified `create_account` → Task 1 (steps 5-6), Task 2 (steps 4-5), Task 4.
- Signed liabilities (engine untouched) → no engine changes; sign adapter in Task 3 (`balanceDisplay`) + Task 4 (submit negation).
- Net worth (assets/liabilities) → Task 1 (step 5), Task 2 (step 5), Task 6, Task 7.
- Derived type/group on reads → Task 1 (step 4 joins), Task 2 (mock hydrate).
- Dashboard rules unchanged (transfers/adjustments excluded) → untouched; verified in Task 9.
- UI: AddAccount/EditAccount/Accounts/Dashboard → Tasks 4-7.
- Migration reclassify-only + one-time notice → Task 1 (UPDATE remap, no sign flip) + Task 8.
- Testing → Rust tests Task 1 (steps 9-10); TS tests Tasks 2-3; full pass Task 9.
- Deferred items (credit limits, schedules, interest, investment value, `account_types` table) → intentionally absent.
```
