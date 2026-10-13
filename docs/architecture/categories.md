# Categories

Two-level hierarchy, user-managed categories, protected system categories, and the Categories screen.
Read this before changing category rules, defaults, or the category picker.

**Key files:** `src-tauri/src/service.rs` · `src/screens/Categories.tsx` · `src/lib/categories.ts` ·
`src/modals/AddTransaction.tsx` · `src/components/{EmojiPicker,ActionMenu}.tsx`

> ⚠ Behavior changes go in the Rust chain **and** `mock.ts`. Default-tree seeding rules live in [backend.md](./backend.md#default-categories-and-backfill).

## Contents

- [Subcategories](#subcategories)
- [User-managed categories](#user-managed-categories)
- [System categories](#system-categories)
- [Categories screen](#categories-screen)

## Subcategories

`categories.parent_id` (nullable self-FK, migration 003) gives a **two-level** hierarchy.

- A top-level category (`parent_id IS NULL`) may have subcategories. **A subcategory cannot.**
- A subcategory **inherits its parent's `kind`**.
- Both invariants (parent must be top-level; child kind = parent kind) are enforced in the
  **service layer** (`create_category`) and mirrored in `mock.ts`. There are no DB constraints for them.
- Uniqueness is **per sibling**, through two partial indexes:
  - `idx_categories_top_kind_name` on `(kind, name) WHERE parent_id IS NULL`
  - `idx_categories_sub_parent_name` on `(parent_id, name) WHERE parent_id IS NOT NULL`
- Transactions may reference a **parent or a subcategory** (no data migration was needed).
- Archiving a top-level category **cascades** archive/restore to its children (`set_children_archived`).
- The Dashboard spending breakdown **rolls subcategory spend up into the parent**
  (`GROUP BY COALESCE(parent_id, id)`, self-joined to label with the parent).

## User-managed categories

| Action | Command | Rule |
|---|---|---|
| Delete | `delete_category` | Only a category with **no subcategories and no transactions**. FK `ON DELETE RESTRICT` is the backstop. The delete-guard also counts split references. |
| Reorder | `reorder_categories` | Drag-to-reorder. |
| Move / convert | `set_category_parent` | New parent must be top-level and the same kind. The moved category must be a leaf. |
| Bulk archive / restore | `set_categories_archived` | Applies to a selection. |

## System categories

The `is_system` flag was dropped by migration 004 and **reintroduced by migration 008** for one narrow purpose.

- Two protected **"Adjustment"** categories: one `income`, one `expense`, emoji ⚖️, `is_system = 1`.
- Used **exclusively** by income/expense balance corrections (see
  [transactions.md](./transactions.md#balance-correction)).
- Backfilled to existing users through the `defaults_v4_seeded` gate
  (`INSERT OR IGNORE` plus a promote `UPDATE`, so a pre-existing plain "Adjustment" is adopted).

System categories **cannot** be:

- deleted, renamed, archived, reparented, or reordered
- hand-assigned to transactions (`ensure_not_system` + `validate_category_for` guard)

They are **hidden** from the Categories screen and the transaction category picker
(`categoryTree` filters `isSystem`).

They **still count in dashboard reporting**, because correction rows are ordinary income/expense.

## Categories screen

`src/screens/Categories.tsx` is a **master–detail** layout.

- The detail (subcategories) pane is **sticky** and viewport-capped, with its own scroll and a
  pinned hero, so it follows the screen as the category list scrolls.
- The transaction picker (`src/modals/AddTransaction.tsx`) groups subcategories indented under
  their parent through `categoryPickerItems` / `categoryTree` in `src/lib/categories.ts`.
- Per-category and per-subcategory actions (archive, move, delete, …) live in a reusable
  **`ActionMenu`** ("⋯") popover (`src/components/ActionMenu.tsx`).
  - Delete is always shown, but renders **disabled with an explanatory tooltip** when a top-level
    category still has subcategories.
- The category form's emoji field uses a searchable popover, **`EmojiPicker`**
  (`src/components/EmojiPicker.tsx`, logic in `src/lib/emoji.ts`).
  - Backed by a committed, lazy-loaded catalog: `src/assets/emoji-data.json`.
  - Regenerate with `scripts/gen-emoji.mjs`.
  - `emojibase-data` is a **dev-only** dependency (keyword tags). The runtime ships no emoji dependency.
