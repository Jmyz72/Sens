# Card and BNPL Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Record a payment from cash, an e-wallet, savings, or a current account onto a credit card or BNPL as its own `payment` kind, posted like a transfer and left out of income and spending.

**Architecture:** Migration 011 rebuilds `transactions` so the CHECK can name `payment`, copying `postings` and `transaction_splits` first. `create_payment` writes that kind; `create_transfer` rejects a card or BNPL destination. The Add Transaction transfer segment relabels to Payment when the destination subtype is `credit-card` or `bnpl` and calls the matching command. Pay on an account row opens that form with the amount owed filled in.

**Tech Stack:** Tauri v2 (Rust + rusqlite/SQLite), React 19 + TypeScript + Vite. Rust tests: `cargo test --lib`. Frontend: Vitest + `npm run build`.

## Global Constraints

- Payment source subtypes are exactly `cash`, `ewallet`, `savings`, `current`.
- Payment destination subtypes are exactly `credit-card` and `bnpl`.
- Amount must be an integer greater than zero. Reuse `validate_positive`. Message: `Amount must be greater than zero` (no trailing period).
- Same account on both sides. Message: `Cannot pay the same account.`
- Destination is not a card or BNPL on `create_payment` or a payment update. Message: `Payments can only pay a credit card or BNPL.`
- Source is not an allowed subtype. Message: `Payments can only come from cash, an e-wallet, savings, or a current account.`
- `create_transfer` aimed at `credit-card` or `bnpl`. Message: `Pay a credit card or BNPL as a payment.` Insert nothing.
- Splits on a payment. Message: `Payments can't be split.`
- A payment stores `category_id` NULL and `excluded_from_reporting` 0. Postings match a transfer: `-amount` on the source, `+amount` on the destination.
- The client sends `kind: "payment"` or `kind: "transfer"` to match the destination. The server does not silently rewrite a mismatched kind.
- Archived accounts use the existing `ensure_active_account` conflicts: `The source account is archived` and `The destination account is archived`.
- Transaction time follows `resolve_time` the same way a transfer does.
- Income, expense, spending breakdown, and day-net totals do not add a payment. `dayNet` in `src/screens/Transactions.tsx` already returns 0 for every other kind. Leave it.
- There is no backfill and no upgrade prompt. Do not relabel existing transfers.
- Every command behavior change lands in both the Rust chain and `src/client/mock.ts`.
- Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Spec: `docs/superpowers/specs/2026-10-13-card-bnpl-payments-design.md`.

---

## File Structure

- `src/lib/payments.ts` — `movementKind`, `isPaymentSource`, `payAmountField`. Form rules only.
- `src/lib/__tests__/payments.test.ts` — those three helpers.
- `src/lib/kinds.ts` — `KIND_META.payment`, `signedFor`, `postingsFor`.
- `src/components/Icon.tsx` — `card` icon.
- `src/types.ts` — `TransactionKind` includes `"payment"`.
- `src/lib/txnSelection.ts` — payment counts and bulk locks, same as a transfer.
- `src-tauri/src/db/migrations.rs` — migration 011.
- `src-tauri/src/db/mod.rs` — migration copy test.
- `src-tauri/src/models.rs` — `KIND_PAYMENT`.
- `src-tauri/src/service.rs` — `create_payment`, transfer rejection, update checks, `postings_for`.
- `src-tauri/src/commands.rs` — `create_payment_transaction`.
- `src-tauri/src/lib.rs` — register the command and service tests.
- `src/client/index.ts` — `createPayment`.
- `src/client/mock.ts` — the same validation as Rust.
- `src/__tests__/mock-payments.test.ts` — mock create, reject, edit, delete, dashboard.
- `src/modals/AddTransaction.tsx` — label switch, Pay prefill, `createPayment`.
- `src/screens/Accounts.tsx` — Pay button.
- `src/components/TxnRow.tsx`, `src/components/TxnDetailPanel.tsx`, `src/components/TxnSelectionPanel.tsx`, `src/screens/Transactions.tsx` — payment renders and edits like a transfer, with the Payment label.
- `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `ROADMAP.md` — document the slice.

---

### Task 1: Payment kind presentation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/kinds.ts`
- Modify: `src/components/Icon.tsx`
- Test: `src/__tests__/kinds.test.ts`
- Test: `src/__tests__/postings.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `TransactionKind` includes `"payment"`. `KIND_META.payment` is `{ label: "Payment", icon: "card", colorKey: "transfer", sign: 0 }`. `signedFor("payment", amount, isDestination)` matches transfer. `postingsFor("payment", amount, accountId, toAccountId)` returns the transfer legs.

- [x] **Step 1: Write the failing tests**

Append to the `signedFor` describe in `src/__tests__/kinds.test.ts`:

```ts
  it("signs a payment like a transfer", () => {
    expect(signedFor("payment", 10000, false)).toBe(-10000);
    expect(signedFor("payment", 10000, true)).toBe(10000);
  });

  it("labels a payment and reuses the transfer color token", () => {
    expect(KIND_META.payment.label).toBe("Payment");
    expect(KIND_META.payment.icon).toBe("card");
    expect(KIND_META.payment.colorKey).toBe("transfer");
  });
```

In `src/__tests__/postings.test.ts`, add a payment case to the `cases` array and two assertions in the sign test:

```ts
    { kind: "payment" as const, amt: 1000, acc: "a", to: "b" },
