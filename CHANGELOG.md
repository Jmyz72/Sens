# Changelog

All notable changes to Sens are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Redesigned the Accounts screen** — the net-worth header now shows a monthly
  change (with %) and a trend sparkline; each account row gains a balance
  sparkline, monthly change, last-activity, and quick stats; expanding a row
  reveals a period-selectable balance chart (1M/3M/6M/1Y/All), In/Out/Net tiles,
  and a deep link into its transactions. All derived on the client from existing
  data — no backend changes.
- Redesigned the app shell: the sidebar is now collapsible (full ↔ icon rail with hover tooltips), its collapse state persists across launches, and the empty gap above the logo is gone. New "Coin S" brand mark and regenerated app icons.
- The top-bar **Add** button now creates a transaction directly; **adding an account moved to the Accounts screen** (an "Add account" button there).
- Removed the account-count row from the sidebar net-worth panel.

## [1.1.4] — 2026-05-30

### Added
- **Advanced sidebar shell** — the app sidebar now shows net worth, assets,
  debts, active account count, grouped navigation, and a clearer local workspace
  footer while keeping the top bar compact.

## [1.1.3] — 2026-05-30

## [1.1.2] — 2026-05-30

### Added
- **Release tooling & CI** — `npm run release -- <major|minor|patch>` bumps all three
  version files (`package.json`, `Cargo.toml`, `tauri.conf.json`) plus `Cargo.lock`,
  rolls this changelog, commits, and tags. GitHub Actions now gate every PR (`ci.yml`)
  and build unsigned macOS/Windows/Linux binaries on a `v*` tag (`release.yml`). See
  `RELEASING.md`.

## [1.1.1] — 2026-05-30

### Fixed
- **Orphaned-subtype accounts no longer vanish** — `get_account`, `list_accounts`,
  and `account_balances` now `LEFT JOIN` the taxonomy with a `COALESCE` fallback
  (`fund`/`own`), so an account whose subtype isn't in the table stays visible
  instead of silently dropping from lists/balances and returning a misleading
  "not found". (issue #2)
- **"Correct balance" for liability accounts** — the "Amount owed" field now
  accepts **0** (fully paid off), and an **"in credit" toggle** lets you reconcile
  an overpaid/refunded account to a positive balance. (issue #2)

## [1.1.0] — 2026-05-30

Account taxonomy: classification now drives behavior. Each account has a
`subtype` that maps to a `type` (fund / financial / receivable / payable /
credit) and a `group` (own / owe), and the group drives net worth across
balances, the dashboard, and account lists.

Design: `docs/superpowers/specs/2026-05-30-account-type-subtype-system-design.md`
· Merged in PR #1 · Follow-ups tracked in issue #2.

### Added
- **`account_subtypes` taxonomy** (16 subtypes → 5 types → 2 groups), the
  canonical reference table created and seeded by migration 002; `type`/`group`
  are derived on read.
- **Signed liabilities & net worth** — `owe`-group accounts carry negative
  balances; the dashboard reports net worth = assets + liabilities, plus assets
  and owe totals. The balance engine is unchanged.
- **Unified `create_account(name, subtype, openingBalanceCents, templateKey?)`**
  command and **`list_account_subtypes`**.
- **Provider/classification decoupling** — templates are branding only; the user
  picks type → subtype independently. New Crypto provider group + Luno.
- **Owe-aware UI** — type-first AddAccount/EditAccount, Accounts grouped by type,
  "You owe" / "In credit" display (`balanceDisplay` in `src/lib/accounts.ts`),
  and an owe-aware "Correct balance" flow ("Amount owed").
- **One-time notice** shown after migration if any account was reclassified as a
  debt.

### Changed
- Dashboard `total_balance_cents` → `net_worth_cents` (+ `assets_cents`,
  `liabilities_cents`).
- `account_type`/`group` are now derived (via JOIN on `account_subtypes`) rather
  than stored ad hoc.

### Removed
- `create_account_from_template` and `create_custom_account` (replaced by the
  unified `create_account`).
- The `accounts.account_type` column (dropped in migration 002; existing rows
  are remapped to the new subtype keys, reclassify-only with no balance sign
  flip).

### Deferred (not in this release)
- Per-subtype behavior: credit limits & utilization, installment/payoff
  schedules, interest, investment cost-vs-value.

## [1.0.0] — 2026-05-30

Initial release — a local-first desktop personal-finance tracker for Malaysian
Ringgit (MYR), manual entry only (no sync, no bank connections, no
multi-currency).

Design: `docs/superpowers/specs/2026-05-30-sens-desktop-finance-tracker-design.md`

### Added
- **Accounts** from a built-in provider template catalog (banks, digital banks,
  e-wallets, BNPL, investment, global fintech) or custom; archive/restore.
- **Transactions** — income, expense, transfer, and signed adjustment kinds;
  balances computed on read as opening + signed history (never stored).
- **Balance correction** — edits the opening balance (no history) or records a
  dated adjustment (with history).
- **Categories** — seeded income/expense/transfer defaults; system categories
  cannot be archived.
- **Dashboard** — month-scoped totals and spending breakdown (transfers and
  adjustments excluded from income/expense/cashflow).
- **Foundation** — Tauri v2 + Rust + SQLite (rusqlite, bundled), React 19 +
  TypeScript + Vite, integer-MYR-cents money, dark/light theming, and the
  Tauri/in-memory-mock dispatch seam for browser-only dev.

[1.1.1]: https://github.com/Jmyz72/Sens/releases/tag/v1.1.1
[1.1.0]: https://github.com/Jmyz72/Sens/releases/tag/v1.1.0
[1.0.0]: https://github.com/Jmyz72/Sens/releases/tag/v1.0.0
