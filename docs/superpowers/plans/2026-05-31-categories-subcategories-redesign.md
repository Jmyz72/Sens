# Categories: Subcategories + Screen Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-level subcategory support (a nullable `parent_id` on `categories`) and rebuild the Categories screen as a macOS-style master–detail layout, keeping the Tauri/Rust backend and the in-memory mock in lockstep.

**Architecture:** A subcategory is an ordinary category row whose `parent_id` points at a top-level category (a category with `parent_id IS NULL`). Two invariants — *parent must be top-level* and *child kind = parent kind* — are enforced in the service layer (Rust) and mirrored in `mock.ts`. Transactions may reference a parent **or** a subcategory (no data migration). The Dashboard spending breakdown rolls subcategory spend up into the parent via `COALESCE(parent_id, id)`. Archiving a top-level category cascades to its children.

**Tech Stack:** Tauri v2 (Rust, rusqlite/SQLite) backend; React 19 + TypeScript + Vite frontend; Vitest + `cargo test` for tests.

**Spec:** `docs/superpowers/specs/2026-05-31-categories-subcategories-redesign-design.md`

**Conventions:**
- Rust commands need `export PATH="$HOME/.cargo/bin:$PATH"` prefixed.
- Frontend gate: `npm run build` (strict TS, `noUnusedLocals`/`noUnusedParameters`).
- Backend tests: `cd src-tauri && cargo test --lib`.
- Any change to a command's behavior must be made in **both** the Rust chain and `src/client/mock.ts`.

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/db/migrations.rs` | Add `MIGRATION_003`; register in `MIGRATIONS` |
| `src-tauri/src/db/mod.rs` | Add migration-003 test |
| `src-tauri/src/models.rs` | `Category.parent_id: Option<String>` |
| `src-tauri/src/repo.rs` | `insert_category` + `parent_id`; `set_children_archived`; `spending_breakdown` rollup |
| `src-tauri/src/service.rs` | `create_category` + `parent_id` validation; cascade `archive_category`/`restore_category` |
| `src-tauri/src/commands.rs` | `create_category` gains `parent_id` arg |
| `src-tauri/src/lib.rs` | New service tests; fix existing `create_category` call sites |
| `src/types.ts` | `Category.parentId: string \| null` |
| `src/client/index.ts` | `createCategory` gains `parentId?` |
| `src/client/mock.ts` | seed `parentId`; create/archive/restore/breakdown parity |
| `src/lib/categories.ts` | **New** — `categoryTree` + `categoryPickerItems` helpers |
| `src/__tests__/mock-categories.test.ts` | **New** — mock parity tests |
| `src/__tests__/category-tree.test.ts` | **New** — helper tests |
| `src/screens/Categories.tsx` | Rebuilt master–detail screen + subcategory-aware form |
| `src/modals/AddTransaction.tsx` | Grouped (indented) category picker |
| `CLAUDE.md`, `CHANGELOG.md` | Docs |

---

## Task 1: Migration 003 — `parent_id` column + partial indexes

Plumb the new column end-to-end on the Rust side so everything compiles, with `parent_id` always `NULL` (no new behavior yet). Behavior comes in Tasks 2–4.

**Files:**
- Modify: `src-tauri/src/db/migrations.rs:6` (MIGRATIONS list) and add `MIGRATION_003`
- Modify: `src-tauri/src/models.rs:58-71` (Category struct)
- Modify: `src-tauri/src/repo.rs:200-213` (map_category), `src-tauri/src/repo.rs:244-260` (insert_category)
- Modify: `src-tauri/src/service.rs:139-144` (create_category caller)
- Test: `src-tauri/src/db/mod.rs` (migration_tests mod)

- [ ] **Step 1: Write the failing migration test**

In `src-tauri/src/db/mod.rs`, inside `mod migration_tests { ... }` (after the existing `migration_002_*` test, before the closing `}` at line 140), add:

```rust
    #[test]
    fn migration_003_adds_parent_id_and_partial_indexes() {
        let conn = super::open_in_memory().unwrap();
        // parent_id column exists on categories
        let has_parent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('categories') WHERE name = 'parent_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_parent, 1, "categories.parent_id should exist");

        let idx = |name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(idx("idx_categories_top_kind_name"), 1, "top-level partial index");
        assert_eq!(idx("idx_categories_sub_parent_name"), 1, "sibling partial index");
        assert_eq!(idx("idx_categories_kind_name"), 0, "old global index should be dropped");
    }
```

- [ ] **Step 2: Run it and watch it fail to compile/fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib migration_003`
Expected: FAIL — either a compile error (Category has no `parent_id`) once later steps are partial, or the assertions fail because migration 003 doesn't exist yet. (If you write the test first and nothing else, it fails on the missing indexes.)

- [ ] **Step 3: Add MIGRATION_003 and register it**

In `src-tauri/src/db/migrations.rs`, change line 6 from:

```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002)];
```
to:
```rust
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003)];
```

Then add this constant just below that line (above `const MIGRATION_002`):

```rust
const MIGRATION_003: &str = r#"
ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT;

DROP INDEX idx_categories_kind_name;

CREATE UNIQUE INDEX idx_categories_top_kind_name
  ON categories(kind, name) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX idx_categories_sub_parent_name
  ON categories(parent_id, name) WHERE parent_id IS NOT NULL;
"#;
```

- [ ] **Step 4: Add `parent_id` to the `Category` struct**

In `src-tauri/src/models.rs`, in the `Category` struct (lines 58-71), add the field right after `pub color: Option<String>,` (line 65):