```

```ts
    const paySrc = postingsFor("payment", 1000, "a", "b").filter((l) => l.accountId === "a");
    expect(paySrc.reduce((s, l) => s + l.amountCents, 0)).toBe(-1000);
    const payDst = postingsFor("payment", 1000, "a", "b").filter((l) => l.accountId === "b");
    expect(payDst.reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/kinds.test.ts src/__tests__/postings.test.ts`

Expected: FAIL. `signedFor` does not accept `"payment"` (`TransactionKind` has no such member).

- [x] **Step 3: Add the kind, the icon, and the sign rule**

In `src/types.ts` change the union to:

```ts
export type TransactionKind = "income" | "expense" | "transfer" | "adjustment" | "opening" | "payment";
```

In `src/components/Icon.tsx`, add `"card"` to the `IconName` union and this entry in `paths`:

```tsx
    card: <>{<rect {...P} x="3" y="6" width="18" height="12" rx="2" />}<path {...P} d="M3 10h18" /></>,
```

In `src/lib/kinds.ts`, add the meta entry after `transfer`:

```ts
  payment: { label: "Payment", icon: "card", colorKey: "transfer", sign: 0 },
```

In `signedFor`, handle payment with the transfer branch:

```ts
  if (kind === "adjustment" || kind === "opening") return amountCents;
  // transfer and payment
  return isDestination ? amountCents : -amountCents;
```

In `postingsFor`, use the transfer legs for payment:

```ts
    case "transfer":
    case "payment":
      return [real(-amountCents), { accountId: toAccountId, bucket: null, amountCents }];
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/kinds.test.ts src/__tests__/postings.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/lib/kinds.ts src/components/Icon.tsx src/__tests__/kinds.test.ts src/__tests__/postings.test.ts
git commit -m "feat: present payment with the transfer sign rule"
```

---

### Task 2: Migration 011

**Files:**
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/mod.rs` (the `#[cfg(test)]` module)
- Test: `src-tauri/src/db/mod.rs`

**Interfaces:**
- Consumes: migrations 001–010 stay unchanged.
- Produces: `MIGRATIONS` includes `(11, MIGRATION_011)`. After it runs, `kind = 'payment'` is legal with the payment CHECK, and rows copied from the previous schema keep their kind.

- [x] **Step 1: Write the failing test**

Add this test inside `mod migration_tests` in `src-tauri/src/db/mod.rs` (that module already imports `super::migrations::MIGRATIONS`). It applies 001–010, inserts a transfer with two postings and an expense with one split, then applies 011.

```rust
    #[test]
    fn migration_011_copies_rows_and_accepts_payment() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..10 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('src', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                      ('card', NULL, 'Visa', 'credit-card', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('c1', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
               VALUES ('xfer', 'transfer', 'src', 'card', NULL, 4000, 'Old pay', '2026-02-01', 0, NULL, '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00'),
                      ('exp', 'expense', 'src', NULL, 'c1', 1500, 'Lunch', '2026-02-02', 0, NULL, '2026-02-02T00:00:00+00:00', '2026-02-02T00:00:00+00:00');
             INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
               VALUES ('p1', 'xfer', 'src', NULL, -4000), ('p2', 'xfer', 'card', NULL, 4000);
             INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
               VALUES ('s1', 'exp', 'c1', 1500, 0, '2026-02-02T00:00:00+00:00');",
        );
        apply(MIGRATIONS[10].1);

        let kind: String = conn.query_row("SELECT kind FROM transactions WHERE id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "transfer");
        let postings: i64 = conn.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(postings, 2);
        let splits: i64 = conn.query_row("SELECT COUNT(*) FROM transaction_splits WHERE transaction_id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(splits, 1);
        conn.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
             VALUES ('pay', 'payment', 'src', 'card', NULL, 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')",
            [],
        ).unwrap();
        let rejected = conn.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
             VALUES ('bad', 'payment', 'src', 'card', 'c1', 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')",
            [],
        );
        assert!(rejected.is_err(), "a payment cannot carry a category");
    }
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib migration_011_copies_rows_and_accepts_payment -- --nocapture`

Expected: FAIL. `MIGRATIONS[10]` is missing, or the `payment` insert is rejected by the old CHECK.

- [x] **Step 3: Append migration 011**

In `src-tauri/src/db/migrations.rs`, extend the list:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004),
    (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007), (8, MIGRATION_008),
    (9, MIGRATION_009), (10, MIGRATION_010), (11, MIGRATION_011),
];
```

Add `MIGRATION_011`. Copy every column. Drop child tables before `transactions`. Do not change any `kind` value.

```rust
// Payment kind. Rebuilds transactions so the CHECK can name 'payment'.
// postings and transaction_splits reference transactions ON DELETE CASCADE,
// so they are copied first and dropped before transactions.
const MIGRATION_011: &str = r#"
CREATE TABLE transactions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment', 'opening', 'payment')),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL,
  description      TEXT,
  transaction_date TEXT NOT NULL,
  excluded_from_reporting INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_reporting IN (0, 1)),
  transaction_time TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (kind IN ('income', 'expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
    (kind = 'transfer' AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'payment'  AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'opening' AND to_account_id IS NULL AND category_id IS NULL AND excluded_from_reporting = 0)
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
"#;
```

`mod migration_tests` already has `use super::migrations::MIGRATIONS`, so the test calls `MIGRATIONS[i].1`.

Index names are global in SQLite. Create `idx_postings_*` and `idx_splits_*` only after `DROP TABLE` removes the old indexes. Creating them on `postings_new` while the old tables still exist fails with a duplicate index name.

- [x] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib migration_011_copies_rows_and_accepts_payment -- --nocapture`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs
git commit -m "feat: add the payment kind in migration 011"
```

---

### Task 3: Create a payment and reject a transfer onto a card

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/service.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `KIND_TRANSFER`, `ensure_active_account`, `validate_positive`, `resolve_time`, `repo::insert_transaction`, `materialize_postings`.
- Produces: `pub const KIND_PAYMENT: &str = "payment"`. `pub fn create_payment(conn, from_account_id: &str, to_account_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>) -> AppResult<Transaction>`. `postings_for` handles `KIND_PAYMENT` with the transfer legs. `create_transfer` returns `Pay a credit card or BNPL as a payment.` when the destination subtype is `credit-card` or `bnpl`.

- [x] **Step 1: Write the failing tests**

Add these tests in `src-tauri/src/lib.rs` inside `mod tests`, using the existing `open_in_memory` helper and `validation_message`:

```rust
    fn pay_pair(conn: &rusqlite::Connection) -> (Account, Account) {
        let savings = service::create_account(conn, "Maybank", "savings", 500_000, None, None).unwrap();
        let card = service::create_account(conn, "Visa", "credit-card", -80_000, None, Some(1_000_000)).unwrap();
        (savings, card)
    }

    #[test]
    fn payment_moves_savings_down_and_card_debt_down() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let pay = service::create_payment(&c, &savings.id, &card.id, 30_000, Some("Card payment"), "2026-06-01", None).unwrap();
        assert_eq!(pay.kind, "payment");
        assert_eq!(pay.category_id, None);
        assert!(!pay.excluded_from_reporting);
        let savings = repo::get_account(&c, &savings.id).unwrap();
        let card = repo::get_account(&c, &card.id).unwrap();
        assert_eq!(savings.balance_cents, 470_000);
        assert_eq!(card.balance_cents, -50_000);
    }

    #[test]
    fn payment_allows_partial_and_overpay() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        service::create_payment(&c, &savings.id, &card.id, 100_000, None, "2026-06-02", None).unwrap();
        let card = service::get_account(&c, &card.id).unwrap();
        assert_eq!(card.balance_cents, 20_000);
    }

    #[test]
    fn payment_accepts_each_allowed_source() {
        let c = open_in_memory().unwrap();
        let card = service::create_account(&c, "Visa", "credit-card", -10_000, None, Some(100_000)).unwrap();
        for subtype in ["cash", "ewallet", "savings", "current"] {
            let src = service::create_account(&c, subtype, subtype, 50_000, None, None).unwrap();
            service::create_payment(&c, &src.id, &card.id, 1_000, None, "2026-06-03", None).unwrap();
        }
        let bnpl = service::create_account(&c, "Atome", "bnpl", -5_000, None, Some(30_000)).unwrap();
        let cash = service::create_account(&c, "Wallet", "cash", 20_000, None, None).unwrap();
        let pay = service::create_payment(&c, &cash.id, &bnpl.id, 5_000, None, "2026-06-03", None).unwrap();
        assert_eq!(pay.kind, "payment");
    }

    #[test]
    fn payment_rejects_bad_shape() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let invest = service::create_account(&c, "Stash", "investment", 0, None, None).unwrap();
        let loan = service::create_account(&c, "Loan", "personal-loan", 0, None, None).unwrap();
        assert_eq!(
            validation_message(service::create_payment(&c, &savings.id, &card.id, 0, None, "2026-06-01", None).unwrap_err()),
            "Amount must be greater than zero"
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &card.id, &card.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Cannot pay the same account."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &invest.id, &card.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only come from cash, an e-wallet, savings, or a current account."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &card.id, &savings.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only pay a credit card or BNPL."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &savings.id, &loan.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only pay a credit card or BNPL."
        );
    }

    #[test]
    fn transfer_onto_a_card_is_rejected() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let err = service::create_transfer(&c, &savings.id, &card.id, 1_000, None, "2026-06-01", None).unwrap_err();
        assert_eq!(validation_message(err), "Pay a credit card or BNPL as a payment.");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE kind='transfer' AND to_account_id=?1", [&card.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn payment_does_not_change_dashboard_income_or_expense() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        service::create_payment(&c, &savings.id, &card.id, 10_000, None, "2026-06-15", None).unwrap();
        let after = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(after.income_cents, before.income_cents);
        assert_eq!(after.expense_cents, before.expense_cents);
    }
