# Categories action menu, default reorder, and factory reset — design

Date: 2026-06-01
Status: Approved (ready for implementation plan)

## Summary

Three independent changes:

1. **Categories detail pane** — collapse the per-category and per-subcategory
   action buttons (Edit / Move / Archive / Delete) into a single reusable "⋯"
   dropdown menu. Delete is now **always shown** but **disabled when the
   category has subcategories**, with a **static tooltip** explaining why.
2. **Default category order** — make "Other Income" sort **last** in the Income
   group by default (seed-data change only).
3. **Settings → factory reset** — a new "Danger zone" card that wipes the
   database back to a fresh-install state and reseeds defaults, guarded by a
   type-`RESET`-to-confirm modal.

No data-model/migration changes. The reset reuses the existing seed path.

## 1. Categories detail-panel action menu

### Current state
`src/screens/Categories.tsx` → `CategoryDetail` renders a row of `Btn`s on the
hero (Edit · Move · Archive/Restore · Delete) and a matching row on each
subcategory. **Delete only renders when the category has no children.**

### New behavior
- A new reusable **`ActionMenu`** atom (anchored popover, modeled on the
  existing `EmojiPicker` pattern: click a trigger to open, click-outside / Esc
  to close, positioned relative to an anchor ref). It takes a list of items:
  `{ label, icon?, onSelect, disabled?, tooltip?, tone? }`.
- The hero's button row becomes a single **"⋯" trigger** opening an `ActionMenu`
  with: **Edit**, **Move**, **Archive/Restore**, **Delete**.
- Each subcategory row's button cluster becomes the same "⋯" menu with: Edit,
  Move, Archive/Restore, Delete.
- **Delete is always present** in the menu (top-level and subcategory).
  - **Disabled when the category has subcategories** (`node.children.length > 0`
    for top-level; subcategories are leaves so never blocked by children).
  - When disabled, the menu item shows a **static tooltip** via the native
    `title` attribute: *"Archive instead — categories with subcategories or
    linked transactions can't be deleted."*
  - When enabled, selecting it opens the existing delete-confirm `Modal`.
- **Backstop unchanged:** a leaf category still referenced by transactions is not
  pre-disabled (the screen does not load usage counts); the delete attempt fails
  into the existing error toast (`del()` already catches and notifies).

### Notes
- No backend change. No new query. The only client-side blocker is the known
  child count.
- Delete keeps its `danger` tone styling within the menu.

## 2. "Other Income" last by default

Seed-data only. In `src-tauri/src/db/seed.rs` the Income block currently is:

```
Salary 0, Bonus 1, Freelance 2, Gift 3, Other Income 4, Investments 5
```

Change to put Other Income last:

```
Salary 0, Bonus 1, Freelance 2, Gift 3, Investments 4, Other Income 5
```

Mirror the same reorder in the `mock.ts` seed category list so browser-dev
matches the packaged app.

This affects fresh installs and the post-reset state ("as default"). Existing
databases are untouched — `INSERT OR IGNORE` never rewrites an existing row's
`sort_order`.

## 3. Settings → factory reset

### Backend
- New thin command `reset_app(state)` in `commands.rs`, registered in
  `lib.rs` `generate_handler!`.
- New service fn `service::reset_to_defaults(conn)`. All in **one transaction**:
  1. `DELETE FROM transactions`
  2. `DELETE FROM categories WHERE parent_id IS NOT NULL` (children first)
  3. `DELETE FROM categories`
  4. `DELETE FROM accounts`
  5. `DELETE FROM app_settings`
  6. `seed::seed(conn, now)` — templates are `INSERT OR IGNORE`; reseeds default
     categories + subcategories (with the new order from change #2).
  7. Re-insert the `seeded` and `defaults_v2_seeded` flags into `app_settings`.

  Delete order respects the `ON DELETE RESTRICT` FKs (transactions reference
  accounts + categories; categories self-reference via `parent_id`).
- A `cargo test --lib` test: seed a DB with an account + transaction + a custom
  category, call `reset_to_defaults`, assert accounts/transactions are empty and
  the default category set is back.

### Client seam
- `client/index.ts`: `resetApp(): Promise<void>` wrapping the command.
- `client/mock.ts`: `resetApp()` resets the in-memory arrays to their seeded
  initial state (accounts/transactions cleared, categories/templates reseeded),
  mirroring the Rust behavior.

### Frontend (Settings.tsx)
- New **"Danger zone"** `Card` at the bottom: a `SettingRow` describing the
  action plus a red (`variant="danger"`) "Reset app to defaults" button.
- Clicking opens a confirm `Modal`:
  - Warning copy: permanently deletes all accounts, transactions, and
    categories and restores defaults; cannot be undone.
  - A text input; the destructive button stays **disabled until the user types
    `RESET`** (exact match).
- On confirm:
  1. `await client.resetApp()`.
  2. Clear client-only preferences: theme → dark (reset if currently light) and
     remove the sidebar localStorage key (`sens.sidebar`).
  3. `reload()` from `useAppData` so every screen refetches (`version` bump).
  4. Success toast; close modal.
- Reset local `remember_month` UI state to its default (off) since
  `app_settings` was wiped.

### Surfaces touched
- `src-tauri/src/commands.rs`, `src-tauri/src/service.rs`,
  `src-tauri/src/lib.rs` (+ test)
- `src-tauri/src/db/seed.rs`
- `src/client/index.ts`, `src/client/mock.ts`
- `src/components/ui.tsx` or a new `src/components/ActionMenu.tsx`
- `src/screens/Categories.tsx`, `src/screens/Settings.tsx`

## Out of scope
- Per-category transaction usage counts / dynamic delete reasons.
- Undo / export-before-reset.
- Any migration or schema change.

## Verification
- `npm run build` clean (strict TS).
- `npm test` and `cargo test --lib` green (incl. new reset test).
- Manual (browser mock via `npm run dev`): action menu opens/closes; Delete
  disabled-with-tooltip on a parent, enabled on a leaf; factory reset wipes data
  and reseeds with Other Income last.

## Docs to update on completion
- `CHANGELOG.md` `[Unreleased]`.
- `CLAUDE.md` Categories section (menu + always-visible Delete) and a note on the
  reset command in the backend-conventions / commands area.
