# Categories Action Menu, Default Reorder & Factory Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Categories detail-pane actions into a "⋯" dropdown (Delete always shown, disabled-with-static-tooltip when it has subcategories), make "Other Income" the last default income category, and add a guarded "Reset app to defaults" action in Settings that wipes the DB and reseeds.

**Architecture:** Three independent slices. (1) Seed-data reorder in Rust + mock. (2) A factory-reset path that wipes the data tables in one transaction and re-runs the existing idempotent seed — added to `db/mod.rs`, exposed through `service` → `commands` → client seam → `mock`. (3) Frontend: a reusable anchored `ActionMenu` popover used by `Categories.tsx`, and a "Danger zone" card in `Settings.tsx` with a type-`RESET`-to-confirm modal.

**Tech Stack:** Tauri v2 (Rust, rusqlite), React 19 + TypeScript + Vite, Vitest, `cargo test`.

Spec: `docs/superpowers/specs/2026-06-01-categories-action-menu-and-factory-reset-design.md`

**Per-command rule (CLAUDE.md):** any backend command change must be mirrored in `src/client/mock.ts`. Money is integer MYR cents; backend owns UUIDs/timestamps; structs serialize `camelCase`.

**Rust commands need the PATH prefix:** `export PATH="$HOME/.cargo/bin:$PATH"` before any `cargo`/`tauri` command.

---

## Task 1: Make "Other Income" the last default income category

