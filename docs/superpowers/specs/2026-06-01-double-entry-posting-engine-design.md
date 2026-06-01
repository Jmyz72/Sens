# Double-Entry Posting Engine — Design (Phase 1)

**Date:** 2026-06-01
**Status:** Approved for planning
**Scope:** Behavior-preserving rebuild of the balance engine onto a double-entry
postings ledger. **No visible behavior change.** Split transactions are explicitly
out of scope and get their own later spec.

---

## 1. Motivation

Today Sens is **single-entry**. Each transaction carries one `kind`, one
`account_id`, an optional `to_account_id` (transfers only), and one
`amount_cents`. A balance is a six-term signed sum across kinds (`balance_expr`
in `repo.rs`). This works and produces correct numbers, but has three concrete
problems:

1. **The sign rule is duplicated three times** and must be kept in sync by hand:
   `balance_expr` (Rust SQL), `balanceOf` (`mock.ts`), and
   `signedFor`/`computeRunningBalances` (`src/lib/kinds.ts`). Every new kind
   (e.g. `opening` in v0.5.0) means editing all three correctly or the desktop
   app and the browser mock silently diverge.
2. **No integrity invariant.** Nothing guarantees the books are internally
   consistent. A bug that writes a transfer with a wrong `to_account_id` or an
   adjustment with a flipped sign produces wrong balances with no way to detect
   it.
3. **Splits are impossible.** A transaction touches at most one category, so a
   shopping trip that is part groceries + part household must be two unlinked
   transactions.

Double-entry fixes all three: balance becomes **one rule** (sum of an account's
postings), every transaction's legs **must sum to zero** (a provable, testable
invariant), and splits become "just more legs" in a later phase.

### Non-goals (phase 1)

- **No number changes.** Every balance, net-worth figure, and dashboard value is
  identical after this change — verified by asserting recomputed balances equal
  the pre-migration values.
- **No new UI, no new commands, no new reports, no multi-currency.**
- **No split transactions** — deferred to a separate spec.

---

## 2. Approach (chosen: "tagged counter-leg")

A new `postings` table is the authoritative source for account balances. Each
posting is **either** a real-money leg (`account_id` set) **or** a nominal
counter leg tagged with a `system_bucket` (`income | expense | equity`,
`account_id` NULL). The counter leg is what makes each transaction balance to
zero; it is **not** an account row, so the `accounts` table, the
`account_subtypes` taxonomy, net-worth math, account pickers, and the entire
account UI are **untouched**.

The existing `transactions` table is **kept unchanged** as the canonical input
shape (`kind`, `account_id`, `to_account_id`, `category_id`, `amount_cents`, …).
The service **materializes postings from the header** on every write; balances
read postings. Because phase 1 has only simple (non-split) transactions, the
header→postings mapping is deterministic and the two cannot diverge (the service
regenerates postings on every write, in the same DB transaction).

> Rejected alternatives: **system accounts as hidden rows in `accounts`** (forces
> a `WHERE is_system = 0` filter through every account list / balance roll-up /
> net-worth sum / picker — many touch points, easy to leak a phantom account);
> and **header-only, no postings table** (not real double-entry — no balance
> invariant).

---

## 3. Data model

New table (added by migration 006; nothing else in the schema changes):

```sql
CREATE TABLE postings (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  system_bucket  TEXT CHECK (system_bucket IN ('income', 'expense', 'equity')),
  amount_cents   INTEGER NOT NULL,
  -- exactly one side: a real account leg XOR a nominal bucket leg
  CHECK ((account_id IS NOT NULL AND system_bucket IS NULL)
      OR (account_id IS NULL     AND system_bucket IS NOT NULL))
);
CREATE INDEX idx_postings_account ON postings(account_id);
CREATE INDEX idx_postings_txn     ON postings(transaction_id);
```

**Invariants:**

