# Category Management & Richer Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sens categories fully user-managed (delete, reorder, move/convert, bulk archive) by removing the `is_system` concept, and ship a richer default category tree backfilled to existing users.

**Architecture:** Follow the strict layering (UI → `src/client/index.ts` → `src/client/invoke.ts` seam → `commands.rs` → `service.rs` → `repo.rs` → SQLite). Every behavior change is made in BOTH the Rust chain and the dev-only mock (`src/client/mock.ts`). Delete and reparent rely on the existing `ON DELETE RESTRICT` foreign keys as a backstop; the service adds friendly pre-checks. Defaults are seeded once on first run and backfilled to existing users via a gated Rust step (not a SQL migration, since raw SQL can't generate UUIDs).

**Tech Stack:** Tauri v2 (Rust, rusqlite/SQLite), React 19 + TypeScript + Vite, Vitest (frontend), `cargo test --lib` (backend). Native HTML5 drag-and-drop (no new dependency).

**Spec:** `docs/superpowers/specs/2026-05-31-category-management-richer-defaults-design.md`

**Commands reference (run from repo root unless noted):**
- Rust tests: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
- Rust build: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build`
- Frontend tests: `npm test`
- Frontend gate: `npm run build`

---

## File Structure

**Backend (`src-tauri/src/`):**
- `db/migrations.rs` — add `MIGRATION_004` (drop `is_system`), register in `MIGRATIONS`.
- `db/seed.rs` — remove `is_system` from inserts; add `SUBCATEGORIES`; expose `seed_categories`.
- `db/mod.rs` — add gated `backfill_defaults` step calling `seed::seed_categories`.
- `models.rs` — remove `is_system` from `Category`.
- `repo.rs` — remove `is_system` mapping/insert; add `count_children`, `count_transactions_for_category`, `delete_category`, `reorder_categories`, `set_category_parent`.
- `service.rs` — drop the system guard; add `delete_category`, `reorder_categories`, `set_category_parent`, `set_categories_archived`.
- `commands.rs` — add the four new `#[tauri::command]` wrappers.
- `lib.rs` — register the four commands; update/extend `#[cfg(test)]` tests.

**Frontend (`src/`):**
- `types.ts` — remove `isSystem` from `Category`.
- `client/index.ts` — add `deleteCategory`, `reorderCategories`, `setCategoryParent`, `setCategoriesArchived`.
- `client/mock.ts` — remove `isSystem`; mirror seed + four new command cases.
- `lib/categories.ts` — add pure helpers `reorderIds` and `moveTargets`.
- `screens/Categories.tsx` — remove System tag; add Delete, drag-reorder, move/convert, bulk-select UI.

**Docs:** `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md`.

**Tests:**
- `src-tauri/src/lib.rs` (`#[cfg(test)]`) — Rust service tests.
- `src/__tests__/mock-categories.test.ts` — extend with new mock cases.
- `src/__tests__/category-tree.test.ts` — extend with `reorderIds` / `moveTargets`.

---

## Task 1: Remove `is_system` from the backend (migration + Rust)

Removes the protected-category concept end-to-end in Rust. The DB column is dropped and all Rust code stops reading/writing it.

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (`MIGRATIONS` line 6, add `MIGRATION_004`)
- Modify: `src-tauri/src/models.rs:60-72`
- Modify: `src-tauri/src/repo.rs:200-262` (`map_category`, `insert_category`)
- Modify: `src-tauri/src/db/seed.rs:104-109` (the category INSERT)
- Modify: `src-tauri/src/service.rs:185-196` (`archive_category`)
- Modify: `src-tauri/src/lib.rs:219-227` (the `cannot_archive_system_category` test)

- [ ] **Step 1: Replace the system-category test with an archivable-category test**

In `src-tauri/src/lib.rs`, replace the whole `cannot_archive_system_category` test (lines ~219-227) with:

```rust
    #[test]
    fn seeded_categories_can_be_archived() {
        let c = open_in_memory().unwrap();
        // After dropping is_system, every seeded category is archivable.
        let cat = service::list_categories(&c, None, false).unwrap().into_iter().next().unwrap();
        let updated = service::archive_category(&c, &cat.id).unwrap();
        assert!(updated.is_archived, "seeded category should archive successfully");
    }
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib seeded_categories_can_be_archived`
Expected: FAIL — compile error, `Category` still has `is_system` and `archive_category` still rejects system rows (or the test references removed behavior). This confirms we're editing the right path.

- [ ] **Step 3: Add migration 004 to drop the column**

In `src-tauri/src/db/migrations.rs`, change line 6 to register the new migration:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004)];
```

Add this constant just below the `MIGRATIONS` line (above `MIGRATION_003`):

```rust
const MIGRATION_004: &str = r#"
ALTER TABLE categories DROP COLUMN is_system;
"#;
```

- [ ] **Step 4: Remove `is_system` from the `Category` model**

In `src-tauri/src/models.rs`, delete this line from the `Category` struct (line ~68):

```rust
    pub is_system: bool,
```

- [ ] **Step 5: Remove `is_system` from the repo mapping and insert**

In `src-tauri/src/repo.rs`, in `map_category` (line ~209) delete:

```rust
        is_system: r.get::<_, i64>("is_system")? != 0,
```

In `insert_category` (lines ~255-258), change the SQL + params to drop the `is_system` column (it now defaults via the schema; after the drop the column no longer exists):

```rust
    conn.execute(
        "INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 100, 0, ?7, ?7)",
        params![id, name, kind, emoji, color, parent_id, now],
    )
    .map_err(map_unique)?;
```

- [ ] **Step 5b: Remove `is_system` from the seed INSERT**

The seed runs *after* migrations, so it must stop referencing the dropped column. In `src-tauri/src/db/seed.rs`, change the category INSERT inside `seed()` (lines ~104-109) to drop the `is_system` column and its `1` value:

```rust
    for (name, kind, emoji, color, sort) in CATEGORIES {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO categories
               (id, name, kind, emoji, color, sort_order, is_archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            rusqlite::params![id, name, kind, emoji, color, sort, now],
        )?;
    }