```

Read balances with `crate::repo::get_account` (`service` has no `get_account`). Add `use crate::repo;` in `mod tests` if it is not already imported. `DashboardSummary.income_cents` and `expense_cents` are the struct fields.

The same-account case uses the card as both sides. `ensure_active_account` runs after the same-id check, so the message is `Cannot pay the same account.` even though a card is not an allowed source.

`create_payment(&c, &card.id, &savings.id, ...)` fails the destination check (`savings` is not a card) before the source check. That matches the assertion `Payments can only pay a credit card or BNPL.`

- [x] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib payment_ -- --nocapture`

Expected: FAIL. `service::create_payment` is not found.

- [x] **Step 3: Implement the service**

In `src-tauri/src/models.rs`:

```rust
pub const KIND_PAYMENT: &str = "payment";
```

Update the comment above the kind constants so it says `transfer`, `payment`, and `adjustment` are excluded from income and expense aggregates.

In `postings_for`:

```rust
        KIND_TRANSFER | KIND_PAYMENT => vec![
            real(-amount_cents),
            Leg { account_id: to_account_id.map(|s| s.to_string()), system_bucket: None, amount_cents },
        ],
```

Add `create_payment` beside `create_transfer`:

```rust
fn is_payment_destination(subtype: &str) -> bool {
    subtype == "credit-card" || subtype == "bnpl"
}

fn is_payment_source(subtype: &str) -> bool {
    matches!(subtype, "cash" | "ewallet" | "savings" | "current")
}

pub fn create_payment(
    conn: &Connection,
    from_account_id: &str,
    to_account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    if from_account_id == to_account_id {
        return Err(AppError::Validation("Cannot pay the same account.".into()));
    }
    ensure_active_account(conn, from_account_id, "source")?;
    ensure_active_account(conn, to_account_id, "destination")?;
    let source = repo::get_account(conn, from_account_id)?;
    let dest = repo::get_account(conn, to_account_id)?;
    if !is_payment_destination(&dest.subtype) {
        return Err(AppError::Validation("Payments can only pay a credit card or BNPL.".into()));
    }
    if !is_payment_source(&source.subtype) {
        return Err(AppError::Validation(
            "Payments can only come from cash, an e-wallet, savings, or a current account.".into(),
        ));
    }
    let time = resolve_time(conn, time, None)?;
    let tx = conn.unchecked_transaction()?;
    let t = repo::insert_transaction(
        &tx, &new_id(), KIND_PAYMENT, from_account_id, Some(to_account_id), None,
        amount_cents, description, date, time.as_deref(), false, &now(),
    )?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}
```

At the end of the existing checks in `create_transfer`, after both `ensure_active_account` calls and before `resolve_time`:

```rust
    let dest = repo::get_account(conn, to_account_id)?;
    if is_payment_destination(&dest.subtype) {
        return Err(AppError::Validation("Pay a credit card or BNPL as a payment.".into()));
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib payment_ -- --nocapture && cargo test --lib transfer_onto_a_card_is_rejected -- --nocapture`

