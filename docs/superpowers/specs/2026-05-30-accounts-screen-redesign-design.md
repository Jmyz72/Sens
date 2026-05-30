# Accounts Screen Redesign — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorm), pending spec review
**Scope:** Frontend-only. No data-model, command, service, repo, or mock changes.

## Goal

Make the Accounts screen "more advanced": richer per-account insight, a stronger
net-worth header, and a deeper expanded view — all computed from the data we already
have. Per the brainstorm, this is **not** about unlocking deferred subtype behaviors
(credit utilization, loan schedules, interest). It is presentation + derived analytics
over existing transactions.

## Non-goals

- No new Tauri commands, services, repos, migrations, or `mock.ts` changes. The redesign
  uses only the existing `client.listAccounts` and `client.listTransactions`.
- No search / sort / filter toolbar on the Accounts screen (explicitly cut).
- No per-subtype behavior (credit limits, installment/payoff schedules, interest,
  investment cost-vs-value) — still deferred.
- No reordering of accounts.

## Chosen design (approved)

**Shell:** the current single-screen accordion, grouped by account `type`
(`Cash & funds`, `Investments`, …), kept as-is structurally. Investment goes into richer
rows, an enhanced header, and a deeper expanded panel.

### 1. Net-worth header
A single `Card` at the top:
- "Net worth" label + large `Money` (SF Mono), red when negative.
- **Monthly delta**: change in net worth over the current calendar month, shown as
  `▲ RM 1,240 (7.2%) this month` (green when ≥ 0, red when < 0). The % is
  `delta / |netWorthAtStartOfMonth|`, omitted when the start value is 0.
- Assets / Owe breakdown line (existing).
- **Net-worth trend sparkline** (small area sparkline, accent-toned) to the right.
- "Show archived" toggle button (existing behavior, moved under the sparkline).

### 2. Collapsed account row (dense)
Per the approved "Dense + last activity" treatment. Row height ~78px:
- Glyph tile (existing `GlyphTile` + `accountTone`).
- Name.
- Sub-line: `subtype · last activity <relative>` (e.g. "ewallet · last activity today";
  "—" when the account has no transactions).
- Stat chips: `N txns` and `avg RM X/mo` (small mono chips on `panel2`).
- Filled **balance sparkline** (tone by direction — see Sign & tone rules).
- Right column: balance via the existing `balanceDisplay` adapter (owe accounts still
  render "You owe RM x" / "In credit"), with a compact **monthly delta** below
  (`▲ RM 340` / `▼ RM 180`).
- Chevron.

### 3. Expanded panel
Replaces today's "actions + recent activity" block with:
- **Period tabs**: `1M · 3M · 6M · 1Y · All` (default **3M**). Selecting one recomputes
  the chart window. Tab state is per-account-session (resets on collapse).
- **Area trend chart** of the account's balance over the selected window (accent-toned,
  same renderer as the header sparkline at a larger size).
- **Stat tiles** (three): `In · this month`, `Out · this month`, `Net` (green/red).
- **Actions** (existing): Correct balance, Edit, Archive/Restore.
- **Recent activity**: existing `TxnRow` list (newest first, current display limit),
  followed by a **"View all N transactions →"** link that deep-links into the
  Transactions screen pre-filtered to this account.

## Data & computation

All derived values are computed on the frontend. On mount (and on `version` change),
Accounts bulk-fetches **all** transactions once via `client.listTransactions({ limit })`
(no `accountId`), groups them by account, and derives stats. This replaces today's
lazy per-account fetch on expand.

A new pure module **`src/lib/accountStats.ts`** owns all math. Given an account and its
transactions (ascending by date), it produces:

| Field | Definition |
|---|---|
| `balanceSeries(window)` | Daily closing `balanceCents` across the window, seeded from `openingBalanceCents` and walked forward using the existing `signedFor` rules. Downsampled to ≤ ~48 points for the SVG path. "All" starts at the first transaction (or account creation). |
| `sparklinePoints` | `balanceSeries` over a fixed 90-day window — feeds the collapsed-row sparkline. |
| `monthChangeCents` | `balanceCents(now) − balanceCents(startOfCurrentMonth)`. Drives the row's monthly delta. |
| `inThisMonthCents` | Σ inflows this calendar month (positive `signedFor` contributions). |
| `outThisMonthCents` | Σ outflows this calendar month (negative `signedFor` contributions, shown as a positive magnitude). |
| `netThisMonthCents` | `inThisMonth − outThisMonth` (≡ `monthChangeCents`). |
| `lastActivityAt` | Max transaction `transactionDate`; `null` if none. |
| `txnCount` | Count of the account's transactions. |
| `avgMonthlyOutCents` | Total outflow ÷ number of active months (first txn month → current), min 1 month. This is the `avg RM X/mo` chip. |

