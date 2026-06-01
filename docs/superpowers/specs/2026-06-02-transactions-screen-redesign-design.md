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

Actions adapt to the eligible subset and disable (dashed, with a reason) when **0 rows
would change**. Nothing fails silently.

**One consistent label format for every action:** an **affected count** (the number of
rows the action will actually change) plus, when guards exclude some of the selection, a
faint **"· N skipped"** whose tooltip gives the reason. The same format applies to Delete
(e.g. "4 · 1 skipped") — no special-casing.

| Action | Affects (the count shown) | Skips |
|---|---|---|
| 🏷 Re-categorize… | income/expense in the selection (kind-aware — see below) | transfer / adjustment / opening; income/expense whose kind has no target chosen |
| ↔︎ Move to account… | income/expense in the selection | transfer (ambiguous from/to) / adjustment / opening |
| ⚑ Exclude from reporting | income/expense **not already excluded** | already-excluded rows + non-income/expense |
| ◷ Include in reporting | income/expense **currently excluded** | already-included rows + non-income/expense |
| 🗑 Delete | income/expense/transfer/adjustment | opening (structural) |
| Clear selection | — | always available |

Exclude/Include count **only the rows whose flag actually flips**, so the result is
deterministic across a mixed-flag selection and the count never overstates the change.

#### Re-categorize: per-kind target picker

Because a category belongs to exactly one kind (`income` or `expense`), bulk re-categorize is **kind-aware**:

- **`TargetPicker` adapts to the selection's kinds.** A mixed income+expense selection shows **one category dropdown per present kind** — an "Expense category" picker and an "Income category" picker — each listing only that kind's categories. A pure-income or pure-expense selection shows only the relevant picker.
- **Unassigned kinds drop into "Can't change."** If the user saves without choosing a target for a particular kind, rows of that kind move to the preview sheet's "Can't change" bucket with the reason *"No income category chosen"* or *"No expense category chosen"*. They are never silently skipped or incorrectly written.
- **Each row is applied to its own kind's target.** `planBulk` pairs every income row with the income-category choice and every expense row with the expense-category choice, so every write sent to `updateTransaction` is kind-valid. The backend's `validate_category_for` rule (category kind must match transaction kind) is never triggered.

The before→after preview in the sheet (`~~Old cat~~ → New cat`) uses each row's own kind to select the correct target for display.

#### Bulk preview sheet (the "what happens next")

Pressing any action opens **one preview sheet** before anything is written — the user
always sees the exact rows that will change and the rows being skipped:

- **Header** names the action. For pick-actions (Re-categorize / Move) it carries an
  **editable target chip** (e.g. "🛒 Food · Change") — the picker (category tree / account
  list) opens inline and can be reopened without leaving the sheet.
- **"Will change · N"** — a list of the affected transactions (mini `TxnRow`s). For
  re-categorize/move each row previews its **before → after** (e.g. ~~Dining~~ → Food).
  Each row carries a quiet **✕ Skip** control to drop it from this operation.
- **"↩ Removed by you · K"** — rows the user skipped in this sheet. Reversible with
  **＋ Add back**. Excluded from the Apply count. This bucket is empty until the user skips
  something.
- **"🔒 Can't change · M"** — the guard-blocked rows, dimmed and **locked** (no control),
  each with its reason (*can't be edited* / *opening balances can't be deleted*). These can
  never be promoted into the change set.
- **Live recompute** — the header count, the **Apply to N** button, and the footer net all
  update as the user skips / adds back. If the change set drops to 0, **Apply disables**.
- **Footer** — Cancel · **Apply to N** (accent), or a red **Delete N** with
  "This can't be undone." copy for the destructive case.
- **On Apply** — sheet closes → panel shows a busy state → the *remaining* change-set rows
  loop through `updateTransaction` / `deleteTransaction` → one `reload()` → selection clears
  → a summary toast (*"Re-categorized 3 · 2 skipped."* — the skip count folds in both
  guard-blocked and user-removed rows).

The sheet's editing is scoped to that one operation: skipping a row here does **not** alter
the broader multi-select behind the sheet (Cancel leaves the original selection intact).

#### Setting: "Preview bulk actions" (default on)

A single toggle in **Settings → Transactions**, following the existing `remember_month`
pattern exactly — a `Toggle` in a `SettingRow`, persisted via
`setSetting("bulk_action_preview", "1" | "0")` and read with `getSetting` (treat
`null`/unset as **on**). The Transactions screen reads the flag when a bulk action is
pressed, so flipping it takes effect immediately with no reload.

- **On (default):** every bulk action opens the preview sheet described above.
- **Off:** Re-categorize / Move show only their target picker, then apply immediately;
  Exclude / Include apply instantly. Same summary toast in both cases.
- **Delete is never silent:** even with preview off, bulk Delete keeps a **lightweight
  confirm** (count + any skips + "can't be undone") — the full preview collapses to that
  compact confirm rather than disappearing. Bulk delete never fires with zero confirmation.

`getSetting`/`setSetting` are already mirrored in `mock.ts`; the new key needs no mock
changes. The Settings screen gains one row under a new (or existing) "Transactions" card.

**Edge cases:**
- 0 rows would change (e.g. all already excluded, or only openings selected): the action
  is disabled + dashed in the panel and the sheet never opens.
- Pure income/expense selection: counts have no "· N skipped" suffix — the clean case.

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
- A new **bulk preview sheet** component (reusing the `Modal` atom + mini `TxnRow`s) that
  takes the action, the resolved target, and the affected/skipped row partition, supports
  per-row skip/add-back, and returns an Apply callback. Single-row delete keeps a
  lightweight confirm (not the sheet).
- `src/screens/Settings.tsx` — one new `SettingRow` + `Toggle` ("Preview bulk actions")
  under a "Transactions" `Card`, wired to `getSetting`/`setSetting("bulk_action_preview")`.
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

**Category-kind parity (implemented):** `mock.ts` now mirrors the Rust service's
`validate_category_for` rule — `updateTransaction` and `createIncome`/`createExpense`
reject a category whose kind does not match the transaction kind, returning an error with
message `"Category kind '…' does not match transaction kind '…'"`. This closes the
Tauri/mock seam gap so browser-dev correctly rejects kind-mismatched writes that the
desktop backend would also reject.

## Testing

- `src/lib` helpers (selection summary eligibility, day-net subtotal, date-range mapping)
  get focused Vitest unit tests.
- `npm run build` (tsc strict) and `npm test` must stay green.
- Manual verification in `npm run dev` (mock) across: mixed-kind bulk selection,
  inline edit of each editable kind, exclude/include toggling, date-range switches,
  keyboard nav, and the read-only adjustment/opening states.
```
