# Sens v0.4.1 — Category management & richer defaults

**Status:** Approved design · **Date:** 2026-05-31 · **Target release:** `v0.4.1`
**Builds on:** v0.4.0 subcategories
(`docs/superpowers/specs/2026-05-31-categories-subcategories-redesign-design.md`)

## Summary

v0.4.0 introduced a two-level category hierarchy and a master–detail Categories
screen. v0.4.1 turns categories into fully user-managed objects and ships a useful
starter tree:

1. **Remove the `is_system` concept** — every category is editable, archivable, and
   deletable.
2. **Delete** — hard-delete any category/subcategory not referenced by a transaction.
3. **Reorder** — drag to set `sort_order` within a sibling group.
4. **Move & convert** — reparent a subcategory, promote a sub to top-level, or demote
   a childless top-level into a subcategory.
5. **Bulk archive / restore** — multi-select on the Categories screen.
6. **Richer default tree** — expanded defaults (top-level + subcategories), backfilled
   to existing users.

### Versioning note

This is feature-weight work for a patch. By the `ROADMAP.md` convention ("minor
carries feature releases, patch carries fixes/follow-ups") it could be a minor. We
ship it as **`v0.4.1`** deliberately, as a follow-up tightly coupled to the v0.4.0
subcategories work. `ROADMAP.md` records the bend. The `v0.5.0` credit/debt phase is
unaffected.

## Principles

- **Strict layering preserved** (UI → client → invoke seam → commands → service →
  repo → SQLite). The mock (`src/client/mock.ts`) mirrors every behavior change.
- **The database FKs are the backstop, the service gives the friendly error.**
  Both relevant foreign keys are already `ON DELETE RESTRICT`:
  - `transactions.category_id REFERENCES categories(id) ON DELETE RESTRICT`
  - `categories.parent_id REFERENCES categories(id) ON DELETE RESTRICT`
  So "can't delete a category with transactions" and "can't delete a parent with
  children" are enforced at the DB even if a service check is missed; the service
  pre-checks exist to return a clear `Conflict` message instead of a raw FK error.
- **Money/balance engine untouched** — this is a categories-only change.

---

## 1. Remove the `is_system` concept

`is_system` is removed end-to-end. There is no longer any protected category; the
"system categories cannot be archived" rule is deleted.

**Backend**
- **Migration 004:** `ALTER TABLE categories DROP COLUMN is_system;`
  - SQLite supports `DROP COLUMN`; each migration runs in its own transaction, as the
    existing runner does. Appended to `MIGRATIONS` as `(4, MIGRATION_004)` — never edit
    a shipped migration.
  - Fallback if `DROP COLUMN` is rejected in this SQLite build: keep the column,
    `UPDATE categories SET is_system = 0`, and stop reading it. (Prefer the drop.)
- Remove `is_system` from `models.rs` (`Category` struct), `repo.rs` row mapping, and
  the seed inserts (no more `is_system = 1`).
- Delete the guard in `service.rs` (the `if cat.is_system { … }` block, ~`service.rs:187`).
- Update the Rust test at ~`lib.rs:222–224` that asserts a seeded category is a system
  category — rewrite it against the new "no system flag" behavior.

**Mock**
- Remove `isSystem` from the seeded category shape and the
  `if (archiving && c.isSystem) fail("Conflict", …)` guard (~`mock.ts:189`).

**Frontend**
- Remove `isSystem` from `Category` in `src/types.ts`.
- Remove the `System` `<Tag>` in `Categories.tsx` (~line 340) and the `!c.isSystem`
  conditions gating the Archive/Restore buttons (archive/restore now always available
  where valid).

---

## 2. Delete action

New command **`delete_category(id)`** through the full chain.

**Service rules** (pre-check for friendly errors; FKs are the backstop):
1. Load the category; `NotFound` if missing.
2. If it is top-level and **has any subcategories** (archived or active) →
   `Conflict`: *"Remove or move its subcategories first."*
3. If it (parent or sub) is **referenced by any transaction** →
   `Conflict`: *"In use by transactions — archive it instead."*
4. Otherwise hard-delete the row.

**Repo**
- `count_children(parent_id) -> i64`
- `count_transactions_for_category(id) -> i64`
- `delete_category(id)` — `DELETE FROM categories WHERE id = ?`.

**Mock** — mirror the same three checks and the delete.

**Client** — `deleteCategory(id)` wrapper dispatching `delete_category`.

**Archive vs Delete** — both are kept:
- **Delete**: permanent removal, only when unused (no transactions, no children).
- **Archive**: hides a category that *is* referenced and so cannot be deleted; the
  existing child-cascade archive/restore (`set_children_archived`) is unchanged.
- The UI shows whichever actions are valid for a given row (see §8).

---

## 3. Reorder (drag-and-drop)

Persist `sort_order` so ordering within a sibling group is user-controlled.

**Command** — `reorder_categories(ids: string[])`:
- The `ids` are the full, reordered list of a **single sibling group** (same
  `parent_id` and same `kind`).
- In one transaction, set `sort_order = index` for each id in order.
- Service validates the ids exist and are genuine siblings (same parent, same kind);
  `ValidationError` otherwise.

**Repo** — batch update of `sort_order` by id within one transaction.

**Mock** — mirror: reassign `sortOrder` by index for the given ids.

**Frontend** — native HTML5 drag-and-drop (`draggable`, `onDragStart/Over/Drop`),
**no new dependency**:
- Reorder top-level categories within their kind group in the left rail.
- Reorder subcategories within the detail pane's list.
- On drop, send the reordered sibling id list to `reorder_categories`, then `reload()`.
- Drag is constrained to a sibling group (can't drag a category into another kind or
  under a different parent via drag — that's §4's explicit Move).

`categoryTree` / `bySort` in `src/lib/categories.ts` already sort by
`isArchived, sortOrder, name`; with user-set `sort_order` this now reflects the chosen
order.

---

## 4. Move & convert (reparenting)

One command **`set_category_parent(id, parentId | null)`** covers move, promote, and
demote:

- **Move** a subcategory to a different parent → `parentId = <other top-level id>`.
- **Promote** a subcategory to top-level → `parentId = null`.
- **Demote** a childless top-level into a subcategory → `parentId = <top-level id>`.

**Invariants** (service-enforced, mirrored in mock):
- The **new parent must be top-level** (`parent_id IS NULL`) — no three-level nesting.
- The **new parent must share the moved category's `kind`** — kind is never silently
  changed; cross-kind moves are rejected (`ValidationError`).
- The **moved category must be a leaf** — a top-level that still has subcategories
  cannot be demoted/moved (empty it first). `Conflict` otherwise.
- **Sibling-name uniqueness** is re-checked; a collision under the new parent →
  `Conflict`. (The partial unique indexes `idx_categories_top_kind_name` and
  `idx_categories_sub_parent_name` enforce this at the DB.)
- Promoting to top-level keeps the category's existing `kind`.

**Repo** — `set_category_parent(id, parent_id, now)` updating `parent_id` +
`updated_at`.

**Mock** — mirror all invariants and the update.

**Client** — `setCategoryParent(id, parentId)`.

**Frontend** — in the detail pane: a "Move to…" action for a subcategory (pick another
top-level of the same kind, or "Make top-level"), and a "Make subcategory of…" action
for a childless top-level. A small picker modal listing valid same-kind targets.

---

## 5. Bulk archive / restore

**Command** — `set_categories_archived(ids: string[], archived: bool)`:
- Atomic (one transaction); applies the existing child-cascade per id (archiving a
  top-level cascades to its children, as today).
- Unknown ids → `NotFound`.

**Repo** — loop the ids, reusing `set_children_archived` semantics, in one transaction.

**Mock** — mirror, including cascade.

**Client** — `setCategoriesArchived(ids, archived)`.

**Frontend** — a selection mode on the Categories screen: checkboxes on left-rail rows
and a compact action bar (Archive / Restore; Delete only when *every* selected row is
delete-eligible). Selection clears on `reload()`.

---

## 6. Richer default tree (+ backfill)

Expand the defaults to a two-level starter tree. **All new rows are non-system /
archivable suggestions** — users can archive or delete any they don't want.

### Source of truth
- Rust constants in `src-tauri/src/db/seed.rs`: existing `CATEGORIES` (top-level) plus
  a new `SUBCATEGORIES` list of `(parent_kind, parent_name, child_name, emoji, color,
  sort_order)`.
- `src/client/mock.ts` mirrors both so browser-dev matches the packaged app.

### Backfill mechanism (existing users)
Raw-SQL migrations can't easily generate UUIDs, so the backfill is a **gated Rust
step**, not a SQL migration:
- A startup step (alongside `seed_once`), gated by its own `app_settings` flag (e.g.
  `defaults_v2_seeded`).
- Runs `INSERT OR IGNORE` for the full tree using Rust-generated UUIDs:
  - top-level rows dedup via `idx_categories_top_kind_name` on `(kind, name) WHERE
    parent_id IS NULL`;
  - subcategory rows look up their parent by `(kind, name) WHERE parent_id IS NULL`,
    then insert deduped via `idx_categories_sub_parent_name` on `(parent_id, name)`.
- Fresh installs receive the tree through the normal first-run `seed()`; the flag
  prevents the backfill re-running, so **a default a user later deletes never
  resurrects**.
- If a default parent name was archived (not deleted), its row still exists, so
  `INSERT OR IGNORE` finds it and attaches the new children to it; the children are
  inserted active (the user can archive them).

### Proposed default subcategory tree (data — refine names/emoji in implementation)

**Expense**
- **Food:** Dining out · Coffee · Delivery/Takeaway · Snacks
- **Transport:** Fuel · Parking & Tolls · Ride-hailing · Public transit · Car maintenance
- **Bills:** Rent · Electricity · Water · Internet · Mobile · Subscriptions
- **Shopping:** Clothing · Electronics · Home · Gifts
- **Health:** Pharmacy · Clinic/Doctor · Insurance · Fitness
- **Entertainment:** Movies · Games · Events · Hobbies
- **Education:** Courses · Books · Tuition
- **Travel:** Flights · Accommodation · Activities
- *(Groceries, Other Expense: no subcategories.)*

**Income**
- **Salary:** Base pay · Overtime · Allowances · Commission
- **Freelance:** Projects · Consulting
- **Investments** *(new top-level income category)*: Dividends · Interest · Capital gains
- *(Bonus, Gift, Other Income: no subcategories.)*

**Transfer** — no subcategories.

---

## 7. Documentation

Per project convention, land alongside the code:
- **`CLAUDE.md`** — remove the "system categories cannot be archived" statement;
  document Delete, reorder (drag), move/convert (reparenting), bulk archive, and the
  gated default-tree backfill. Note that all defaults are now non-system.
- **`CHANGELOG.md`** — roll the `[Unreleased]` section for v0.4.1.
- **`ROADMAP.md`** — add the `v0.4.1` row, noting the deliberate feature-weight-in-a-
  patch bend; link this spec.
- This spec lives at
  `docs/superpowers/specs/2026-05-31-category-management-richer-defaults-design.md`.

---

## 8. UI surface (Categories screen)

The master–detail layout (`src/screens/Categories.tsx`) gains:
- **Per-row actions** reflect validity: Edit always; Archive/Restore where applicable;
  **Delete** only when the category has no transactions (and, for a top-level, no
  subcategories).
- **Drag handles** for reordering within a sibling group (left-rail top-levels; detail
  subcategories).
- **Move/convert** affordances in the detail pane (§4).
- **Selection mode** with checkboxes + a bulk action bar (§5).
- The `System` tag is gone.

All actions surface errors via the existing toast (page-level) or inline form error,
matching the `AppError` `{code, message}` shape.

---

## 9. Out of scope

- No third level of nesting (two-level limit preserved).
- No change to the dashboard spending roll-up (`GROUP BY COALESCE(parent_id, id)`).
- No change to transaction category references or money/balance logic.
- No new dependency for drag-and-drop (native HTML5 DnD).

---

## 10. New backend surface (summary)

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `delete_category` | `id` | `()` | Hard-delete an unused category (§2) |
| `reorder_categories` | `ids: string[]` | `()` | Persist sibling order (§3) |
| `set_category_parent` | `id`, `parentId \| null` | `Category` | Move/promote/demote (§4) |
| `set_categories_archived` | `ids: string[]`, `archived` | `()` | Bulk archive/restore (§5) |

Each is registered in `lib.rs`, added to `commands.rs` (thin), implemented in
`service.rs` (rules) + `repo.rs` (SQL), mirrored in `mock.ts`, and wrapped in
`src/client/index.ts`.
