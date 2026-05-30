# Sens Roadmap

Sens is built one **phase** at a time. **One phase = one release.** A phase begins
with a brainstorming session (turning its line below into a spec under
`docs/superpowers/specs/`), proceeds through an implementation plan in
`docs/superpowers/plans/`, and ends when its `v*` tag ships per `RELEASING.md`.
This file is the index; the specs and plans hold the detail.

The project is **pre-1.0**. In `0.x`, the **minor** carries feature releases and the
**patch** carries fixes/follow-ups. **`1.0.0` is reserved for feature-complete.**

**Last shipped:** `v0.4.0` — Subcategories ·
**Next:** `v0.5.0` — Credit & debt behavior ·
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

## In progress

_Nothing in flight — `v0.5.0` is next up. The `v0.4.0` subcategories work shipped;
its design lives at
`docs/superpowers/specs/2026-05-31-categories-subcategories-redesign-design.md`._

## Planned — the climb to 1.0

### ⚪ v0.5.0 — Credit & debt behavior
Credit limits + utilization (credit-card, BNPL); installment/payoff schedules and
interest for loans (personal-loan, mortgage, car-loan, borrowed).
- [ ] credit limit + utilization % + available credit
- [ ] installment / payoff schedules
- [ ] interest + principal-vs-interest split
— spec: _TBD_

### ⚪ v0.6.0 — Investment value
Completes the deferred taxonomy work.
- [ ] cost basis vs current value
- [ ] unrealized gain/loss (investment, unit-trust, crypto)
- [ ] fixed-deposit maturity
— spec: _TBD_

### ⚪ v0.7.0 — Budgets & goals
- [ ] monthly budget per category
- [ ] budget-vs-actual + overspend warnings
- [ ] savings goals (target amounts + progress)
— spec: _TBD_

### ⚪ v0.8.0 — Recurring & reminders
- [ ] recurring/scheduled transactions
- [ ] upcoming list + one-tap post
- [ ] bill due-date reminders
— spec: _TBD_

### ⚪ v0.9.0 — Search, filter & tags
- [ ] full transaction search
- [ ] advanced filters (date / account / kind / amount)
- [ ] free-form tags
— spec: _TBD_

### ⚪ v0.10.0 — Reports & insights
- [ ] spending & cashflow trends/charts beyond the dashboard
- [ ] net-worth history over time
— spec: _TBD_

### ⚪ v0.11.0 — Data integrity & ownership
- [ ] CSV import/export
- [ ] full backup & restore
- [ ] account reconciliation against a statement balance
— spec: _TBD_

### 🎉 ⚪ v1.0.0 — Onboarding & polish (feature-complete milestone)
- [ ] receipts/attachments on transactions
- [ ] first-run onboarding
- [ ] 1.0 polish pass
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