```

(Task 7 later refactors this loop into a shared `seed_categories` function; this step just keeps the build green now.)

- [ ] **Step 6: Drop the system guard in `archive_category`**

In `src-tauri/src/service.rs`, replace `archive_category` (lines ~185-196) with:

```rust
pub fn archive_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    let now = now();
    let updated = repo::set_category_archived(conn, id, true, &now)?;
    if cat.parent_id.is_none() {
        repo::set_children_archived(conn, id, true, &now)?;
    }
    Ok(updated)
}
```

- [ ] **Step 7: Run the full Rust suite to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS — all tests green (the seed inserts no longer reference `is_system`; the new test archives a seeded category).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/db/seed.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "refactor: drop is_system from categories (migration 004)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove `isSystem` from the frontend (types, mock, UI)

Mirrors Task 1 on the TypeScript side so the seam stays in sync.

**Files:**
- Modify: `src/types.ts:53`
- Modify: `src/client/mock.ts:54-60` (seed), `:181` (create_category), `:185-196` (archive/restore)
- Modify: `src/screens/Categories.tsx:340` (System tag)

- [ ] **Step 1: Remove `isSystem` from the `Category` type**

In `src/types.ts`, delete the `isSystem: boolean;` line (line ~53) from the `Category` interface.

- [ ] **Step 2: Run the frontend gate to verify it fails**

Run: `npm run build`
Expected: FAIL — `tsc` errors in `mock.ts` (seed sets `isSystem`, line ~60; create_category sets `isSystem`, line ~181) and `Categories.tsx:340` (`c.isSystem`). Confirms the spots to fix.

- [ ] **Step 3: Remove `isSystem` from the mock seed and create_category**

In `src/client/mock.ts`:

In the seed map (line ~59-60), change the object literal to drop `isSystem`:

```ts
const categories: Category[] = CAT_SEED.map(([name, kind, emoji, color], i) => ({
  id: uid(), name, kind, emoji, color, parentId: null, sortOrder: i, isArchived: false, createdAt: now(), updatedAt: now(),
```

In the `create_category` case (line ~181), drop `isSystem: false,` from the new `cat` literal:

```ts
      const cat: Category = { id: uid(), name, kind, emoji: a.emoji, color: a.color ?? null, parentId: a.parentId ?? null, sortOrder: 100, isArchived: false, createdAt: now(), updatedAt: now() };
```

- [ ] **Step 4: Drop the system guard in the mock archive/restore case**

In `src/client/mock.ts`, in the `archive_category`/`restore_category` case (lines ~185-196), delete this line:

```ts
      if (archiving && c.isSystem) fail("Conflict", "System categories cannot be archived");
```

- [ ] **Step 5: Remove the System tag from the Categories screen**

In `src/screens/Categories.tsx` (line ~340), delete this fragment from the hero block:

```tsx
            {c.isSystem && <Tag tone={t.accent}>System</Tag>}
```

- [ ] **Step 6: Run the frontend gate + tests to verify they pass**

Run: `npm run build && npm test`
Expected: PASS — `tsc` clean, Vitest green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/client/mock.ts src/screens/Categories.tsx
git commit -m "refactor: drop isSystem from frontend types, mock, and UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Delete category (full stack + mock)

Hard-delete a category that has no subcategories and no transactions. FKs (`ON DELETE RESTRICT` on `categories.parent_id` and `transactions.category_id`) are the backstop; the service pre-checks give friendly errors.

**Files:**
- Modify: `src-tauri/src/repo.rs` (add `count_children`, `count_transactions_for_category`, `delete_category`)
- Modify: `src-tauri/src/service.rs` (add `delete_category`)
- Modify: `src-tauri/src/commands.rs` (add command)
- Modify: `src-tauri/src/lib.rs` (register + test)
- Modify: `src/client/index.ts` (add `deleteCategory`)
- Modify: `src/client/mock.ts` (add `delete_category` case)
- Modify: `src/__tests__/mock-categories.test.ts` (add mock test)

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/lib.rs` (`#[cfg(test)]` mod), add:

```rust
    #[test]
    fn delete_category_rules() {
        let c = open_in_memory().unwrap();
        // Unused leaf category: deletes fine.
        let unused = service::create_category(&c, "Throwaway", "expense", "🗑️", None, None).unwrap();
        service::delete_category(&c, &unused.id).unwrap();
        assert!(service::list_categories(&c, None, true).unwrap().iter().all(|x| x.id != unused.id));

        // Parent with a child: blocked.
        let parent = service::create_category(&c, "Parent X", "expense", "📦", None, None).unwrap();
        let _child = service::create_category(&c, "Child X", "expense", "📦", None, Some(&parent.id)).unwrap();
        assert!(matches!(service::delete_category(&c, &parent.id), Err(AppError::Conflict(_))));

        // Category referenced by a transaction: blocked.
        let acc = service::create_account(&c, "Acc", "cash", 0, None).unwrap();
        let used = service::create_category(&c, "Used Cat", "expense", "💳", None, None).unwrap();
        service::create_expense(&c, &acc.id, &used.id, 1000, None, "2026-05-10").unwrap();
        assert!(matches!(service::delete_category(&c, &used.id), Err(AppError::Conflict(_))));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib delete_category_rules`
Expected: FAIL — `service::delete_category` does not exist (compile error).

- [ ] **Step 3: Add repo helpers**

In `src-tauri/src/repo.rs`, after `set_children_archived` (line ~306), add:

```rust
pub fn count_children(conn: &Connection, parent_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM categories WHERE parent_id = ?1",
        [parent_id],
        |r| r.get(0),
    )?)
}

pub fn count_transactions_for_category(conn: &Connection, category_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM transactions WHERE category_id = ?1",
        [category_id],
        |r| r.get(0),
    )?)
}

pub fn delete_category(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Category not found".into()));
    }
    Ok(())
}
```

- [ ] **Step 4: Add the service function**

In `src-tauri/src/service.rs`, after `restore_category` (line ~210), add:

```rust
pub fn delete_category(conn: &Connection, id: &str) -> AppResult<()> {
    repo::get_category(conn, id)?; // NotFound if missing
    if repo::count_children(conn, id)? > 0 {
        return Err(AppError::Conflict("Remove or move its subcategories first".into()));
    }
    if repo::count_transactions_for_category(conn, id)? > 0 {
        return Err(AppError::Conflict("In use by transactions — archive it instead".into()));
    }
    repo::delete_category(conn, id)
}
```

- [ ] **Step 5: Run the Rust test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib delete_category_rules`
Expected: PASS.

- [ ] **Step 6: Add the Tauri command and register it**

In `src-tauri/src/commands.rs`, after `restore_category` (line ~94), add:

```rust
#[tauri::command]
pub fn delete_category(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => service::delete_category(&c, &id))
}
```

In `src-tauri/src/lib.rs`, add `commands::delete_category,` to the `generate_handler!` list (after `commands::restore_category,`, line ~54).

- [ ] **Step 7: Verify the backend builds**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build`
Expected: PASS — compiles, command registered.

- [ ] **Step 8: Add the client wrapper**

In `src/client/index.ts`, after `restoreCategory` (line ~42), add:

```ts
  deleteCategory: (id: string) => dispatch<void>("delete_category", { id }),
```

- [ ] **Step 9: Add the mock case + failing mock test**

In `src/__tests__/mock-categories.test.ts`, add inside the `describe` block:

```ts
  it("deletes an unused category but blocks ones with children or transactions", async () => {
    const unused = await expenseParent(`Trash-${Math.random()}`);
    await mockInvoke("delete_category", { id: unused.id });
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.some((c) => c.id === unused.id)).toBe(false);

    const parent = await expenseParent(`HasKid-${Math.random()}`);
    await mockInvoke<Category>("create_category", { name: "Kid", kind: "expense", emoji: "🧒", color: null, parentId: parent.id });
    await expect(mockInvoke("delete_category", { id: parent.id })).rejects.toMatchObject({ code: "Conflict" });

    const acc = await mockInvoke<{ id: string }>("create_account", { name: `A-${Math.random()}`, subtype: "cash", openingBalanceCents: 0, templateKey: null });
    const used = await expenseParent(`Used-${Math.random()}`);
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: used.id, amountCents: 100, description: null, date: "2026-05-10" });
    await expect(mockInvoke("delete_category", { id: used.id })).rejects.toMatchObject({ code: "Conflict" });
  });
```

Run to confirm it fails: `npx vitest run src/__tests__/mock-categories.test.ts -t "deletes an unused category"`
Expected: FAIL — `delete_category` is an unknown command in the mock.

In `src/client/mock.ts`, add a case after the `archive_category`/`restore_category` case (line ~196):

```ts
    case "delete_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      if (categories.some((x) => x.parentId === c.id)) fail("Conflict", "Remove or move its subcategories first");
      if (txns.some((t) => t.categoryId === c.id)) fail("Conflict", "In use by transactions — archive it instead");
      categories.splice(categories.indexOf(c), 1);
      return undefined as T;
    }
```

- [ ] **Step 10: Run mock test + gate to verify they pass**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/client/index.ts src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat: delete unused categories (delete_category)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Reorder categories (full stack + mock)

Persist `sort_order` for a sibling group via a batch `reorder_categories(ids)` that assigns `sort_order = index`.

**Files:**
- Modify: `src-tauri/src/repo.rs` (add `reorder_categories`)
- Modify: `src-tauri/src/service.rs` (add `reorder_categories`)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/client/index.ts`, `src/client/mock.ts`
- Modify: `src-tauri/src/lib.rs` (test), `src/__tests__/mock-categories.test.ts` (test)

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/lib.rs` (`#[cfg(test)]`), add:

```rust
    #[test]
    fn reorder_categories_sets_sort_order() {
        let c = open_in_memory().unwrap();
        let a = service::create_category(&c, "AA", "expense", "🅰️", None, None).unwrap();
        let b = service::create_category(&c, "BB", "expense", "🅱️", None, None).unwrap();
        // Put b before a.
        service::reorder_categories(&c, &[b.id.clone(), a.id.clone()]).unwrap();
        let a2 = service::list_categories(&c, None, true).unwrap().into_iter().find(|x| x.id == a.id).unwrap();
        let b2 = service::list_categories(&c, None, true).unwrap().into_iter().find(|x| x.id == b.id).unwrap();
        assert_eq!(b2.sort_order, 0);
        assert_eq!(a2.sort_order, 1);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reorder_categories_sets_sort_order`
Expected: FAIL — `service::reorder_categories` undefined.

- [ ] **Step 3: Add the repo function**

In `src-tauri/src/repo.rs`, after `delete_category`, add:

```rust
pub fn reorder_categories(conn: &Connection, ids: &[String], now: &str) -> AppResult<()> {
    for (i, id) in ids.iter().enumerate() {
        let n = conn.execute(
            "UPDATE categories SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, i as i64, now],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("Category not found".into()));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Add the service function**

In `src-tauri/src/service.rs`, after `delete_category`, add:

```rust
/// Assign sort_order = index to each id. Caller (frontend) supplies one full
/// sibling group (same parent + kind); we validate they are genuine siblings.
pub fn reorder_categories(conn: &Connection, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let first = repo::get_category(conn, &ids[0])?;
    for id in &ids[1..] {
        let cat = repo::get_category(conn, id)?;
        if cat.kind != first.kind || cat.parent_id != first.parent_id {
            return Err(AppError::Validation("Can only reorder categories within one group".into()));
        }
    }
    repo::reorder_categories(conn, ids, &now())
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reorder_categories_sets_sort_order`
Expected: PASS.

- [ ] **Step 6: Add command + register**

In `src-tauri/src/commands.rs`, after `delete_category`, add:

```rust
#[tauri::command]
pub fn reorder_categories(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<()> {
    with_conn!(state, c => service::reorder_categories(&c, &ids))
}
```

In `src-tauri/src/lib.rs`, add `commands::reorder_categories,` to `generate_handler!`.

- [ ] **Step 7: Add client wrapper + mock case + mock test**

In `src/client/index.ts`, after `deleteCategory`, add:

```ts
  reorderCategories: (ids: string[]) => dispatch<void>("reorder_categories", { ids }),
```

In `src/__tests__/mock-categories.test.ts`, add:

```ts
  it("reorder_categories assigns sort_order by index", async () => {
    const a = await expenseParent(`Ord-A-${Math.random()}`);
    const b = await expenseParent(`Ord-B-${Math.random()}`);
    await mockInvoke("reorder_categories", { ids: [b.id, a.id] });
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === b.id)!.sortOrder).toBe(0);
    expect(all.find((c) => c.id === a.id)!.sortOrder).toBe(1);
  });
```

Run to confirm fail: `npx vitest run src/__tests__/mock-categories.test.ts -t "reorder_categories assigns"`
Expected: FAIL — unknown command.

In `src/client/mock.ts`, add after the `delete_category` case:

```ts
    case "reorder_categories": {
      (a.ids as string[]).forEach((id, i) => {
        const c = categories.find((x) => x.id === id);
        if (c) { c.sortOrder = i; c.updatedAt = now(); }
      });
      return undefined as T;
    }
```

- [ ] **Step 8: Run tests + gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/client/index.ts src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat: persist category order (reorder_categories)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Move & convert categories (set_category_parent, full stack + mock)

One command reparents: move a sub to another parent, promote a sub to top-level (`parentId = null`), or demote a childless top-level into a subcategory. Invariants: new parent must be top-level and same kind; the moved category must be a leaf; sibling-name uniqueness enforced.

**Files:**
- Modify: `src-tauri/src/repo.rs` (add `set_category_parent`)
- Modify: `src-tauri/src/service.rs` (add `set_category_parent`)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/client/index.ts`, `src/client/mock.ts`
- Modify: `src-tauri/src/lib.rs` (tests), `src/__tests__/mock-categories.test.ts` (test)

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/lib.rs` (`#[cfg(test)]`), add:

```rust
    #[test]
    fn set_category_parent_move_promote_demote() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food MP", "expense", "🍔", None, None).unwrap();
        let fun = service::create_category(&c, "Fun MP", "expense", "🎮", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee MP", "expense", "☕", None, Some(&food.id)).unwrap();

        // Move sub to another parent.
        let moved = service::set_category_parent(&c, &coffee.id, Some(&fun.id)).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(fun.id.as_str()));

        // Promote sub to top-level.
        let promoted = service::set_category_parent(&c, &coffee.id, None).unwrap();
        assert_eq!(promoted.parent_id, None);
        assert_eq!(promoted.kind, "expense");

        // Demote a childless top-level under another parent.
        let demoted = service::set_category_parent(&c, &coffee.id, Some(&food.id)).unwrap();
        assert_eq!(demoted.parent_id.as_deref(), Some(food.id.as_str()));
    }

    #[test]
    fn set_category_parent_rejects_invalid() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food R", "expense", "🍔", None, None).unwrap();
        let salary = service::create_category(&c, "Salary R", "income", "💰", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee R", "expense", "☕", None, Some(&food.id)).unwrap();

        // Cross-kind move rejected.
        assert!(matches!(service::set_category_parent(&c, &coffee.id, Some(&salary.id)), Err(AppError::Validation(_))));

        // Cannot demote a parent that still has children.
        assert!(matches!(service::set_category_parent(&c, &food.id, Some(&salary.id)), Err(AppError::Validation(_))));

        // New parent must be top-level (not a subcategory).
        let snack = service::create_category(&c, "Snack R", "expense", "🍪", None, Some(&food.id)).unwrap();
        assert!(matches!(service::set_category_parent(&c, &snack.id, Some(&coffee.id)), Err(AppError::Validation(_))));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_category_parent`
Expected: FAIL — `service::set_category_parent` undefined.

- [ ] **Step 3: Add the repo function**

In `src-tauri/src/repo.rs`, after `reorder_categories`, add:

```rust
pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>, now: &str) -> AppResult<Category> {
    conn.execute(
        "UPDATE categories SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, parent_id, now],
    )
    .map_err(map_unique)?;
    get_category(conn, id)
}
```

- [ ] **Step 4: Add the service function**

In `src-tauri/src/service.rs`, after `reorder_categories`, add:

```rust
/// Reparent a category: move a leaf to another top-level parent, promote a
/// subcategory to top-level (parent_id = None), or demote a childless top-level
/// into a subcategory. Kind never changes; the new parent must be top-level and
/// share the moved category's kind.
pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    if let Some(pid) = parent_id {
        if pid == id {
            return Err(AppError::Validation("A category cannot be its own parent".into()));
        }
        let parent = repo::get_category(conn, pid)?; // NotFound if bogus
        if parent.parent_id.is_some() {
            return Err(AppError::Validation("The new parent must be a top-level category".into()));
        }
        if parent.kind != cat.kind {
            return Err(AppError::Validation("Cannot move a category to a different kind".into()));
        }
        // Demoting/moving a top-level that still has children would create a third level.
        if cat.parent_id.is_none() && repo::count_children(conn, id)? > 0 {
            return Err(AppError::Validation("Empty this category's subcategories before making it a subcategory".into()));
        }
    }
    repo::set_category_parent(conn, id, parent_id, &now())
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_category_parent`
Expected: PASS (both tests).

- [ ] **Step 6: Add command + register**

In `src-tauri/src/commands.rs`, after `reorder_categories`, add:

```rust
#[tauri::command]
pub fn set_category_parent(state: State<'_, DbState>, id: String, parent_id: Option<String>) -> AppResult<Category> {
    with_conn!(state, c => service::set_category_parent(&c, &id, parent_id.as_deref()))
}
```

In `src-tauri/src/lib.rs`, add `commands::set_category_parent,` to `generate_handler!`.

- [ ] **Step 7: Add client wrapper + mock case + mock test**

In `src/client/index.ts`, after `reorderCategories`, add:

```ts
  setCategoryParent: (id: string, parentId: string | null) =>
    dispatch<Category>("set_category_parent", { id, parentId }),
```

In `src/__tests__/mock-categories.test.ts`, add:

```ts
  it("set_category_parent moves, promotes, and rejects cross-kind", async () => {
    const food = await expenseParent(`Food-SP-${Math.random()}`);
    const fun = await expenseParent(`Fun-SP-${Math.random()}`);
    const salary = await mockInvoke<Category>("create_category", { name: `Sal-SP-${Math.random()}`, kind: "income", emoji: "💰", color: null, parentId: null });
    const coffee = await mockInvoke<Category>("create_category", { name: "Coffee SP", kind: "expense", emoji: "☕", color: null, parentId: food.id });

    const moved = await mockInvoke<Category>("set_category_parent", { id: coffee.id, parentId: fun.id });
    expect(moved.parentId).toBe(fun.id);

    const promoted = await mockInvoke<Category>("set_category_parent", { id: coffee.id, parentId: null });
    expect(promoted.parentId).toBe(null);

    await expect(mockInvoke("set_category_parent", { id: coffee.id, parentId: salary.id }))
      .rejects.toMatchObject({ code: "ValidationError" });
  });
```

Run to confirm fail: `npx vitest run src/__tests__/mock-categories.test.ts -t "set_category_parent moves"`
Expected: FAIL — unknown command.

In `src/client/mock.ts`, add after the `reorder_categories` case:

```ts
    case "set_category_parent": {
      const cat = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      const pid: string | null = a.parentId ?? null;
      if (pid != null) {
        if (pid === cat.id) fail("ValidationError", "A category cannot be its own parent");
        const parent = categories.find((x) => x.id === pid) ?? fail("NotFound", "Category not found");
        if (parent.parentId != null) fail("ValidationError", "The new parent must be a top-level category");
        if (parent.kind !== cat.kind) fail("ValidationError", "Cannot move a category to a different kind");
        if (cat.parentId == null && categories.some((x) => x.parentId === cat.id)) {
          fail("ValidationError", "Empty this category's subcategories before making it a subcategory");
        }
        // Sibling-name uniqueness under the new parent.
        if (categories.some((x) => x.id !== cat.id && x.parentId === pid && x.name === cat.name)) {
          fail("Conflict", "A category with this name already exists at this level");
        }
      } else if (categories.some((x) => x.id !== cat.id && x.parentId == null && x.kind === cat.kind && x.name === cat.name)) {
        fail("Conflict", "A category with this name already exists at this level");
      }
      cat.parentId = pid;
      cat.updatedAt = now();
      return cat as T;
    }
```

- [ ] **Step 8: Run tests + gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/client/index.ts src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat: move/promote/demote categories (set_category_parent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Bulk archive / restore (set_categories_archived, full stack + mock)

Atomically archive or restore many categories, reusing the existing child-cascade for top-level rows.

**Files:**
- Modify: `src-tauri/src/service.rs` (add `set_categories_archived`)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/client/index.ts`, `src/client/mock.ts`
- Modify: `src-tauri/src/lib.rs` (test), `src/__tests__/mock-categories.test.ts` (test)

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/lib.rs` (`#[cfg(test)]`), add:

```rust
    #[test]
    fn set_categories_archived_bulk_with_cascade() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food B", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee B", "expense", "☕", None, Some(&food.id)).unwrap();
        let fun = service::create_category(&c, "Fun B", "expense", "🎮", None, None).unwrap();

        service::set_categories_archived(&c, &[food.id.clone(), fun.id.clone()], true).unwrap();
        let all = service::list_categories(&c, None, true).unwrap();
        assert!(all.iter().find(|x| x.id == food.id).unwrap().is_archived);
        assert!(all.iter().find(|x| x.id == fun.id).unwrap().is_archived);
        // Cascade archived the child too.
        assert!(all.iter().find(|x| x.id == coffee.id).unwrap().is_archived);

        service::set_categories_archived(&c, &[food.id.clone()], false).unwrap();
        let all = service::list_categories(&c, None, true).unwrap();
        assert!(!all.iter().find(|x| x.id == coffee.id).unwrap().is_archived);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_categories_archived_bulk_with_cascade`
Expected: FAIL — `service::set_categories_archived` undefined.

- [ ] **Step 3: Add the service function (reuses archive/restore for cascade)**

In `src-tauri/src/service.rs`, after `set_category_parent`, add:

```rust
/// Bulk archive or restore. Reuses the per-id archive/restore so the top-level
/// child cascade is applied to each.
pub fn set_categories_archived(conn: &Connection, ids: &[String], archived: bool) -> AppResult<()> {
    for id in ids {
        if archived {
            archive_category(conn, id)?;
        } else {
            restore_category(conn, id)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib set_categories_archived_bulk_with_cascade`
Expected: PASS.

- [ ] **Step 5: Add command + register**

In `src-tauri/src/commands.rs`, after `set_category_parent`, add:

```rust
#[tauri::command]
pub fn set_categories_archived(state: State<'_, DbState>, ids: Vec<String>, archived: bool) -> AppResult<()> {
    with_conn!(state, c => service::set_categories_archived(&c, &ids, archived))
}
```

In `src-tauri/src/lib.rs`, add `commands::set_categories_archived,` to `generate_handler!`.

- [ ] **Step 6: Add client wrapper + mock case + mock test**

In `src/client/index.ts`, after `setCategoryParent`, add:

```ts
  setCategoriesArchived: (ids: string[], archived: boolean) =>
    dispatch<void>("set_categories_archived", { ids, archived }),
```

In `src/__tests__/mock-categories.test.ts`, add:

```ts
  it("set_categories_archived archives many with cascade", async () => {
    const food = await expenseParent(`Food-BA-${Math.random()}`);
    const coffee = await mockInvoke<Category>("create_category", { name: "Coffee BA", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    const fun = await expenseParent(`Fun-BA-${Math.random()}`);
    await mockInvoke("set_categories_archived", { ids: [food.id, fun.id], archived: true });
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === coffee.id)!.isArchived).toBe(true);
    expect(all.find((c) => c.id === fun.id)!.isArchived).toBe(true);
  });
```

Run to confirm fail: `npx vitest run src/__tests__/mock-categories.test.ts -t "set_categories_archived archives many"`
Expected: FAIL — unknown command.

In `src/client/mock.ts`, add after the `set_category_parent` case. (Note: the existing `archive_category`/`restore_category` case has the cascade; mirror it per id.)

```ts
    case "set_categories_archived": {
      const archiving = a.archived === true;
      (a.ids as string[]).forEach((id) => {
        const c = categories.find((x) => x.id === id);
        if (!c) return;
        c.isArchived = archiving;
        c.updatedAt = now();
        if (c.parentId == null) {
          categories.forEach((x) => { if (x.parentId === c.id) { x.isArchived = archiving; x.updatedAt = now(); } });
        }
      });
      return undefined as T;
    }
```

- [ ] **Step 7: Run tests + gate**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/client/index.ts src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat: bulk archive/restore categories (set_categories_archived)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Richer default tree + backfill (Rust seed + gated step + mock)

Add default subcategories (and a new `Investments` income category) as non-system rows, seeded on first run and backfilled to existing users via a gated Rust step.

**Files:**
- Modify: `src-tauri/src/db/seed.rs` (add `SUBCATEGORIES`, expose `seed_categories`)
- Modify: `src-tauri/src/db/mod.rs` (add gated `backfill_defaults`)
- Modify: `src/client/mock.ts` (mirror the tree in the seed)
- Modify: `src-tauri/src/lib.rs` (test)
- Modify: `src/__tests__/mock-categories.test.ts` (test)

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/lib.rs` (`#[cfg(test)]`), add:

```rust
    #[test]
    fn seeds_subcategories_under_food() {
        let c = open_in_memory().unwrap();
        let all = service::list_categories(&c, Some("expense"), false).unwrap();
        let food = all.iter().find(|x| x.name == "Food" && x.parent_id.is_none()).unwrap();
        let coffee = all.iter().find(|x| x.name == "Coffee" && x.parent_id.as_deref() == Some(food.id.as_str()));
        assert!(coffee.is_some(), "expected a seeded 'Coffee' subcategory under Food");
        // New income top-level.
        let inc = service::list_categories(&c, Some("income"), false).unwrap();
        assert!(inc.iter().any(|x| x.name == "Investments" && x.parent_id.is_none()), "expected seeded 'Investments' income category");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib seeds_subcategories_under_food`
Expected: FAIL — no `Coffee`/`Investments` rows are seeded yet.

- [ ] **Step 3: Add the `Investments` income category and the `SUBCATEGORIES` table to the seed**

In `src-tauri/src/db/seed.rs`, add `Investments` to the `CATEGORIES` array (in the Income block, after `Other Income`), keeping the existing `sort_order` values; give it `sort_order = 5`:

```rust
    ("Investments", "income", "\u{1F4C8}", "#3fcf8e", 5),
```

Add a new constant after the `CATEGORIES` array (after line ~91):

```rust
/// (parent_kind, parent_name, child_name, emoji, color, sort_order). Seeded as
/// non-system rows; users may archive or delete any they don't want.
const SUBCATEGORIES: &[(&str, &str, &str, &str, &str, i64)] = &[
    // Expense
    ("expense", "Food", "Dining out",        "\u{1F37D}", "#e0a13c", 0),
    ("expense", "Food", "Coffee",            "\u{2615}",  "#c08a4a", 1),
    ("expense", "Food", "Delivery/Takeaway", "\u{1F6F5}", "#d99a3c", 2),
    ("expense", "Food", "Snacks",            "\u{1F36A}", "#e3b15c", 3),
    ("expense", "Transport", "Fuel",            "\u{26FD}", "#8b7bd8", 0),
    ("expense", "Transport", "Parking & Tolls", "\u{1F17F}", "#9a8be0", 1),
    ("expense", "Transport", "Ride-hailing",    "\u{1F695}", "#7d6dd0", 2),
    ("expense", "Transport", "Public transit",  "\u{1F687}", "#a89bea", 3),
    ("expense", "Transport", "Car maintenance", "\u{1F527}", "#6f5fc0", 4),
    ("expense", "Bills", "Rent",          "\u{1F3E0}", "#56b3c4", 0),
    ("expense", "Bills", "Electricity",   "\u{1F4A1}", "#5fbecf", 1),
    ("expense", "Bills", "Water",         "\u{1F6BF}", "#4aa6b8", 2),
    ("expense", "Bills", "Internet",      "\u{1F4F6}", "#63c5d6", 3),
    ("expense", "Bills", "Mobile",        "\u{1F4F1}", "#52aebf", 4),
    ("expense", "Bills", "Subscriptions", "\u{1F4FA}", "#48a2b4", 5),
    ("expense", "Shopping", "Clothing",    "\u{1F457}", "#d9728f", 0),
    ("expense", "Shopping", "Electronics", "\u{1F50C}", "#e07f9a", 1),
    ("expense", "Shopping", "Home",        "\u{1F6CB}", "#cf6685", 2),
    ("expense", "Shopping", "Gifts",       "\u{1F381}", "#e58aa3", 3),
    ("expense", "Health", "Pharmacy",      "\u{1F48A}", "#f0708c", 0),
    ("expense", "Health", "Clinic/Doctor", "\u{1FA7A}", "#f37e98", 1),
    ("expense", "Health", "Insurance",     "\u{1F6E1}", "#e96680", 2),
    ("expense", "Health", "Fitness",       "\u{1F3CB}", "#f58aa2", 3),
    ("expense", "Entertainment", "Movies", "\u{1F3AC}", "#a78bfa", 0),
    ("expense", "Entertainment", "Games",  "\u{1F3AE}", "#b39bfb", 1),
    ("expense", "Entertainment", "Events",  "\u{1F39F}", "#9b7df9", 2),
    ("expense", "Entertainment", "Hobbies", "\u{1F3A8}", "#bfa9fc", 3),
    ("expense", "Education", "Courses", "\u{1F393}", "#5b8def", 0),
    ("expense", "Education", "Books",   "\u{1F4D6}", "#6b97f1", 1),
    ("expense", "Education", "Tuition", "\u{1F9D1}", "#4f83ed", 2),
    ("expense", "Travel", "Flights",       "\u{2708}",  "#33c9d6", 0),
    ("expense", "Travel", "Accommodation", "\u{1F3E8}", "#45d0dc", 1),
    ("expense", "Travel", "Activities",    "\u{1F3DD}", "#28bdca", 2),
    // Income
    ("income", "Salary", "Base pay",   "\u{1F4B5}", "#46d39a", 0),
    ("income", "Salary", "Overtime",   "\u{23F0}",  "#52d8a2", 1),
    ("income", "Salary", "Allowances", "\u{1F9FE}", "#3fcf8e", 2),
    ("income", "Salary", "Commission", "\u{1F4CA}", "#5bddaa", 3),
    ("income", "Freelance", "Projects",   "\u{1F4BB}", "#5aa66d", 0),
    ("income", "Freelance", "Consulting", "\u{1F4BC}", "#66b079", 1),
    ("income", "Investments", "Dividends",     "\u{1F4B9}", "#3fcf8e", 0),
    ("income", "Investments", "Interest",      "\u{1F3E6}", "#4bd699", 1),
    ("income", "Investments", "Capital gains", "\u{1F4C8}", "#37c886", 2),
];
```

- [ ] **Step 4: Refactor `seed()` to use a shared idempotent `seed_categories`**

In `src-tauri/src/db/seed.rs`, replace the category loop inside `seed()` with a call, and add a public `seed_categories` function. Change `seed()` (lines ~93-112) to:

```rust
pub fn seed(conn: &Connection, now: &str) -> AppResult<()> {
    for t in templates() {
        conn.execute(
            "INSERT OR IGNORE INTO account_templates
               (key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 1)",
            rusqlite::params![t.0, t.1, t.2, t.3, t.0, t.4],
        )?;
    }
    seed_categories(conn, now)?;
    Ok(())
}

/// Idempotent: inserts default top-level categories and subcategories via
/// INSERT OR IGNORE (deduped by the partial unique indexes). Safe to re-run;
/// used by both first-run seeding and the existing-user backfill.
pub fn seed_categories(conn: &Connection, now: &str) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    for (name, kind, emoji, color, sort) in CATEGORIES {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO categories
               (id, name, kind, emoji, color, sort_order, is_archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            rusqlite::params![id, name, kind, emoji, color, sort, now],
        )?;
    }
    for (parent_kind, parent_name, child_name, emoji, color, sort) in SUBCATEGORIES {
        let parent_id: Option<String> = conn
            .query_row(
                "SELECT id FROM categories WHERE kind = ?1 AND name = ?2 AND parent_id IS NULL",
                rusqlite::params![parent_kind, parent_name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(pid) = parent_id {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT OR IGNORE INTO categories
                   (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
                rusqlite::params![id, child_name, parent_kind, emoji, color, pid, sort, now],
            )?;
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Add the gated backfill step in `db/mod.rs`**

In `src-tauri/src/db/mod.rs`, add a constant near `FIRST_RUN_KEY` (line ~12):

```rust
const DEFAULTS_V2_KEY: &str = "defaults_v2_seeded";
```

In `open` (after `seed_once(&conn)?;`, line ~20) and in `open_in_memory` (after `seed_once(&conn)?;`, line ~30), add:

```rust
    backfill_defaults(&conn)?;
```

Add the function below `seed_once` (after line ~62):

```rust
/// Backfill the richer default category tree for existing users. Gated by its
/// own flag so it runs once; INSERT OR IGNORE means it never duplicates rows a
/// fresh install already has, and never resurrects a default the user deleted
/// after this has run.
fn backfill_defaults(conn: &Connection) -> AppResult<()> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = ?1)",
            [DEFAULTS_V2_KEY],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if done {
        return Ok(());
    }
    let now = crate::now();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        seed::seed_categories(conn, &now)?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2)",
            rusqlite::params![DEFAULTS_V2_KEY, now],
        )?;
        Ok(())
    })();
    match res {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}