Expected: PASS. Then run `cargo test --lib --locked` and confirm the existing suite still passes.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: create a payment and reject card transfers"
```

---

### Task 4: Edit and delete a payment

**Files:**
- Modify: `src-tauri/src/service.rs` (`update_transaction`)
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `create_payment`, `is_payment_destination`, `is_payment_source`, `KIND_PAYMENT`, `UpdateTransactionInput`.
- Produces: `update_transaction` accepts `kind = "payment"` with the create checks, rejects splits, stores `excluded_from_reporting` false and category NULL. A transfer update whose destination is a card or BNPL returns `Pay a credit card or BNPL as a payment.` `delete_transaction` already deletes any non-opening row. Leave that guard as it is.

- [x] **Step 1: Write the failing tests**

Add `use crate::repo;` inside `mod tests` if it is not already imported. The new tests call `repo::get_account`.

```rust
    fn payment_update(id: &str, kind: &str, from: &str, to: &str, amount: i64) -> UpdateTransactionInput {
        UpdateTransactionInput {
            id: id.into(),
            kind: kind.into(),
            account_id: from.into(),
            to_account_id: Some(to.into()),
            category_id: None,
            amount_cents: amount,
            description: None,
            transaction_date: "2026-06-04".into(),
            transaction_time: None,
            excluded_from_reporting: false,
            splits: None,
        }
    }

    #[test]
    fn editing_a_payment_updates_both_balances() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let cash = service::create_account(&c, "Cash", "cash", 40_000, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 10_000, None, "2026-06-01", None).unwrap();
        service::update_transaction(&c, payment_update(&pay.id, "payment", &cash.id, &card.id, 4_000)).unwrap();
        assert_eq!(repo::get_account(&c, &savings.id).unwrap().balance_cents, 500_000);
        assert_eq!(repo::get_account(&c, &cash.id).unwrap().balance_cents, 36_000);
        assert_eq!(repo::get_account(&c, &card.id).unwrap().balance_cents, -76_000);
    }

    #[test]
    fn editing_the_destination_flips_kind() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let wallet = service::create_account(&c, "TNG", "ewallet", 0, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let flipped = service::update_transaction(&c, payment_update(&pay.id, "transfer", &savings.id, &wallet.id, 5_000)).unwrap();
        assert_eq!(flipped.kind, "transfer");

        let back = service::update_transaction(&c, payment_update(&pay.id, "payment", &savings.id, &card.id, 5_000)).unwrap();
        assert_eq!(back.kind, "payment");
    }

    #[test]
    fn editing_a_payment_rejects_an_investment_source_without_writing() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let invest = service::create_account(&c, "Stash", "investment", 0, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let err = service::update_transaction(&c, payment_update(&pay.id, "payment", &invest.id, &card.id, 5_000)).unwrap_err();
        assert_eq!(
            validation_message(err),
            "Payments can only come from cash, an e-wallet, savings, or a current account."
        );
        let stored = repo::get_transaction(&c, &pay.id).unwrap();
        assert_eq!(stored.account_id, savings.id);
        assert_eq!(stored.kind, "payment");
    }

    #[test]
    fn updating_a_transfer_onto_a_card_is_rejected() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let wallet = service::create_account(&c, "TNG", "ewallet", 0, None, None).unwrap();
        let xfer = service::create_transfer(&c, &savings.id, &wallet.id, 2_000, None, "2026-06-01", None).unwrap();
        let err = service::update_transaction(&c, payment_update(&xfer.id, "transfer", &savings.id, &card.id, 2_000)).unwrap_err();
        assert_eq!(validation_message(err), "Pay a credit card or BNPL as a payment.");
        assert_eq!(repo::get_transaction(&c, &xfer.id).unwrap().kind, "transfer");
    }

    #[test]
    fn payment_rejects_splits_and_can_be_deleted() {
        let c = open_in_memory().unwrap();
        let (savings, card) = pay_pair(&c);
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let mut input = payment_update(&pay.id, "payment", &savings.id, &card.id, 5_000);
        input.splits = Some(vec![SplitInput { category_id: expense_cat(&c), amount_cents: 5_000 }]);
        assert_eq!(
            validation_message(service::update_transaction(&c, input).unwrap_err()),
            "Payments can't be split."
        );
        service::delete_transaction(&c, &pay.id).unwrap();
        assert_eq!(repo::get_account(&c, &savings.id).unwrap().balance_cents, 500_000);
        assert_eq!(repo::get_account(&c, &card.id).unwrap().balance_cents, -80_000);
    }
```

Import `repo` in the test module if it is not already in scope (`use crate::repo`). `SplitInput` is `crate::models::SplitInput`. Opening balances mean the savings balance after create is `500_000` and the card is `-80_000` before the payment. After a 5_000 payment those are `495_000` and `-75_000`. Delete restores `500_000` and `-80_000`. The investment-source test's untouched savings balance is `495_000` only if you assert it; the test above asserts the stored account id, which is enough.

- [x] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib editing_a_payment -- --nocapture`

Expected: FAIL. `update_transaction` returns `Invalid transaction kind: payment`.

- [x] **Step 3: Accept payment on update**

In the `match input.kind.as_str()` inside `update_transaction`, handle payment before the `other` arm. Reject splits first:

```rust
        KIND_PAYMENT => {
            if input.splits.as_ref().is_some_and(|s| !s.is_empty()) {
                return Err(AppError::Validation("Payments can't be split.".into()));
            }
            let to = input.to_account_id.as_deref().ok_or_else(|| {
                AppError::Validation("A destination account is required for payments.".into())
            })?;
            if to == input.account_id {
                return Err(AppError::Validation("Cannot pay the same account.".into()));
            }
            ensure_active_account(conn, to, "destination")?;
            let source = repo::get_account(conn, &input.account_id)?;
            let dest = repo::get_account(conn, to)?;
            if !is_payment_destination(&dest.subtype) {
                return Err(AppError::Validation("Payments can only pay a credit card or BNPL.".into()));
            }
            if !is_payment_source(&source.subtype) {
                return Err(AppError::Validation(
                    "Payments can only come from cash, an e-wallet, savings, or a current account.".into(),
                ));
            }
            (Some(to.to_string()), None)
        }
```

In the existing `KIND_TRANSFER` arm, after `ensure_active_account(conn, to, "destination")`:

```rust
            let dest = repo::get_account(conn, to)?;
            if is_payment_destination(&dest.subtype) {
                return Err(AppError::Validation("Pay a credit card or BNPL as a payment.".into()));
            }
```

`excluded` is already false unless the kind is income or expense. Category for the payment arm is `None`. `materialize_postings` already rewrites legs from the header, so `KIND_PAYMENT` in `postings_for` covers the edit.

- [x] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib --locked`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat: edit and delete card payments"
```

---

### Task 5: Command and typed client

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (the `generate_handler!` list)
- Modify: `src/client/index.ts`

**Interfaces:**
- Consumes: `service::create_payment`.
- Produces: Tauri command `create_payment_transaction(fromAccountId, toAccountId, amountCents, description, date, time) -> Transaction`. Client `createPayment(fromAccountId, toAccountId, amountCents, description, date, time = null)`.

- [x] **Step 1: Add the command and the client wrapper**

