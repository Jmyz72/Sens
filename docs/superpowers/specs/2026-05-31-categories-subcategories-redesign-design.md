# Categories: Subcategories + Screen Redesign (v1.2.x)

**Status:** Approved design — ready for implementation plan
**Date:** 2026-05-31
**Author:** Brainstormed with Claude Code

## Summary

Add **two-level subcategory** support to Sens's category system and rebuild the
Categories screen as a **master–detail** layout (macOS System Settings style).
Subcategories are ordinary categories that point at a top-level parent via a new
nullable `parent_id`. Transactions may be logged against **either** a parent or a
subcategory — no migration of existing data. The Dashboard spending breakdown
**rolls subcategory spend up into the parent**.

This is classification + presentation only. Per-subcategory budgets, drag-reorder,
reparenting, arbitrary nesting, and dashboard drill-down are explicitly deferred.

## Motivation

Today `categories` is a flat table scoped by `kind` (income/expense/transfer). Users
want finer granularity (e.g. **Food → Groceries / Dining Out / Coffee**) without
losing the high-level rollups on the Dashboard. The current single-list screen also
doesn't scale visually once a kind has many categories.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Hierarchy depth | **Two levels** (parent → child); a child cannot have children |
| Transaction assignment | A txn may sit on the **parent OR any subcategory**; existing txns unchanged |
| Subcategory styling | Subcategories have their **own emoji + color** (a category like any other) |
| Dashboard breakdown | **Roll up** subcategory spend into the parent bar |
| Archiving a parent | **Cascade** — archive/restore children with the parent |
| Screen layout | **Master–detail** (left rail of parents by kind, right detail pane) |
| Reparenting / moving | **Out of scope** for v1 (no `parentId` edits) |

## Data Model

### Schema change — Migration 003 (append-only)

Add one nullable self-referential column to `categories`:

```sql
ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT;
```

Replace the single global uniqueness index with **two partial indexes** (SQLite treats
`NULL`s as distinct, so one index cannot enforce uniqueness across both levels):

```sql
DROP INDEX idx_categories_kind_name;
CREATE UNIQUE INDEX idx_categories_top_kind_name
  ON categories(kind, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX idx_categories_sub_parent_name
  ON categories(parent_id, name) WHERE parent_id IS NOT NULL;
```

Semantics:
- `parent_id IS NULL` → **top-level** category; `parent_id` set → **subcategory**.
- Top-level names are unique per `(kind, name)`. Subcategory names are unique within a
  parent `(parent_id, name)`. So "Coffee" may exist under both "Food" and "Work", but
  not twice under "Food".

> Note: like the existing taxonomy work, the in-transaction migration runner cannot do
> a full table rebuild, so `parent_id` is an `ADD COLUMN` with a `REFERENCES` clause for
> documentation; the **two-level + same-kind** invariants are enforced in the **service
> layer**, not by DB constraints. `ON DELETE RESTRICT` matches the existing FK posture.

### Invariants (enforced in `service.rs`, mirrored in `mock.ts`)

1. **Parent must be top-level.** A new/edited subcategory's `parent_id` must reference a
   category whose own `parent_id IS NULL`. This caps depth at two.
2. **Kind must match parent.** A subcategory's `kind` equals its parent's `kind`. The
   create command derives the kind from the parent when `parentId` is supplied (the
   passed `kind`, if any, must agree).
3. **Sibling-name uniqueness** as above (also defended by the partial indexes).
4. **System parents** may receive user-created subcategories; those children are normal
   non-system categories. System categories themselves remain non-archivable.

## Backend (Rust + mock in lockstep)

`src/client/mock.ts` mirrors every rule below; both change together.

### Types

`Category` gains `parentId: string | null`.

```rust
// models.rs
pub parent_id: Option<String>,  // serialized as parentId
```
```ts
// types.ts
parentId: string | null;
```

`UpdateCategoryInput` is **unchanged** — `parentId` is not editable in v1.

### Commands / services