A second helper computes the **net-worth series** = per-day sum of every active
(non-archived) account's `balanceSeries`, feeding the header sparkline and the monthly
delta. Archived accounts are excluded from net worth and all header figures (existing rule).

`signedFor` and `computeRunningBalances` already live in `src/lib/kinds.ts`; `accountStats`
builds on them rather than reimplementing balance math.

### Sign & tone rules (uniform for own + owe)
Tone is driven by **direction of `balanceCents`**, which is correct for both groups:
- `own`: higher balance = good. `owe`: balance is negative; moving toward 0 (debt
  shrinking) is an *increase* in `balanceCents` = good.
- **Monthly delta / sparkline tone:** green when `Δbalance ≥ 0`, red when `< 0`.
- The displayed balance itself keeps the existing `balanceDisplay` adapter (owe → "You
  owe"/"In credit"); only the delta and the sparkline use the uniform direction rule.

## Components

- **`src/components/Sparkline.tsx`** (new) — reusable SVG renderer. Props: `points`
  (number[]), `tone` (theme color), `fill` (bool), `width`, `height`. Pure, token-driven,
  no hardcoded hex. Used by the collapsed row, the header, and (larger) the expanded chart.
- **Accounts screen** consumes `accountStats` + `Sparkline`; owns the bulk fetch, the
  group/section layout, expanded-panel state (open id + per-open period tab), and actions.

## Deep-link to Transactions

- `App.tsx`: extend the nav helper `go` from `(id) => void` to
  `(id, opts?: { accountId?: string }) => void`. It stores an optional
  `txnFilterAccountId` in App state and clears it on any nav that omits it.
- `Accounts` receives `go` as a prop (it currently takes none) and calls
  `go("transactions", { accountId: a.id })` from the "View all" link.
- `Transactions` accepts an optional `initialAccountId` prop, seeds an **account filter**
  state from it, and renders a clearable filter chip ("Account: TnG eWallet ✕") alongside
  its existing kind filters. Clearing returns to the unfiltered log.

## Error handling

- Bulk transaction fetch failure → existing toast pattern (`notify(..., "error")`); rows
  still render balances from `listAccounts` with empty stats (sparkline/stat-chips hidden,
  delta omitted) rather than blocking the screen.
- Accounts with zero transactions render gracefully: no sparkline, `last activity —`,
  stat chips hidden or `0 txns`, delta omitted, expanded chart shows a flat baseline.

## Testing

- **`src/__tests__/accountStats.test.ts`** (new, TDD): unit-test every derived field with
  fixture transactions — including transfers (both directions), signed adjustments, an
  owe account (negative balances, debt shrinking → positive delta), zero-transaction
  accounts, and the net-worth series aggregation. Downsampling preserves first/last points.
- Existing `accounts.test.ts` / `mock-accounts.test.ts` stay green (no backend change).
- Frontend gate: `npm run build` (tsc strict, `noUnusedLocals/Parameters`) + `npm test`.

## File-change summary

| File | Change |
|---|---|
| `src/lib/accountStats.ts` | **new** — pure derived-stat + series functions |
| `src/components/Sparkline.tsx` | **new** — reusable SVG sparkline/area |
| `src/screens/Accounts.tsx` | **rewrite** — bulk fetch, dense rows, header, expanded panel, period tabs, `go` prop |
| `src/screens/Transactions.tsx` | **edit** — `initialAccountId` prop + clearable account filter chip |
| `src/App.tsx` | **edit** — `go(id, {accountId})`, store `txnFilterAccountId`, pass `go` to Accounts, prop to Transactions |
| `src/__tests__/accountStats.test.ts` | **new** — unit tests |

## Open assumptions (made explicit)

- `avg RM X/mo` = average monthly **outflow** (spend through the account). Chosen as the
  most intuitive "how much moves through this account"; revisit if it reads wrong.
- Bulk-fetch limit is high enough for a local personal-finance dataset; pagination is not
  introduced. If volume ever demands it, a backend aggregate endpoint is the escape hatch
  (out of scope here).
- Period-tab state resets when a row collapses (no persistence).
