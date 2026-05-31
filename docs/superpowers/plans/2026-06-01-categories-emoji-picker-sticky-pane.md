# Categories Emoji Picker + Sticky Subcategories Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw emoji text input on the Categories screen with a reusable searchable emoji-picker popover, and make the subcategories detail pane stay on-screen (sticky, capped, internal scroll) as the category list scrolls.

**Architecture:** Frontend-only. A one-shot dev script generates a committed `emoji-data.json` from the `unicode-emoji-json` devDependency (zero runtime deps); the data is lazy-loaded. Pure filtering/recents logic lives in `src/lib/emoji.ts` (unit-tested); the popover UI lives in `src/components/EmojiPicker.tsx`; `CategoryForm` gets a trigger button; `CategoryDetail`/the detail column get sticky CSS. No backend, mock, schema, or `types.ts` changes.

**Tech Stack:** React 19 + TypeScript (strict), Vite, Vitest. Theme via `useTheme()` tokens. JSON import enabled (`resolveJsonModule: true`).

**Spec:** `docs/superpowers/specs/2026-06-01-categories-emoji-picker-sticky-pane-design.md`

---

## File Structure

- **Create** `scripts/gen-emoji.mjs` — one-shot generator; reads `unicode-emoji-json`, writes the data file. Not part of the build.
- **Create** `src/assets/emoji-data.json` — committed generated data: a flat array of `{ c, n, g, k }`.
- **Create** `src/lib/emoji.ts` — types + pure helpers: `filterEmojis`, `groupEmojis`, `loadRecents`, `pushRecent`, `SUGGESTED`. Holds all logic worth unit-testing.
- **Create** `src/lib/__tests__/emoji.test.ts` — Vitest unit tests for the helpers.
- **Create** `src/components/EmojiPicker.tsx` — reusable popover component (UI only; imports from `src/lib/emoji.ts`).
- **Modify** `src/screens/Categories.tsx` — emoji trigger button in `CategoryForm`; sticky wrapper around the detail column; pinned hero in `CategoryDetail`.
- **Modify** `package.json` — add `unicode-emoji-json` to `devDependencies`.

---

## Task 1: Generate and commit the emoji dataset

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `scripts/gen-emoji.mjs`
- Create: `src/assets/emoji-data.json` (generated output, committed)

- [ ] **Step 1: Add the dev dependency**

Run:
```bash
cd /Users/jimmyhew/Documents/Sens
npm install --save-dev unicode-emoji-json@^0.9.0
```
Expected: `package.json` gains `"unicode-emoji-json": "^0.9.0"` under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Write the generator script**

Create `scripts/gen-emoji.mjs`:
```js
// One-shot generator: builds src/assets/emoji-data.json from unicode-emoji-json.
// Run with `node scripts/gen-emoji.mjs`. Not part of the normal build — the
// JSON output is committed. Re-run only to refresh the emoji catalog.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const byEmoji = require("unicode-emoji-json/data-by-emoji.json");
const keywords = require("unicode-emoji-json/data-emoji-keywords.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "src", "assets", "emoji-data.json");

// Skip skin-tone component modifiers and the literal keycap component pieces;
// keep everything else in unicode order (data-by-emoji is already ordered).
const data = [];
for (const [char, info] of Object.entries(byEmoji)) {
  if (!info.group || info.group === "Component") continue;
  data.push({
    c: char,
    n: info.name,
    g: info.group,
    k: keywords[char] ?? [],
  });
}

writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${data.length} emojis to ${out}`);
```

- [ ] **Step 3: Run the generator**

Run:
```bash
cd /Users/jimmyhew/Documents/Sens && node scripts/gen-emoji.mjs
```
Expected: prints `Wrote <~1800> emojis to .../src/assets/emoji-data.json` and the file exists.

- [ ] **Step 4: Sanity-check the output shape**

Run:
```bash
cd /Users/jimmyhew/Documents/Sens && node -e "const d=require('./src/assets/emoji-data.json'); console.log(d.length, JSON.stringify(d[0]), JSON.stringify(d.find(e=>e.c==='💰')))"
```
Expected: a count > 1500, and entries shaped like `{"c":"😀","n":"grinning face","g":"Smileys & Emotion","k":["face","grin",...]}`. The 💰 entry resolves with group `Objects` (or similar) — confirms keyword join worked.

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add package.json package-lock.json scripts/gen-emoji.mjs src/assets/emoji-data.json
git commit -m "feat: generate committed emoji catalog (unicode-emoji-json, dev-only)"
```

