# Sens v1.1 — Account Type & Subtype System (Design)

**Status:** Approved for planning
**Date:** 2026-05-30
**Supersedes:** the "Current account-type caveat" in v1 (account_type/subtype were labels only)
**Builds on:** `2026-05-30-sens-desktop-finance-tracker-design.md`

## Summary

In v1, every account is treated as a cash asset; `account_type`/`subtype` are stored
but drive no behavior. v1.1 makes account classification real: each account has a
**subtype** that maps to a **type** and a **group** (own/owe), and the group drives
**net worth = assets − liabilities** across balances, the dashboard, and account lists.

Liabilities use a **signed balance** model: an account you owe RM500 on is stored as
`−50000` cents. This keeps the entire transaction/balance engine unchanged — `type`
becomes a pure classification + presentation layer.

**Provider templates are decoupled from classification.** A provider (Maybank, Luno) is
branding only; the user picks the type and subtype independently. Maybank can be a
savings account *or* a credit card.

### Scope

**In v1.1:**
- The taxonomy: 16 subtypes → 5 types → 2 groups.
- Provider/subtype decoupling; unified create flow.
- Signed liabilities; net worth (assets/liabilities) on dashboard and accounts screen.
- Migration of existing v1 accounts; testing.

**Deferred to later versions (explicitly out of scope):**
- Per-subtype behavior of any kind: credit limits & utilization, installment/payoff
  schedules, interest/amortization, investment cost-basis vs market value.
- A separate `account_types` table (promote `type` to its own table only when it grows
  attributes/behavior).

## The taxonomy

`subtype` is the only thing the user picks at creation (after choosing type to filter).
`type` and `group` are derived.

| Type | Group | Subtypes |
|------|-------|----------|
| `fund` | own | cash, ewallet, savings, current |
| `financial` | own | fixed-deposit, investment, unit-trust, crypto |
| `receivable` | own | lent |
| `payable` | owe | borrowed |
| `credit` | owe | credit-card, bnpl, personal-loan, mortgage, car-loan, other-debt |

Group derivation: `fund | financial | receivable → own`; `payable | credit → owe`.

Full subtype list with labels and ordering (the seed):

| key | label | type | group | sort |
|-----|-------|------|-------|------|
| cash | Cash | fund | own | 0 |
| ewallet | E-wallet | fund | own | 1 |
| savings | Savings account | fund | own | 2 |
| current | Current / Checking | fund | own | 3 |
| fixed-deposit | Fixed deposit | financial | own | 4 |
| investment | Investment / Brokerage | financial | own | 5 |
| unit-trust | Unit trust / ASNB | financial | own | 6 |
| crypto | Crypto | financial | own | 7 |
| lent | Lent to someone (IOU) | receivable | own | 8 |
| borrowed | Borrowed from someone | payable | owe | 9 |
| credit-card | Credit card | credit | owe | 10 |
| bnpl | BNPL | credit | owe | 11 |
| personal-loan | Personal loan | credit | owe | 12 |
| mortgage | Mortgage | credit | owe | 13 |
| car-loan | Car / Hire-purchase loan | credit | owe | 14 |
| other-debt | Other debt | credit | owe | 15 |

`type` is internal to the model (no per-type behavior in v1.1) but **user-facing at
creation time** as the step that filters the subtype list.

## Data model

### Guiding principle

One stored classifier per account: **`subtype`**. `type` and `group` are derived from a
single canonical source (the `account_subtypes` table). Storing them as extra account
columns would be denormalization that can drift — avoided.

### New table: `account_subtypes` (canonical taxonomy)

Source of truth for the picker, validation, labels, ordering, and SQL group rollups.
Seeded idempotently like `account_templates`/`categories`.

```sql
CREATE TABLE account_subtypes (
  key           TEXT PRIMARY KEY,   -- 'savings', 'credit-card', 'crypto', …
  label         TEXT NOT NULL,      -- 'Savings account'
  type          TEXT NOT NULL CHECK (type IN
                  ('fund','financial','receivable','payable','credit')),
  account_group TEXT NOT NULL CHECK (account_group IN ('own','owe')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
```

- Column is `account_group`, not `group` (`group` is a SQL reserved word).
- The `(type → group)` pairing is fixed and CHECK-constrained per row; not derived in
  code, so SQL can `GROUP BY account_group` directly.

### Changes to `accounts`