In `commands.rs`, next to `create_transfer_transaction`:

```rust
#[tauri::command]
pub fn create_payment_transaction(
    state: State<'_, DbState>,
    from_account_id: String,
    to_account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_payment(
        &c, &from_account_id, &to_account_id, amount_cents, description.as_deref(), &date, time.as_deref()
    ))
}
```

Register `commands::create_payment_transaction` in `generate_handler!` immediately after `commands::create_transfer_transaction`.

In `src/client/index.ts`, next to `createTransfer`:

```ts
  createPayment: (fromAccountId: string, toAccountId: string, amountCents: number, description: string | null, date: string, time: string | null = null) =>
    dispatch<Transaction>("create_payment_transaction", { fromAccountId, toAccountId, amountCents, description, date, time }),
```

- [x] **Step 2: Compile both sides**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build --locked`

Expected: exit 0.

Run: `npx tsc --noEmit -p tsconfig.json`

`npm run build` runs `tsc` as well. `tsc --noEmit` is enough here if `npm run build` is slow. Expected: exit 0. If `tsc` is not scripted alone, run `npm run build`.

- [x] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/client/index.ts
git commit -m "feat: expose create_payment to the client"
```

---

### Task 6: Mock parity

**Files:**
- Modify: `src/client/mock.ts`
- Create: `src/__tests__/mock-payments.test.ts`

**Interfaces:**
- Consumes: `createPayment` command name `create_payment_transaction`. `postingsFor` from Task 1. `balanceOf` already sums `postingsFor`, so a stored payment moves both balances once the mock inserts `kind: "payment"`.
- Produces: the mock accepts `create_payment_transaction` with the same messages as Rust, and `create_transfer_transaction` rejects a card or BNPL destination. `update_transaction` applies the same payment and transfer checks.

- [x] **Step 1: Write the failing test**

Create `src/__tests__/mock-payments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, DashboardSummary, Transaction } from "../types";

async function pair() {
  const savings = await mockInvoke<Account>("create_account", {
    name: "Maybank", subtype: "savings", openingBalanceCents: 500_000, templateKey: null, creditLimitCents: null,
  });
  const card = await mockInvoke<Account>("create_account", {
    name: "Visa", subtype: "credit-card", openingBalanceCents: -80_000, templateKey: null, creditLimitCents: 1_000_000,
  });
  return { savings, card };
}

describe("mock payments", () => {
  it("moves both balances and stays out of the dashboard", async () => {
    const { savings, card } = await pair();
    const before = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-06" });
    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 30_000,
      description: "Card payment", date: "2026-06-01", time: null,
    });
    expect(pay.kind).toBe("payment");
    const accounts = await mockInvoke<Account[]>("list_accounts", {});
    expect(accounts.find((a) => a.id === savings.id)?.balanceCents).toBe(470_000);
    expect(accounts.find((a) => a.id === card.id)?.balanceCents).toBe(-50_000);
    const after = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-06" });
    expect(after.incomeCents).toBe(before.incomeCents);
    expect(after.expenseCents).toBe(before.expenseCents);
  });

  it("rejects a bad source, a transfer onto a card, and a split edit", async () => {
    const { savings, card } = await pair();
    const invest = await mockInvoke<Account>("create_account", {
      name: "Stash", subtype: "investment", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    await expect(mockInvoke("create_payment_transaction", {
      fromAccountId: invest.id, toAccountId: card.id, amountCents: 100, description: null, date: "2026-06-01", time: null,
    })).rejects.toMatchObject({ message: "Payments can only come from cash, an e-wallet, savings, or a current account." });
    await expect(mockInvoke("create_transfer_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 100, description: null, date: "2026-06-01", time: null,
    })).rejects.toMatchObject({ message: "Pay a credit card or BNPL as a payment." });

    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 5_000, description: null, date: "2026-06-01", time: null,
    });
    await expect(mockInvoke("update_transaction", {
      input: {
        id: pay.id, kind: "payment", accountId: savings.id, toAccountId: card.id, categoryId: null,
        amountCents: 5_000, description: null, transactionDate: "2026-06-01", transactionTime: null,
        excludedFromReporting: false, splits: [{ categoryId: "x", amountCents: 5_000 }],
      },
    })).rejects.toMatchObject({ message: "Payments can't be split." });
  });

  it("flips kind when the destination changes and restores balances on delete", async () => {
    const { savings, card } = await pair();
    const wallet = await mockInvoke<Account>("create_account", {
      name: "TNG", subtype: "ewallet", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 5_000, description: null, date: "2026-06-01", time: null,
    });
    const flipped = await mockInvoke<Transaction>("update_transaction", {
      input: {
        id: pay.id, kind: "transfer", accountId: savings.id, toAccountId: wallet.id, categoryId: null,
        amountCents: 5_000, description: null, transactionDate: "2026-06-04", transactionTime: null,
        excludedFromReporting: false, splits: null,
      },
    });
    expect(flipped.kind).toBe("transfer");
    await mockInvoke("delete_transaction", { id: pay.id });
    const accounts = await mockInvoke<Account[]>("list_accounts", {});
    expect(accounts.find((a) => a.id === savings.id)?.balanceCents).toBe(500_000);
    expect(accounts.find((a) => a.id === card.id)?.balanceCents).toBe(-80_000);
  });
});
```

`mockInvoke` is the export used by `src/__tests__/mock.test.ts`. It throws objects with `message`. The mock keeps one in-memory store per test file. Each test in this file creates its own accounts, so the assertions stay on those ids.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/mock-payments.test.ts`

Expected: FAIL. The mock has no `create_payment_transaction` case.

- [x] **Step 3: Mirror the service in the mock**

Near the top of the command switch in `src/client/mock.ts`:

```ts
function isPaymentDestination(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}
function isPaymentSource(subtype: string): boolean {
  return subtype === "cash" || subtype === "ewallet" || subtype === "savings" || subtype === "current";
}
```

In `create_transfer_transaction`, after the same-account check, load both accounts the way other cases do and:

```ts
      const dest = accounts.find((x) => x.id === a.toAccountId) ?? fail("NotFound", "Account not found");
      if (dest.isArchived) fail("Conflict", "The destination account is archived");
      if (isPaymentDestination(dest.subtype)) fail("ValidationError", "Pay a credit card or BNPL as a payment.");
      const src = accounts.find((x) => x.id === a.fromAccountId) ?? fail("NotFound", "Account not found");
      if (src.isArchived) fail("Conflict", "The source account is archived");