---

## Task 2: Pure emoji helpers (`src/lib/emoji.ts`) with tests

**Files:**
- Create: `src/lib/emoji.ts`
- Test: `src/lib/__tests__/emoji.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/emoji.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { filterEmojis, groupEmojis, loadRecents, pushRecent, type EmojiEntry } from "../emoji";

const DATA: EmojiEntry[] = [
  { c: "😀", n: "grinning face", g: "Smileys & Emotion", k: ["face", "grin", "happy"] },
  { c: "🍕", n: "pizza", g: "Food & Drink", k: ["slice", "cheese"] },
  { c: "💰", n: "money bag", g: "Objects", k: ["dollar", "cash"] },
];

describe("filterEmojis", () => {
  it("returns all entries for an empty query", () => {
    expect(filterEmojis(DATA, "")).toHaveLength(3);
    expect(filterEmojis(DATA, "   ")).toHaveLength(3);
  });
  it("matches on name, case-insensitively", () => {
    expect(filterEmojis(DATA, "PIZZA").map((e) => e.c)).toEqual(["🍕"]);
  });
  it("matches on keywords", () => {
    expect(filterEmojis(DATA, "cash").map((e) => e.c)).toEqual(["💰"]);
  });
  it("returns empty when nothing matches", () => {
    expect(filterEmojis(DATA, "zzzzz")).toEqual([]);
  });
});

describe("groupEmojis", () => {
  it("buckets entries by group, preserving first-seen order", () => {
    const groups = groupEmojis(DATA);
    expect(groups.map((g) => g.group)).toEqual([
      "Smileys & Emotion",
      "Food & Drink",
      "Objects",
    ]);
    expect(groups[1].emojis.map((e) => e.c)).toEqual(["🍕"]);
  });
});

describe("recents", () => {
  beforeEach(() => localStorage.clear());
  it("returns [] when nothing stored", () => {
    expect(loadRecents()).toEqual([]);
  });
  it("pushes most-recent-first, dedupes, and caps at 24", () => {
    let r = pushRecent([], "😀");
    r = pushRecent(r, "🍕");
    r = pushRecent(r, "😀"); // re-select moves it to front, no dupe
    expect(r.slice(0, 2)).toEqual(["😀", "🍕"]);
    expect(r).toHaveLength(2);
    let big: string[] = [];
    for (let i = 0; i < 30; i++) big = pushRecent(big, `e${i}`);
    expect(big).toHaveLength(24);
    expect(big[0]).toBe("e29");
  });
  it("persists to localStorage and reloads", () => {
    pushRecent([], "💰");
    expect(loadRecents()).toEqual(["💰"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jimmyhew/Documents/Sens && npx vitest run src/lib/__tests__/emoji.test.ts`
Expected: FAIL — cannot resolve module `../emoji`.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/emoji.ts`:
```ts
// Pure emoji helpers for the picker: search, grouping, and a recents list
// persisted to localStorage. UI lives in src/components/EmojiPicker.tsx.

export interface EmojiEntry {
  c: string;       // the emoji character
  n: string;       // human name, e.g. "money bag"
  g: string;       // Unicode group, e.g. "Food & Drink"
  k: string[];     // search keywords
}

export interface EmojiGroup {
  group: string;
  emojis: EmojiEntry[];
}

const RECENTS_KEY = "sens.emoji.recent";
const RECENTS_CAP = 24;

// Finance-relevant quick picks shown above the groups when the search is empty.
// Hardcoded data constant (allowed per CLAUDE.md).
export const SUGGESTED = [
  "💰", "🏦", "💳", "🛒", "🍽️", "🚗", "🏠", "💡", "📱", "💊",
  "🎁", "📈", "💸", "✈️", "🎬", "👕", "📚", "🐶", "☕", "💵",
];