```

- [ ] **Step 6: Run the Rust test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS — including `seeds_subcategories_under_food` and the existing `seeds_templates_and_categories`.

- [ ] **Step 7: Commit the backend seed work**

```bash
git add src-tauri/src/db/seed.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "feat: seed richer default category tree + backfill existing users

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Mirror the tree in the mock seed + add a mock test**

In `src/__tests__/mock-categories.test.ts`, add:

```ts
  it("mock seeds Coffee under Food and an Investments income category", async () => {
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: false });
    const food = all.find((c) => c.name === "Food" && c.parentId == null)!;
    expect(all.some((c) => c.name === "Coffee" && c.parentId === food.id)).toBe(true);
    expect(all.some((c) => c.name === "Investments" && c.kind === "income" && c.parentId == null)).toBe(true);
  });
```

Run to confirm fail: `npx vitest run src/__tests__/mock-categories.test.ts -t "mock seeds Coffee"`
Expected: FAIL — the mock seed has no subcategories or `Investments`.

In `src/client/mock.ts`, add `Investments` to `CAT_SEED` (in the income block, line ~55):

```ts
  ["Investments", "income", "📈", "#3fcf8e"],
```

After the `categories` array is built (after line ~61, where the `CAT_SEED.map(...)` assignment ends), add a subcategory seed that mirrors `SUBCATEGORIES`:

