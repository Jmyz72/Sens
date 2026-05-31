# Sens Roadmap

Sens is built one **phase** at a time. **One phase = one release.** A phase begins
with a brainstorming session (turning its line below into a spec under
`docs/superpowers/specs/`), proceeds through an implementation plan in
`docs/superpowers/plans/`, and ends when its `v*` tag ships per `RELEASING.md`.
This file is the index; the specs and plans hold the detail.

The project is **pre-1.0**. In `0.x`, the **minor** carries feature releases and the
**patch** carries fixes/follow-ups. **`1.0.0` is reserved for feature-complete.**

**Last shipped:** `v0.4.7` — Cash account template ·
**In progress:** `v0.5.0` — Non-cashflow transactions (implemented; pending release) ·
**Later:** the climb to `v1.0.0`

Legend: 🟢 shipped · 🟡 in progress · ⚪ planned

## Shipped — the `0.x` foundation

| Release | What landed |
|---|---|
| 🟢 `v0.1.0` | Initial release — accounts, transactions (income/expense/transfer/adjustment), categories, dashboard, dark/light theme |
| 🟢 `v0.2.0` | Account taxonomy (asset/liability), signed liabilities, net worth |
| 🟢 `v0.2.1` | JOIN robustness + owe-account balance correction |
| 🟢 `v0.2.2`–`v0.2.3` | Fixes & follow-ups |
| 🟢 `v0.2.4` | Advanced sidebar shell (net worth, assets, debts) |
| 🟢 `v0.3.0` | Accounts screen redesign + collapsible app shell, new brand mark |
| 🟢 `v0.3.1` | Two-step New Account modal + provider logos |
| 🟢 `v0.4.0` | Two-level subcategories + master–detail Categories screen |
| 🟢 `v0.4.1` | Category management (delete, reorder, move/convert, bulk archive); dropped the system-category flag — spec: `docs/superpowers/specs/2026-05-31-category-management-richer-defaults-design.md` |
| 🟢 `v0.4.2` | Full-window-width layout fix across all screens |
| 🟢 `v0.4.3` | Searchable emoji picker + sticky subcategories pane — spec: `docs/superpowers/specs/2026-06-01-categories-emoji-picker-sticky-pane-design.md` |
| 🟢 `v0.4.4` | Desktop drag-to-reorder fix (`dragDropEnabled: false`) |
| 🟢 `v0.4.5` | Categories action menu (⋯) + Settings → factory reset + default reorder — spec: `docs/superpowers/specs/2026-06-01-categories-action-menu-and-factory-reset-design.md` |
| 🟢 `v0.4.6` | Richer Malaysia-focused default category tree (`defaults_v3_seeded` backfill); dropped the Investments income default |

## In progress

_`v0.5.0` — Non-cashflow transactions is **implemented on `feat/v0.5.0-non-cashflow-transactions`, pending its release tag**. Opening balances became real `opening` transactions (the `accounts.opening_balance_cents` column was dropped; balance reconciles to a pure sum of signed history) and income/expense gained an `excludedFromReporting` flag. Existing databases **upgrade automatically** via the data-preserving `MIGRATION_005` (no data loss, no user action). Spec: `docs/superpowers/specs/2026-06-01-non-cashflow-transactions-design.md`; plan: `docs/superpowers/plans/2026-06-01-non-cashflow-transactions.md`._

## Planned — the climb to 1.0

### 🟡 v0.5.0 — Non-cashflow transactions (excluded from income/expense)
Let an income/expense transaction be flagged as **money movement, not real
income/expense** — so it affects balances only and is excluded from the dashboard's
income/expense/net-cashflow/spending-breakdown, the same way `transfer` and
`adjustment` already are. This is the groundwork the **v0.6.0** credit & debt
behavior leans on: a credit-card payment, loan repayment, or BNPL installment moves
money and pays down a balance but is **not** a new expense; reimbursements/claims are
money back, not new income. **Foundational pillar:** opening balances became real
`opening` transactions (column dropped; full reconciliation), with a data-preserving auto-migration (`MIGRATION_005`) so existing databases upgrade with no data loss.
- [x] mark an income/expense transaction as non-cashflow (`excludedFromReporting`)
- [x] dashboard + spending breakdown honor the exclusion (extends the existing
      transfer/adjustment exclusion in `repo.rs` / `mock.ts`)
- [x] opening balance as a structural `opening` transaction (drops
      `accounts.opening_balance_cents`; derived `openingBalanceCents`)
- [ ] credit-card payments and loan/BNPL repayments recorded as money movement
      rather than income/expense — _carried into v0.6.0 (own→owe transfers already
      excluded; the flag covers external-party cases)_
- [ ] reimbursements & claims — money back that offsets an original expense rather
      than counting as new income — _flag excludes it; explicit offset-pairing deferred_
— spec: `docs/superpowers/specs/2026-06-01-non-cashflow-transactions-design.md`

### ⚪ v0.6.0 — Credit & debt behavior
Credit limits + utilization (credit-card, BNPL); installment/payoff schedules and
interest for loans (personal-loan, mortgage, car-loan, borrowed). Builds on the
**v0.5.0** non-cashflow flag so repayments move money without polluting income/expense.
- [ ] credit limit + utilization % + available credit
- [ ] installment / payoff schedules
- [ ] interest + principal-vs-interest split
— spec: _TBD_

### ⚪ v0.7.0 — Investment value
Completes the deferred taxonomy work.
- [ ] cost basis vs current value
- [ ] unrealized gain/loss (investment, unit-trust, crypto)
- [ ] fixed-deposit maturity
— spec: _TBD_

