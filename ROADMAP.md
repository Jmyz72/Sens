# Sens Roadmap

Sens is built one **phase** at a time. **One phase = one release.** A phase begins
with a brainstorming session (turning its entry below into a spec under
`docs/superpowers/specs/`), proceeds through an implementation plan in
`docs/superpowers/plans/`, and ends when its `v*` tag ships per `RELEASING.md`.
This file is the index; the specs and plans hold the detail.

The project is **pre-1.0**. In `0.x`, the **minor** carries feature releases and the
**patch** carries fixes/follow-ups. **`1.0.0` is reserved for feature-complete.**

Planned phases are listed in **priority order — not pre-assigned version numbers.**
The next minor is decided **at release time** (`npm run release -- minor`), so
re-ordering, inserting, or dropping a phase never renumbers the rest. Versions live
in the Shipped table below *after* a phase ships, never before.

**Last shipped:** `v0.9.0` — Category splits ·
**Next up:** Credit & debt behavior ·
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
| 🟢 `v0.4.7` | Cash account template + illustrated RM100 logo |
| 🟢 `v0.5.0` | Non-cashflow transactions: opening balance as a structural `opening` transaction (column dropped; data-preserving `MIGRATION_005`) + `excludedFromReporting` flag — spec: `docs/superpowers/specs/2026-06-01-non-cashflow-transactions-design.md` |
| 🟢 `v0.5.1` | Opening-balance row now appears in Accounts-screen activity (with running balance) |
| 🟢 `v0.5.2` | Double-entry posting ledger — balances now come from `SUM(postings.amount_cents)` via balanced two-leg entries (migration 006); invisible refactor, groundwork for split transactions — spec: `docs/superpowers/specs/2026-06-01-double-entry-posting-engine-design.md` |
| 🟢 `v0.5.3` | Dashboard redesign — unified net-worth + month-KPI hero, responsive account tile grid — spec: `docs/superpowers/specs/2026-05-30-sens-desktop-finance-tracker-design.md` |
| 🟢 `v0.5.4` | Kind-aware wording for the income/expense reporting-exclusion toggle |
| 🟢 `v0.6.0` | **Transactions screen redesign ("Evolved List")** — toolbar (search / date-range / sort / density), date-grouped list with sticky day-net subtotals + hover quick-actions, three-state sidebar (inline-edit detail / adaptive multi-select), bulk-action preview sheet with per-kind re-categorize, keyboard nav; frontend-only — spec: `docs/superpowers/specs/2026-06-02-transactions-screen-redesign-design.md` |
| 🟡 `Unreleased` | **Category splits** — divide an income/expense across ≥2 categories (`transaction_splits`, migration 009) via the itemized Add Transaction builder; single list row with a Split·N badge, per-category detail breakdown, attributed in the dashboard spending breakdown; balances untouched — spec: `docs/superpowers/specs/2026-06-06-category-splits-and-add-transaction-redesign-design.md` |

## Planned — the climb to 1.0

Listed in **priority order**. The version each phase ships under is assigned when it
ships, not here — finishing a phase moves it into the Shipped table above with its tag.

### ⚪ Credit & debt behavior
Credit limits + utilization (credit-card, BNPL); installment/payoff schedules and
interest for loans (personal-loan, mortgage, car-loan, borrowed). Builds on the
**v0.5.0** non-cashflow flag so repayments move money without polluting income/expense.
- [ ] credit limit + utilization % + available credit
- [ ] installment / payoff schedules
- [ ] interest + principal-vs-interest split
- [ ] credit-card payments and loan/BNPL repayments recorded as money movement rather
      than income/expense (own→owe transfers are already excluded; the `excludedFromReporting`
      flag covers external-party cases) — carried over from v0.5.0
- [ ] reimbursements & claims — money back that explicitly offsets an original expense
      (pairing), beyond the v0.5.0 flag that already excludes it from income
— spec: _TBD_

### ⚪ Investment value
Completes the deferred taxonomy work.
- [ ] cost basis vs current value
- [ ] unrealized gain/loss (investment, unit-trust, crypto)
- [ ] fixed-deposit maturity
— spec: _TBD_

### ⚪ Budgets & goals
- [ ] monthly budget per category
- [ ] budget-vs-actual + overspend warnings
- [ ] savings goals (target amounts + progress)
— spec: _TBD_

### ⚪ Recurring & reminders
- [ ] recurring/scheduled transactions
- [ ] upcoming list + one-tap post
- [ ] bill due-date reminders
— spec: _TBD_

### ⚪ Advanced search, filter & tags
Basic search and date-range / kind / amount filtering already shipped with the
**v0.6.0** Transactions redesign; this phase covers what's left.
- [ ] saved / advanced filters (combine account + category + kind + amount + date)
- [ ] free-form tags + tag-based filtering
— spec: _TBD_

### ⚪ Reports & insights
- [ ] spending & cashflow trends/charts beyond the dashboard
- [ ] net-worth history over time
— spec: _TBD_

### ⚪ Data integrity & ownership
- [ ] CSV import/export
- [ ] full backup & restore
- [ ] account reconciliation against a statement balance
— spec: _TBD_