**Files:**
- Modify: `src-tauri/src/db/seed.rs` (CATEGORIES const, income block)
- Modify: `src/client/mock.ts:54-59` (CAT_SEED order)
- Test: `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing Rust test**

Add to the `tests` module in `src-tauri/src/lib.rs` (alongside `seeds_templates_and_categories`):

```rust
#[test]
fn other_income_sorts_after_investments() {
    let c = open_in_memory().unwrap();
    let income = service::list_categories(&c, Some("income"), false).unwrap();
    let pos = |name: &str| income.iter().position(|x| x.name == name).unwrap();
    assert!(
        pos("Other Income") > pos("Investments"),
        "Other Income must come after Investments by default"
    );
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib other_income_sorts_after_investments`
Expected: FAIL (currently Other Income sort_order 4 < Investments 5).

- [ ] **Step 3: Reorder the income block in `seed.rs`**

In `src-tauri/src/db/seed.rs`, change the Income rows of `CATEGORIES` so Investments is `4` and Other Income is `5`:

```rust
    // Income
    ("Salary", "income", "\u{1F4B0}", "#46d39a", 0),
    ("Bonus", "income", "\u{1F389}", "#3fcf8e", 1),
    ("Freelance", "income", "\u{1F4BB}", "#5aa66d", 2),
    ("Gift", "income", "\u{1F381}", "#56b3c4", 3),
    ("Investments", "income", "\u{1F4C8}", "#2fbf71", 4),
    ("Other Income", "income", "\u{2795}", "#7bbf8f", 5),
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib other_income_sorts_after_investments`
Expected: PASS.

- [ ] **Step 5: Mirror the order in the mock**

In `src/client/mock.ts`, reorder the income entries of `CAT_SEED` (line ~55) so `Investments` precedes `Other Income`:

```ts
const CAT_SEED: [string, Category["kind"], string, string][] = [
  ["Salary", "income", "💰", "#46d39a"], ["Bonus", "income", "🎉", "#3fcf8e"], ["Freelance", "income", "💻", "#5aa66d"], ["Gift", "income", "🎁", "#56b3c4"], ["Investments", "income", "📈", "#2fbf71"], ["Other Income", "income", "➕", "#7bbf8f"],
  ["Food", "expense", "🍔", "#e0a13c"], ["Transport", "expense", "🚗", "#8b7bd8"], ["Bills", "expense", "🧾", "#56b3c4"], ["Shopping", "expense", "🛍️", "#d9728f"], ["Health", "expense", "🏥", "#f0708c"], ["Entertainment", "expense", "🎬", "#a78bfa"], ["Groceries", "expense", "🛒", "#5aa66d"], ["Education", "expense", "📚", "#5b8def"], ["Travel", "expense", "✈️", "#33c9d6"], ["Other Expense", "expense", "💸", "#9aa4b2"],
  ["Transfer", "transfer", "🔄", "#9aa4b2"],
];
```

(The mock assigns `sortOrder: i` by array index, so reordering the array is sufficient.)

- [ ] **Step 6: Typecheck the frontend**

Run: `npm run build`
Expected: PASS (tsc clean, vite build succeeds).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/seed.rs src-tauri/src/lib.rs src/client/mock.ts
git commit -m "feat: order default 'Other Income' category last"
```

---

## Task 2: Factory-reset backend (`reset_app` command)

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (new `pub fn reset_to_defaults`)
- Modify: `src-tauri/src/service.rs` (new `pub fn reset_app`)
- Modify: `src-tauri/src/commands.rs` (new `reset_app` command)
- Modify: `src-tauri/src/lib.rs` (register command + test)

- [ ] **Step 1: Write the failing service test**

Add to the `tests` module in `src-tauri/src/lib.rs`:

```rust
#[test]
fn reset_app_wipes_data_and_reseeds_defaults() {
    let c = open_in_memory().unwrap();
    // Arrange: an account, a transaction, and a custom category.
    let a = acct(&c, "Wallet", 10_000);
    let cat = expense_cat(&c);
    service::create_expense_transaction(&c, &a.id, &cat, 500, None, "2026-01-01").unwrap();
    service::create_category(&c, "Bespoke", "expense", "🦄", None, None).unwrap();
    let default_income = service::list_categories(&c, Some("income"), false).unwrap().len();

    // Act
    service::reset_app(&c).unwrap();

    // Assert: user data gone, defaults restored.
    assert!(service::list_accounts(&c, true).unwrap().is_empty(), "accounts wiped");
    assert!(service::list_transactions(&c, None).unwrap().is_empty(), "transactions wiped");
    let income = service::list_categories(&c, Some("income"), false).unwrap();
    assert_eq!(income.len(), default_income, "default income categories reseeded");
    assert!(
        !service::list_categories(&c, Some("expense"), true).unwrap().iter().any(|x| x.name == "Bespoke"),
        "custom category removed"
    );
}
```

Note: confirm the helper/signature names (`acct`, `expense_cat`, `create_expense_transaction`, `list_transactions`, `list_accounts`) match what's already in the test module and `service.rs`; adapt the calls if a signature differs (e.g. date/description argument order).

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reset_app_wipes_data_and_reseeds_defaults`
Expected: FAIL — `service::reset_app` does not exist.

- [ ] **Step 3: Add `reset_to_defaults` to `db/mod.rs`**

`db/mod.rs` already owns the `seed` module and the `FIRST_RUN_KEY` / `DEFAULTS_V2_KEY` constants, so the reset lives here. Add:

```rust
/// Factory reset: wipe all user data and re-run the idempotent seed so the
/// database returns to a fresh-install state. Done in one transaction. The
/// `account_subtypes` reference table and `schema_migrations` are preserved;
/// `account_templates` are reseeded by `seed::seed` (INSERT OR IGNORE).
pub fn reset_to_defaults(conn: &Connection) -> AppResult<()> {
    let now = crate::now();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        // Order respects ON DELETE RESTRICT FKs: transactions reference
        // accounts + categories; categories self-reference via parent_id.
        conn.execute("DELETE FROM transactions", [])?;
        conn.execute("DELETE FROM categories WHERE parent_id IS NOT NULL", [])?;
        conn.execute("DELETE FROM categories", [])?;
        conn.execute("DELETE FROM accounts", [])?;
        conn.execute("DELETE FROM app_settings", [])?;
        seed::seed(conn, &now)?;
        for key in [FIRST_RUN_KEY, DEFAULTS_V2_KEY] {
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2)",
                rusqlite::params![key, now],
            )?;
        }
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

- [ ] **Step 4: Add `reset_app` to `service.rs`**

Add to `src-tauri/src/service.rs` (thin pass-through to the db lifecycle op):

