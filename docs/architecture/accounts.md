# Accounts

The account taxonomy (subtype → type → group), signed liabilities, credit limits, and provider branding.
Read this before changing account creation, account display, or liability behavior.

**Spec:** `docs/superpowers/specs/2026-05-30-account-type-subtype-system-design.md`

**Key files:** `src-tauri/src/db/migrations.rs` (migrations 002, 010) ·
`src/lib/accounts.ts` · `src/screens/Accounts.tsx` · `src/client/mock.ts`

> ⚠ Behavior changes go in the Rust chain **and** `mock.ts`. Seed data is generated; see [backend.md](./backend.md#the-tauri--mock-seam).

## Taxonomy: subtype → type → group

Each account stores **one classifier: `subtype`**. Everything else is derived.

| Subtype (16) | Type | Group |
|---|---|---|
| `cash`, `ewallet`, `savings`, `current` | `fund` | `own` |
| `fixed-deposit`, `investment`, `unit-trust`, `crypto` | `financial` | `own` |
| `lent` | `receivable` | `own` |
| `borrowed` | `payable` | `owe` |
| `credit-card`, `bnpl`, `personal-loan`, `mortgage`, `car-loan`, `other-debt` | `credit` | `owe` |

> The table above is a summary. The canonical mapping is the **`account_subtypes`** reference
> table (created and seeded by **migration 002**). The generated `src/generated/seed-catalog.json`
> is the mock's copy. If the table above disagrees with either of them, they win.

- `type` ∈ `fund | financial | receivable | payable | credit`; `group` ∈ `own | owe`.
- `type` / `group` are **derived on read via JOIN**. They are never stored on `accounts`.
- On the serialized `Account`, `accountType` holds the *type*, plus a `group` field.
- Subtype validity is enforced in the **service layer** (`subtype_exists` on create/update),
  not by a foreign key. A FK would need an accounts-table rebuild that the in-transaction
  migration runner can't do.

## Commands

- **Create:** `create_account(name, subtype, openingBalanceCents, templateKey?)`.
  - It replaced the old `create_account_from_template` / `create_custom_account`.
- **Read taxonomy:** `list_account_subtypes`.

## Providers are branding only

- A template's `group_name` only organizes the provider picker.
- `default_subtype` is a *suggestion*. The template never determines the type.
- The same provider (e.g. Maybank) can back a savings account *or* a credit card.

## Signed liabilities

- `owe`-group accounts carry **negative** balances.
- The balance engine is **identical for every account**. `type` / `group` only classify and present.
- The backend speaks **signed cents everywhere** and never enforces sign-by-group.
- The sign adapter is **frontend-only**:
  - `balanceDisplay` (`src/lib/accounts.ts`) renders an owe balance as a positive
    "You owe RMx", or "In credit" when overpaid.
  - AddAccount and SetBalance negate the positive "Amount owed" input before sending.

## Credit limit (credit-card and BNPL)

- Those two subtypes store a **required** `creditLimitCents` (positive sen; migration 010).
- Every other subtype leaves it null.
  - Switching **away** clears it.
  - Switching **in** requires one.
  - Both are enforced in the service **and** the mock.
- Derived in `creditReadout` (`src/lib/accounts.ts`):
  - Amount owed = the negative balance.
  - Available credit floors at zero and never exceeds the limit.
  - A card in credit shows the full limit and 0% utilization.
  - `overLimit` is a whole-number percent above 100.
- Over-limit charges **still save**.
- The Accounts row and expanded panel show the readout. Dashboard totals do not.

## Money lent (`lent`)

The `lent` subtype (type `receivable`, group `own`) is an ordinary signed asset. You lend by transferring
into it and are repaid by transferring out; neither is income or an expense. A positive balance reads
**"Owes you"** on the Accounts row (`lentLabel` in `src/lib/accounts.ts`).

## Frontend helpers

- `TYPE_LABEL`, `TYPE_ORDER`, `balanceDisplay`, `toneColor`, `creditReadout` live in `src/lib/accounts.ts`.
- The Accounts screen groups by type. AddAccount / EditAccount pick type → subtype.
- AddAccount flow and provider logos: see [frontend.md](./frontend.md#addaccount-flow).

## Still deferred

Update Net Worth is specified and not built yet
(`docs/superpowers/specs/2026-10-14-update-net-worth-design.md`).
Fixed-deposit maturity, installment schedules, and interest stay unscheduled.
See [`ROADMAP.md`](../../ROADMAP.md).
