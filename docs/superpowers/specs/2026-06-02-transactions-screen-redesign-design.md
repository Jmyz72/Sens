# Transactions screen redesign — "Evolved List" (A+)

**Date:** 2026-06-02
**Status:** Approved design, pending implementation plan
**Scope:** Frontend-only. No schema, migration, or Tauri-command changes. Mock parity limited to verifying date-range filtering.

## Summary

Redesign the Transactions screen (`src/screens/Transactions.tsx`) keeping its current
shape — a warm, date-grouped list with a right-hand detail panel — but leveling it up
on four axes the user asked for: **visual polish**, **scannability/findability**, a
**stronger detail panel**, and **new capabilities** (date-range filtering, bulk actions,
inline quick-edit, including the non-cashflow `excludedFromReporting` flag).

The chosen direction is **"A+ · Evolved List"** — an evolution of today's screen, not a
data-table rewrite. It borrows the per-day net subtotal idea from a table layout while
keeping the glyph-led row warmth that matches the rest of the app.

## Why frontend-only

All behaviors reuse existing Tauri commands and their mock mirrors:

- **Date-range filter** → `listTransactions({ fromDate, toDate, accountId })` already
  supports these params (`TransactionFilters` in `src/types.ts`). Multi-kind filtering
  stays client-side (the command takes a single `kind`).
- **Inline edit** → `updateTransaction(UpdateTransactionInput)`.
- **Duplicate** → the matching `createIncome` / `createExpense` / `createTransfer`.
- **Bulk actions** → client-side loops over `updateTransaction` / `deleteTransaction`,
  ending in a single `reload()` and one summary toast.
- **Exclude/Include from reporting** → `updateTransaction` with `excludedFromReporting`.

No new commands are introduced. If any bulk loop proves too chatty in practice, batching
is a later optimization, not part of this redesign.

## Backend guards that shape the UI

Confirmed in `src-tauri/src/service.rs`:

| Kind | Editable? | Deletable? | Has category | `excludedFromReporting` allowed |
|---|---|---|---|---|
| `income` / `expense` | ✅ | ✅ | ✅ | ✅ |
| `transfer` | ✅ (no category) | ✅ | ✕ | ✕ (CHECK pins to 0) |
| `adjustment` | ✕ (guard) | ✅ | ✕ | ✕ |
| `opening` | ✕ (guard) | ✕ (structural) | ✕ | ✕ |

These guards are the single source of truth for which row/bulk actions are offered.
The UI never attempts a guarded action — it disables it with a reason.

## Layout

A two-column CSS grid, same as today: `1fr` list + a sticky right panel that appears
when there is a selection (single detail) or a multi-row selection (Selection panel).

### 1. Toolbar (row 1)

- **Search** (description / category / account), client-side as today.
- **Date-range picker**: `This month` · `Last month` · `Custom…` · `All`. Drives
  `fromDate`/`toDate` on `listTransactions` (server-side). Default: `This month`.
- **Sort control**: Date ↓ (default) / Date ↑ / Amount ↓ / Amount ↑. Client-side.
- **Density toggle**: comfortable ↔ compact, persisted to `localStorage`
  (`sens.txn.density`), mirroring the sidebar-collapse pattern.

### 2. Filter line (row 2)

- **Kind chips** (multi-select, client-side): Income / Expense / Transfer / Adjustment.
  `opening` is not offered as a chip (structural, rarely filtered).
- **Account-filter pill** when arriving with `initialAccountId` (unchanged behavior).
- **Live In/Out totals**, right-aligned, reflecting the active filter + range.

### 3. The list

- **Date groups** with **sticky headers** (`position: sticky`) showing the group date and
  the **day's net subtotal** (income − expense for that day, signed, kind-colored).
- **Rows** (`TxnRow`, extended): glyph with a small **category color dot**, title +
  subtitle, and an **aligned monospace amount column** (fixed width, right-aligned) for
  clean vertical scanning. Compact density reduces row height + paddings.
- **Hover quick-actions** on the row: **Edit · Duplicate · Delete**. Duplicate and Edit
  are hidden for `adjustment`/`opening` (Edit) and `adjustment`/`opening` (Duplicate has
  no create path). Delete hidden for `opening`.
- **Selection checkbox** reveals on row hover (and stays visible once any row is checked).

### 4. Sidebar — contextual panel

The right panel has three states driven by selection:

**(a) Empty** — nothing selected/clicked: panel is absent (list spans full width).

**(b) Single detail / inline edit** — one row clicked, nothing checked:
- Header: kind badge · title · **big signed amount**.
- **Balance-impact line**: account balance before → after this transaction, computed
  frontend-side via `computeRunningBalances` over that account's postings
  (`src/lib/kinds.ts`). For transfers, show the perspective of the source account; omit
  if not computable.