```

Add a `create_payment_transaction` case that inserts `kind: "payment"` after the same checks and messages as `create_payment` in Rust. Copy the transaction object shape from the transfer case (`excludedFromReporting: false`, `splits: []`, `categoryId: null`).

In `update_transaction`, insert this block before `const hasSplits`, so a payment split is rejected before `validateSplits`:

```ts
      if (a.input.kind === "payment") {
        if (Array.isArray(a.input.splits) && a.input.splits.length > 0) fail("ValidationError", "Payments can't be split.");
        if (a.input.accountId === a.input.toAccountId) fail("ValidationError", "Cannot pay the same account.");
        const src = accounts.find((x) => x.id === a.input.accountId) ?? fail("NotFound", "Account not found");
        const dest = accounts.find((x) => x.id === a.input.toAccountId) ?? fail("NotFound", "Account not found");
        if (src.isArchived) fail("Conflict", "The source account is archived");
        if (dest.isArchived) fail("Conflict", "The destination account is archived");
        if (!isPaymentDestination(dest.subtype)) fail("ValidationError", "Payments can only pay a credit card or BNPL.");
        if (!isPaymentSource(src.subtype)) fail("ValidationError", "Payments can only come from cash, an e-wallet, savings, or a current account.");
      }
      if (a.input.kind === "transfer" && a.input.toAccountId) {
        const dest = accounts.find((x) => x.id === a.input.toAccountId) ?? fail("NotFound", "Account not found");
        if (isPaymentDestination(dest.subtype)) fail("ValidationError", "Pay a credit card or BNPL as a payment.");
      }
```

When kind is payment, force `categoryId: null`, `excludedFromReporting: false`, and `splits: []` on the stored row.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/mock-payments.test.ts src/__tests__/mock.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/client/mock.ts src/__tests__/mock-payments.test.ts
git commit -m "feat: mirror card payments in the mock backend"
```

---

### Task 7: Selection counts and bulk locks

**Files:**
- Modify: `src/lib/txnSelection.ts`
- Modify: `src/components/TxnSelectionPanel.tsx`
- Test: `src/__tests__/txnSelection.test.ts`

**Interfaces:**
- Consumes: `TransactionKind` includes `"payment"`.
- Produces: `SelectionSummary.otherCounts` is `{ transfer: number; payment: number; adjustment: number; opening: number }`. `planBulk` locks a payment for recategorize, move, exclude, and include, with the transfer reasons worded for payments. Delete includes a payment in `changeable`.

- [x] **Step 1: Write the failing test**

In `src/__tests__/txnSelection.test.ts`, extend the fixture so a payment has a destination:

```ts
    toAccountId: kind === "transfer" || kind === "payment" ? "a2" : null,
```

Add:

```ts
  it("counts a payment beside transfers and will not recategorize or exclude it", () => {
    const payment = tx("payment", 5000);
    const s = summarizeSelection([payment, tx("transfer", 1000)]);
    expect(s.otherCounts).toEqual({ transfer: 1, payment: 1, adjustment: 0, opening: 0 });
    expect(s.inCents).toBe(0);
    const recat = planBulk("recategorize", [payment]);
    expect(recat.changeable).toHaveLength(0);
    expect(recat.lockedSkipped[0].reason).toBe("Payments have no category");
    const excl = planBulk("exclude", [payment]);
    expect(excl.changeable).toHaveLength(0);
    const del = planBulk("delete", [payment]);
    expect(del.changeable.map((t) => t.id)).toEqual([payment.id]);
  });
```

The existing summarize test expects `otherCounts` without `payment`. Update that expectation to `{ transfer: 1, adjustment: 1, opening: 1, payment: 0 }` in the same step as the implementation, or the old test fails for a missing key. Change it in this step so the new shape is what both tests demand.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/txnSelection.test.ts`

Expected: FAIL. `otherCounts` has no `payment` field, and indexing it with a payment kind is a type error.

- [x] **Step 3: Count and lock payments**

```ts
  otherCounts: { transfer: number; payment: number; adjustment: number; opening: number };
```

```ts
  const otherCounts = { transfer: 0, payment: 0, adjustment: 0, opening: 0 };
```

```ts
  if (t.kind === "transfer") {
    return action === "recategorize" ? "Transfers have no category" : "Transfers move between two accounts";
  }
  if (t.kind === "payment") {
    return action === "recategorize" ? "Payments have no category" : "Payments move between two accounts";
  }
```

In `src/components/TxnSelectionPanel.tsx`, add the payment count next to the transfer count:

```ts
    s.otherCounts.payment && `${s.otherCounts.payment} payment`,
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/txnSelection.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/txnSelection.ts src/components/TxnSelectionPanel.tsx src/__tests__/txnSelection.test.ts
git commit -m "feat: treat payments like transfers in bulk selection"
```

---

### Task 8: Form rules for Pay and the transfer segment

**Files:**
- Create: `src/lib/payments.ts`
- Create: `src/lib/__tests__/payments.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `movementKind(destSubtype: string | undefined): "payment" | "transfer"`
  - `isPaymentSource(subtype: string): boolean`
  - `payAmountField(balanceCents: number): string` — `(-balanceCents / 100).toFixed(2)` when `balanceCents < 0`, otherwise `""`.

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isPaymentSource, movementKind, payAmountField } from "../payments";

describe("movementKind", () => {
  it("is payment only for a credit card or BNPL destination", () => {
    expect(movementKind("credit-card")).toBe("payment");
    expect(movementKind("bnpl")).toBe("payment");
    expect(movementKind("savings")).toBe("transfer");
    expect(movementKind("personal-loan")).toBe("transfer");
    expect(movementKind(undefined)).toBe("transfer");
  });
});

describe("isPaymentSource", () => {
  it("allows only cash, e-wallet, savings, and current", () => {
    for (const subtype of ["cash", "ewallet", "savings", "current"]) {
      expect(isPaymentSource(subtype)).toBe(true);
    }
    expect(isPaymentSource("credit-card")).toBe(false);
    expect(isPaymentSource("investment")).toBe(false);
  });
});

