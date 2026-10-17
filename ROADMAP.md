# Sens Roadmap

Sens is built one **phase** at a time. **One phase = one release.** This file is the index; specs and plans hold the detail.

> **Last shipped:** `v0.9.1` (Rust↔mock seed drift guard; latest feature `v0.9.0`, category splits)
> **Next up:** Update Net Worth
> Credit & debt behavior is complete and unreleased.
> **Later:** the climb to `v1.0.0`

Legend: 🟢 shipped · 🟡 in progress · ⚪ planned

## Contents

- [How phases work](#how-phases-work)
- [Shipped](#shipped--the-0x-foundation)
- [Planned](#planned--the-climb-to-10)
- [Technical health](#technical-health--hardening-cross-cutting)
- [Later / unscheduled](#later--unscheduled)
- [Conventions](#conventions)

## How phases work

- A phase begins with a **brainstorming session** that turns its entry below into a spec in `docs/superpowers/specs/`.
- It continues through an **implementation plan** in `docs/superpowers/plans/`.
- It ends when its `v*` tag ships, per [`RELEASING.md`](./RELEASING.md).

**Versioning.** The project is **pre-1.0**. In `0.x`, the **minor** carries feature releases and the
**patch** carries fixes and follow-ups. **`1.0.0` is reserved for feature-complete.**

**Planned phases are listed in priority order, not pre-assigned version numbers.** The next minor is
decided at release time (`npm run release -- minor`), so re-ordering, inserting, or dropping a phase
never renumbers the rest. A version appears in the Shipped section only *after* a phase ships.

## Shipped — the `0.x` foundation

Per-release detail lives in [`CHANGELOG.md`](./CHANGELOG.md).

### Accounts & shell (`v0.1` – `v0.3`)

| Release | What landed |
|---|---|
| 🟢 `v0.1.0` | Initial release: accounts, transactions (income/expense/transfer/adjustment), categories, dashboard, dark/light theme |
| 🟢 `v0.2.0` | Account taxonomy (asset/liability), signed liabilities, net worth |
| 🟢 `v0.2.1` | JOIN robustness + owe-account balance correction |
| 🟢 `v0.2.2` – `v0.2.3` | Fixes and follow-ups |
| 🟢 `v0.2.4` | Advanced sidebar shell (net worth, assets, debts) |
| 🟢 `v0.3.0` | Accounts screen redesign + collapsible app shell, new brand mark |
| 🟢 `v0.3.1` | Two-step New Account modal + provider logos |

### Categories (`v0.4`)

| Release | What landed | Spec |
|---|---|---|
| 🟢 `v0.4.0` | Two-level subcategories + master–detail Categories screen | |
| 🟢 `v0.4.1` | Category management (delete, reorder, move/convert, bulk archive); dropped the system-category flag | `2026-05-31-category-management-richer-defaults-design.md` |
| 🟢 `v0.4.2` | Full-window-width layout fix across all screens | |
| 🟢 `v0.4.3` | Searchable emoji picker + sticky subcategories pane | `2026-06-01-categories-emoji-picker-sticky-pane-design.md` |
| 🟢 `v0.4.4` | Desktop drag-to-reorder fix (`dragDropEnabled: false`) | |
| 🟢 `v0.4.5` | Categories action menu (⋯) + Settings → factory reset + default reorder | `2026-06-01-categories-action-menu-and-factory-reset-design.md` |
| 🟢 `v0.4.6` | Richer Malaysia-focused default category tree (`defaults_v3_seeded` backfill); dropped the Investments income default | |
| 🟢 `v0.4.7` | Cash account template + illustrated RM100 logo | |

### Ledger & dashboard (`v0.5`)

| Release | What landed | Spec |
|---|---|---|
| 🟢 `v0.5.0` | **Non-cashflow transactions:** opening balance as a structural `opening` transaction (column dropped; data-preserving `MIGRATION_005`) + `excludedFromReporting` flag | `2026-06-01-non-cashflow-transactions-design.md` |
| 🟢 `v0.5.1` | Opening-balance row now appears in Accounts-screen activity (with running balance) | |
| 🟢 `v0.5.2` | **Double-entry posting ledger:** balances come from `SUM(postings.amount_cents)` via balanced two-leg entries (migration 006); invisible refactor, groundwork for splits | `2026-06-01-double-entry-posting-engine-design.md` |
| 🟢 `v0.5.3` | Dashboard redesign: unified net-worth + month-KPI hero, responsive account tile grid | `2026-05-30-sens-desktop-finance-tracker-design.md` |
| 🟢 `v0.5.4` | Kind-aware wording for the income/expense reporting-exclusion toggle | |

### Transactions (`v0.6` – `v0.9`)

| Release | What landed | Spec |
|---|---|---|
| 🟢 `v0.6.0` | **Transactions screen redesign ("Evolved List"):** toolbar (search / date-range / sort / density), date-grouped list with sticky day-net subtotals and hover quick-actions, three-state sidebar (inline-edit detail / multi-select), bulk-action preview sheet, keyboard nav. Frontend-only. | `2026-06-02-transactions-screen-redesign-design.md` |
| 🟢 `v0.7.0` | **Optional transaction time:** nullable `transaction_time` (migration 007, plain `ALTER TABLE`), gated by the "Record transaction times" setting; same-day transactions sort chronologically | `2026-06-02-transaction-time-support-design.md` |
| 🟢 `v0.7.1` | Excluded-from-reporting rows dimmed in the list; neutral colors for opening/adjustment amounts | |
| 🟢 `v0.8.0` | **Balance correction as income/expense:** a correction can be booked as real income/expense (protected, hidden "Adjustment" system categories, migration 008) instead of a neutral adjustment | `2026-06-03-balance-correction-as-income-expense-design.md` |
| 🟢 `v0.9.0` | **Category splits:** divide an income/expense across ≥ 2 categories (`transaction_splits`, migration 009) via the itemized Add Transaction builder; Split·N badge, per-category detail breakdown, attributed in the dashboard spending breakdown; balances untouched | `2026-06-06-category-splits-and-add-transaction-redesign-design.md` |
| 🟢 `v0.9.1` | **Rust↔mock drift guard:** the mock's seed data is generated from Rust into `src/generated/seed-catalog.json` and checked in CI | `2026-06-06-rust-mock-seed-drift-guard-design.md` |

Spec files above live in `docs/superpowers/specs/`.

## Planned — the climb to 1.0

Listed in **priority order.** The version is assigned when a phase ships. Finishing a phase moves it
into *Shipped* with its tag.

| # | Phase | Status | Spec |
|---|---|---|---|
| 1 | [Credit & debt behavior](#-credit--debt-behavior) | 🟢 (shipped, awaiting release) | credit limit ✅ · payments ✅ · reimbursements ✅ |
| 2 | [Update Net Worth](#-update-net-worth) | ⚪ | `2026-10-14-update-net-worth-design.md` |
| 3 | [Budgets & goals](#-budgets--goals) | ⚪ | `2026-10-14-budgets-and-goals-design.md` |
| 4 | [Recurring & reminders](#-recurring--reminders) | ⚪ | `2026-10-15-recurring-and-reminders-design.md` |
| 5 | [Advanced search, filter & tags](#-advanced-search-filter--tags) | ⚪ | TBD |
| 6 | [Reports & insights](#-reports--insights) | ⚪ | TBD |
| 7 | [Data integrity & ownership](#-data-integrity--ownership) | ⚪ | TBD |
| 8 | [1.0 — Onboarding & polish](#--10--onboarding--polish-feature-complete-milestone) | ⚪ | TBD |

### ⚪ Credit & debt behavior

Credit limits and utilization (credit-card, BNPL), plus card/BNPL repayments and reimbursement pairing.
Builds on the **v0.5.0** non-cashflow flag so repayments move money without polluting income/expense.
Loan schedules and interest are unscheduled; see [Later / unscheduled](#later--unscheduled).

- [x] Credit limit + utilization % + available credit
  — spec: `docs/superpowers/specs/2026-10-12-credit-limit-design.md`
- [x] Credit-card payments and BNPL repayments recorded as their own `payment` kind
  (cash, e-wallet, savings, or current → credit card or BNPL)
  — spec: `docs/superpowers/specs/2026-10-13-card-bnpl-payments-design.md`
- [x] Reimbursements & claims: money back that explicitly offsets an original expense (pairing),
  beyond the v0.5.0 flag that already excludes it from income; also an "Owes you" reading for `lent` accounts
  — spec: `docs/superpowers/specs/2026-10-13-reimbursements-and-receivables-design.md`

### ⚪ Update Net Worth

Set what a fixed deposit, investment, unit trust, or crypto account is worth
now. The difference is income or expense in a category saved on the account,
or picked for that update. Correct balance stays as it is.

- [x] Update Net Worth on those four account kinds
- [x] Optional gain and loss categories on the account
- [x] A rise records income and a drop records expense, counted in reporting and budgets

Spec: `docs/superpowers/specs/2026-10-14-update-net-worth-design.md`

### ⚪ Budgets & goals

- [x] Monthly budget per category
- [x] Budget-vs-actual + overspend warnings
- [x] Savings goals (target amounts + progress)

Spec: `docs/superpowers/specs/2026-10-14-budgets-and-goals-design.md`

### ⚪ Recurring & reminders

- [x] Recurring/scheduled transactions
- [x] Upcoming list + one-tap post
- [x] Bill due-date reminders

Spec: `docs/superpowers/specs/2026-10-15-recurring-and-reminders-design.md`

### ⚪ Advanced search, filter & tags

Basic search and date-range / kind / amount filtering already shipped with the **v0.6.0** Transactions
redesign. This phase covers what's left.

- [ ] Saved / advanced filters (combine account + category + kind + amount + date)
- [ ] Free-form tags + tag-based filtering

Spec: _TBD_

### ⚪ Reports & insights

- [ ] Spending & cashflow trends/charts beyond the dashboard
- [ ] Net-worth history over time

Spec: _TBD_

### ⚪ Data integrity & ownership

- [ ] CSV import/export
- [x] Import transactions from a photo (OS OCR + LLM, review before save): the Drafts screen
  — spec: `docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md`
- [ ] Full backup & restore
- [ ] Account reconciliation against a statement balance

Spec: [photo import](docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md) (CSV/backup _TBD_)

### 🎉 ⚪ 1.0 — Onboarding & polish (feature-complete milestone)

The `1.0.0` release. Ships when the phases above are done and the app is feature-complete.

- [ ] Receipts/attachments on transactions
- [ ] First-run onboarding
- [ ] 1.0 polish pass

Spec: _TBD_

## Technical health & hardening (cross-cutting)

Not feature phases. This is engineering-quality work that spans releases. Pick items up alongside the
feature phases (or fold the smaller ones into a patch). All are ⚪ planned until scheduled, except the shipped drift guard.

| Item | Status | Pairs with |
|---|---|---|
| [Performance: balance computation at scale](#-performance--balance-computation-at-scale) | ⚪ | n/a |
| [Rust↔mock drift guard](#-rustmock-drift-guard-shipped-v091) | 🟢 `v0.9.1` | n/a |
| [Test coverage: UI & integration](#-test-coverage--ui--integration) | ⚪ | n/a |
| [Accessibility pass](#-accessibility-pass) | ⚪ | 1.0 polish |
| [Startup resilience](#-startup-resilience) | ⚪ | Backup/restore |
| [Frontend cleanups](#-frontend-cleanups-low-priority) | ⚪ | n/a |

### ⚪ Performance — balance computation at scale

The balance engine (`balance_expr` in `src-tauri/src/repo.rs`) runs a
`SUM(postings.amount_cents) WHERE account_id = X` correlated sub-query **per account row**
(double-entry `postings` table, migration 006). It is reused on the Accounts screen and the dashboard
(`list_accounts` / `get_account` / `account_balances`). Fine today; scans grow with transaction history.

- [ ] Rewrite as a single `LEFT JOIN postings … GROUP BY a.id`, or maintain a running-balance materialization
- [ ] Frontend re-fetch discipline:
  - `store.ts` bumps a `version` counter and every screen re-pulls.
  - Accounts loads the **entire** transaction history in a 1000-row loop on each reload.
  - Consolidate the duplicate Transactions/Accounts fetches; add a lightweight query cache and request cancellation on unmount.
- [ ] The Transactions screen loads up to 1000 rows for the active date range (no pagination UI).
  Once histories grow past that, add range-aware paging.

Spec: _TBD_

### 🟢 Rust↔mock drift guard (shipped `v0.9.1`)

The mock's seed data (account subtypes, provider templates, category tree) is **generated** from the
Rust source into `src/generated/seed-catalog.json`. `mock.ts` and `providers.ts` consume that JSON; the
hand-maintained `SUBTYPE_ROWS`, `CAT_SEED` / `SUB_SEED`, and `PROVIDER_GROUPS` arrays are deleted.
The `seed_catalog_json_is_fresh` cargo test (run by CI as `cargo test --lib --locked`) guards it.
Regenerate with `npm run gen:seed-catalog`.

- [x] CI check (shared generated JSON) so divergence between the mock and the Rust seed fails the build

Spec: `docs/superpowers/specs/2026-06-06-rust-mock-seed-drift-guard-design.md`

### ⚪ Test coverage — UI & integration

Backend services/repos and frontend libs are well covered. There are **no React component/interaction
tests** for the screens (`Categories.tsx`, `Accounts.tsx`, `Dashboard.tsx`, `Transactions.tsx`) or the
modals, i.e. the form-submit → error-toast → `reload()` flows users actually exercise.

- [ ] Add `@testing-library/react` + modal-flow tests (submit, validation, error)
- [ ] Backend edges: `month_range` date boundaries (leap year / year-end), combined transaction filters
  (account + category + date), pagination limits

Spec: _TBD_

### ⚪ Accessibility pass

Aria/role coverage is still thin across `src/**/*.tsx`. The v0.6.0 redesign added some (checkbox roles,
label associations, keyboard nav on Transactions).

- [ ] `aria-label` on remaining icon-only buttons; `role="dialog"` + focus trapping on modals
- [ ] Keyboard path + live-region announcements for Categories drag-reorder
- [ ] Audit the own/owe account distinction for a non-color cue (kind colors already pair with sign +
  icon; accounts should match that guarantee)

_Note:_ overlaps the **1.0 — Onboarding & polish** phase and could land there.

Spec: _TBD_

### ⚪ Startup resilience

App setup uses `.expect()` (`src-tauri/src/lib.rs`). A corrupt or unreachable app-data DB panics on
launch with no user-facing message. Normal operation already surfaces `AppError` cleanly; only startup is exposed.

- [ ] Graceful startup error path with a recovery dialog

_Note:_ pairs naturally with backup/restore in the **Data integrity & ownership** phase.

Spec: _TBD_

### ⚪ Frontend cleanups (low priority)

- [ ] Split `Categories.tsx` (609 lines): extract the inline `CategoryForm` and `MoveCategoryModal`
- [ ] Extract one `getErrorMessage(e, fallback)` helper (the `(e as { message?: string })?.message ?? "…"`
  cast is copy-pasted across screens)
- [ ] Factor repeated modal-header / inline theme-token styling into a `ModalHeader` atom plus a few style helpers

Spec: _TBD_

## Later / unscheduled

### Fixed-deposit maturity

A maturity date and interest for a fixed deposit. Update Net Worth already
covers recording what the deposit is worth now. This is not on the path to 1.0.

- [ ] Maturity date
- [ ] Interest

### Loan schedules and interest

Personal loan, mortgage, car loan, borrowed, and other debt stay ordinary owe accounts (a signed balance
that counts in net worth). Extra loan behavior is **not on the path to 1.0**.

- [ ] Installment / payoff schedules
- [ ] Interest + principal-vs-interest split
- [ ] Loan repayments recorded as money movement rather than income/expense
  (own→owe transfers are already excluded; the `excludedFromReporting` flag covers external-party cases)

## Conventions

- **Versioning:** one phase = one minor bump (`0.N.0`); fixes are patches (`0.N.x`); `1.0.0` is the
  feature-complete milestone. Planned phases are **not** pre-pinned to a version. The next minor comes
  only from `npm run release -- <major|minor|patch>` at release time, per [`RELEASING.md`](./RELEASING.md).
- **Adding an idea:** append it to the relevant phase's checklist, or to *Later / unscheduled* if it has
  no home yet. The roadmap never blocks capture.
- **Re-prioritizing:** reorder the phase entries under *Planned* freely. No versions are pinned there, so moving a phase costs nothing.
- **Finishing a phase:** move its entry from *Planned* into *Shipped* with its `v*` tag and `spec:` link,
  and update the **Last shipped / Next up** block at the top.