- **Inline-editable fields** for income/expense/transfer: category (tree popover),
  account (and to-account for transfers), date, note, amount — saved via
  `updateTransaction`. For income/expense, an **Exclude from reporting** switch
  (`excludedFromReporting`); the existing TxnRow "Excluded" chip reflects it live.
- `adjustment`/`opening`: **read-only**, with the existing explanatory note
  ("Adjustments can be deleted but not edited" / "The opening balance is set from the
  account").
- Footer: **Save** · **Duplicate** (income/expense/transfer) · **Delete**
  (hidden for `opening`).

**(c) Selection panel** — two or more rows checked: the same sticky panel **morphs** into
a multi-select summary (see next section). Checking a 2nd row swaps single-detail → this;
clearing drops back to single-detail or empty.

### 5. Selection panel (bulk) — adaptive

Summary, always valid for any mix:
- **Count** + **net** = sum of selected income − expense (selection arithmetic, not
  dashboard reporting). Labeled simply **"net"** to avoid implying dashboard semantics.
- **In · n** / **Out · n** rows.
- **"Also selected (not in net): N transfer, N adjustment, N opening"** line so the other
  kinds are acknowledged without distorting the net. If any selected income/expense are
  flagged excluded, note the count (they are still summed in the selection math).

Actions adapt to the eligible subset; each shows its eligible count and disables (dashed,
with a reason) when nothing qualifies. Nothing fails silently.

| Action | Eligible kinds | Notes |
|---|---|---|
| 🏷 Re-categorize… | income/expense | Category-tree popover; loops `updateTransaction`. |
| ↔︎ Move to account… | income/expense | Account popover; loops `updateTransaction`. Transfers excluded (ambiguous from/to). |
| ⚑ Exclude from reporting | income/expense | Sets `excludedFromReporting = true`. |
| ◷ Include in reporting | income/expense | Sets `excludedFromReporting = false`. |
| 🗑 Delete | income/expense/transfer/adjustment | Skips `opening`; count reads e.g. "4 · skips 1 opening". Confirm dialog repeats skips. |
| Clear selection | — | Always available. |

After any bulk action: one `reload()` and a summary toast, e.g.
*"Re-categorized 2 · 3 skipped."*

**Edge cases:**
- All-ineligible selection (e.g. only openings, or only a transfer for re-categorize):
  the action is disabled + dashed with a reason.
- Delete with an opening in the mix: stays enabled, count shows the skip, confirm repeats it.
- Pure income/expense selection: every button fully enabled, no skip notes.

### 6. Keyboard

- `↑` / `↓` move the active single selection through the visible (filtered) list.
- `E` edit the active row (focus first inline field), `⌫` delete it (with confirm).
- `⌘A` / `Ctrl+A` select the visible (filtered) range into the Selection panel.
- `Esc` clears the multi-selection, else closes the single detail.
- `Space` toggles the checkbox on the active row.

Keyboard handling is scoped to the screen (listener added/removed on mount) and ignores
events while a text input is focused.

## Components touched

- `src/screens/Transactions.tsx` — the bulk of the work: toolbar, filter line, grouped
  list with sticky subtotals, selection state, the three-state sidebar, keyboard handling.
- `src/components/TxnRow.tsx` — category color dot, aligned amount column, density prop,
  hover quick-actions slot, selection checkbox.
- `src/lib/` — small helpers: day-net subtotal computation, selection summary
  (counts/net/eligibility), date-range → `{fromDate,toDate}` mapping. Reuse
  `computeRunningBalances`/`signedFor` for the balance-impact line.
- Reuse existing atoms (`Card`, `Btn`, `Pill`, `Money`, `GlyphTile`, `IconBtn`,
  `ActionMenu`, `EmojiPicker`/category tree, toast). No new design primitives.

## Out of scope

- Running-balance **column** in the list (de-scoped; the balance-impact line in the
  detail panel covers the per-txn need).
- New Tauri commands, batch/bulk backend endpoints, schema or migration changes.
- CSV export, saved filters, column customization.

## Mock parity

Verify `src/client/mock.ts` `listTransactions` honors `fromDate`/`toDate` (and
`accountId`); add the filter if missing. All other paths reuse already-mirrored mock
methods. No new mock state.

## Testing

- `src/lib` helpers (selection summary eligibility, day-net subtotal, date-range mapping)
  get focused Vitest unit tests.
- `npm run build` (tsc strict) and `npm test` must stay green.
- Manual verification in `npm run dev` (mock) across: mixed-kind bulk selection,
  inline edit of each editable kind, exclude/include toggling, date-range switches,
  keyboard nav, and the read-only adjustment/opening states.
```