```rust
    pub color: Option<String>,
    pub parent_id: Option<String>,
```

- [ ] **Step 5: Read `parent_id` in `map_category`**

In `src-tauri/src/repo.rs`, in `map_category` (lines 200-213), add after `color: r.get("color")?,` (line 205):

```rust
        color: r.get("color")?,
        parent_id: r.get("parent_id")?,
```

- [ ] **Step 6: Plumb `parent_id` through `insert_category` (always NULL for now)**

In `src-tauri/src/repo.rs`, replace `insert_category` (lines 244-260) with:

```rust
pub fn insert_category(
    conn: &Connection,
    id: &str,
    name: &str,
    kind: &str,
    emoji: &str,
    color: Option<&str>,
    parent_id: Option<&str>,
    now: &str,
) -> AppResult<Category> {
    conn.execute(
        "INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_system, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 100, 0, 0, ?7, ?7)",
        params![id, name, kind, emoji, color, parent_id, now],
    )
    .map_err(map_unique)?;
    get_category(conn, id)
}
```

Then update the single caller in `src-tauri/src/service.rs` (`create_category`, line 143) from:

```rust
    repo::insert_category(conn, &new_id(), &name, kind, &emoji, color, &now())
```
to:
```rust
    repo::insert_category(conn, &new_id(), &name, kind, &emoji, color, None, &now())
```

- [ ] **Step 7: Run the migration test + full backend suite**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS — `migration_003_adds_parent_id_and_partial_indexes` passes and all pre-existing tests still pass (the seed still inserts 17 top-level categories; the new top-level partial index is equivalent for them).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/mod.rs src-tauri/src/models.rs src-tauri/src/repo.rs src-tauri/src/service.rs
git commit -m "feat(categories): migration 003 adds parent_id + partial indexes"
```

---

## Task 2: `create_category` accepts a parent (service validation)

**Files:**
- Modify: `src-tauri/src/service.rs:139-144` (create_category)
- Modify: `src-tauri/src/commands.rs:76-79` (create_category command)
- Modify: `src-tauri/src/lib.rs` (existing call site at line 233; add new tests)

- [ ] **Step 1: Fix the existing call site so the suite still compiles**

In `src-tauri/src/lib.rs`, the test `list_categories_can_include_archived` calls `create_category` with 5 args (line ~233):

```rust
        let cat = service::create_category(&c, "Old Food", "expense", "🍔", None).unwrap();
```
Change it to pass the new trailing `parent_id` argument:
```rust
        let cat = service::create_category(&c, "Old Food", "expense", "🍔", None, None).unwrap();
```

(Search the whole file for any other `create_category(` call and append `, None` to each so they pass a top-level parent.)

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/lib.rs`, inside `mod tests { ... }`, add these tests (after `list_categories_can_include_archived`):

```rust
    #[test]
    fn subcategory_inherits_parent_kind() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P2", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "income", "☕", None, Some(&food.id)).unwrap();
        // kind is derived from the parent, not the passed-in "income"
        assert_eq!(coffee.kind, "expense");
        assert_eq!(coffee.parent_id.as_deref(), Some(food.id.as_str()));
    }

    #[test]
    fn cannot_nest_subcategory_under_a_subcategory() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P3", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        let nested = service::create_category(&c, "Latte", "expense", "🥛", None, Some(&coffee.id));
        assert!(nested.is_err(), "two-level cap: cannot nest under a subcategory");
    }

    #[test]
    fn subcategory_names_unique_within_parent_only() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P4", "expense", "🍔", None, None).unwrap();
        let work = service::create_category(&c, "Work P4", "expense", "💼", None, None).unwrap();
        service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        // same name under a DIFFERENT parent is allowed
        service::create_category(&c, "Coffee", "expense", "☕", None, Some(&work.id)).unwrap();
        // duplicate under the SAME parent is rejected
        let dupe = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id));
        assert!(dupe.is_err(), "duplicate sibling name should conflict");
    }
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib subcategory`
Expected: FAIL — `create_category` doesn't accept a 6th argument yet (compile error).

- [ ] **Step 4: Implement parent validation in the service**

In `src-tauri/src/service.rs`, replace `create_category` (lines 139-144) with:

```rust
pub fn create_category(
    conn: &Connection,
    name: &str,
    kind: &str,
    emoji: &str,
    color: Option<&str>,
    parent_id: Option<&str>,
) -> AppResult<Category> {
    let name = require_nonempty("Category name", name)?;
    let emoji = require_nonempty("Emoji", emoji)?;
    // A subcategory inherits its parent's kind; a top-level category validates its own.
    let effective_kind = match parent_id {
        Some(pid) => {
            let parent = repo::get_category(conn, pid)?; // NotFound if bogus
            if parent.parent_id.is_some() {
                return Err(AppError::Validation(
                    "Subcategories can only be nested one level deep".into(),
                ));
            }
            parent.kind
        }
        None => {
            validate_category_kind(kind)?;
            kind.to_string()
        }
    };
    repo::insert_category(conn, &new_id(), &name, &effective_kind, &emoji, color, parent_id, &now())
}
```

- [ ] **Step 5: Add `parent_id` to the command**

In `src-tauri/src/commands.rs`, replace the `create_category` command (lines 76-79) with:

```rust
#[tauri::command]
pub fn create_category(state: State<'_, DbState>, name: String, kind: String, emoji: String, color: Option<String>, parent_id: Option<String>) -> AppResult<Category> {
    with_conn!(state, c => service::create_category(&c, &name, &kind, &emoji, color.as_deref(), parent_id.as_deref()))
}
```

- [ ] **Step 6: Run the new tests + full suite**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS — the three new tests pass; everything else still green.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(categories): create_category accepts a parent with two-level + kind validation"
```

---

## Task 3: Cascade archive / restore

**Files:**
- Modify: `src-tauri/src/repo.rs` (add `set_children_archived`)
- Modify: `src-tauri/src/service.rs:163-173` (archive_category / restore_category)
- Modify: `src-tauri/src/lib.rs` (add test)

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/lib.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn archiving_parent_cascades_to_children_and_restores_them() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P5", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();

        service::archive_category(&c, &food.id).unwrap();
        let archived = service::list_categories(&c, None, true).unwrap();
        let child = archived.iter().find(|x| x.id == coffee.id).unwrap();
        assert!(child.is_archived, "child should be archived with its parent");

        service::restore_category(&c, &food.id).unwrap();
        let restored = service::list_categories(&c, None, true).unwrap();
        let child2 = restored.iter().find(|x| x.id == coffee.id).unwrap();
        assert!(!child2.is_archived, "child should be restored with its parent");
    }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib archiving_parent_cascades`
Expected: FAIL — the child stays active (cascade not implemented).

- [ ] **Step 3: Add the repo cascade helper**

In `src-tauri/src/repo.rs`, add right after `set_category_archived` (after line 295):

```rust
/// Archive or restore all subcategories of a top-level category in one statement.
pub fn set_children_archived(conn: &Connection, parent_id: &str, archived: bool, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE categories SET is_archived = ?2, updated_at = ?3 WHERE parent_id = ?1",
        params![parent_id, archived as i64, now],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Cascade from the service**

In `src-tauri/src/service.rs`, replace `archive_category` and `restore_category` (lines 163-173) with:

```rust
pub fn archive_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    if cat.is_system {
        return Err(AppError::Conflict("System categories cannot be archived".into()));
    }
    let now = now();
    let updated = repo::set_category_archived(conn, id, true, &now)?;
    if cat.parent_id.is_none() {
        repo::set_children_archived(conn, id, true, &now)?;
    }
    Ok(updated)
}