describe("payAmountField", () => {
  it("starts at the amount owed and is blank when nothing is owed", () => {
    expect(payAmountField(-80_000)).toBe("800.00");
    expect(payAmountField(0)).toBe("");
    expect(payAmountField(2_000)).toBe("");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/payments.test.ts`

Expected: FAIL. `src/lib/payments.ts` does not exist.

- [x] **Step 3: Implement the helpers**

```ts
const PAYMENT_DESTINATIONS = new Set(["credit-card", "bnpl"]);
const PAYMENT_SOURCES = new Set(["cash", "ewallet", "savings", "current"]);

export function movementKind(destSubtype: string | undefined): "payment" | "transfer" {
  return destSubtype != null && PAYMENT_DESTINATIONS.has(destSubtype) ? "payment" : "transfer";
}

export function isPaymentSource(subtype: string): boolean {
  return PAYMENT_SOURCES.has(subtype);
}

export function payAmountField(balanceCents: number): string {
  if (balanceCents < 0) return (-balanceCents / 100).toFixed(2);
  return "";
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/payments.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/payments.ts src/lib/__tests__/payments.test.ts
git commit -m "feat: decide payment vs transfer from the destination"
```

---

### Task 9: Add Transaction saves a payment

**Files:**
- Modify: `src/modals/AddTransaction.tsx`

**Interfaces:**
- Consumes: `movementKind`, `isPaymentSource`, `payAmountField`, `client.createPayment`, `KIND_META.payment`.
- Produces: `AddTransaction` accepts optional `payAccountId?: string`. `FORM_KINDS` stays `["expense", "income", "transfer"]`. While the selected destination subtype is `credit-card` or `bnpl`, that segment's label is Payment, its icon is `card`, the source list is payment sources, and save calls `createPayment` or `updateTransaction` with `kind: "payment"`. Otherwise it stays a transfer.

- [x] **Step 1: Thread the Pay target and the derived kind**

Change the props:

```tsx
export function AddTransaction({ accounts, categories, editing, payAccountId, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; payAccountId?: string;
  onClose: () => void; onDone: () => void;
}) {
```

Resolve the starting destination before state:

```tsx
  const payTarget = accounts.find((a) => a.id === payAccountId);
  const initialTo = editing?.toAccountId
    ?? payTarget?.id
    ?? active.find((a) => a.id !== (editing?.accountId ?? active[0]?.id))?.id
    ?? "";
  const initialKind: TransactionKind = editing?.kind === "payment" || (payTarget && movementKind(payTarget.subtype) === "payment")
    ? "payment"
    : (editing?.kind ?? "expense");
```

Initialize `kind` from `initialKind`. Initialize `toAccountId` from `initialTo`. Initialize amount:

```tsx
  const [amount, setAmount] = useState(
    editing && (editing.kind === "transfer" || editing.kind === "payment")
      ? (editing.amountCents / 100).toFixed(2)
      : payTarget ? payAmountField(payTarget.balanceCents) : "",
  );
```

When `initialKind` is `"payment"`, pick a source that `isPaymentSource` and is not `initialTo`:

```tsx
  const [accountId, setAccountId] = useState(() => {
    if (editing) return editing.accountId;
    if (initialKind === "payment") {
      return active.find((a) => isPaymentSource(a.subtype) && a.id !== initialTo)?.id ?? "";
    }
    return active[0]?.id ?? "";
  });
```

Derive the destination account during render:

```tsx
  const dest = active.find((a) => a.id === toAccountId) ?? accounts.find((a) => a.id === toAccountId);
  const movement = movementKind(dest?.subtype);
```

When `toAccountId` changes, if the current kind is `transfer` or `payment` and `movement` differs from `kind`, call `setKind(movement)`. If the new kind is `payment` and the current source fails `isPaymentSource`, `setAccountId` to the first allowed source that is not the destination, or `""`.

The segment button for `"transfer"` is selected when `kind === "transfer" || kind === "payment"`. Its label is `movement === "payment" ? "Payment" : "Transfer"`. Its icon is `movement === "payment" ? "card" : "swap"`. Clicking it while kind is already `transfer` or `payment` returns without clearing the amount. Clicking Expense or Income still uses `changeKind`.

Source `<option>`s: when `kind === "payment"`, `active.filter((a) => isPaymentSource(a.subtype) && a.id !== toAccountId)`. Otherwise keep today's list (`active` for From, `active` except the source for To).

`valid` treats `kind === "payment"` like `kind === "transfer"`.

`submit` for `kind === "payment"`:

```tsx
        if (editing) {
          await client.updateTransaction({
            id: editing.id, kind: "payment", accountId, toAccountId,
            categoryId: null, amountCents: cents, description: desc.trim() || null,
            transactionDate: date, transactionTime: txTime, excludedFromReporting: false, splits: null,
          });
        } else {
          await client.createPayment(accountId, toAccountId, cents, desc.trim() || null, date, txTime);
        }
```

Keep the existing transfer branch for `kind === "transfer"`. The note placeholder is `"Note (optional)"` for both. The two-account grid renders for both. `catKind` for a payment can stay `"transfer"`; that branch does not show the category picker.

`accentForKind` for a payment uses `kindColor(t, "payment")`.

- [x] **Step 2: Typecheck**

Run: `npm run build`

Expected: exit 0. `payAccountId` is unused by callers until Task 11. That is allowed. An unused prop on the component type is used inside the component, so `noUnusedLocals` stays clean.

- [x] **Step 3: Commit**

```bash
git add src/modals/AddTransaction.tsx
git commit -m "feat: save a card destination as a payment"
```

---

### Task 10: Rows, detail, duplicate, and the kind filter

**Files:**
- Modify: `src/components/TxnRow.tsx`
- Modify: `src/components/TxnDetailPanel.tsx`
- Modify: `src/screens/Transactions.tsx`

**Interfaces:**
- Consumes: `movementKind`, `isPaymentSource`, `client.createPayment`, `KIND_META.payment`.
- Produces: a payment row title falls through to `KIND_META` (`Payment`) when there is no description. Its subtitle is `From → To`, same as a transfer. The detail panel edits a payment the way it edits a transfer, and on save sends `movementKind` of the selected destination. Duplicate of a payment calls `createPayment`. `KIND_FILTERS` includes `"payment"` after `"transfer"`.

- [x] **Step 1: Show and edit the payment row**

In `TxnRow.tsx`, treat payment like transfer for the from → to subtitle and the neutral amount color. Do not force the title to the word Transfer. A payment with no description uses `meta.label` (`Payment`).

```tsx
  const movement = tx.kind === "transfer" || tx.kind === "payment";
  const title = tx.description
    || cat?.name
    || (tx.kind === "adjustment" ? "Balance adjustment" : meta.label);
  // ...
  if (movement) subtitle = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`;
```

Use `movement` anywhere this file special-cases `tx.kind === "transfer"` for color or sign (`useKindColor`, destination perspective). A payment's destination perspective uses `signedFor`, which already handles `"payment"`.

In `TxnDetailPanel.tsx`:

```tsx
  const movement = tx.kind === "transfer" || tx.kind === "payment";
  const editable = tx.kind === "income" || tx.kind === "expense" || movement;
```

Replace each `tx.kind === "transfer"` check that chooses the two-account editor, the unsigned amount, the From/To labels, and `excludedFromReporting: false` with `movement`. On save, when `movement` is true:

```tsx
        const dest = accounts.find((a) => a.id === toAccountId);
        const kind = movementKind(dest?.subtype);
        await client.updateTransaction({
          id: tx.id, kind, accountId,
          toAccountId,
          categoryId: null,
          amountCents: tx.amountCents, description: desc.trim() || null, transactionDate: date,
          transactionTime: timeEnabled ? time : tx.transactionTime,
          excludedFromReporting: false,
          splits: null,
        });
```

The From `<select>` lists `isPaymentSource` accounts when `movementKind(dest?.subtype) === "payment"`. Otherwise it keeps `accountOptions`.

In `Transactions.tsx`:

```ts
const KIND_FILTERS: TransactionKind[] = ["income", "expense", "transfer", "payment", "adjustment", "opening"];
```

In the duplicate handler, before the transfer branch:

```ts
      else if (tx.kind === "payment" && tx.toAccountId)
        await client.createPayment(tx.accountId, tx.toAccountId, tx.amountCents, tx.description, tx.transactionDate, dupTime);
```

- [x] **Step 2: Typecheck**

Run: `npm run build`

Expected: exit 0.

- [x] **Step 3: Commit**

```bash
git add src/components/TxnRow.tsx src/components/TxnDetailPanel.tsx src/screens/Transactions.tsx
git commit -m "feat: show and edit payments in the transaction list"
```

---

### Task 11: Pay on the account row

**Files:**
- Modify: `src/screens/Accounts.tsx`

**Interfaces:**
- Consumes: `AddTransaction`'s `payAccountId` prop from Task 9. `Account.subtype` and `Account.balanceCents`.
- Produces: each non-archived `credit-card` and `bnpl` row shows a Pay button. It opens Add Transaction with `payAccountId` set to that account and does not toggle the row open.

- [x] **Step 1: Add the button and the modal**

Import `AddTransaction`. Hold `const [payAccount, setPayAccount] = useState<Account | null>(null)`.

On the collapsed row, before the chevron, stop the row click from also firing:

```tsx
{(a.subtype === "credit-card" || a.subtype === "bnpl") && !a.isArchived && (
  <span onClick={(e) => e.stopPropagation()}>
    <Btn size="sm" variant="outline" onClick={() => setPayAccount(a)}>Pay</Btn>
  </span>
)}
```

Next to the other modals at the bottom of the screen:

```tsx
{payAccount && (
  <AddTransaction
    accounts={all}
    categories={categories}
    payAccountId={payAccount.id}
    onClose={() => setPayAccount(null)}
    onDone={() => { setPayAccount(null); afterMutation(); }}
  />
)}
```

`all` is the accounts array already in this screen. Use that variable's real name (`accounts` or whatever the component already loads). `categories` must already be loaded here because the expanded activity renders `TxnRow` with categories. Pass that same list.

- [x] **Step 2: Typecheck and verify in the browser**

Run: `npm run build`

Expected: exit 0.

Run: `npm run dev`

In the browser:

1. Add a savings account with opening balance RM 500.00.
2. Add a credit card with amount owed RM 80.00 and a credit limit.
3. On the card row, click Pay. The form label reads Payment. The amount is `80.00`. The destination is the card. The source list does not include the card.
4. Save. Savings shows RM 420.00. The card shows nothing owed (or RM 0). The dashboard expense total does not include RM 80.
5. Add an expense of RM 25 on the card. Pay again, change the amount to `10.00`, and save. The card still owes RM 15.00.
6. Open Add Transaction, choose Transfer, and pick the card as the destination. The segment label changes to Payment. Saving creates a payment, which you can see in the transaction list with the Payment label and `Savings → Card`.

- [x] **Step 3: Commit**

```bash
git add src/screens/Accounts.tsx
git commit -m "feat: add Pay on credit card and BNPL accounts"
```

---

### Task 12: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–11.
- Produces: both agent docs name `payment` in the kind list and describe the source and destination limits. `CHANGELOG.md` `[Unreleased]` records the feature. `ROADMAP.md` checks off the payments item and keeps the reimbursements item open.

- [x] **Step 1: Update the four docs**

In the money-and-kinds bullet of `CLAUDE.md` and the same bullet of `AGENTS.md`, add `payment` to the kind list. State that a payment posts like a transfer (`-amount` on the source, `+amount` on the card or BNPL), the source subtype is `cash`, `ewallet`, `savings`, or `current`, the destination subtype is `credit-card` or `bnpl`, and dashboard income, expense, and spending skip it. `create_transfer` rejects a card or BNPL destination. Mention migration 011 copies `transactions`, `postings`, and `transaction_splits` and does not relabel old rows.

Under `CHANGELOG.md` `## [Unreleased]`, add an Added bullet:

```md
- Card and BNPL payments. Pay from cash, an e-wallet, savings, or a current account onto a credit card or BNPL. The row is a payment, both balances move, and income and spending stay unchanged.
```

In `ROADMAP.md`, check the payments item (`- [x]`) and leave the reimbursements item unchecked with `spec: _TBD_`.

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md AGENTS.md CHANGELOG.md ROADMAP.md
git commit -m "docs: describe card and BNPL payments"
```

---

## Self-review notes

Spec coverage: migration copy and the payment CHECK are Task 2. Posting signs are Tasks 1 and 3. Create, reject, partial, and overpay are Task 3. Edit flip, split rejection, and delete are Task 4. The command and mock are Tasks 5 and 6. Bulk locks are Task 7. The form label, source list, and Pay prefill are Tasks 8, 9, and 11. List label, detail edit, duplicate, and the kind filter are Task 10. Docs are Task 12. Day-net needs no edit. Reimbursements, loans, external payments, due dates, and interest have no tasks.
