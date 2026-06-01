# Changelog

All notable changes to Sens are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] — 2026-06-01

### Changed
- **Redesigned the Dashboard layout.** Net worth and the month's Income / Expenses /
  Net Cashflow are now unified into a single hero strip, and accounts render as a
  responsive tile grid (with provider logos) instead of a tall list pinned beside the
  spending breakdown. The old two-column row left a large empty gap when one side was
  short; the new full-width stack flows naturally from an empty state to a full one.

## [0.5.2] — 2026-06-01

### Changed
- Internal: account balances now come from a double-entry `postings` ledger (one
  uniform rule) instead of a per-kind signed sum. No visible behavior change;
  existing data is migrated automatically (migration 006). Lays the groundwork
  for split transactions.

## [0.5.1] — 2026-06-01

### Fixed
- The **Opening balance** row now appears in an account's **Recent activity** on the
  Accounts screen, and that view's per-row running balance now includes the opening
  amount. Previously the opening transaction showed everywhere except the Accounts
  screen.

## [0.5.0] — 2026-05-31

### Added
- **Opening balances are real transactions.** Every account now starts with a
  dedicated **Opening balance** transaction, so its history fully reconciles to its
  balance — no more "phantom" starting money that appears in the balance but nowhere
  in the ledger. It's a structural row (one per account, can't be edited or deleted
  here; change it from the account's opening-balance field).
- **Money-movement flag on income/expense.** Mark an income or expense as **money
  movement** to keep it out of your income/expense/cashflow/spending reports while it
  still moves the account balance — for reimbursements and claims (money back, not new
  income) or repaying someone (money out, not a new expense). The transactions log
  shows an **Excluded** badge on these, and **Opening balance** is now a filterable
  kind.

### Changed
- **Schema upgrade (automatic, non-destructive):** dropped the stored
  `opening_balance_cents` column, added the `opening` transaction kind and an
  `excluded_from_reporting` flag. Existing databases **upgrade automatically** on first
  launch via migration 005 — every account's opening balance is backfilled as an
  `opening` transaction before the column is dropped, so all accounts and transactions
  are preserved with identical balances. No action required when upgrading from any
  earlier version.

## [0.4.7] — 2026-05-31

### Added
- **Cash account template** — the account picker now leads with a dedicated
  **Cash** provider (default subtype `cash`) for physical notes/coins, so you no
  longer have to reach for "Custom account". It carries an original, in-house
  **RM100**-styled logo (violet note, hibiscus, portrait disc) — evocative of the
  real banknote without reproducing Bank Negara's copyrighted design. Existing
  users pick it up automatically via an idempotent every-open template re-seed;
  fresh installs and factory reset get it too.

## [0.4.6] — 2026-05-31

### Added
- **Richer default categories** — the seeded category tree now covers the
  recurring realities of Malaysian personal finance: new top-levels **Business**,
  **Rental Income**, **Government & Aid**, **Cashback & Rewards** (income) and
  **Family & Dependents**, **Kids**, **Insurance & Protection**, **Personal Care**,
  **Home & Living**, **Donations & Religious** (incl. Zakat), **Government & Fees**
  (road tax, summons), **Pets**, and **Fees & Charges** (expense), plus many new
  subcategories (e.g. Mamak/Kopitiam, Bubble tea, TnG/Toll reload, Astro/TV, Dental,
  Optical, Mental health, Angpow/Duit raya). Existing users are backfilled once via
  a new `defaults_v3_seeded` gate (idempotent `INSERT OR IGNORE`, never duplicates
  or disturbs your edits); fresh installs and factory reset get the full set.

### Changed
- Dropped **Investments** from the default income categories. Saving/investing,
  loans & debt, reimbursements/claims, and credit-card payments are deliberately
  **not** categories — they are money movement that dedicated features will handle
  in a later phase. Existing users keep any such categories they already have.

## [0.4.5] — 2026-05-31

### Added
- **Categories: action menu** — per-category and per-subcategory actions are now
  grouped in a "⋯" dropdown (`src/components/ActionMenu.tsx`). Delete is always
  shown but disabled (with an explanatory tooltip) when a top-level category still
  has subcategories.
- **Settings: Reset app to defaults** — a "Danger zone" section lets you wipe all
  accounts, transactions, and categories and restore the seeded defaults, guarded by
  a type-`RESET`-to-confirm prompt.

### Changed
- Default category order: "Other Income" now sorts last in the Income group (applies
  to fresh installs and after a reset).

## [0.4.4] — 2026-05-31

### Fixed
- **Drag-to-reorder categories and subcategories now works in the desktop app.**
  The Tauri webview's OS-level drag-and-drop was intercepting the events before
  the frontend's HTML5 drop handler could fire, so reordering silently did
  nothing. Disabled it via `dragDropEnabled: false` on the window.

## [0.4.3] — 2026-05-31

### Added
- **Searchable emoji picker** for categories: a popover over the full Unicode
  catalog with keyword search, recent, and finance-suggested rows, replacing the
  plain emoji text field.

### Changed
- Categories: the subcategories pane now stays on-screen (sticky, with its own
  internal scroll and a pinned header) while the category list scrolls, so it no
  longer disappears off the bottom on long lists.

## [0.4.2] — 2026-05-31

### Fixed
- All screens now span the full window width. Accounts, Categories, and Settings
  previously capped their content width and hugged the left edge while Dashboard
  and Transactions spread edge-to-edge, producing an inconsistent layout on wider
  windows.

## [0.4.1] — 2026-05-31

### Added
- **Delete categories**: any category or subcategory with no subcategories and no
  transactions can now be permanently deleted; categories still referenced by
  transactions can be archived instead.
- **Reorder** top-level categories and subcategories by drag-and-drop.
- **Move & convert** categories: move a subcategory to another parent, promote a
  subcategory to top-level, or demote a childless top-level into a subcategory.
- **Bulk archive/restore** multiple categories at once via a selection mode.
- **Richer default categories**: a two-level starter tree (subcategories under Food,
  Transport, Bills, Shopping, Health, Entertainment, Education, Travel, Salary,
  Freelance, and a new Investments income category). Existing users are backfilled
  these defaults once; any you delete won't come back.

### Changed
- Categories are now fully user-managed: the `is_system` flag was removed, so every
  category can be edited, archived, or deleted.
- macOS release builds are now ad-hoc signed (`APPLE_SIGNING_IDENTITY: "-"`) so the
  bundle's resources are sealed. This replaces the misleading _"Sens is damaged and
  can't be opened"_ Gatekeeper error with the normal _"unidentified developer"_ prompt
  that right-click → Open can bypass. Builds remain un-notarized.

### Documentation
- README now has a **Download & install** section with macOS first-launch
  instructions, including the `xattr -dr com.apple.quarantine` workaround for the
  "damaged" error.
- Release notes (`release.yml`) now spell out the macOS first-launch steps for
  downloaders.

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
  and build unsigned macOS/Windows binaries on a `v*` tag (`release.yml`). See
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