- **Drop the `account_type` column** (`ALTER TABLE accounts DROP COLUMN account_type`;
  SQLite ≥ 3.35, satisfied by bundled rusqlite).
- **`subtype`** becomes the single classifier. Validity is enforced in the **service
  layer** (checked against `account_subtypes` on create/update), not a DB foreign key:
  adding an FK to the existing table needs a full rebuild (SQLite can't `ALTER ADD
  CONSTRAINT`, and a rebuild requires `foreign_keys=OFF`, which the in-transaction
  migration runner can't toggle). Integrity is equivalent because all writes go through
  the service. The column stays `subtype TEXT NOT NULL`.
- **`opening_balance_cents`** is now **signed**: for `owe` accounts it is stored negative.
  No CHECK forbids negatives (none today), so no constraint change.

### Derived `type`/`group` on reads

`repo.rs` JOINs `account_subtypes` when loading accounts so the serialized `Account`
carries derived values; the frontend never recomputes.

```
Account {
  id, templateKey, name,
  subtype,                 // 'credit-card'  (stored)
  accountType,             // 'credit'  (DERIVED via join — field kept by this name to
                           //  avoid Rust's reserved `type`/`r#type`; value domain is now
                           //  the 5 types, not the old bank/ewallet values)
  group,                   // 'owe'  (DERIVED — new field)
  openingBalanceCents,     // signed
  currency, isArchived, createdAt, updatedAt,
  balanceCents             // signed; engine unchanged
}
```

`AccountBalance` (dashboard struct) likewise: `accountType` value becomes the type, plus
a new `group` field.

### `account_templates` (provider = branding only)

- **`group_name` stays**, but only to organize the provider picker (Banks, Digital banks,
  E-wallets, BNPL, Investment, Global fintech, **+ Crypto**). It no longer derives type.
- **`default_subtype` stays** as a *suggestion* pre-selecting type+subtype after a provider
  is chosen; re-seeded to valid keys (banks → `savings`, ewallets → `ewallet`,
  bnpl → `bnpl`, investment → `investment`, fintech → `ewallet`, crypto → `crypto`).
- **Add Luno** under a new `Crypto` group, `default_subtype='crypto'`.

### Code removed

- `account_type_for_group()` in `service.rs` (Rust) and `GROUP_TYPE` in `mock.ts` (TS):
  type is no longer inferred from the template group.

## Create flow & API

### Create-account flow (UI)

```
Step 1  Provider          Pick a provider (Maybank, Luno…) or "Custom (no provider)"
Step 2  Type              fund / financial / receivable / payable / credit
Step 3  Subtype           filtered to the chosen type
Step 4  Name + balance    label adapts to group (below)
```

- Picking a provider pre-selects type+subtype from its `defaultSubtype`; user can change
  both freely. Provider never restricts the choice.
- "Custom" skips provider; `templateKey` is null.
- **Step 4 label adapts by group:** `own` → "Opening balance"; `owe` → "Amount owed". In
  both cases the user types a **positive** number.

### Sign adapter lives at the frontend edge

The backend speaks **signed cents everywhere** (like transactions). The only place that
knows "owe shows positive" is the frontend:

- **On submit:** for an `owe` subtype, the form negates the positive "Amount owed" →
  sends negative `openingBalanceCents`. `own` sends as-is.
- **On display:** owe balances render via `balanceDisplay` (below).
- The backend does **not** enforce sign-by-group (an owe account can be positive when in
  credit), so there is no validation coupling.

### Command changes

**New:**
```rust
list_account_subtypes() -> Vec<AccountSubtype>
// AccountSubtype { key, label, type, group, sortOrder, isActive }
```

**Unify the two create commands into one** (provider is now optional branding):
```rust
// REPLACES create_account_from_template + create_custom_account
create_account(
  name: String,
  subtype: String,                 // FK-validated against account_subtypes
  opening_balance_cents: i64,      // signed; frontend already negated for owe
  template_key: Option<String>,    // None = custom
) -> Account
```

**Unchanged signatures, adjusted semantics:**
- `update_account(input)` — `subtype` stays editable; re-picking re-derives type/group.
  `UpdateAccountInput` unchanged.
- `set_account_balance(account_id, real_balance_cents)` — backend logic unchanged
  (adjustment = real − current, both signed). Frontend negates the "amount owed" input
  for owe accounts before calling.

**Serialized shape:** `Account` and `AccountBalance` change as described in Data model
(`accountType` value domain → 5 types; new `group`).

### Client + mock

- `src/client/index.ts`: add `listAccountSubtypes()`; replace the two create wrappers with
  `createAccount(name, subtype, openingBalanceCents, templateKey)`.
- `src/client/mock.ts`: seed the 16-row taxonomy mirror; implement `list_account_subtypes`
  + `create_account`; derive `type`/`group` on returned accounts; remove old
  `GROUP_TYPE`. Same seam discipline as today (Rust and mock must match).

## Balances & net worth

### Engine unchanged

`balance_expr` (repo), `signedFor` + `computeRunningBalances` (kinds.ts), and `balanceOf`
(mock) stay exactly as they are. A balance is still `opening + signed history`; owe
accounts simply carry a negative number. The activity view's per-account "balance after"
column keeps working for credit cards/loans with no change.

### Net-worth aggregation (new)

```
assets_cents      = SUM(balance) where group = 'own'    // ≥ 0 typically
liabilities_cents = SUM(balance) where group = 'owe'    // ≤ 0, stored signed
net_worth_cents   = assets_cents + liabilities_cents     // = SUM(all balances)
```

`net_worth_cents` equals what `total_balance` computes today. Implementation:
- `repo::account_balances` JOINs `account_subtypes` so each `AccountBalance` carries
  `type` + `group`.
- Group totals are computed in Rust by filtering that one list (as `total_balance`
  already sums it) — no extra SQL, single source.

### Dashboard summary shape

```
DashboardSummary {
  - total_balance_cents
  + net_worth_cents          // = assets + liabilities
  + assets_cents             // own total (positive)
  + liabilities_cents        // owe total (signed, negative)
  …unchanged: income, expense, netCashflow, spendingBreakdown, accountBalances,
              recentTransactions
}
```

### Display adapter (frontend, the only sign-aware spot)

New `src/lib/accounts.ts` (taxonomy/group display helpers; `kinds.ts` stays
transaction-focused):

```
balanceDisplay(group, balanceCents) → { magnitude, tone, label }
  own:                 signed as today (negative = overdraft, red)
  owe & balance ≤ 0:   abs, red,   "You owe RM{abs}"     (normal case)
  owe & balance > 0:   positive, green, "In credit RM{bal}"   (overpaid)
```

Used by the account list, account detail, the activity view's running-balance column for
owe accounts, and the dashboard mini-list. The `Money` atom stays generic; callers apply
owe framing via this helper.

`src/lib/accounts.ts` also exports `TYPE_LABEL` for type section headers:
`fund`→"Cash & funds", `financial`→"Investments", `receivable`→"Receivables",
`payable`→"Payables", `credit`→"Credit & loans".

### Dashboard income/expense/spending — rules unchanged

Still excludes transfers and adjustments. An expense charged to a credit card is still
spending and still counts (`expense` kind). Paying the card is a `transfer` → excluded
from cashflow, reduces debt. No special-casing needed.

## UI layout

### Dashboard — net worth replaces flat total

A net-worth card with the assets/owe split, followed by the existing monthly KPI tiles
(unchanged):

```
┌─ NET WORTH ──────────────────────────────┐  ┌ INCOME ┐ ┌ EXPENSES ┐ ┌ NET CASHFLOW ┐
│  RM 24,600                                │  │RM 5,000│ │ RM 3,200 │ │  +RM 1,800   │
│  Assets RM 30,100   ·   Owe  RM 5,500     │  └────────┘ └──────────┘ └──────────────┘
└───────────────────────────────────────────┘
```

- Net worth = `netWorthCents` (red if negative). Assets = `assetsCents`.
  Owe = `abs(liabilitiesCents)`, expense/negative tone.
- Income / Expenses / Net Cashflow tiles and rules unchanged.

The right-column "Accounts" mini-list splits into Assets then Liabilities subsections
(only rendered if that group has accounts); owe rows use `balanceDisplay`. With no owe
accounts it looks identical to today.

### Accounts screen — grouped by type

One section per **type**, ordered fund → financial → receivable → payable → credit, each
with a subtotal; empty types hidden.

```
┌─────────────────────────────────────────────┐
│ Net worth                          RM 24,600 │
│ Assets RM 30,100        Owe RM 5,500         │
└─────────────────────────────────────────────┘

CASH & FUNDS ───────────────────────  RM 8,100
   Maybank Everyday     savings         RM 5,000
   TNG eWallet          e-wallet        RM 3,100

INVESTMENTS ────────────────────────  RM 22,000
   Luno                 crypto          RM 22,000

CREDIT & LOANS ─────────────────────   RM 5,500
   Atome                BNPL      You owe RM 500
   CIMB Card            credit card  You owe RM 5,000
```

- Top "Total balance" card → **Net worth** + Assets/Owe line.
- Section headers use `TYPE_LABEL`. Row subtype label uses the taxonomy `label` (not the
  raw key). Owe-type rows render via `balanceDisplay`.
- Expand/activity/correct-balance/edit/archive behavior unchanged; running-balance column
  uses `balanceDisplay` for owe accounts.

### AddAccount / EditAccount modals

```
New account                              [Custom account ⇄ Pick a provider]
  🔍 Search banks, e-wallets, brokers…
  Banks      [Maybank] [CIMB] …
  Crypto     [Luno] …
  ───────────────────────────────
  Account name      [ Everyday Savings        ]
  Type              [ fund ▾ ]      (prefilled from provider)
  Subtype           [ Savings account ▾ ]   (filtered to chosen type, prefilled)
  Opening balance (RM) [ 0.00 ]    (label → "Amount owed (RM)" when group=owe)
  [ Cancel ]  [ Create account ]
```

- Type + subtype selectors always shown (not just custom), sourced from
  `listAccountSubtypes()`; the hardcoded `CUSTOM_TYPES` constant is deleted.
- Submit calls `createAccount(name, subtype, signedCents, templateKey ?? null)`, negating
  for owe.
- `EditAccount`: subtype re-pickable via the same selectors; balance/amount-owed label
  adapts identically.

## Migration (002) & testing

### Migration 002 (append-only, own transaction)

1. **Create + seed `account_subtypes`** (16 rows; idempotent `INSERT OR IGNORE`).
2. **Remap existing accounts' `subtype`** (table below), then **drop `account_type`**.
3. **Re-seed templates**: align `default_subtype`; add Crypto group + Luno; delete
   `account_type_for_group` / `GROUP_TYPE`.

**Old → new subtype remap** (by old `subtype` first, then old `account_type` fallback):

| Old subtype | → new | Fallback by old account_type |
|---|---|---|
| savings | savings | bank, digital_bank → savings |
| ewallet | ewallet | ewallet, global_fintech → ewallet |
| bnpl | bnpl | bnpl → bnpl |
| investment | investment | investment → investment |
| *(anything else / custom free-text)* | — | custom/unknown → **cash** |

### Existing owe-account balances — reclassify only

Old `bnpl` accounts were stored as positive cash assets. After reclassification to
`group='owe'`, **do NOT auto-flip signs**:

- Flipping only the opening balance while leaving transaction history under old semantics
  yields an inconsistent ledger — worse than leaving it.
- User intent for those numbers is unknowable.
- v1 shipped days ago; real owe-data is minimal-to-none.
- The existing **"Correct balance"** tool inserts a proper signed adjustment.

After migration, if any account landed in an owe group, show a **one-time notice**:
"Some accounts are now treated as debts — review their balances."

### Testing

**Rust (`cargo test --lib`):**
- Migration 002: seeds 16 subtypes; bnpl/savings/ewallet/investment remap correctly;
  unknown → cash; `account_type` column gone.
- Taxonomy seed idempotent (re-run = no dupes).
- `create_account`: template path + custom path; rejects invalid subtype (FK/validation);
  stores signed opening balance as given.
- Net worth: assets/liabilities/net_worth correct with mixed own + signed owe;
  `net_worth = assets + liabilities`.
- `set_account_balance` on an owe account computes the right signed adjustment.

**TS (`vitest run`):**
- `balanceDisplay`: own / owe-negative / owe-positive(in-credit) / own-overdraft.
- `accounts.ts` taxonomy helpers + `TYPE_LABEL`.
- Mock parity: `list_account_subtypes`, `create_account`, dashboard net-worth match the
  Rust contract.
- AddAccount sign negation: owe subtype → negative `openingBalanceCents` sent.

## The Tauri/mock seam (reminder)

Every behavior/signature change above must land in BOTH the Rust chain and `mock.ts`:
the new taxonomy seed, `list_account_subtypes`, `create_account`, derived `type`/`group`,
and the net-worth dashboard fields. Browser-dev and the packaged app must not diverge.
