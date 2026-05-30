# Changelog

All notable changes to Sens are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-05-31

### Added
- Two-level **subcategories**: categories can now have subcategories via a new
  `parent_id`. A subcategory inherits its parent's kind; nesting is capped at one
  level. Transactions can be logged against a parent **or** a subcategory, and the
  Dashboard spending breakdown rolls subcategory spend up into the parent.
  Archiving a parent cascades to its subcategories.
- Redesigned the **Categories** screen as a master–detail layout: a left rail of
  top-level categories grouped by kind, and a detail pane for editing a category
  and managing its subcategories. The transaction Category picker now groups
  subcategories indented under their parent.

## [0.3.1] — 2026-05-31

### Changed
- **Redesigned the New Account modal** as a two-step, provider-first flow: pick a
  provider (or "Custom account") from a searchable logo grid, then choose the
  account type + subtype, name, and balance. The provider is branding only and
  never determines the account type. Subtype selection moved from dropdowns to a
  visual type-card picker + chips.

### Added
- Provider logos: a new `ProviderLogo` tile renders a real bundled logo on a white
  plate where one is available, falling back to a brand-tinted monogram otherwise.
  Used in the New Account modal and on the Accounts list rows. (Bundled logos
  currently cover major global brands; more can be added by dropping a file into
  `src/assets/logos/`.)
- `src/lib/providers.ts` — frontend provider catalog mirroring the Rust seed, now
  used by the browser mock (which previously listed fewer providers).

## [0.3.0] — 2026-05-30

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

## [0.2.4] — 2026-05-30

### Added
- **Advanced sidebar shell** — the app sidebar now shows net worth, assets,
  debts, active account count, grouped navigation, and a clearer local workspace
  footer while keeping the top bar compact.

## [0.2.3] — 2026-05-30

## [0.2.2] — 2026-05-30

### Added
- **Release tooling & CI** — `npm run release -- <major|minor|patch>` bumps all three
  version files (`package.json`, `Cargo.toml`, `tauri.conf.json`) plus `Cargo.lock`,
  rolls this changelog, commits, and tags. GitHub Actions now gate every PR (`ci.yml`)
  and build unsigned macOS/Windows/Linux binaries on a `v*` tag (`release.yml`). See
  `RELEASING.md`.

## [0.2.1] — 2026-05-30

### Fixed
- **Orphaned-subtype accounts no longer vanish** — `get_account`, `list_accounts`,
  and `account_balances` now `LEFT JOIN` the taxonomy with a `COALESCE` fallback
  (`fund`/`own`), so an account whose subtype isn't in the table stays visible
  instead of silently dropping from lists/balances and returning a misleading
  "not found". (issue #2)
- **"Correct balance" for liability accounts** — the "Amount owed" field now
  accepts **0** (fully paid off), and an **"in credit" toggle** lets you reconcile
  an overpaid/refunded account to a positive balance. (issue #2)

## [0.2.0] — 2026-05-30

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

## [0.1.0] — 2026-05-30

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

[Unreleased]: https://github.com/Jmyz72/Sens/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Jmyz72/Sens/releases/tag/v0.3.1
[0.3.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.3.0
[0.2.4]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.4
[0.2.3]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.3
[0.2.2]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.2
[0.2.1]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.1
[0.2.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.0
[0.1.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.1.0