export function filterEmojis(data: EmojiEntry[], query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return data;
  return data.filter(
    (e) => e.n.toLowerCase().includes(q) || e.k.some((kw) => kw.toLowerCase().includes(q)),
  );
}

export function groupEmojis(data: EmojiEntry[]): EmojiGroup[] {
  const groups: EmojiGroup[] = [];
  const index = new Map<string, EmojiGroup>();
  for (const e of data) {
    let g = index.get(e.g);
    if (!g) {
      g = { group: e.g, emojis: [] };
      index.set(e.g, g);
      groups.push(g);
    }
    g.emojis.push(e);
  }
  return groups;
}

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(current: string[], emoji: string): string[] {
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENTS_CAP);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / unavailable storage */
  }
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/jimmyhew/Documents/Sens && npx vitest run src/lib/__tests__/emoji.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/lib/emoji.ts src/lib/__tests__/emoji.test.ts
git commit -m "feat: pure emoji search/group/recents helpers with tests"
```

---

## Task 3: The `EmojiPicker` popover component

**Files:**
- Create: `src/components/EmojiPicker.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/EmojiPicker.tsx`:
```tsx
// Reusable searchable emoji picker. Renders as a popover anchored to a trigger
// element. Loads the (committed) emoji catalog lazily on first open so it never
// enters the initial bundle. All colors come from theme tokens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Icon } from "./Icon";
import { inputStyle } from "./ui";
import {
  filterEmojis,
  groupEmojis,
  loadRecents,
  pushRecent,
  SUGGESTED,
  type EmojiEntry,
} from "../lib/emoji";