```rust
/// Factory reset — wipe user data and restore seeded defaults.
pub fn reset_app(conn: &Connection) -> AppResult<()> {
    crate::db::reset_to_defaults(conn)
}
```

- [ ] **Step 5: Run the service test to confirm it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib reset_app_wipes_data_and_reseeds_defaults`
Expected: PASS.

- [ ] **Step 6: Add the `reset_app` command**

In `src-tauri/src/commands.rs`, after the settings commands (near `set_setting`):

```rust
#[tauri::command]
pub fn reset_app(state: State<'_, DbState>) -> AppResult<()> {
    with_conn!(state, c => service::reset_app(&c))
}
```

- [ ] **Step 7: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs`, add `commands::reset_app,` to the `generate_handler!` list (after `commands::set_setting,`):

```rust
            commands::get_setting,
            commands::set_setting,
            commands::reset_app,
        ])
```

- [ ] **Step 8: Build the backend to validate command registration**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo build`
Expected: compiles cleanly.

- [ ] **Step 9: Run the full Rust test suite**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/service.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add reset_app command to wipe and reseed the database"
```

---

## Task 3: Factory-reset client seam (`resetApp` + mock)

**Files:**
- Modify: `src/client/index.ts` (Settings section)
- Modify: `src/client/mock.ts` (extract a category seeder; add `reset_app` case)

- [ ] **Step 1: Add the typed client wrapper**

In `src/client/index.ts`, under the `// Settings` block (after `setSetting`):

```ts
  // Settings
  getSetting: (key: string) => dispatch<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => dispatch<void>("set_setting", { key, value }),
  resetApp: () => dispatch<void>("reset_app"),
};
```

- [ ] **Step 2: Make the mock category seed re-runnable**

In `src/client/mock.ts`, the category seeding currently runs once at module load against the module-level `const categories` array. Wrap the seeding (the `CAT_SEED.map(...)` assignment through the `SUB_SEED.forEach(...)` block, lines ~60-87) into a function so reset can rebuild it. Replace that block with:

```ts
const categories: Category[] = [];

function seedCategories() {
  categories.length = 0;
  CAT_SEED.forEach(([name, kind, emoji, color], i) => {
    categories.push({ id: uid(), name, kind, emoji, color, parentId: null, sortOrder: i, isArchived: false, createdAt: now(), updatedAt: now() });
  });
  const subSortByParent: Record<string, number> = {};
  SUB_SEED.forEach(([parentName, kind, childName, emoji, color]) => {
    const parent = categories.find((c) => c.name === parentName && c.kind === kind && c.parentId == null);
    if (parent) {
      const sort = subSortByParent[parent.id] ?? 0;
      subSortByParent[parent.id] = sort + 1;
      categories.push({ id: uid(), name: childName, kind, emoji, color, parentId: parent.id, sortOrder: sort, isArchived: false, createdAt: now(), updatedAt: now() });
    }
  });
}
seedCategories();
```

(Keep `CAT_SEED` and `SUB_SEED` declared above this block, unchanged from Task 1.)

- [ ] **Step 3: Add the `reset_app` case to `mockInvoke`**

In `src/client/mock.ts`, add a case before `default:` in the `switch`. It mirrors the Rust reset: clears accounts, transactions, and settings, then reseeds categories. (Demo accounts are intentionally NOT reseeded — a real factory reset starts with no accounts.)

```ts
    case "reset_app": {
      accounts.length = 0;
      txns.length = 0;
      settings.clear();
      seedCategories();
      return undefined as T;
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Run the JS test suite (regression)**

Run: `npm test`
Expected: PASS (no behavior the existing tests depend on changed).

- [ ] **Step 6: Commit**

```bash
git add src/client/index.ts src/client/mock.ts
git commit -m "feat: wire resetApp through the client seam and mock"
```

---

## Task 4: Reusable `ActionMenu` component

**Files:**
- Create: `src/components/ActionMenu.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/ActionMenu.tsx`. It is an anchored popover (same open/close + positioning pattern as `EmojiPicker`) rendering a vertical list of items. A disabled item is non-interactive and shows its reason through the native `title` tooltip.

```tsx
// Reusable anchored action menu (the "⋯" overflow popover). Mirrors the
// EmojiPicker popover pattern: opens under a trigger, closes on outside-click
// / Esc. Disabled items are inert and surface their reason via the native
// title tooltip. All colors come from theme tokens.
import { useEffect, useMemo, useRef } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";