pub fn restore_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    let now = now();
    let updated = repo::set_category_archived(conn, id, false, &now)?;
    if cat.parent_id.is_none() {
        repo::set_children_archived(conn, id, false, &now)?;
    }
    Ok(updated)
}
```

- [ ] **Step 5: Run the test + full suite**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/service.rs src-tauri/src/lib.rs
git commit -m "feat(categories): cascade archive/restore from parent to subcategories"
```

---

## Task 4: Spending breakdown rolls up to parent

**Files:**
- Modify: `src-tauri/src/repo.rs:429-448` (spending_breakdown)
- Modify: `src-tauri/src/lib.rs` (add test)

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/lib.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn spending_breakdown_rolls_subcategories_into_parent() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let food = service::create_category(&c, "Food P6", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        // one expense on the PARENT, one on the SUB — both should land in the parent bucket
        service::create_expense(&c, &a.id, &food.id, 1000, None, "2026-05-10").unwrap();
        service::create_expense(&c, &a.id, &coffee.id, 500, None, "2026-05-11").unwrap();

        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        let row = s.spending_breakdown.iter().find(|b| b.category_id == food.id).unwrap();
        assert_eq!(row.total_cents, 1500, "parent + sub spend rolled up");
        assert!(
            !s.spending_breakdown.iter().any(|b| b.category_id == coffee.id),
            "subcategory must not appear as its own bar"
        );
    }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib spending_breakdown_rolls`
Expected: FAIL — coffee appears as its own row and Food only totals 1000.

- [ ] **Step 3: Rewrite the breakdown SQL to group by the parent**

In `src-tauri/src/repo.rs`, replace the prepared statement in `spending_breakdown` (lines 430-435) with:

```rust
    let mut stmt = conn.prepare(
        "SELECT COALESCE(c.parent_id, c.id) AS group_id, pc.name, pc.emoji, pc.color, SUM(t.amount_cents) AS total
         FROM transactions t
         JOIN categories c  ON c.id = t.category_id
         JOIN categories pc ON pc.id = COALESCE(c.parent_id, c.id)
         WHERE t.kind = 'expense' AND t.transaction_date >= ?1 AND t.transaction_date < ?2
         GROUP BY group_id ORDER BY total DESC",
    )?;
```

(The closure that maps rows already reads columns 0-4 positionally as `category_id, category_name, emoji, color, total_cents` — `group_id` is column 0 and `pc.*` are the parent's label, so it needs no change.)

- [ ] **Step 4: Run the test + full suite**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/repo.rs src-tauri/src/lib.rs
git commit -m "feat(dashboard): roll subcategory spend up into the parent in spending breakdown"
```

---

## Task 5: Frontend types + client + mock parity

Mirror Tasks 1–4 in the dev-only mock so browser dev and Vitest match the Rust backend.

**Files:**
- Modify: `src/types.ts:45-56` (Category)
- Modify: `src/client/index.ts:37-38` (createCategory)
- Modify: `src/client/mock.ts` (seed, create_category, archive/restore, breakdown)
- Test: `src/__tests__/mock-categories.test.ts` (new)

- [ ] **Step 1: Write the failing mock tests**