### ⚪ v0.8.0 — Budgets & goals
- [ ] monthly budget per category
- [ ] budget-vs-actual + overspend warnings
- [ ] savings goals (target amounts + progress)
— spec: _TBD_

### ⚪ v0.9.0 — Recurring & reminders
- [ ] recurring/scheduled transactions
- [ ] upcoming list + one-tap post
- [ ] bill due-date reminders
— spec: _TBD_

### ⚪ v0.10.0 — Search, filter & tags
- [ ] full transaction search
- [ ] advanced filters (date / account / kind / amount)
- [ ] free-form tags
— spec: _TBD_

### ⚪ v0.11.0 — Reports & insights
- [ ] spending & cashflow trends/charts beyond the dashboard
- [ ] net-worth history over time
— spec: _TBD_

### ⚪ v0.12.0 — Data integrity & ownership
- [ ] CSV import/export
- [ ] full backup & restore
- [ ] account reconciliation against a statement balance
— spec: _TBD_

### 🎉 ⚪ v1.0.0 — Onboarding & polish (feature-complete milestone)
- [ ] receipts/attachments on transactions
- [ ] first-run onboarding
- [ ] 1.0 polish pass
— spec: _TBD_

## Technical health & hardening (cross-cutting)

Not feature phases — engineering-quality work that spans releases. Pick these up
alongside the feature minors above (or fold the smaller ones into a patch). Items
are ⚪ planned until scheduled.

### ⚪ Performance — balance computation at scale
The current balance engine (`balance_expr` in `src-tauri/src/repo.rs`) runs five
correlated sub-queries over `transactions` **per account row**, reused on the
Accounts screen and the dashboard (`list_accounts` / `get_account` /
`account_balances`). Fine today; scans grow with transaction history.
- [ ] rewrite as a single `LEFT JOIN transactions … GROUP BY a.id` (CASE sums), or
      maintain a running-balance materialization
- [ ] re-fetch discipline on the frontend: `store.ts` bumps a `version` counter and
      every screen re-pulls — Accounts loads the **entire** transaction history in a
      1000-row loop on each reload; consolidate the duplicate Transactions/Accounts
      fetches and add a lightweight query cache + request cancellation on unmount
- [ ] Transactions screen caps at 500 rows with no pagination UI — older txns are
      silently unreachable there
— spec: _TBD_

### ⚪ Rust↔mock drift guard
The subtype taxonomy and default category tree are hand-maintained in **both** the
Rust seed (`db/seed.rs`, migration 002) and `src/client/mock.ts` (`SUBTYPE_ROWS`,
`CAT_SEED`/`SUB_SEED`). CLAUDE.md already warns every behavior change must land in
both places — a standing drift hazard.
- [ ] CI check (or shared generated JSON) asserting the mock's taxonomy/seed matches
      the Rust source, so divergence fails the build
— spec: _TBD_

### ⚪ Test coverage — UI & integration
Backend services/repos and frontend libs are well covered; there are **no React
component/interaction tests** for the screens (`Categories.tsx`, `Accounts.tsx`,
`Dashboard.tsx`) or the four modals — i.e. the form-submit → error-toast →
`reload()` flows users actually exercise.
- [ ] add `@testing-library/react` + modal-flow tests (submit, validation, error)
- [ ] backend edges: `month_range` date boundaries (leap year / year-end), combined
      transaction filters (account + category + date), pagination limits
— spec: _TBD_

### ⚪ Accessibility pass
Only two aria/role attributes exist across the entire `src/**/*.tsx` tree.
- [ ] `aria-label` on icon-only buttons; `role="dialog"` + focus trapping on modals
- [ ] keyboard path + live-region announcements for Categories drag-reorder
- [ ] audit the own/owe account distinction for a non-color cue (the kind colors
      already pair with sign + icon; accounts should match that guarantee)
- _Note:_ overlaps the v1.0.0 "1.0 polish pass" — could land there.
— spec: _TBD_

### ⚪ Startup resilience
App setup uses `.expect()` (`src-tauri/src/lib.rs`); a corrupt or unreachable
app-data DB panics on launch with no user-facing message. Normal operation already
surfaces `AppError` cleanly — only startup is exposed.
- [ ] graceful startup error path with a recovery dialog
- _Note:_ pairs naturally with backup/restore in **v0.12.0 — Data integrity &
  ownership**.
— spec: _TBD_

### ⚪ Frontend cleanups (low priority)
- [ ] split `Categories.tsx` (572 lines) — extract the inline `CategoryForm` and
      `MoveCategoryModal`
- [ ] extract one `getErrorMessage(e, fallback)` helper (the
      `(e as { message?: string })?.message ?? "…"` cast is copy-pasted ~5×)
- [ ] factor repeated modal-header / inline theme-token styling into a `ModalHeader`
      atom + a few style helpers
— spec: _TBD_

## Later / unscheduled
_Nothing yet — every selected feature is placed above. New ideas land here (or in
the right phase) before they're scheduled._

## Conventions
- **Versioning:** one phase = one minor bump (`0.N.0`); fixes are patches (`0.N.x`);
  `1.0.0` is the feature-complete milestone. Versions are produced only by
  `npm run release -- <major|minor|patch>` per `RELEASING.md`.
- **Adding an idea:** append it to the relevant phase's checklist, or to
  *Later / unscheduled* if it has no home yet. The roadmap never blocks capture.
- **Finishing a phase:** flip its marker to 🟢, record the shipped tag, and fill in
  its `spec:` link.