```ts
const SUB_SEED: [string, Category["kind"], string, string, string][] = [
  ["Food", "expense", "Dining out", "🍽️", "#e0a13c"], ["Food", "expense", "Coffee", "☕", "#c08a4a"], ["Food", "expense", "Delivery/Takeaway", "🛵", "#d99a3c"], ["Food", "expense", "Snacks", "🍪", "#e3b15c"],
  ["Transport", "expense", "Fuel", "⛽", "#8b7bd8"], ["Transport", "expense", "Parking & Tolls", "🅿️", "#9a8be0"], ["Transport", "expense", "Ride-hailing", "🚕", "#7d6dd0"], ["Transport", "expense", "Public transit", "🚇", "#a89bea"], ["Transport", "expense", "Car maintenance", "🔧", "#6f5fc0"],
  ["Bills", "expense", "Rent", "🏠", "#56b3c4"], ["Bills", "expense", "Electricity", "💡", "#5fbecf"], ["Bills", "expense", "Water", "🚿", "#4aa6b8"], ["Bills", "expense", "Internet", "📶", "#63c5d6"], ["Bills", "expense", "Mobile", "📱", "#52aebf"], ["Bills", "expense", "Subscriptions", "📺", "#48a2b4"],
  ["Shopping", "expense", "Clothing", "👗", "#d9728f"], ["Shopping", "expense", "Electronics", "🔌", "#e07f9a"], ["Shopping", "expense", "Home", "🛋️", "#cf6685"], ["Shopping", "expense", "Gifts", "🎁", "#e58aa3"],
  ["Health", "expense", "Pharmacy", "💊", "#f0708c"], ["Health", "expense", "Clinic/Doctor", "🩺", "#f37e98"], ["Health", "expense", "Insurance", "🛡️", "#e96680"], ["Health", "expense", "Fitness", "🏋️", "#f58aa2"],
  ["Entertainment", "expense", "Movies", "🎬", "#a78bfa"], ["Entertainment", "expense", "Games", "🎮", "#b39bfb"], ["Entertainment", "expense", "Events", "🎟️", "#9b7df9"], ["Entertainment", "expense", "Hobbies", "🎨", "#bfa9fc"],
  ["Education", "expense", "Courses", "🎓", "#5b8def"], ["Education", "expense", "Books", "📖", "#6b97f1"], ["Education", "expense", "Tuition", "🧑", "#4f83ed"],
  ["Travel", "expense", "Flights", "✈️", "#33c9d6"], ["Travel", "expense", "Accommodation", "🏨", "#45d0dc"], ["Travel", "expense", "Activities", "🏝️", "#28bdca"],
  ["Salary", "income", "Base pay", "💵", "#46d39a"], ["Salary", "income", "Overtime", "⏰", "#52d8a2"], ["Salary", "income", "Allowances", "🧾", "#3fcf8e"], ["Salary", "income", "Commission", "📊", "#5bddaa"],
  ["Freelance", "income", "Projects", "💻", "#5aa66d"], ["Freelance", "income", "Consulting", "💼", "#66b079"],
  ["Investments", "income", "Dividends", "💹", "#3fcf8e"], ["Investments", "income", "Interest", "🏦", "#4bd699"], ["Investments", "income", "Capital gains", "📈", "#37c886"],
];
SUB_SEED.forEach(([parentName, kind, childName, emoji, color], i) => {
  const parent = categories.find((c) => c.name === parentName && c.kind === kind && c.parentId == null);
  if (parent) {
    categories.push({ id: uid(), name: childName, kind, emoji, color, parentId: parent.id, sortOrder: i, isArchived: false, createdAt: now(), updatedAt: now() });
  }
});
```