Create `src/__tests__/mock-categories.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Category, DashboardSummary } from "../types";

async function expenseParent(name: string): Promise<Category> {
  return mockInvoke<Category>("create_category", { name, kind: "expense", emoji: "🍔", color: null, parentId: null });
}

describe("mock subcategories", () => {
  it("a subcategory inherits its parent's kind", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "income", emoji: "☕", color: null, parentId: food.id });
    expect(sub.kind).toBe("expense");
    expect(sub.parentId).toBe(food.id);
  });

  it("rejects nesting under a subcategory", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await expect(mockInvoke("create_category", { name: "Latte", kind: "expense", emoji: "🥛", color: null, parentId: sub.id }))
      .rejects.toMatchObject({ code: "ValidationError" });
  });

  it("archiving a parent cascades to children and restoring un-archives them", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await mockInvoke("archive_category", { id: food.id });
    let all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === sub.id)!.isArchived).toBe(true);
    await mockInvoke("restore_category", { id: food.id });
    all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === sub.id)!.isArchived).toBe(false);
  });

  it("dashboard rolls subcategory spend into the parent", async () => {
    const acc = await mockInvoke<{ id: string }>("create_account", { name: `Acc-${Math.random()}`, subtype: "cash", openingBalanceCents: 0, templateKey: null });
    const food = await expenseParent(`Food-${Math.random()}`);
    const coffee = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: food.id, amountCents: 1000, description: null, date: "2026-07-10" });
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: coffee.id, amountCents: 500, description: null, date: "2026-07-11" });
    const d = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-07" });
    const row = d.spendingBreakdown.find((b) => b.categoryId === food.id)!;
    expect(row.totalCents).toBe(1500);
    expect(d.spendingBreakdown.some((b) => b.categoryId === coffee.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/__tests__/mock-categories.test.ts`
Expected: FAIL — `parentId` is unknown / mock has no parent handling.

- [ ] **Step 3: Add `parentId` to the `Category` type**

In `src/types.ts`, in the `Category` interface (lines 45-56), add after `color: string | null;` (line 50):

```ts
  color: string | null;
  parentId: string | null;
```

- [ ] **Step 4: Add `parentId` to the typed client**

In `src/client/index.ts`, replace `createCategory` (lines 37-38) with:

```ts
  createCategory: (name: string, kind: CategoryKind, emoji: string, color?: string, parentId?: string | null) =>
    dispatch<Category>("create_category", { name, kind, emoji, color: color ?? null, parentId: parentId ?? null }),
```

- [ ] **Step 5: Seed `parentId` in the mock**

In `src/client/mock.ts`, in the `categories` seed map (lines 59-61), add `parentId: null`:

```ts
const categories: Category[] = CAT_SEED.map(([name, kind, emoji, color], i) => ({
  id: uid(), name, kind, emoji, color, parentId: null, sortOrder: i, isSystem: true, isArchived: false, createdAt: now(), updatedAt: now(),
}));
```

- [ ] **Step 6: Handle the parent in mock `create_category`**

In `src/client/mock.ts`, replace the `create_category` case (lines 167-171) with:

```ts
    case "create_category": {
      const name = String(a.name).trim();
      let kind = a.kind;
      if (a.parentId != null) {
        const parent = categories.find((x) => x.id === a.parentId) ?? fail("NotFound", "Category not found");
        if (parent.parentId != null) fail("ValidationError", "Subcategories can only be nested one level deep");
        kind = parent.kind;
      }
      const clash = categories.find((x) =>
        x.name.toLowerCase() === name.toLowerCase() &&
        (a.parentId != null ? x.parentId === a.parentId : x.parentId == null && x.kind === kind),
      );
      if (clash) fail("Conflict", "A category with this name already exists");
      const cat: Category = { id: uid(), name, kind, emoji: a.emoji, color: a.color ?? null, parentId: a.parentId ?? null, sortOrder: 100, isSystem: false, isArchived: false, createdAt: now(), updatedAt: now() };
      categories.push(cat);
      return cat as T;
    }
```

- [ ] **Step 7: Cascade in mock archive/restore**

In `src/client/mock.ts`, replace the `archive_category`/`restore_category` case (lines 172-178) with:

```ts
    case "archive_category":
    case "restore_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      const archiving = command === "archive_category";
      if (archiving && c.isSystem) fail("Conflict", "System categories cannot be archived");
      c.isArchived = archiving;
      c.updatedAt = now();
      if (c.parentId == null) {
        categories.forEach((x) => { if (x.parentId === c.id) { x.isArchived = archiving; x.updatedAt = now(); } });
      }
      return c as T;
    }
```

- [ ] **Step 8: Roll up the mock breakdown**

In `src/client/mock.ts`, in the `get_dashboard_summary` case, replace the breakdown accumulation (lines 232-237) with:

```ts
      const parentOf = (cid: string) => categories.find((x) => x.id === cid)?.parentId ?? cid;
      const byCat = new Map<string, number>();
      txns.filter((t) => t.kind === "expense" && inRange(t)).forEach((t) => {
        const pid = parentOf(t.categoryId!);
        byCat.set(pid, (byCat.get(pid) ?? 0) + t.amountCents);
      });
      const breakdown: CategoryBreakdown[] = [...byCat.entries()].map(([cid, total]) => {
        const c = categories.find((x) => x.id === cid)!;
        return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
      }).sort((x, y) => y.totalCents - x.totalCents);
```

- [ ] **Step 9: Run the mock tests + the whole Vitest suite + build**

