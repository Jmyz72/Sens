# Frontend

Theming, the app shell, the main screens and modals, the auto-updater, and app settings.
Read this before changing UI structure or adding a setting.

**Key files:** `src/theme/tokens.ts` · `src/App.tsx` · `src/components/ui.tsx` ·
`src/screens/*` · `src/modals/*` · `src/lib/*`

## Contents

- [Theming & UI conventions](#theming--ui-conventions)
- [App shell](#app-shell)
- [Dashboard & Plan](#dashboard--plan)
- [AddAccount flow](#addaccount-flow)
- [Transactions screen](#transactions-screen)
- [Itemized Add-Transaction builder](#itemized-add-transaction-builder)
- [Reimbursement form](#reimbursement-form)
- [Auto-updater](#auto-updater-desktop-only)
- [App settings & window config](#app-settings--window-config)

## Theming & UI conventions

- `src/theme/tokens.ts` defines semantic tokens for **dark (default) + light**.
- `ThemeProvider.tsx` injects base CSS and persists the mode to `localStorage`.
- **Never hardcode colors in components.** Use `useTheme()` tokens.
  - Allowed raw hex: data constants only (`src/lib/brand.ts` provider brand colors, category color palettes).
- Kinds map to tokens: income green · expense red · transfer blue · adjustment amber.
  - **Color is never the only cue.** Amounts also carry sign + icon (`src/lib/kinds.ts`, `src/components/TxnRow.tsx`).
- New work uses the existing atoms in `src/components/ui.tsx` (Card, Btn, Modal, Money, GlyphTile, …)
  and the macOS-native aesthetic.

## App shell

Composed in `src/App.tsx` from `Sidebar.tsx` and `TopBar.tsx`.

| Piece | Behavior |
|---|---|
| `src/components/Sidebar.tsx` | Collapsible: full 220 px ↔ 56 px icon rail with hover tooltips. State persisted in `localStorage` under `sens.sidebar`. Net-worth card shows only when expanded. |
| `src/components/TopBar.tsx` | Title/subtitle, the month control on **Dashboard and Plan**, and a **Transaction-only** Add button. |
| `src/nav.ts` | Nav config. **Overview** groups Dashboard and Plan. |
| `src/components/Brand.tsx` | Brand mark (Coin S). |

**Account creation lives on the Accounts screen**, not the top bar: `src/screens/Accounts.tsx` owns the `AddAccount` modal.

## Dashboard & Plan

Both screens share the **`month` state** in `src/App.tsx` (TopBar chevrons; persisted via `remember_month` / `dashboard_month` like before).

**Dashboard** (`src/screens/Dashboard.tsx`): below the spending breakdown, a **Plan** card summarizes budget overspend and open savings goals for the selected month when any exist. **View** navigates to Plan (`go("plan")`).

**Plan** (`src/screens/Plan.tsx`): budgets and savings goals for the selected month. Data comes from `client.getPlan`; spent and goal pace are backend-computed (the UI does not recompute `monthlyCents`). Past months are read-only. Forms: `src/modals/BudgetForm.tsx`, `src/modals/GoalForm.tsx`. Pure helpers: `src/lib/plan.ts`.

## AddAccount flow

A **two-step, provider-first** flow.

1. **Step 1:** pick a provider (branding only) or "Custom account" from a searchable logo grid.
2. **Step 2:** pick type → subtype (visual type-card picker + chips), name (pre-filled from the provider,
   editable), and opening balance.

- Only `subtype` is persisted. The type cards just filter the chips.
- Provider logos are bundled SVGs in `src/assets/logos/<key>.svg`, resolved by `src/lib/logos.ts` (`logoFor`)
  and rendered by `src/components/ProviderLogo.tsx`.
  - Real logo on a white plate; a brand-tinted monogram fallback when no logo is bundled.
  - Coverage is best-effort, not exhaustive.
- `ProviderLogo` is also used on the Accounts list rows.
- The provider catalog `src/lib/providers.ts` is generated from the Rust seed (see
  [backend.md](./backend.md#the-tauri--mock-seam)) and feeds the mock.

## Transactions screen

The "Evolved List" redesign. **Frontend-only:** no schema, migration, or command changes.
Spec: `docs/superpowers/specs/2026-06-02-transactions-screen-redesign-design.md`.

**Toolbar** (`src/screens/Transactions.tsx`)

- Live search.
- Date-range segmented control (This month / Last month / Custom / All), wired to `listTransactions` `fromDate` / `toDate`.
- Sort by date or amount.
- Compact / comfortable density toggle, persisted in `localStorage` under `sens.txn.density`.

**List**

- Date-grouped, with **sticky day headers showing the day's net subtotal**.
- Aligned monospace amount column.
- A category color dot on each glyph tile.
- Hover quick-actions: Edit / Duplicate / Delete.

**Right sidebar** has three states:

1. Empty.
2. **`TxnDetailPanel`**: single-transaction inline edit, with a balance-impact before → after line and the
   exclude-from-reporting toggle.
3. **`TxnSelectionPanel`**: adaptive multi-select summary, shown when ≥ 1 row is checked.

**Bulk actions** (re-categorize / move account / exclude / include / delete)

- Flow through **`BulkPreviewSheet`** + **`TargetPicker`**.
  - Lists affected rows with per-row Skip / Add-back, plus locked "can't change" rows.
- The sheet is gated by the Settings toggle **"Preview bulk actions"** (`bulk_action_preview`, default on).
  - When off, edits apply directly.
  - Bulk **Delete always confirms.**

**Keyboard**

| Key | Action |
|---|---|
| ↑ / ↓ | Move focus |
| E | Edit |
| ⌫ | Delete |
| ⌘A | Select all |
| Space | Toggle a row |
| Esc | Clear selection / close the panel |

**Supporting code**

- Pure logic (unit-tested): `src/lib/txnFilters.ts` (date-range + search filtering), `src/lib/txnSelection.ts` (multi-select state).
- Components: `TxnDetailPanel.tsx`, `TxnSelectionPanel.tsx`, `BulkPreviewSheet.tsx`, `TargetPicker.tsx`.
- `TxnRow.tsx` carries density, color dot, checkbox, and quick-actions.

## Itemized Add-Transaction builder

Add Transaction (`src/modals/AddTransaction.tsx`) supports an **itemized mode** for income/expense.
Data model: [transactions.md](./transactions.md#category-splits).
Spec: `docs/superpowers/specs/2026-06-06-category-splits-and-add-transaction-redesign-design.md`.

- A tap-grid category picker: each tap adds a line item.
- An Add-item control and a **live running total** reconciled against the entered amount.
- Pure builder state and validation live in `src/lib/txnBuilder.ts` (unit-tested).
- Submitting ≥ 2 items sends a `splits` array. A single category is a plain non-split transaction.
- A split row shows a **"Split · N"** pill in `TxnRow.tsx` (in place of a single category label).
- `TxnDetailPanel.tsx` shows a **read-only per-category breakdown**. Other fields stay editable;
  individual line amounts are edited through the Edit dialog.

## Reimbursement form

Add Transaction has a fourth segment, **Reimbursement**, that swaps in `src/modals/ReimbursementForm.tsx`
(own state, own Save/Cancel). Fields: amount received, note, receiving account, date/time, and an
**Applies to** picker built from `candidateExpenses` (expenses with something left, expected ones first).
Each picked expense gets an editable allocation; Save stays disabled until "Allocated X of Y" balances.

- Entry points: the segment itself, the **Record reimbursement** action on an expense row and in its
  detail panel (opens the form with that expense picked, `reimburseExpenseId`), and **Edit reimbursement**
  in a reimbursement's detail panel.
- While editing an existing transaction the Reimbursement segment is shown disabled: a reimbursement can't change type, and no other kind can become one.
- The expense form has an optional **Expecting reimbursement** toggle with an amount; it saves through
  `client.setExpectedReimbursement` after the expense is saved. If that call fails, the modal stays open
  and the retry goes through the edit path rather than creating a duplicate expense.
- Rows: expenses show a `pending` / `Reimbursed` badge (`reimbursementBadge`); the Transactions toolbar has
  an **Awaiting reimbursement** filter (all-time: it ignores the date range and pages through every expense; the Dashboard tile's View link opens it already on, via `go("transactions", { awaiting: true })`); list totals count expenses at `effectiveCents`; the Dashboard shows
  an "Awaiting reimbursement" tile.
- Helpers: `src/lib/reimbursements.ts`.

## Auto-updater (desktop only)

Plugins `tauri-plugin-updater` + `tauri-plugin-process` are registered in `src-tauri/src/lib.rs` and
granted in `src-tauri/capabilities/default.json` (`updater:default`, `process:default`).

**`tauri.conf.json`** sets:

- `bundle.createUpdaterArtifacts: true`
- the minisign **public key**
- the endpoint `https://github.com/Jmyz72/Sens/releases/latest/download/latest.json`
- Windows `installMode: "passive"`

The matching private key lives **only** in the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret.
Losing it strands installed apps (see [`RELEASING.md`](../../RELEASING.md)).

**UI logic** is `src/lib/updater.ts` (`useUpdater`, plus the pure `updatePanelCopy` / `updateProgressPercent` helpers).

- `src/App.tsx` runs **one** check ~3.5 s after launch and only toasts "Sens X is available in Settings".
- It **never downloads automatically.** The user clicks *Download & Install* in **Settings → About**
  (progress bar, then `relaunch()`).
- In a plain browser (`isTauriDesktop()` false) the panel shows "Desktop app only", and the plugin
  modules are lazy-imported so the mock/dev build never loads them.
- The app version shown in Settings is `__APP_VERSION__`, injected by `vite.config.ts` from `package.json`.

## App settings & window config

Preferences are key/value rows, read and written through `client.getSetting` / `setSetting`
(`get_setting` / `set_setting`, mirrored in the mock).

| Key | Purpose |
|---|---|
| `remember_month` + `dashboard_month` | Restore the last Dashboard month (`src/App.tsx`) |
| `bulk_action_preview` | "Preview bulk actions" toggle (default on) |
| `transaction_time_enabled` | "Record transaction times" toggle (default on; a missing key means on) |
| `owe_notice_shown` | One-time post-migration debt-reclassification notice |

Settings also hosts the theme toggle, the About/updater panel, and the type-`RESET` factory-reset "Danger zone".

**Window config:** the main window sets `dragDropEnabled: false` in `tauri.conf.json`.
This is required so HTML5 drag-to-reorder (Categories) works in the Tauri webview. **Don't remove it.**