- `create_category(name, kind, emoji, color, parentId?)`
  - If `parentId` is `Some`: load parent → assert exists, assert `parent.parent_id IS NULL`
    (Conflict/Validation otherwise), set child `kind = parent.kind`, validate sibling-name
    uniqueness, insert with `parent_id`.
  - If `parentId` is `None`: behave as today (top-level), validate `(kind, name)` uniqueness.
- `update_category(input)` — unchanged fields (name/emoji/color/sortOrder). Renames revalidate
  uniqueness against the correct sibling scope.
- `archive_category(id)` — if the target is a **top-level** category, archive it **and all its
  children** in one transaction. System categories still rejected. `restore_category(id)`
  restores the parent **and all of its currently-archived children** in one transaction.
  (v1 simplification: a child that was archived independently before its parent is also
  restored when the parent is restored — we do not track *why* a child was archived.)
- `list_categories(kind?, include_archived)` — unchanged shape; rows now include `parentId`.
  Frontend builds the tree.

### Repository

- `insert_category` gains a `parent_id` argument.
- `set_category_archived` gains a cascade path (or a sibling `set_children_archived(parent_id,
  archived)` called within the same transaction).
- `spending_breakdown` rolls up to the parent:

```sql
SELECT COALESCE(c.parent_id, c.id) AS group_id,
       pc.name, pc.emoji, pc.color,
       SUM(t.amount_cents) AS total
FROM transactions t
JOIN categories c  ON c.id = t.category_id
JOIN categories pc ON pc.id = COALESCE(c.parent_id, c.id)   -- label with the parent
WHERE t.kind = 'expense' AND t.transaction_date >= ?1 AND t.transaction_date < ?2
GROUP BY group_id
ORDER BY total DESC;
```

Transactions logged directly on a parent contribute to the same parent bucket.

## Frontend

### Categories screen — master–detail (`src/screens/Categories.tsx`)

Rebuilt into two panes (all colors via `useTheme()` tokens):

- **Left rail.** Kind sections (Income / Expense / Transfer). Each lists **top-level**
  categories: emoji tile, name, and a subcategory count. Selecting one sets the detail
  target. A "+ New" toolbar button creates a new top-level category; a "Show archived"
  toggle reveals archived items (dimmed, with Restore).
- **Right detail pane.** The selected parent's hero (large emoji tile, name, kind, this-month
  total), then a **Subcategories** list — each row editable (emoji/color/name), with a dashed
  "+ Add subcategory" affordance that opens the category form pre-bound to this parent and kind.
  Editing the parent reuses the existing inline form/modal.
- **Archived parents** show their cascaded archived children; restoring the parent restores them.

The category form (currently inline in `Categories.tsx`) gains an optional `parent` context:
when present, the kind toggle is hidden (inherited) and the form creates a subcategory.

### Transaction picker (`src/modals/AddTransaction.tsx`)

The category `<select>` becomes **grouped**: each top-level category is selectable, with its
subcategories listed indented beneath it (native `<optgroup>`-style indentation). Selecting a
parent or a leaf both produce a valid `categoryId`. Transfer/adjustment paths unchanged
(no category).

### Helpers

- A small tree/group helper (e.g. in `src/store.ts` or `src/lib/categories.ts`) that turns the
  flat `Category[]` into `{ parent, children }[]` grouped by kind, used by both the screen and
  the picker. Unit-tested.

## Testing

- **Rust (`cargo test --lib`):** parent-must-be-top-level rejection; kind-derived-from-parent;
  sibling-name uniqueness at both levels; cascade archive + restore; breakdown rollup
  (parent-direct + sub spend land in one bucket).
- **Vitest:** mock mirrors all of the above; tree/group helper; grouped picker renders parents
  with indented children and yields the right `categoryId`.
- `npm run build` stays clean (strict TS, no unused).
- Mock and Rust kept in lockstep (seam invariant).

## Out of Scope (clean follow-ups)

Arbitrary nesting · drag-to-reorder · reparenting/moving a category · leaf-only enforcement ·
per-subcategory budgets · expandable Dashboard drill-down.

## Documentation

- Update `CLAUDE.md` (category section: note `parent_id`, two-level rule, rollup, cascade).
- Roll `CHANGELOG.md` `[Unreleased]`.
- This spec is the authoritative reference for the data-model/business-rule change.