- *Per posting:* exactly one of `account_id` / `system_bucket` is set (DB CHECK).
- *Per transaction:* `SUM(amount_cents) = 0`. This is a cross-row aggregate, so
  it **cannot** be a table CHECK. It is guaranteed by the service always writing
  balanced postings, and asserted by tests (per-transaction and global
  `SUM(postings.amount_cents) = 0`).
- `ON DELETE CASCADE` means deleting a transaction removes its postings
  automatically; `delete_transaction` keeps only its existing kind guards.

`transactions` is unchanged. `accounts` is unchanged.

---

## 4. The canonical posting mapping (the single sign rule)

One function encodes how a header becomes balanced legs. It lives in **exactly
one place** in Rust (`service::postings_for`) and is mirrored once in the mock
(`legsFor`). For a transaction with header `(kind, account_id, to_account_id,
amount_cents)` where `amount_cents` is positive for income/expense/transfer and
already-signed for adjustment/opening:

| kind        | leg 1 (real account)                 | leg 2 (counter)                              |
|-------------|--------------------------------------|----------------------------------------------|
| `income`    | `account_id`, `+amount_cents`        | bucket `income`,  `-amount_cents`            |
| `expense`   | `account_id`, `-amount_cents`        | bucket `expense`, `+amount_cents`            |
| `transfer`  | `account_id`, `-amount_cents`        | `to_account_id`, `+amount_cents` (real, no bucket) |
| `adjustment`| `account_id`, `+amount_cents`        | bucket `equity`,  `-amount_cents`            |
| `opening`   | `account_id`, `+amount_cents`        | bucket `equity`,  `-amount_cents`            |

