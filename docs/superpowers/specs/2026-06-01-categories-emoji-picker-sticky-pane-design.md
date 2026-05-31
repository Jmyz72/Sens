# Categories: searchable emoji picker + sticky subcategories pane

**Date:** 2026-06-01
**Status:** Approved (brainstorm) — pending implementation plan
**Scope:** Frontend only. No backend, schema, command, or mock-backend changes.

## Summary

Two focused upgrades to the Categories screen (`src/screens/Categories.tsx`),
both pure-frontend:

1. **Searchable emoji picker** — replace the raw `maxLength={4}` text input in
   `CategoryForm` with a proper popover picker over the full Unicode emoji
   catalog (~1800), with keyword search, category groups, a recent row, and a
   finance "suggested" row. Built as a **reusable** component so AddAccount and
   future screens can adopt it.
2. **Sticky subcategories pane** — the right-hand detail pane follows the screen
   as the (potentially long) left category list scrolls, capped to viewport
   height with its own internal scroll so it can never run off-screen.

Explicitly **out of scope** (considered and dropped): per-category budgets,
spending analytics, inline list editing, list-level search/filter, keyboard
navigation of the category list, and hierarchy deeper than two levels.

## 1. Searchable emoji picker

### Data source — vendored generated JSON, zero runtime deps

The project is deliberately lean (5 runtime deps) and macOS-native in look. We
therefore bundle **data only**, never a third-party picker UI.

- Add `unicode-emoji-json` as a **devDependency only**.
- Add `scripts/gen-emoji.mjs`: reads `unicode-emoji-json`, emits
  `src/assets/emoji-data.json`. Each entry: `{ c: char, n: name, g: group,
  k: keywords[] }`. Groups follow Unicode's own ordering (Smileys & Emotion,
  People & Body, Animals & Nature, Food & Drink, Travel & Places, Activities,
  Objects, Symbols, Flags).
- The generated JSON is **committed** to the repo (reproducible, offline, no
  network at build or run time). `gen-emoji.mjs` is a one-shot regeneration tool,
  not part of the normal build.
- The JSON is **lazy-loaded** via dynamic `import("../assets/emoji-data.json")`
  inside the picker, so it never enters the initial bundle — it loads only when
  a user first opens the picker.

Rejected alternatives: `unicode-emoji-json` as a runtime dep (adds a runtime
dependency against the lean philosophy); hand-maintained list (user wants the
full catalog); emoji-mart or similar UI lib (fights the theme/aesthetic).

### Component — `src/components/EmojiPicker.tsx`

A reusable popover, themed entirely via `useTheme()` tokens (no hardcoded
colors except the data palette already permitted by CLAUDE.md). Public API:

```ts
interface EmojiPickerProps {
  value: string;                 // currently selected emoji ("" if none)
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>; // element to position against
}
```

Behavior and layout:

- **Popover**, ~320px wide, anchored to `anchorRef` (the trigger button),
  positioned below it with viewport-edge flipping; closes on outside-click and
  `Esc`. Rendered above the modal (Categories' `CategoryForm` is itself a
  `Modal`) — z-index must sit above the modal overlay.
- **Search input** at the top (autofocus). Filters the catalog by substring
  match over `name` + `keywords`. Typing collapses the grouped view into a flat
  result grid.
- **Recent row** — last-used emojis, persisted to `localStorage` under
  `sens.emoji.recent` (cap ~24, most-recent-first, deduped). Shown above the
  groups when search is empty. Selecting any emoji unshifts it into this list.
- **Suggested row** — a small curated finance set (e.g. 💰🏦🛒🍽️🚗🏠💡📱💊🎁
  📈💸…), shown when search is empty, so the common cases are one click away.
  This is a hardcoded data constant (acceptable per CLAUDE.md).
- **Grouped grid** — the full catalog under sticky group headers; vertical
  scroll within the popover body. Each cell is a tappable emoji button with a
  hover/selected highlight; the current `value` is marked selected.
- Selecting an emoji calls `onSelect`, updates recents, and closes.

Reusability: the component takes no Categories-specific props, so AddAccount or
any future screen can mount it against its own trigger. (Adoption elsewhere is
out of scope for this branch — we only wire it into Categories now.)

### Integration into `CategoryForm`

In `src/screens/Categories.tsx`, replace the emoji `<input>` (current lines
~122–127) with a **trigger button** that displays the current emoji (or a
placeholder glyph when empty) and matches `inputStyle`'s height/border. Clicking
it opens `EmojiPicker` anchored to that button. The picker's `onSelect` sets the
existing `emoji` state; the rest of the form (name, kind, color, validation,
`canSubmit` requiring a non-empty emoji) is unchanged.

## 2. Sticky subcategories pane

### Problem

The whole Categories screen lives in a single padded scroller
(`src/App.tsx:152`, `flex:1; overflow:auto; padding:24`). The two columns are
flex children with `alignItems:flex-start` already set. When the left top-level
list is long, the entire row scrolls and the right detail pane (subcategories)
scrolls off-screen with it.

### Fix — sticky pane, capped to viewport, internal scroll

Wrap the detail pane (`Categories.tsx` ~line 410, the `flex:1` right column) in
a container with:

```
position: sticky;
top: 0;                                  /* pins to top of the scroller content box */
max-height: calc(100vh - SHELL_OFFSET);  /* never taller than the visible area */
overflow: auto;                          /* long subcategory lists scroll inside */
```

- `SHELL_OFFSET` accounts for the TopBar height + scroller top/bottom padding
  (≈100px); the exact value is tuned by measurement during implementation.
- **Hero header pinned within the pane:** the category hero (`CategoryDetail`'s
  top block) becomes `position: sticky; top: 0` *inside* the scrollable pane, so
  the category name/emoji stays visible while its subcategory list scrolls.
- Short subcategory lists → the pane simply sticks. Long lists → the pane sticks
  *and* scrolls internally. Either way it stays on-screen.

This is the minimal change confirmed against the mock; the alternative
(viewport-locked independent-scroll columns) was rejected as a larger shell
change for no extra benefit here.

## Files touched

- `package.json` — add `unicode-emoji-json` devDependency.
- `scripts/gen-emoji.mjs` — new generator (one-shot).
- `src/assets/emoji-data.json` — new, committed generated data.
- `src/components/EmojiPicker.tsx` — new reusable component.
- `src/screens/Categories.tsx` — emoji trigger button wiring; sticky pane
  wrapper; pinned hero in `CategoryDetail`.

No changes to: Rust backend, `src/client/mock.ts`, DB migrations, `src/types.ts`.

## Testing / verification

- `npm run build` stays clean (strict TS, no unused locals/params).
- `npm test` — add a unit test for the emoji search/filter helper (substring
  over name + keywords) and the recents localStorage logic if extracted to a
  pure helper (e.g. `src/lib/emoji.ts`). Keep DOM-heavy popover behavior to
  manual verification.
- Manual: open New/Edit category → picker opens, search works, recent + suggested
  rows populate, selection updates the form; long category list keeps the
  subcategories pane on-screen with internal scroll and pinned hero.

## Out of scope (YAGNI)

Budgets, analytics, inline list editing, list-level search/filter, list keyboard
nav, deeper hierarchy. The picker gets internal search; broader keyboard nav of
the picker grid is optional polish, not required.