### 🎉 ⚪ 1.0 — Onboarding & polish (feature-complete milestone)
The `1.0.0` release. Ships when the phases above are done and the app is
feature-complete.
- [ ] receipts/attachments on transactions
- [ ] first-run onboarding
- [ ] 1.0 polish pass
— spec: _TBD_

## Technical health & hardening (cross-cutting)

Not feature phases — engineering-quality work that spans releases. Pick these up
alongside the feature phases above (or fold the smaller ones into a patch). Items
are ⚪ planned until scheduled.

### ⚪ Performance — balance computation at scale
The current balance engine (`balance_expr` in `src-tauri/src/repo.rs`) runs a
`SUM(postings.amount_cents) WHERE account_id = X` correlated sub-query **per
account row** (double-entry `postings` table, migration 006), reused on the
Accounts screen and the dashboard (`list_accounts` / `get_account` /
`account_balances`). Fine today; scans grow with transaction history.
- [ ] rewrite as a single `LEFT JOIN postings … GROUP BY a.id`, or maintain a
      running-balance materialization
- [ ] re-fetch discipline on the frontend: `store.ts` bumps a `version` counter and
      every screen re-pulls — Accounts loads the **entire** transaction history in a
      1000-row loop on each reload; consolidate the duplicate Transactions/Accounts
      fetches and add a lightweight query cache + request cancellation on unmount
- [ ] the Transactions screen now loads up to 1000 rows for the active date range
      (no pagination UI); once histories grow past that, add range-aware paging
— spec: _TBD_

### 🟡 Rust↔mock drift guard
The mock's seed data (account subtypes, provider templates, category tree) is now
**generated** from the Rust source into `src/generated/seed-catalog.json`.
`mock.ts` and `providers.ts` consume that JSON directly — the hand-maintained
`SUBTYPE_ROWS`, `CAT_SEED`/`SUB_SEED`, and `PROVIDER_GROUPS` arrays are deleted.
Guarded by the `seed_catalog_json_is_fresh` cargo test, which CI already runs
(`cargo test --lib --locked`). Regenerate via `npm run gen:seed-catalog`.
- [x] CI check (shared generated JSON) asserting the mock's taxonomy/seed matches
      the Rust source, so divergence fails the build
— spec: `docs/superpowers/specs/2026-06-06-rust-mock-seed-drift-guard-design.md`

### ⚪ Test coverage — UI & integration
Backend services/repos and frontend libs are well covered; there are **no React
component/interaction tests** for the screens (`Categories.tsx`, `Accounts.tsx`,
`Dashboard.tsx`, `Transactions.tsx`) or the modals — i.e. the form-submit →
error-toast → `reload()` flows users actually exercise.
- [ ] add `@testing-library/react` + modal-flow tests (submit, validation, error)
- [ ] backend edges: `month_range` date boundaries (leap year / year-end), combined
      transaction filters (account + category + date), pagination limits
— spec: _TBD_

### ⚪ Accessibility pass
Aria/role coverage is still thin across the `src/**/*.tsx` tree (the v0.6.0 redesign
added some — checkbox roles, label associations, keyboard nav on Transactions).
- [ ] `aria-label` on remaining icon-only buttons; `role="dialog"` + focus trapping on modals
- [ ] keyboard path + live-region announcements for Categories drag-reorder
- [ ] audit the own/owe account distinction for a non-color cue (the kind colors
      already pair with sign + icon; accounts should match that guarantee)
- _Note:_ overlaps the **1.0 — Onboarding & polish** phase — could land there.
— spec: _TBD_

### ⚪ Startup resilience
App setup uses `.expect()` (`src-tauri/src/lib.rs`); a corrupt or unreachable
app-data DB panics on launch with no user-facing message. Normal operation already
surfaces `AppError` cleanly — only startup is exposed.
- [ ] graceful startup error path with a recovery dialog
- _Note:_ pairs naturally with backup/restore in the **Data integrity & ownership** phase.
— spec: _TBD_

### ⚪ Frontend cleanups (low priority)
- [ ] split `Categories.tsx` (572 lines) — extract the inline `CategoryForm` and
      `MoveCategoryModal`
- [ ] extract one `getErrorMessage(e, fallback)` helper (the
      `(e as { message?: string })?.message ?? "…"` cast is copy-pasted across screens)
- [ ] factor repeated modal-header / inline theme-token styling into a `ModalHeader`
      atom + a few style helpers
— spec: _TBD_

## Later / unscheduled
_Nothing yet — every selected feature is placed above. New ideas land here (or in
the right phase) before they're scheduled._

## Conventions
- **Versioning:** one phase = one minor bump (`0.N.0`); fixes are patches (`0.N.x`);
  `1.0.0` is the feature-complete milestone. **Planned phases are not pre-pinned to a
  version** — the next minor is produced only by `npm run release -- <major|minor|patch>`
  at release time, per `RELEASING.md`.
- **Adding an idea:** append it to the relevant phase's checklist, or to
  *Later / unscheduled* if it has no home yet. The roadmap never blocks capture.
- **Re-prioritizing:** reorder the phase entries under *Planned* freely — because no
  versions are pinned there, moving a phase up or down costs nothing.
- **Finishing a phase:** move its entry from *Planned* into the *Shipped* table with
  its `v*` tag and `spec:` link, and update the **Last shipped / Next up** line.