Each row sums to zero. **An account's balance = `SUM(amount_cents) WHERE
account_id = X`**, which reproduces the old six-term `balance_expr` exactly for
every account, including a transfer's destination (verified in §8).

---

## 5. Balance engine change

`balance_expr(a)` in `repo.rs` collapses from the six-term per-kind sum to:

```sql
COALESCE((SELECT SUM(amount_cents) FROM postings WHERE account_id = {a}.id), 0)
```

This single expression replaces every current use site (`list_accounts`,
`get_account`, `account_balances`, `get_account_balance`). The
derived-`openingBalanceCents` sub-select (the `… kind='opening' LIMIT 1` alias)
is **unchanged** — it still reads the opening transaction header.

The frontend's per-account "balance after" column (`computeRunningBalances` /
`signedFor` in `kinds.ts`) reads transaction **headers** and is **unchanged**.

The **dashboard** (`sum_kind_in_range`, `spending_breakdown`,
assets/liabilities/net-worth) reads transaction **headers** (kind, category,
`excluded_from_reporting`) and account balances, so it is **unchanged** — it
simply benefits from the new balance expression underneath `account_balances`.

---

## 6. Backend changes (Rust)

1. **`MIGRATION_006`** (append to `MIGRATIONS`): create the `postings` table +
   indexes, then backfill two legs per existing transaction with `INSERT … SELECT`
   using the §4 mapping (posting ids `'p1-' || id` and `'p2-' || id`, CASE on
   `kind` for the signs/bucket). Fresh installs run 001→006; the backfill is a
   no-op with zero transactions. Data-preserving and automatic, like 005.
2. **`repo.rs`:**
   - Rewrite `balance_expr` (§5).
   - Add `insert_postings(conn, transaction_id, legs)` and
     `delete_postings_for(conn, transaction_id)` helpers. (Delete is rarely
     needed thanks to CASCADE, but used by the opening-edit rewrite path.)
3. **`service.rs`:**
   - Add private `postings_for(kind, account_id, to_account_id, amount_cents)
     -> Vec<Leg>` — the §4 mapping, the only place signs live.
   - Wrap `create_income` / `create_expense` / `create_transfer`,
     `update_transaction`, and `set_account_balance` in
     `conn.unchecked_transaction()` and write header **and** postings atomically.
     `update_transaction` regenerates the row's postings (delete + re-insert).
     `create_account` (already transactional) writes the opening row's postings.
     `set_account_balance`: the opening-edit branch rewrites the opening
     transaction's postings; the adjustment branch inserts the adjustment's
     postings.
   - All existing kind guards (opening/adjustment not editable/deletable) and
     validations are unchanged.
4. **Tests** (`src-tauri/src/lib.rs`):
   - Invariant: after each create/update/delete/reconcile path, every
     transaction's postings sum to 0 and the global posting sum is 0.
   - Parity: for a seeded fixture, the new balance equals the old `balance_expr`
     value for each account (lock in "no number changes").
   - Migration: build a DB at the pre-006 schema with sample rows, run 006,
     assert per-account balances are unchanged and postings are balanced.
   - Per-kind shape: each kind produces the legs in §4.

---

## 7. Mock parity (the seam)

`src/client/mock.ts` must mirror the engine or browser-dev and the packaged app
diverge:

- Add a `legsFor(tx)` mirroring `postings_for` (the same §4 mapping, one place).
- `balanceOf(a)` becomes: sum `legsFor(t)` across all transactions, keeping legs
  whose `accountId === a.id`. This replaces the current per-kind `if/else`
  chain, so the mock now has the **same one rule** as Rust.
- No stored postings array is required in the mock (it can derive legs on read),
  but the derivation must match `postings_for` exactly. A mock-side assertion in
  dev that `legsFor(t)` sums to 0 is a cheap guard.
- `resetApp` / demo seed: unaffected beyond using the new `balanceOf`.

`reset_to_defaults` (Rust) must also `DELETE FROM postings` in its wipe
transaction.

---

## 8. Migration & verification

- **Backfill correctness** is provable: the §4 leg-1 amount for each kind is
  exactly the term that kind contributes in the old `balance_expr`
  (`income/opening/adjustment` → `+amount`; `expense` → `-amount`; `transfer`
  source → `-amount`, destination leg-2 on `to_account_id` → `+amount`). So
  `SUM(postings WHERE account_id = X)` equals the old expression term-for-term.
- **Verification step in the plan:** a Rust test seeds representative data,
  records every account's `balance_expr` value, runs migration 006, and asserts
  each account's posting-sum balance is identical. This is the gate that proves
  "invisible refactor."

---

## 9. Frontend

**No changes.** No command signatures change, no `Transaction`/`Account` shape
changes, no new commands. `types.ts` gains nothing in phase 1 (postings are
internal). The UI (`TxnRow`, `AddTransaction`, filters, dashboard,
running-balance column) is untouched.

---

## 10. Risks & edge cases

- **Header/postings divergence** — mitigated by regenerating postings on every
  write inside one DB transaction; there is no path that writes a header without
  its postings.
- **The per-transaction sum-zero invariant isn't a DB constraint** — accepted;
  enforced in the service (single mapping function) and covered by tests, in the
  same spirit as subtype validation living in the service rather than as an FK.
- **Migration on a large existing DB** — two `INSERT … SELECT` over
  `transactions`; O(n), wrapped in 006's transaction like prior migrations.
- **`opening`/`adjustment` carry a signed `amount_cents`** — the mapping uses the
  signed value directly for leg 1 and its negation for leg 2, so a negative
  opening (owe accounts) backfills correctly.

---

## 11. Out of scope → future phases

- **Split transactions** (multiple category/account legs on one transaction):
  separate spec. The header money-fields become a summary and `category_id`
  moves onto the posting then.
- **Exposing postings to the UI / a ledger view / income statement** built on
  the buckets.
- **A user-facing "books balance" integrity command** (kept as a Rust test for
  now, per YAGNI).

---

## 12. Versioning

Lands as its own release per `RELEASING.md` (a `minor` bump — new internal
capability, no behavior change). Not currently in `ROADMAP.md`; it is a
foundational pre-requisite for later split/credit work and should be slotted
ahead of features that would benefit from balanced books.