Run: `npx vitest run src/__tests__/mock-categories.test.ts && npm test && npm run build`
Expected: PASS — new file passes, all 145 prior tests still pass, build is clean.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/client/index.ts src/client/mock.ts src/__tests__/mock-categories.test.ts
git commit -m "feat(categories): mock + types + client parity for subcategories"
```

---

## Task 6: Category tree / picker helpers

**Files:**
- Create: `src/lib/categories.ts`
- Test: `src/__tests__/category-tree.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `src/__tests__/category-tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { categoryTree, categoryPickerItems } from "../lib/categories";
import type { Category } from "../types";

function cat(p: Partial<Category> & { id: string; name: string }): Category {
  return {
    id: p.id, name: p.name, kind: p.kind ?? "expense", emoji: p.emoji ?? "•",
    color: p.color ?? null, parentId: p.parentId ?? null, sortOrder: p.sortOrder ?? 0,
    isSystem: p.isSystem ?? false, isArchived: p.isArchived ?? false,
    createdAt: "t", updatedAt: "t",
  };
}

const data: Category[] = [
  cat({ id: "food", name: "Food", sortOrder: 1 }),
  cat({ id: "coffee", name: "Coffee", parentId: "food", sortOrder: 0 }),
  cat({ id: "dining", name: "Dining", parentId: "food", sortOrder: 1 }),
  cat({ id: "bills", name: "Bills", sortOrder: 2 }),
  cat({ id: "salary", name: "Salary", kind: "income", sortOrder: 0 }),
  cat({ id: "old", name: "Old", parentId: "food", isArchived: true }),
];

describe("categoryTree", () => {
  it("groups top-level expense categories with their children", () => {
    const tree = categoryTree(data, "expense");
    expect(tree.map((n) => n.category.id)).toEqual(["food", "bills"]);
    expect(tree[0].children.map((c) => c.id)).toEqual(["coffee", "dining", "old"]);
  });

  it("does not mix kinds", () => {
    expect(categoryTree(data, "income").map((n) => n.category.id)).toEqual(["salary"]);
  });
});

describe("categoryPickerItems", () => {
  it("returns parents then their non-archived children with depth", () => {
    const items = categoryPickerItems(data, "expense");
    expect(items).toEqual([
      { id: "food", label: "Food", emoji: "•", depth: 0 },
      { id: "coffee", label: "Coffee", emoji: "•", depth: 1 },
      { id: "dining", label: "Dining", emoji: "•", depth: 1 },
      { id: "bills", label: "Bills", emoji: "•", depth: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/category-tree.test.ts`
Expected: FAIL — module `../lib/categories` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/categories.ts`:

```ts
// Category hierarchy helpers. A subcategory is a Category whose `parentId`
// points at a top-level category (parentId === null). Two levels only.

import type { Category, CategoryKind } from "../types";

export interface CategoryNode {
  category: Category;
  children: Category[];
}

const bySort = (a: Category, b: Category) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Top-level categories of a kind, each with its sorted subcategories. */
export function categoryTree(cats: Category[], kind: CategoryKind): CategoryNode[] {
  const sorted = [...cats].sort(bySort);
  return sorted
    .filter((c) => c.kind === kind && c.parentId == null)
    .map((parent) => ({
      category: parent,
      children: sorted.filter((c) => c.parentId === parent.id),
    }));
}

export interface PickerItem {
  id: string;
  label: string;
  emoji: string;
  depth: 0 | 1;
}

/** Flattened, archive-filtered list for a <select>: each parent followed by
 *  its children. `depth` drives indentation. */