export interface ActionMenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a native tooltip on hover (used to explain a disabled item). */
  tooltip?: string;
  danger?: boolean;
}

export function ActionMenu({
  items,
  onClose,
  anchorRef,
}: {
  items: ActionMenuItem[];
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useTheme();
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click and Esc.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorRef, onClose]);

  // Position the menu under the anchor, right-aligned, flipping up on overflow.
  const pos = useMemo(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return { top: 0, left: 0 };
    const W = 188, gap = 6;
    const H = Math.min(items.length * 38 + 10, 360);
    let left = a.right - W;
    if (left < 8) left = 8;
    let top = a.bottom + gap;
    if (top + H > window.innerHeight - 8) top = Math.max(8, a.top - H - gap);
    return { top, left };
  }, [anchorRef, items.length]);

  return (
    <div ref={popRef} className="sens-pop"
      style={{
        position: "fixed", top: pos.top, left: pos.left, width: 188, zIndex: 200,
        background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 10,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)", padding: 5,
        display: "flex", flexDirection: "column", gap: 1,
      }}>
      {items.map((it) => {
        const color = it.disabled ? t.faint : it.danger ? t.expense : t.text;
        return (
          <button key={it.label} title={it.tooltip} disabled={it.disabled}
            onClick={() => { if (it.disabled) return; onClose(); it.onSelect(); }}
            style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "8px 10px", border: "none", borderRadius: 7,
              background: "transparent", color, cursor: it.disabled ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 550, textAlign: "left",
              opacity: it.disabled ? 0.6 : 1,
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = it.danger ? hexA(t.expense, 0.12) : t.panel2; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            {it.icon && <Icon name={it.icon} size={15} color={color} stroke={2} />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
```

Note: confirm `Icon` exports a named `IconName` type (it does — see `src/components/Icon.tsx`). Confirm `t.borderStrong` and `t.expense` exist on the theme (they are used in `EmojiPicker.tsx` / `Categories.tsx`); if a token name differs, use the equivalent already used in those files.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS (component compiles; unused until Task 5 — it is exported, so `noUnusedLocals` does not flag it).

- [ ] **Step 3: Commit**

```bash
git add src/components/ActionMenu.tsx
git commit -m "feat: add reusable ActionMenu popover component"
```

---

## Task 5: Categories detail pane uses the "⋯" menu; Delete always shown

**Files:**
- Modify: `src/screens/Categories.tsx` (`CategoryDetail` + per-subcategory rows; imports)

- [ ] **Step 1: Import the menu and React hook**

At the top of `src/screens/Categories.tsx`, add the import:

```ts
import { ActionMenu, type ActionMenuItem } from "../components/ActionMenu";
```

`useRef`/`useState` are already imported.

- [ ] **Step 2: Add a small trigger helper inside the file**

Add this component near the bottom of `src/screens/Categories.tsx` (next to `Tag`). It owns the open/close state for one "⋯" button + menu:

```tsx
function ActionMenuButton({ items }: { items: ActionMenuItem[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className="sens-icon-btn" onClick={() => setOpen((o) => !o)}
        title="Actions"
        style={{ width: 30, height: 30, color: t.dim, borderRadius: 8 }}>
        <Icon name="dots" size={18} />
      </button>
      {open && <ActionMenu items={items} anchorRef={ref} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 3: Replace the hero button row with the menu**

In `CategoryDetail`, replace the hero actions block (the `<div style={{ display: "flex", gap: 4 }}>` containing Edit/Move/Archive/Delete `Btn`s, lines ~522-532) with:

```tsx
        <ActionMenuButton items={[
          { label: "Edit", icon: "pencil", onSelect: onEdit },
          { label: "Move", icon: "swap", onSelect: onMove },
          c.isArchived
            ? { label: "Restore", icon: "restore", onSelect: onRestore }
            : { label: "Archive", icon: "archive", onSelect: onArchive },
          {
            label: "Delete", icon: "trash", danger: true, onSelect: onDelete,
            disabled: node.children.length > 0,
            tooltip: node.children.length > 0
              ? "Archive instead — categories with subcategories or linked transactions can't be deleted."
              : undefined,
          },
        ]} />
```

(`onDelete` is already a prop on `CategoryDetail`; it opens the existing confirm modal. The previous `node.children.length === 0 && <Btn ...Delete>` conditional is now gone — Delete is always present, disabled when it has children.)

- [ ] **Step 4: Replace the per-subcategory button row with the menu**

In `CategoryDetail`, replace each subcategory row's actions block (the `<div style={{ display: "flex", gap: 4 }}>` with Edit/Move/Archive/Delete for `child`, lines ~562-569) with:

```tsx
                <ActionMenuButton items={[
                  { label: "Edit", icon: "pencil", onSelect: () => onEditChild(child) },
                  { label: "Move", icon: "swap", onSelect: () => onMoveChild(child) },
                  child.isArchived
                    ? { label: "Restore", icon: "restore", onSelect: () => onRestoreChild(child) }
                    : { label: "Archive", icon: "archive", onSelect: () => onArchiveChild(child) },
                  { label: "Delete", icon: "trash", danger: true, onSelect: () => onDeleteChild(child) },
                ]} />
```

(Subcategories are leaves — never blocked by children. A subcategory still referenced by transactions falls through to the existing delete error toast, unchanged.)

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS. If `noUnusedLocals` flags `Btn` (no longer used in the detail pane but still used elsewhere in the file) leave it; only remove imports that are now truly unused.

- [ ] **Step 6: Manual verification in the browser mock**

Run: `npm run dev`, open the Categories screen.
- Click the "⋯" on a top-level category with subcategories (e.g. Food) → menu opens; **Delete is greyed out**; hovering it shows the static tooltip.
- Click the "⋯" on a leaf top-level category with no subcategories (e.g. Transfer) → **Delete is enabled**.
- Open a subcategory's "⋯" → Edit/Move/Archive/Delete all present.
- Esc and outside-click close the menu.

Use the preview tooling to confirm (start server, snapshot, click). Capture a screenshot of an open menu for the completion summary.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Categories.tsx
git commit -m "feat: collapse category actions into a dropdown; always show Delete"
```

---

## Task 6: Settings "Danger zone" with type-RESET-to-confirm

**Files:**
- Modify: `src/screens/Settings.tsx`

- [ ] **Step 1: Add imports and the reset modal component**

At the top of `src/screens/Settings.tsx`, extend imports:

```ts
import { Btn, Card, SectionTitle, Modal, inputStyle } from "../components/ui";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";
```

(`useState` is already imported; `useTheme`, `useThemeMode`, `Icon` already present.)

Add this modal component above the `Settings` function:

```tsx
function ResetModal({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();
  const { reload } = useAppData();
  const { notify } = useToast();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = confirm.trim().toUpperCase() === "RESET";

  async function run() {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await client.resetApp();
      // Reset client-only preferences to defaults.
      localStorage.removeItem("sens.sidebar");
      if (mode === "light") toggle(); // back to dark default
      await reload();
      notify("App reset to defaults", "success");
      onClose();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Reset failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 15, fontWeight: 700 }}>
        Reset app to defaults?
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12.5, color: t.dim, lineHeight: 1.5 }}>
          This permanently deletes all accounts, transactions, and categories, then
          restores the default categories. Appearance and dashboard preferences are
          reset too. This cannot be undone.
        </div>
        <div>
          <div style={{ fontSize: 12, color: t.faint, marginBottom: 6 }}>
            Type <strong style={{ color: t.text, fontFamily: t.mono }}>RESET</strong> to confirm
          </div>
          <input className="sens-input" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            placeholder="RESET" style={inputStyle(t)} autoFocus />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="outline" size="md" onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" size="md" icon="trash" disabled={!armed || busy} onClick={run}>
            {busy ? "Resetting…" : "Reset everything"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
```

Note: confirm `t.mono` exists (it is used in this same file for the version string). `Btn` supports `variant="danger"` (used in `Categories.tsx`).

- [ ] **Step 2: Add the Danger zone card + modal state to the screen**

Inside the `Settings` function, add state near the top (after the existing `useState` calls):

```tsx
  const [resetOpen, setResetOpen] = useState(false);
```

Then add a new `Card` as the **last** child inside the screen's root `<div>` (after the About card), and render the modal:

```tsx
      {/* Danger zone */}
      <Card>
        <SectionTitle>Danger zone</SectionTitle>
        <SettingRow
          label="Reset app to defaults"
          hint="Erase all data and restore the default categories"
          right={
            <Btn variant="danger" size="md" icon="trash" onClick={() => setResetOpen(true)}>
              Reset
            </Btn>
          }
        />
      </Card>

      {resetOpen && <ResetModal onClose={() => setResetOpen(false)} />}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification in the browser mock**

Run: `npm run dev`, open Settings.
- "Danger zone" card shows a red Reset button.
- Click it → modal opens; the confirm button is **disabled** until you type `RESET` (case-insensitive, trimmed).
- Type `RESET`, confirm → toast "App reset to defaults"; navigate to Accounts (now empty) and Categories (defaults restored, Other Income last); Dashboard recomputes.
- Verify theme returns to dark if it was light, and the sidebar collapse state is cleared.

Use the preview tooling; capture a screenshot of the open confirm modal.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Settings.tsx
git commit -m "feat: add factory-reset Danger zone to Settings"
```

---

## Task 7: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `CLAUDE.md` (Categories + backend notes)

- [ ] **Step 1: Update the CHANGELOG**

Add under `## [Unreleased]` in `CHANGELOG.md` (create the section if absent, matching the existing format):

```markdown
### Added
- Categories: per-category and per-subcategory actions are now grouped in a "⋯" dropdown menu. Delete is always shown but disabled (with an explanatory tooltip) when a category still has subcategories.
- Settings: a "Danger zone" with **Reset app to defaults** — wipes all accounts, transactions, and categories and restores defaults, guarded by a type-`RESET`-to-confirm prompt.

### Changed
- Default category order: "Other Income" now sorts last in the Income group (applies to fresh installs and after a reset).
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`:
- In the **Subcategories (v0.4.0)** / Categories-screen description, note that the detail pane's actions are presented in a reusable `ActionMenu` ("⋯") popover (`src/components/ActionMenu.tsx`) and that Delete is always shown but disabled-with-tooltip when a category has subcategories.
- In **Backend conventions**, add a sentence: a `reset_app` command (`db::reset_to_defaults`) performs a factory reset — wipes `transactions`/`categories`/`accounts`/`app_settings` in one transaction and re-runs the idempotent seed, re-setting the `seeded`/`defaults_v2_seeded` flags; mirrored by `resetApp()` in `mock.ts`.

- [ ] **Step 3: Final full verification**

Run, expecting all green:
```bash
npm run build
npm test
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib && cd ..
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: changelog + CLAUDE.md for action menu and factory reset"
```

---

## Self-Review Notes

- **Spec coverage:** Task 5 = detail-pane dropdown + always-shown/blocked Delete with static tooltip. Task 1 = Other Income last. Tasks 2/3/6 = factory reset (backend, seam+mock, UI). Task 7 = docs. All spec sections covered.
- **Dropped from spec:** the `category_usage()` command (per user: static tooltip only) — not present in any task. Good.
- **Type consistency:** `ActionMenuItem` shape (`label`/`icon`/`onSelect`/`disabled`/`tooltip`/`danger`) defined in Task 4 and used identically in Task 5. `resetApp` command name `reset_app` is consistent across Rust (Task 2), client/mock (Task 3), and UI (Task 6).
- **Backstop preserved:** transaction-referenced leaf deletes still surface the existing error toast (`del()` in `Categories.tsx`, `delete_category` in mock) — unchanged.
- **FK-safe delete order** in `reset_to_defaults`: transactions → child categories → categories → accounts → app_settings.
```