export function EmojiPicker({
  value,
  onSelect,
  onClose,
  anchorRef,
}: {
  value: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useTheme();
  const popRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<EmojiEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  // Lazy-load the catalog on mount (component only mounts when picker opens).
  useEffect(() => {
    let alive = true;
    import("../assets/emoji-data.json").then((m) => {
      if (alive) setData(m.default as EmojiEntry[]);
    });
    return () => { alive = false; };
  }, []);

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

  // Position the popover under the anchor, flipping up if it would overflow.
  const pos = useMemo(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return { top: 0, left: 0 };
    const W = 320, H = 360, gap = 6;
    let left = a.left;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    let top = a.bottom + gap;
    if (top + H > window.innerHeight - 8) top = Math.max(8, a.top - H - gap);
    return { top, left };
  }, [anchorRef]);

  const groups = useMemo(() => (data ? groupEmojis(data) : []), [data]);
  const results = useMemo(
    () => (data && query.trim() ? filterEmojis(data, query) : null),
    [data, query],
  );

  function choose(emoji: string) {
    setRecents((r) => pushRecent(r, emoji));
    onSelect(emoji);
    onClose();
  }

  const cell = (e: EmojiEntry | string) => {
    const ch = typeof e === "string" ? e : e.c;
    const title = typeof e === "string" ? undefined : e.n;
    const on = ch === value;
    return (
      <button key={ch} title={title} onClick={() => choose(ch)}
        style={{
          width: 34, height: 34, fontSize: 20, lineHeight: "34px", border: "none",
          borderRadius: 7, cursor: "pointer", background: on ? hexA(t.accent, 0.2) : "transparent",
          padding: 0,
        }}
        onMouseEnter={(ev) => (ev.currentTarget.style.background = t.panel2)}
        onMouseLeave={(ev) => (ev.currentTarget.style.background = on ? hexA(t.accent, 0.2) : "transparent")}>
        {ch}
      </button>
    );
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, color: t.faint, textTransform: "uppercase",
    letterSpacing: 0.5, padding: "10px 4px 4px",
  };

  return (
    <div ref={popRef} className="sens-pop"
      style={{
        position: "fixed", top: pos.top, left: pos.left, width: 320, zIndex: 200,
        background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column",
        maxHeight: 360, overflow: "hidden",
      }}>
      {/* Search */}
      <div style={{ padding: 10, borderBottom: `0.5px solid ${t.divider}`, position: "relative" }}>
        <Icon name="search" size={14} color={t.faint}
          style={{ position: "absolute", left: 20, top: 21 }} />
        <input className="sens-input" autoFocus value={query}
          onChange={(e) => setQuery(e.target.value)} placeholder="Search emoji"
          style={{ ...inputStyle(t), height: 34, paddingLeft: 32 }} />
      </div>

      {/* Body */}
      <div style={{ overflow: "auto", padding: "0 10px 10px" }}>
        {!data ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: t.faint }}>Loading…</div>
        ) : results ? (
          results.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: t.faint }}>No matches</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, paddingTop: 8 }}>
              {results.slice(0, 300).map(cell)}
            </div>
          )
        ) : (
          <>
            {recents.length > 0 && (
              <>
                <div style={sectionLabel}>Recent</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {recents.map((c) => cell(c))}
                </div>
              </>
            )}
            <div style={sectionLabel}>Suggested</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
              {SUGGESTED.map((c) => cell(c))}
            </div>
            {groups.map((g) => (
              <div key={g.group}>
                <div style={{ ...sectionLabel, position: "sticky", top: 0, background: t.panel, zIndex: 1 }}>
                  {g.group}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {g.emojis.map(cell)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build`
Expected: build succeeds (no TS errors, no unused-locals errors). If `Icon` does not accept a `style` prop, confirm via `src/components/Icon.tsx` — it does (`style?: CSSProperties` in its props). The component is not yet imported anywhere, which is fine.

- [ ] **Step 3: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/components/EmojiPicker.tsx
git commit -m "feat: reusable searchable EmojiPicker popover"
```

---

## Task 4: Wire the picker into `CategoryForm`

**Files:**
- Modify: `src/screens/Categories.tsx` (imports; the emoji field in `CategoryForm`, lines ~122–132)

- [ ] **Step 1: Add imports**

In `src/screens/Categories.tsx`, add to the existing import block near the top:
```tsx
import { useRef } from "react";
import { EmojiPicker } from "../components/EmojiPicker";
```
Note: `useState`, `useEffect`, `useMemo` are already imported from `"react"` on line 6 — add `useRef` there instead of a separate line if cleaner: change line 6 to
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
```
and add only the `EmojiPicker` import.

- [ ] **Step 2: Add picker state to `CategoryForm`**

Inside `CategoryForm` (after the existing `useState` hooks, near line 58), add:
```tsx
  const [pickerOpen, setPickerOpen] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
```

- [ ] **Step 3: Replace the emoji `<input>` with a trigger button + picker**

In `CategoryForm`, replace the emoji `Field` block (currently lines ~123–127):
```tsx
          <Field label="Emoji">
            <input className="sens-input" value={emoji} maxLength={4}
              onChange={(e) => setEmoji(e.target.value)} placeholder="😀"
              style={{ ...inputStyle(t), textAlign: "center", fontSize: 20 }} />
          </Field>
```
with:
```tsx
          <Field label="Emoji">
            <button ref={emojiBtnRef} type="button" className="sens-btn"
              onClick={() => setPickerOpen((o) => !o)}
              style={{ ...inputStyle(t), display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 20, cursor: "pointer" }}>
              {emoji || <span style={{ fontSize: 13, color: t.faint }}>Pick</span>}
            </button>
            {pickerOpen && (
              <EmojiPicker value={emoji} anchorRef={emojiBtnRef}
                onSelect={setEmoji} onClose={() => setPickerOpen(false)} />
            )}
          </Field>
```
Leave the surrounding `grid` wrapper, the Name field, kind buttons, color, and `canSubmit` (still requires a non-empty `emoji`) unchanged.

- [ ] **Step 4: Verify build**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build`
Expected: build succeeds. No unused-locals (the old centered-input style usage of `inputStyle` is still referenced by the new button).

- [ ] **Step 5: Manual verification**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run dev`, open the browser, go to Categories → **New**. Confirm: the Emoji field is now a button; clicking it opens the popover above the modal; search filters; selecting fills the button and closes; reopening shows the just-picked emoji under **Recent**; the form still saves.

- [ ] **Step 6: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/screens/Categories.tsx
git commit -m "feat: use EmojiPicker for category emoji selection"
```

---

## Task 5: Sticky subcategories pane + pinned hero

**Files:**
- Modify: `src/screens/Categories.tsx` — the detail column wrapper (lines ~409–430) and `CategoryDetail`'s hero block (lines ~493–516)

- [ ] **Step 1: Make the detail column sticky and viewport-capped**

In `Categories.tsx`, the detail column is currently:
```tsx
      {/* DETAIL PANE */}
      <div style={{ flex: 1, minWidth: 0 }}>
```
Replace that opening `<div>` with a sticky, capped, internally-scrolling container:
```tsx
      {/* DETAIL PANE — sticky so it follows the screen as the left list scrolls.
          Capped to the viewport with its own scroll so a long subcategory list
          can never run off-screen. SHELL_OFFSET ≈ TopBar + scroller padding. */}
      <div style={{
        flex: 1, minWidth: 0, position: "sticky", top: 0,
        maxHeight: "calc(100vh - 104px)", overflow: "auto",
      }}>
```
(The matching closing `</div>` for this block is unchanged.)

- [ ] **Step 2: Pin the hero inside the pane**

In `CategoryDetail`, the hero block currently starts:
```tsx
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
```
Make it stick to the top of the scrolling pane so the category stays visible while subcategories scroll:
```tsx
      {/* Hero — pinned to the top of the scrolling pane */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 18,
        borderBottom: `0.5px solid ${t.divider}`, position: "sticky", top: 0,
        background: t.panel, zIndex: 2 }}>
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual verification**

Run `npm run dev` (or reuse the running dev server), open Categories. With enough top-level categories to force the left list to scroll: scroll the page and confirm the subcategories pane stays pinned in view. Select a category with many subcategories (add several if needed) and confirm the pane caps at the viewport and scrolls internally, with the hero header staying pinned at the top of the pane. If the pane's top is clipped under the TopBar or floats too low, tune the `104px` offset in Step 1 until the top edge sits just below the TopBar.

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/screens/Categories.tsx
git commit -m "feat: sticky subcategories pane with internal scroll and pinned hero"
```

---

## Task 6: Final gate + docs

**Files:**
- Modify: `CHANGELOG.md` (add entries under `[Unreleased]`)
- Modify: `CLAUDE.md` (Categories/frontend notes) — only if the picker/sticky behavior is worth recording per the project's "always update documentation" rule

- [ ] **Step 1: Full test + typecheck gate**

Run:
```bash
cd /Users/jimmyhew/Documents/Sens && npm test && npm run build
```
Expected: all Vitest tests pass; build clean.

- [ ] **Step 2: Update the CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add:
```markdown
- Searchable emoji picker for categories (full Unicode catalog, recent + suggested rows).
```
and under `### Changed` (create the heading if absent):
```markdown
- Categories: the subcategories pane now stays on-screen (sticky, internal scroll) while the category list scrolls.
```

- [ ] **Step 3: Update CLAUDE.md (Categories notes)**

In `CLAUDE.md`, in the subcategories paragraph that describes `src/screens/Categories.tsx` as a master–detail layout, append a sentence:
```markdown
The emoji field uses a reusable searchable popover (`src/components/EmojiPicker.tsx`) backed by a committed, lazy-loaded catalog (`src/assets/emoji-data.json`, regenerated via `scripts/gen-emoji.mjs`; `unicode-emoji-json` is a dev-only dependency). The detail (subcategories) pane is sticky and viewport-capped so it follows the screen as the category list scrolls.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: changelog + CLAUDE.md notes for emoji picker and sticky pane"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** data source (Task 1), pure helpers + tests (Task 2), component with search/recent/suggested/groups (Task 3), CategoryForm integration (Task 4), sticky pane + pinned hero (Task 5), build/test gate + docs (Task 6). All spec sections map to a task.
- **Type consistency:** `EmojiEntry { c, n, g, k }` is defined once in `src/lib/emoji.ts` and imported by the test, the component, and the generator output shape. `filterEmojis`/`groupEmojis`/`loadRecents`/`pushRecent`/`SUGGESTED` names are identical across helper, tests, and component.
- **No backend touch:** no changes to `mock.ts`, Rust, migrations, or `types.ts` — emoji is already a plain string on `Category`.
- **Lean-deps guard:** `unicode-emoji-json` is dev-only; runtime imports only the committed JSON.