- [ ] **Step 9: Run frontend tests + gate to verify they pass**

Run: `npm test && npm run build`
Expected: PASS — the seed + tree mock tests are green.

- [ ] **Step 10: Commit the mock seed work**

```bash
git add src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat: mirror richer default category tree in the mock backend

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Pure helpers for reorder + move targets (lib/categories.ts)

Extract the drag-reorder index math and the valid-move-target computation into tested pure functions so the UI tasks stay thin.

**Files:**
- Modify: `src/lib/categories.ts`
- Modify: `src/__tests__/category-tree.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/__tests__/category-tree.test.ts`, add at the top-level (adjust the import to include the new helpers):

```ts
import { reorderIds, moveTargets } from "../lib/categories";
import type { Category } from "../types";

function cat(partial: Partial<Category> & { id: string }): Category {
  return { id: partial.id, name: partial.name ?? partial.id, kind: partial.kind ?? "expense", emoji: "x", color: null, parentId: partial.parentId ?? null, sortOrder: partial.sortOrder ?? 0, isArchived: partial.isArchived ?? false, createdAt: "", updatedAt: "" };
}

describe("reorderIds", () => {
  it("moves an item from one index to another", () => {
    expect(reorderIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderIds(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns the same order when from === to", () => {
    expect(reorderIds(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("moveTargets", () => {
  const food = cat({ id: "food", name: "Food", kind: "expense" });
  const fun = cat({ id: "fun", name: "Fun", kind: "expense" });
  const salary = cat({ id: "salary", name: "Salary", kind: "income" });
  const coffee = cat({ id: "coffee", name: "Coffee", kind: "expense", parentId: "food" });
  const all = [food, fun, salary, coffee];

  it("for a subcategory: same-kind top-level parents excluding the current one", () => {
    const targets = moveTargets(all, coffee).map((c) => c.id);
    expect(targets).toContain("fun");
    expect(targets).not.toContain("food"); // current parent
    expect(targets).not.toContain("salary"); // different kind
  });
  it("for a childless top-level: same-kind top-level parents excluding itself", () => {
    const targets = moveTargets(all, fun).map((c) => c.id);
    expect(targets).toContain("food");
    expect(targets).not.toContain("fun");
    expect(targets).not.toContain("salary");
  });
  it("for a top-level WITH children: returns empty (must empty it first)", () => {
    expect(moveTargets(all, food)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/category-tree.test.ts -t "reorderIds"`
Expected: FAIL — `reorderIds` / `moveTargets` not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/categories.ts`, append:

```ts
/** Return `ids` with the item at `from` moved to index `to`. */
export function reorderIds(ids: string[], from: number, to: number): string[] {
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Valid top-level parents a category may be moved under: same kind, top-level,
 *  not itself, not its current parent. A top-level that still has children
 *  cannot be moved (would create a third level), so it returns []. */
export function moveTargets(cats: Category[], category: Category): Category[] {
  const hasChildren = cats.some((c) => c.parentId === category.id);
  if (category.parentId == null && hasChildren) return [];
  return cats.filter(
    (c) =>
      c.parentId == null &&
      c.kind === category.kind &&
      c.id !== category.id &&
      c.id !== category.parentId,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/category-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/categories.ts src/__tests__/category-tree.test.ts
git commit -m "feat: add reorderIds + moveTargets category helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Categories screen — Delete action

Add a Delete button to the detail hero and to each subcategory row, wired to `client.deleteCategory`. Errors surface via the existing toast.

**Files:**
- Modify: `src/screens/Categories.tsx`

- [ ] **Step 1: Add a delete handler in the `Categories` component**

In `src/screens/Categories.tsx`, after the `restore` function (line ~212), add:

```tsx
  async function del(c: Category) {
    try { await client.deleteCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to delete category", "error"); }
  }
```

- [ ] **Step 2: Pass delete callbacks into `CategoryDetail`**

In the `CategoryDetail` JSX usage (line ~286-295), add two props:

```tsx
          <CategoryDetail
            node={selectedNode}
            onEdit={() => setEditing(selectedNode.category)}
            onArchive={() => archive(selectedNode.category)}
            onRestore={() => restore(selectedNode.category)}
            onDelete={() => del(selectedNode.category)}
            onAddSub={() => setAddingSubTo(selectedNode.category)}
            onEditChild={(child) => setEditing(child)}
            onArchiveChild={(child) => archive(child)}
            onRestoreChild={(child) => restore(child)}
            onDeleteChild={(child) => del(child)}
          />
```

- [ ] **Step 3: Extend the `CategoryDetail` props + render Delete buttons**

In `src/screens/Categories.tsx`, update the `CategoryDetail` function signature/props type (line ~317-328) to add `onDelete` and `onDeleteChild`:

```tsx
function CategoryDetail({
  node, onEdit, onArchive, onRestore, onDelete, onAddSub, onEditChild, onArchiveChild, onRestoreChild, onDeleteChild,
}: {
  node: CategoryNode;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onAddSub: () => void;
  onEditChild: (c: Category) => void;
  onArchiveChild: (c: Category) => void;
  onRestoreChild: (c: Category) => void;
  onDeleteChild: (c: Category) => void;
}) {
```

In the hero action row (line ~347-353), add a Delete button after the archive/restore button. It is enabled only when the category has no children (transaction-use is enforced by the backend and reported via toast):

```tsx
        <div style={{ display: "flex", gap: 4 }}>
          <Btn variant="outline" size="sm" icon="pencil" onClick={onEdit}>Edit</Btn>
          {c.isArchived
            ? <Btn variant="outline" size="sm" icon="restore" onClick={onRestore}>Restore</Btn>
            : <Btn variant="outline" size="sm" icon="archive" onClick={onArchive}>Archive</Btn>}
          {node.children.length === 0 && (
            <Btn variant="outline" size="sm" icon="trash" onClick={onDelete}>Delete</Btn>
          )}
        </div>
```

In each subcategory row's action group (line ~375-380), add a Delete button:

```tsx
                <div style={{ display: "flex", gap: 4 }}>
                  <Btn variant="outline" size="sm" icon="pencil" onClick={() => onEditChild(child)}>Edit</Btn>
                  {child.isArchived
                    ? <Btn variant="outline" size="sm" icon="restore" onClick={() => onRestoreChild(child)}>Restore</Btn>
                    : <Btn variant="outline" size="sm" icon="archive" onClick={() => onArchiveChild(child)}>Archive</Btn>}
                  <Btn variant="outline" size="sm" icon="trash" onClick={() => onDeleteChild(child)}>Delete</Btn>
                </div>
```

- [ ] **Step 4: Confirm `trash` is a valid icon name**

Run: `grep -n "trash\|\"archive\"\|IconName" src/components/Icon.tsx | head`
Expected: a `trash` entry exists. If it does NOT, use `"archive"` as the icon for Delete instead (do not invent an icon name), e.g. `icon="archive"`.

- [ ] **Step 5: Run the gate to verify it builds**

Run: `npm run build`
Expected: PASS — `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat: delete categories from the Categories screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Categories screen — drag-and-drop reorder

Make the left-rail top-level rows (within their kind group) and the detail subcategory rows draggable; on drop, persist with `client.reorderCategories`.

**Files:**
- Modify: `src/screens/Categories.tsx`

- [ ] **Step 1: Add a reusable drag hook/handlers in `Categories.tsx`**

In `src/screens/Categories.tsx`, inside the `Categories` component, add drag state and a commit helper (after the existing `useState` hooks, ~line 180):

```tsx
  const [dragId, setDragId] = useState<string | null>(null);

  async function commitReorder(siblings: Category[], fromId: string, toId: string) {
    const ids = siblings.map((c) => c.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = reorderIds(ids, from, to);
    try { await client.reorderCategories(next); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to reorder", "error"); }
  }
```

Add `reorderIds` to the import from `../lib/categories` (line ~16):

```tsx
import { categoryTree, reorderIds, type CategoryNode } from "../lib/categories";
```

- [ ] **Step 2: Make left-rail top-level rows draggable**

In the left-rail `nodes.map((node) => …)` block (line ~256-276), add drag props to the row `<button>`. The siblings for a top-level row are the `nodes` of that kind group (the `nodes` in scope):

```tsx
                    <button key={c.id} className="sens-row" onClick={() => setSelectedId(c.id)}
                      draggable
                      onDragStart={() => setDragId(c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragId) commitReorder(nodes.map((n) => n.category), dragId, c.id); setDragId(null); }}
                      style={{
```

(Keep the rest of the existing `style` object and children unchanged.)

- [ ] **Step 3: Make subcategory rows draggable**

The subcategory list lives in `CategoryDetail`. Pass an `onReorderChildren` callback from `Categories` into `CategoryDetail`:

In the `CategoryDetail` usage (Task 9 Step 2 block), add:

```tsx
            onReorderChildren={(fromId, toId) => commitReorder(selectedNode.children, fromId, toId)}
```

In `CategoryDetail`'s props type, add:

```tsx
  onReorderChildren: (fromId: string, toId: string) => void;
```

`CategoryDetail` needs local drag state — add at the top of the function body (after `const c = node.category;`, ~line 330):

```tsx
  const [dragChild, setDragChild] = useState<string | null>(null);
```

And add `useState` to the React import at the top of the file if not already imported there (it is imported at line 6). Then add drag props to each subcategory row `<div>` (line ~367-369):

```tsx
              <div key={child.id} className="sens-row"
                draggable
                onDragStart={() => setDragChild(child.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragChild) onReorderChildren(dragChild, child.id); setDragChild(null); }}
                style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 10px",
                  border: `0.5px solid ${t.border}`, borderRadius: 9, opacity: child.isArchived ? 0.55 : 1 }}>
```

- [ ] **Step 4: Run the gate to verify it builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manually verify in the browser**

Run: `npm run dev`, open the Categories screen, drag a top-level category within its kind group and a subcategory within its parent. Confirm order persists after the drop (the list re-sorts).

- [ ] **Step 6: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat: drag-and-drop reordering on the Categories screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Categories screen — move & convert UI

Add a "Move to…" modal that lets a subcategory move to another same-kind parent or become top-level, and lets a childless top-level become a subcategory.

**Files:**
- Modify: `src/screens/Categories.tsx`

- [ ] **Step 1: Add `moveTargets` to imports and a `moving` state**

In `src/screens/Categories.tsx`, extend the categories import (line ~16):

```tsx
import { categoryTree, reorderIds, moveTargets, type CategoryNode } from "../lib/categories";
```

Add state in the `Categories` component (near the other modal state, ~line 180):

```tsx
  const [moving, setMoving] = useState<Category | null>(null);
```

- [ ] **Step 2: Add a `MoveCategoryModal` component**

In `src/screens/Categories.tsx`, add this component near `CategoryForm` (e.g., after it, ~line 167):

```tsx
function MoveCategoryModal({ category, all, onClose, onDone }: {
  category: Category;
  all: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const targets = moveTargets(all, category);
  const isSub = category.parentId != null;

  async function move(parentId: string | null) {
    setBusy(true);
    try { await client.setCategoryParent(category.id, parentId); onDone(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to move category", "error"); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={360}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 15, fontWeight: 700 }}>
        Move “{category.name}”
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {isSub && (
          <Btn variant="outline" size="md" disabled={busy} onClick={() => move(null)}>
            Make top-level category
          </Btn>
        )}
        {targets.length === 0 && !isSub && (
          <div style={{ fontSize: 12.5, color: t.faint }}>
            No eligible destination. Empty this category’s subcategories first, or add another top-level category of the same kind.
          </div>
        )}
        {targets.map((p) => (
          <Btn key={p.id} variant="outline" size="md" disabled={busy} onClick={() => move(p.id)}>
            <GlyphTile tone={p.color ?? t.accent} size={20} emoji={p.emoji} radius={6} /> Under {p.name}
          </Btn>
        ))}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Add a "Move" button to the detail hero and subcategory rows**

In `CategoryDetail`, add an `onMove` and `onMoveChild` prop (extend the props type and destructuring like Task 9):

```tsx
  onMove: () => void;
  onMoveChild: (c: Category) => void;
```

In the hero action row, add (after Edit):

```tsx
          <Btn variant="outline" size="sm" icon="swap" onClick={onMove}>Move</Btn>
```

In each subcategory row's action group, add (after Edit):

```tsx
                  <Btn variant="outline" size="sm" icon="swap" onClick={() => onMoveChild(child)}>Move</Btn>
```

Wire them in the `CategoryDetail` usage:

```tsx
            onMove={() => setMoving(selectedNode.category)}
            onMoveChild={(child) => setMoving(child)}
```

- [ ] **Step 4: Render the modal**

In the MODALS block of `Categories` (line ~301-310), add:

```tsx
      {moving && (
        <MoveCategoryModal category={moving} all={all} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />
      )}
```

- [ ] **Step 5: Run the gate to verify it builds**

Run: `npm run build`
Expected: PASS. (If `swap` is not a valid icon name per `src/components/Icon.tsx`, use `"pencil"` or another existing name — verify with `grep -n swap src/components/Icon.tsx`.)

- [ ] **Step 6: Manually verify in the browser**

Run: `npm run dev`, Categories screen → Move a subcategory under a different expense parent, promote it to top-level, and confirm a childless top-level can become a subcategory.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat: move and convert categories from the Categories screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Categories screen — bulk archive/restore selection

Add a selection mode to the left rail with checkboxes and an action bar (Archive / Restore selected), wired to `client.setCategoriesArchived`.

**Files:**
- Modify: `src/screens/Categories.tsx`

- [ ] **Step 1: Add selection state + handlers**

In `src/screens/Categories.tsx`, in the `Categories` component, add (near the other state, ~line 180):

```tsx
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function bulkArchive(archived: boolean) {
    if (selected.size === 0) return;
    try {
      await client.setCategoriesArchived([...selected], archived);
      setSelected(new Set());
      setSelectMode(false);
      await reload();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Bulk action failed", "error");
    }
  }
```

- [ ] **Step 2: Add a Select toggle + action bar to the summary card**

In the summary `Card` (line ~227-242), add a "Select" toggle next to "New", and an action bar shown in select mode:

```tsx
          <div style={{ display: "flex", gap: 6 }}>
            <Btn variant="outline" size="md" onClick={() => { setSelectMode((s) => !s); setSelected(new Set()); }}>
              {selectMode ? "Done" : "Select"}
            </Btn>
            <Btn variant="primary" icon="plus" size="md" onClick={() => setCreating("expense")}>New</Btn>
          </div>
```

Below the existing `hasArchived` block (line ~235-241), add:

```tsx
          {selectMode && (
            <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
              <Btn variant="outline" size="sm" icon="archive" disabled={selected.size === 0} onClick={() => bulkArchive(true)}>
                Archive ({selected.size})
              </Btn>
              <Btn variant="outline" size="sm" icon="restore" disabled={selected.size === 0} onClick={() => bulkArchive(false)}>
                Restore
              </Btn>
            </div>
          )}
```

(Replace the single `<Btn variant="primary" icon="plus" …>New</Btn>` at line ~233 with the two-button `<div>` above.)

- [ ] **Step 3: Render checkboxes on left-rail rows in select mode**

In the left-rail row `<button>` (line ~260-274), prepend a checkbox shown in select mode. Wrap the existing row content so clicking the checkbox toggles selection instead of selecting the detail. Change the row's `onClick`:

```tsx
                    <button key={c.id} className="sens-row" onClick={() => selectMode ? toggleSelected(c.id) : setSelectedId(c.id)}
```

And add, as the first child inside the button (before `<GlyphTile …>`):

```tsx
                      {selectMode && (
                        <span style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${selected.has(c.id) ? t.accent : t.border}`, background: selected.has(c.id) ? t.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {selected.has(c.id) && <Icon name="check" size={11} color={t.onAccent} />}
                        </span>
                      )}
```

- [ ] **Step 4: Confirm the `check` icon exists**

Run: `grep -n '"check"\|check:' src/components/Icon.tsx | head`
Expected: a `check` entry. If absent, use an existing affirmative icon name (verify in `Icon.tsx`) rather than inventing one.

- [ ] **Step 5: Run the gate to verify it builds**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Manually verify in the browser**

Run: `npm run dev`, Categories screen → click Select, tick several top-level categories, click Archive (N), confirm they archive (and children cascade); toggle Show archived, Select, Restore.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat: bulk archive/restore selection on the Categories screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Documentation

Update project docs to match the new behavior, per the always-update-documentation convention.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`:
- In the backend conventions / seeding section, **remove** the clause "**system categories cannot be archived**" and the statement that default categories are seeded as system. Replace with: "Default categories and subcategories seed once on first run and are backfilled to existing users via a gated step (`defaults_v2_seeded`); all defaults are normal (non-system) rows users can archive or delete."
- In the Subcategories (v0.4.0) paragraph, append a sentence: "v0.4.1 made categories fully user-managed — Delete (any category with no subcategories and no transactions; FK `ON DELETE RESTRICT` is the backstop), drag-to-reorder (`reorder_categories`), move/convert via `set_category_parent` (new parent must be top-level and same kind; the moved category must be a leaf), and bulk archive/restore (`set_categories_archived`). The `is_system` flag was dropped (migration 004)."

- [ ] **Step 2: Update CHANGELOG.md**

In `CHANGELOG.md`, under `## [Unreleased]`, add an `### Added` and `### Changed` entry above the existing content:

```markdown
### Added
- **Delete categories**: any category or subcategory with no subcategories and no
  transactions can now be permanently deleted; categories still referenced by
  transactions can be archived instead.
- **Reorder** top-level categories and subcategories by drag-and-drop.
- **Move & convert** categories: move a subcategory to another parent, promote a
  subcategory to top-level, or demote a childless top-level into a subcategory.
- **Bulk archive/restore** multiple categories at once via a selection mode.
- **Richer default categories**: a two-level starter tree (subcategories under Food,
  Transport, Bills, Shopping, Health, Entertainment, Education, Travel, Salary,
  Freelance, and a new Investments income category). Existing users are backfilled
  these defaults once; any you delete won't come back.

### Changed
- Categories are now fully user-managed: the `is_system` flag was removed, so every
  category can be edited, archived, or deleted.
```

- [ ] **Step 3: Update ROADMAP.md**

In `ROADMAP.md`:
- Update the header line: change **Last shipped** to `v0.4.1` once released; for now add a `v0.4.1` row to the shipped table:

```markdown
| 🟢 `v0.4.1` | Category management (delete, reorder, move/convert, bulk archive) + richer default tree; dropped the system-category flag |
```

- Add a note in the conventions or in-progress area: "`v0.4.1` is a deliberately feature-weight patch — a tight follow-up to the v0.4.0 subcategories work rather than a new phase; spec: `docs/superpowers/specs/2026-05-31-category-management-richer-defaults-design.md`."

- [ ] **Step 4: Verify gates still pass**

Run: `npm run build && npm test && cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS (docs-only change; everything stays green).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs: document v0.4.1 category management & richer defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run every gate one last time**

```bash
npm run build && npm test
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib && cargo build
```
Expected: all PASS.

- [ ] **Smoke-test the desktop app**

Run: `npm run tauri dev`. On the Categories screen: create/delete a category, reorder, move/convert, bulk-archive. Confirm an existing DB (if present) gains the new default subcategories once (backfill), and that deleting a default doesn't bring it back on next launch.

---

## Notes for the implementer

- **Seam rule:** every command exists in BOTH the Rust chain and `src/client/mock.ts`. Tasks 3–6 already pair them; never land one without the other.
- **Error shape:** Rust `AppError` serializes to `{code, message}` with codes `ValidationError | NotFound | Conflict | DatabaseError`; the mock throws the same shape (`fail("ValidationError" | "Conflict" | "NotFound", msg)`). Match these exactly so the UI's toast handling is consistent.
- **Tauri arg casing:** command params are sent camelCase from JS and map to snake_case Rust params automatically (e.g. `{ parentId }` → `parent_id: Option<String>`). Mirror the existing `list_categories` pattern.
- **Icons:** Tasks 9/11/12 use `trash`, `swap`, `check`. Each step verifies the icon exists in `src/components/Icon.tsx`; if one is missing, substitute an existing name rather than inventing one (no new SVGs needed for this release).
- **Backfill safety:** `backfill_defaults` is gated by `defaults_v2_seeded` and uses `INSERT OR IGNORE`, so it never duplicates rows and never resurrects a default the user deleted after it ran once.
```