export function categoryPickerItems(cats: Category[], kind: CategoryKind): PickerItem[] {
  const out: PickerItem[] = [];
  for (const node of categoryTree(cats, kind)) {
    if (node.category.isArchived) continue;
    out.push({ id: node.category.id, label: node.category.name, emoji: node.category.emoji, depth: 0 });
    for (const child of node.children) {
      if (child.isArchived) continue;
      out.push({ id: child.id, label: child.name, emoji: child.emoji, depth: 1 });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test + build**

Run: `npx vitest run src/__tests__/category-tree.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add src/lib/categories.ts src/__tests__/category-tree.test.ts
git commit -m "feat(categories): category tree + picker helpers"
```

---

## Task 7: Rebuild the Categories screen (master–detail)

Replace `src/screens/Categories.tsx` wholesale. Left rail lists top-level categories grouped by kind (with a subcategory count); the right pane shows the selected parent and an editable list of its subcategories. The form gains a `parent` context for creating subcategories.

**Files:**
- Replace: `src/screens/Categories.tsx`

- [ ] **Step 1: Replace the file**

Overwrite `src/screens/Categories.tsx` with:

```tsx
// Categories screen: a master–detail layout. The left rail lists top-level
// categories grouped by kind (income / expense / transfer) with a subcategory
// count; selecting one shows it in the detail pane alongside an editable list
// of its subcategories. Two-level hierarchy only (see the subcategories spec).

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Category, CategoryKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Card, Empty, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";
import { categoryTree, type CategoryNode } from "../lib/categories";

// ── Preset colour palette (data constant, acceptable hardcoded hex) ─────────

const PALETTE = [
  "#33c9d6", "#46d39a", "#5b8def", "#a78bfa", "#d9728f",
  "#f0708c", "#e0a13c", "#5aa66d", "#56b3c4", "#9aa4b2",
];

const KIND_LABELS: Record<CategoryKind, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

const KIND_ICONS: Record<CategoryKind, import("../components/Icon").IconName> = {
  income: "arrowDown",
  expense: "arrowUp",
  transfer: "swap",
};

const KIND_ORDER: CategoryKind[] = ["income", "expense", "transfer"];

// ── Create / edit modal (top-level or, with `parent`, a subcategory) ─────────

interface CategoryFormProps {
  initial?: Category;
  parent?: Category;
  defaultKind?: CategoryKind;
  onClose: () => void;
  onDone: () => void;
}

function CategoryForm({ initial, parent, defaultKind = "expense", onClose, onDone }: CategoryFormProps) {
  const t = useTheme();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(initial?.kind ?? parent?.kind ?? defaultKind);
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && emoji.trim().length > 0;
  const title = parent ? "New subcategory" : isEdit ? "Edit category" : "New category";

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        await client.updateCategory({ id: initial!.id, name: name.trim(), emoji: emoji.trim(), color: color ?? undefined });
      } else {
        await client.createCategory(name.trim(), parent ? parent.kind : kind, emoji.trim(), color ?? undefined, parent?.id ?? null);
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not save category");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={380}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {parent && (
          <div style={{ fontSize: 12.5, color: t.dim, display: "flex", alignItems: "center", gap: 7 }}>
            <GlyphTile tone={parent.color ?? t.accent} size={22} emoji={parent.emoji} radius={6} />
            Under <strong style={{ color: t.text, fontWeight: 600 }}>{parent.name}</strong>
          </div>
        )}

        {/* Kind selector — only when creating a top-level category */}
        {!isEdit && !parent && (
          <Field label="Kind">
            <div style={{ display: "flex", gap: 6 }}>
              {KIND_ORDER.map((k) => {
                const on = kind === k;
                return (
                  <button key={k} className="sens-btn"
                    onClick={() => setKind(k)}
                    style={{
                      flex: 1, height: 34, borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                      color: on ? t.onAccent : t.dim,
                      background: on ? t.accent : t.panel2,
                      border: `0.5px solid ${on ? "transparent" : t.border}`,
                      boxShadow: on ? `0 1px 6px ${hexA(t.accent, 0.3)}` : "none",
                      transition: "background .12s, color .12s",
                    }}>
                    {KIND_LABELS[k]}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10 }}>
          <Field label="Emoji">
            <input className="sens-input" value={emoji} maxLength={4}
              onChange={(e) => setEmoji(e.target.value)} placeholder="😀"
              style={{ ...inputStyle(t), textAlign: "center", fontSize: 20 }} />
          </Field>
          <Field label="Name">
            <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={parent ? "e.g. Coffee" : "e.g. Dining out"} style={inputStyle(t)} autoFocus />
          </Field>
        </div>

        <Field label="Colour (optional)">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", paddingTop: 2 }}>
            <button className="sens-btn" onClick={() => setColor(null)} title="None"
              style={{ width: 26, height: 26, borderRadius: 6, background: t.panel2,
                border: `1.5px solid ${color === null ? t.text : t.border}`,
                display: "flex", alignItems: "center", justifyContent: "center" }}>
              {color === null && <Icon name="close" size={11} color={t.dim} />}
            </button>
            {PALETTE.map((hex) => (
              <button key={hex} className="sens-btn" onClick={() => setColor(hex)} title={hex}
                style={{ width: 26, height: 26, borderRadius: 6, background: hex,
                  border: `1.5px solid ${color === hex ? t.text : "transparent"}`,
                  boxShadow: color === hex ? `0 0 0 2px ${hexA(hex, 0.4)}` : "none",
                  transition: "box-shadow .1s, border-color .1s" }} />
            ))}
          </div>
        </Field>

        {error && (
          <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!canSubmit || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>
            {isEdit ? "Save changes" : parent ? "Add subcategory" : "Create category"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export function Categories() {
  const t = useTheme();
  const { reload, version } = useAppData();
  const { notify } = useToast();
  const [all, setAll] = useState<Category[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<CategoryKind | null>(null);
  const [addingSubTo, setAddingSubTo] = useState<Category | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);

  useEffect(() => {
    client.listCategories(undefined, true).then(setAll).catch(() => {});
  }, [version]);

  const treesByKind = useMemo(() => {
    const visible = all.filter((c) => showArchived || !c.isArchived);
    return KIND_ORDER.map((kind) => ({ kind, nodes: categoryTree(visible, kind) }));
  }, [all, showArchived]);

  const selectedNode = useMemo<CategoryNode | null>(() => {
    for (const { nodes } of treesByKind) {
      const n = nodes.find((n) => n.category.id === selectedId);
      if (n) return n;
    }
    return null;
  }, [treesByKind, selectedId]);

  // Keep a valid selection as data / filters change.
  useEffect(() => {
    if (selectedNode) return;
    const first = treesByKind.flatMap((g) => g.nodes)[0];
    setSelectedId(first ? first.category.id : null);
  }, [treesByKind, selectedNode]);

  async function archive(c: Category) {
    try { await client.archiveCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to archive category", "error"); }
  }
  async function restore(c: Category) {
    try { await client.restoreCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to restore category", "error"); }
  }
  async function afterMutation() {
    await reload();
    setCreating(null);
    setAddingSubTo(null);
    setEditing(null);
  }

  const activeCount = all.filter((c) => !c.isArchived).length;
  const hasArchived = all.some((c) => c.isArchived);

  return (
    <div className="sens-screen" style={{ display: "flex", gap: 14, alignItems: "flex-start", maxWidth: 940 }}>
      {/* LEFT RAIL */}
      <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>{activeCount} active</div>
              <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>Categories &amp; subcategories</div>
            </div>
            <Btn variant="primary" icon="plus" size="md" onClick={() => setCreating("expense")}>New</Btn>
          </div>
          {hasArchived && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>
                {showArchived ? "Hide archived" : "Show archived"}
              </Btn>
            </div>
          )}
        </Card>

        <Card pad={0} style={{ overflow: "hidden" }}>
          {treesByKind.map(({ kind, nodes }) => (
            <div key={kind}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "12px 16px 8px" }}>
                <Icon name={KIND_ICONS[kind]} size={12} color={t.dim} stroke={2} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {KIND_LABELS[kind]}
                </span>
              </div>
              {nodes.length === 0 ? (
                <div style={{ padding: "0 16px 12px", fontSize: 12, color: t.faint }}>None yet</div>
              ) : (
                nodes.map((node) => {
                  const c = node.category;
                  const on = c.id === selectedId;
                  return (
                    <button key={c.id} className="sens-row" onClick={() => setSelectedId(c.id)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "8px 16px",
                        background: on ? t.panel2 : "transparent", border: "none", cursor: "pointer",
                        opacity: c.isArchived ? 0.55 : 1, textAlign: "left",
                        borderLeft: `2px solid ${on ? (c.color ?? t.accent) : "transparent"}`,
                      }}>
                      <GlyphTile tone={c.color ?? t.accent} size={28} emoji={c.emoji} radius={8} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 650 : 550, color: t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.name}
                      </span>
                      {node.children.length > 0 && (
                        <span style={{ fontSize: 11, color: t.faint, fontVariantNumeric: "tabular-nums" }}>{node.children.length}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </Card>
      </div>

      {/* DETAIL PANE */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedNode ? (
          <CategoryDetail
            node={selectedNode}
            onEdit={() => setEditing(selectedNode.category)}
            onArchive={() => archive(selectedNode.category)}
            onRestore={() => restore(selectedNode.category)}
            onAddSub={() => setAddingSubTo(selectedNode.category)}
            onEditChild={(child) => setEditing(child)}
            onArchiveChild={(child) => archive(child)}
            onRestoreChild={(child) => restore(child)}
          />
        ) : (
          <Card><Empty icon="filter" title="No categories yet" hint="Create one with the New button." /></Card>
        )}
      </div>

      {/* MODALS */}
      {creating !== null && (
        <CategoryForm defaultKind={creating} onClose={() => setCreating(null)} onDone={afterMutation} />
      )}
      {addingSubTo && (
        <CategoryForm parent={addingSubTo} onClose={() => setAddingSubTo(null)} onDone={afterMutation} />
      )}
      {editing && (
        <CategoryForm initial={editing} onClose={() => setEditing(null)} onDone={afterMutation} />
      )}
    </div>
  );
}

// ── Detail pane ──────────────────────────────────────────────────────────────

function CategoryDetail({
  node, onEdit, onArchive, onRestore, onAddSub, onEditChild, onArchiveChild, onRestoreChild,
}: {
  node: CategoryNode;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onAddSub: () => void;
  onEditChild: (c: Category) => void;
  onArchiveChild: (c: Category) => void;
  onRestoreChild: (c: Category) => void;
}) {
  const t = useTheme();
  const c = node.category;

  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
        <GlyphTile tone={c.color ?? t.accent} size={48} emoji={c.emoji} radius={12} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {c.name}
            {c.isSystem && <Tag t={t} tone={t.accent}>System</Tag>}
            {c.isArchived && <Tag t={t} tone={t.faint}>Archived</Tag>}
          </div>
          <div style={{ fontSize: 12.5, color: t.dim, marginTop: 3 }}>
            {KIND_LABELS[c.kind]} · {node.children.length} {node.children.length === 1 ? "subcategory" : "subcategories"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Btn variant="outline" size="sm" icon="pencil" onClick={onEdit}>Edit</Btn>
          {!c.isSystem && (c.isArchived
            ? <Btn variant="outline" size="sm" icon="restore" onClick={onRestore}>Restore</Btn>
            : <Btn variant="outline" size="sm" icon="archive" onClick={onArchive}>Archive</Btn>
          )}
        </div>
      </div>

      {/* Subcategories */}
      <div style={{ padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>
          Subcategories
        </div>

        {node.children.length === 0 ? (
          <div style={{ fontSize: 12.5, color: t.faint, marginBottom: 12 }}>No subcategories yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {node.children.map((child) => (
              <div key={child.id} className="sens-row"
                style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 10px",
                  border: `0.5px solid ${t.border}`, borderRadius: 9, opacity: child.isArchived ? 0.55 : 1 }}>
                <GlyphTile tone={child.color ?? t.accent} size={28} emoji={child.emoji} radius={8} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 550, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  {child.name}
                  {child.isArchived && <Tag t={t} tone={t.faint}>Archived</Tag>}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <Btn variant="outline" size="sm" icon="pencil" onClick={() => onEditChild(child)}>Edit</Btn>
                  {child.isArchived
                    ? <Btn variant="outline" size="sm" icon="restore" onClick={() => onRestoreChild(child)}>Restore</Btn>
                    : <Btn variant="outline" size="sm" icon="archive" onClick={() => onArchiveChild(child)}>Archive</Btn>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!c.isArchived && (
          <Btn variant="outline" size="md" icon="plus" onClick={onAddSub}>Add subcategory</Btn>
        )}
      </div>
    </Card>
  );
}

function Tag({ t, tone, children }: { t: ReturnType<typeof useTheme>; tone: string; children: ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: tone, border: `0.5px solid ${hexA(tone, 0.4)}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck / build**

Run: `npm run build`
Expected: PASS (clean strict TS). If `Tag`'s `React.ReactNode` triggers an unused-import or missing-React error, add `import type { ReactNode } from "react";` and use `ReactNode` instead of `React.ReactNode`.

- [ ] **Step 3: Smoke-test in the browser mock**

Run: `npm run dev`, open the Categories screen. Verify: rail groups by kind; selecting a parent shows its detail; "Add subcategory" creates a child that appears indented in the detail and bumps the rail count; archiving a parent hides it and (with "Show archived") shows its children dimmed.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat(categories): master-detail screen with subcategory management"
```

---

## Task 8: Grouped category picker in AddTransaction

**Files:**
- Modify: `src/modals/AddTransaction.tsx:14,32-35,118-131`

- [ ] **Step 1: Swap the category source to picker items**

In `src/modals/AddTransaction.tsx`, replace the import on line 14:

```ts
import { categoriesByKind } from "../store";
```
with:
```ts
import { categoryPickerItems } from "../lib/categories";
```

- [ ] **Step 2: Build the indented item list**

Replace lines 32-35 (the `catKind` / `catList` / `categoryId` / `effectiveCat` block) with:

```ts
  const catKind: Category["kind"] = kind === "income" ? "income" : kind === "transfer" ? "transfer" : "expense";
  const pickerItems = useMemo(() => categoryPickerItems(categories, catKind), [categories, catKind]);
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? "");
  const effectiveCat = categoryId || pickerItems[0]?.id || "";
```

- [ ] **Step 3: Render parents + indented children**

Replace the category `<select>` block (lines 120-124, the `<Field label="Category">…</Field>`) with:

```tsx
            <Field label="Category">
              <select className="sens-input" value={effectiveCat} onChange={(e) => setCategoryId(e.target.value)} style={sel}>
                {pickerItems.map((it) => (
                  <option key={it.id} value={it.id} style={{ background: t.panel2 }}>
                    {it.depth === 1 ? " " : ""}{it.emoji} {it.label}
                  </option>
                ))}
              </select>
            </Field>
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS. (`valid` already keys off `effectiveCat`, which is unchanged; transfer path is untouched.)

- [ ] **Step 5: Smoke-test**

Run: `npm run dev`. Add an expense — the category dropdown lists top-level categories with subcategories indented beneath; selecting either yields a valid transaction.

- [ ] **Step 6: Commit**

```bash
git add src/modals/AddTransaction.tsx
git commit -m "feat(transactions): grouped category picker with indented subcategories"
```

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (Categories / data-model notes)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, in the "Money, balances, and transaction kinds" / category area, add a sentence describing the new model. Add this bullet after the dashboard breakdown description:

```markdown
- **Subcategories (v1.2):** `categories.parent_id` (nullable, self-FK) gives a **two-level** hierarchy — a top-level category (`parent_id IS NULL`) may have subcategories, but a subcategory cannot. A subcategory inherits its parent's `kind`; both invariants (parent-must-be-top-level, child-kind = parent-kind) are enforced in the **service layer** (mirrored in `mock.ts`), not by DB constraints. Uniqueness is per-sibling: two partial indexes (`idx_categories_top_kind_name` on `(kind,name) WHERE parent_id IS NULL`, `idx_categories_sub_parent_name` on `(parent_id,name)`). Transactions may reference a **parent or a subcategory** (no migration). Archiving a parent **cascades** to its children. The Dashboard spending breakdown **rolls subcategory spend up into the parent** (`GROUP BY COALESCE(parent_id, id)`). The Categories screen (`src/screens/Categories.tsx`) is a **master–detail** layout; the transaction picker (`src/modals/AddTransaction.tsx`) groups subcategories indented under their parent via `categoryPickerItems` (`src/lib/categories.ts`).
```

- [ ] **Step 2: Update CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]` (create the section/`### Added` heading if missing), add:

```markdown
### Added
- Two-level **subcategories**: categories can now have subcategories (`parent_id`). Transactions can be logged against a parent or a subcategory; the Dashboard spending breakdown rolls subcategory spend up into the parent.
- Redesigned **Categories** screen as a master–detail layout for managing categories and their subcategories.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: document subcategories + categories screen redesign"
```

---

## Final Verification

- [ ] **Backend:** `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib` → all pass.
- [ ] **Backend compiles for the desktop binary:** `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build` → clean (validates command registration with the new `parent_id` arg).
- [ ] **Frontend tests:** `npm test` → all pass (145 prior + new files).
- [ ] **Frontend gate:** `npm run build` → clean.
- [ ] **Manual smoke (`npm run dev`):** create a subcategory under "Food"; log an expense on it; confirm the Dashboard breakdown shows it under "Food", not separately; archive "Food" and confirm the subcategory hides too.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge / PR.

## Notes & Deliberate Scope Trims

- The detail-pane hero shows kind + subcategory count, **not** a per-category monthly spend figure (the brainstorm mockup's RM numbers were illustrative). Adding live totals would couple this screen to dashboard data; deferred.
- `update_category` does **not** support reparenting/moving (`parentId` stays uneditable) — per spec, out of scope for v1.
- Restoring a parent un-archives **all** its currently-archived children, including any archived independently before the parent — accepted v1 simplification (we don't track why a child was archived).
