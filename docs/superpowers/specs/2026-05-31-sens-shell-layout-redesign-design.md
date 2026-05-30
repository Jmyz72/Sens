# Sens Shell Layout Redesign — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) → ready for implementation plan
**Scope:** Frontend app shell only. **Theme tokens, fonts, and colors are unchanged.** No backend/Rust/mock-seam behavior changes (one config-level icon change to `tauri.conf.json` assets, no command changes).

## Goal

Rework the application shell — sidebar and top bar — for better ergonomics and a stronger brand mark, while preserving the existing dark/light theme system. Five concrete changes:

1. Make the left sidebar **collapsible** (full ↔ icon rail).
2. Make the top-bar **Add** action **Transaction-only** (no dropdown).
3. Move **account creation** to the **Accounts screen**.
4. Replace the app's **brand mark** (sparkle → "Coin S") in-app and regenerate the OS app icons.
5. **Remove the empty gap** above the sidebar logo.

Plus a structural cleanup: extract `Sidebar` and `TopBar` out of the oversized `App.tsx`.

## Non-goals (deferred / YAGNI)

- No theme, palette, font, or token changes.
- No keyboard shortcut for collapse (can add later).
- No flyout-on-hover sidebar expansion (tooltips only).
- No changes to any Rust command, service, repo, or the mock seam.
- No per-screen contextual top-bar toolbars beyond what exists today.

---

## 1. Collapsible sidebar

The sidebar has two states:

- **Expanded** — 220px, today's content with one trim (below): brand header, nav sections, net-worth card, theme toggle.
- **Collapsed (rail)** — ~56px, icon-only.

**Toggle.** A small chevron button lives in the sidebar header next to the brand mark — `‹` when expanded, `›` when collapsed. Clicking flips the state.

**Persistence.** The collapsed/expanded state is stored in `localStorage` under key `sens.sidebar` (values `"expanded" | "collapsed"`), read on mount and restored on launch. This mirrors the existing theme-mode persistence in `ThemeProvider.tsx` (`STORE_KEY`). Default on first run: **expanded**.

**Collapsed-state behavior:**
- Only nav **icons** show; the active item keeps its `accentSoft` background highlight and `accent`-colored icon.
- Nav **labels appear as hover tooltips** (a small label rendered on hover; native `title` is the minimum acceptable, a themed tooltip is preferred).
- The **net-worth card is hidden** (collapsing = focus mode).
- The three section headers (Overview / Money / System) are replaced by a thin `divider` line between groups.
- The brand mark and the theme-toggle (as an icon) remain, top and bottom respectively.
- Per-item **count badges** (accounts/categories) are suppressed in rail mode (no room); they return when expanded.

**Layout.** The main content area flexes to fill the reclaimed width. The width change animates (CSS transition on the sidebar width) and is disabled under `prefers-reduced-motion` — consistent with the existing base CSS in `ThemeProvider`.

**Net-worth card trim.** The card drops its bottom **"Accounts" count row** (and the `divider` above it), leaving **Net worth → Assets → Debts** only. The `activeAccountCount` value remains where it is still used (e.g. the Accounts nav badge); if the net-worth card was its only consumer, remove the now-unused computation to keep the strict-TS gate clean.

**Drag region.** The `data-tauri-drag-region` element at the sidebar top is preserved in **both** states so the window stays draggable from the chrome (see §5 for its height).

---

## 2. Top bar: Add → Transaction-only

Today the top-bar **Add** button opens a popover menu with "Transaction" and "Account". That popover is removed.

- The Add control becomes a **single direct button** that opens the **AddTransaction** modal immediately.
- The "Account" entry is removed from the top bar entirely (relocated — see §3).
- All other top-bar elements are unchanged: screen title/subtitle, and the dashboard-only month picker.

State/wiring: the `showTxn` flow in `App.tsx` is unchanged; only the intermediate Add-menu popover state and its "Account" branch are deleted.

---

## 3. Accounts screen owns account creation

- A primary **"Add account"** button is added to the Accounts screen header, beside the existing "Show archived" toggle (`src/screens/Accounts.tsx`).
- The `AddAccount` modal **moves into `Accounts.tsx`**: the screen owns a local `showAdd` state and renders `<AddAccount onClose=… onDone=…>` itself, calling its existing `afterMutation`/reload path on completion.
- `App.tsx` **drops** the `showAcct` state, the `AddAccount` import, and the `{showAcct && <AddAccount …/>}` render. Account creation is now exclusively an Accounts-screen concern, tightening the boundary.
- The empty-state hint changes from *"Create one from the Add menu."* to *"Create one with the Add account button."* (`Empty` in `Accounts.tsx`).

This is a pure UI relocation: `client.createAccount`, the `AddAccount` modal internals, and the backend are untouched.

---

## 4. New brand mark — "Coin S"

The mark is an **"S" struck into a coin**: a circle outline with an S-curve through it. Treatment matches the current logo — **cyan tile (`accent`) + dark glyph (`onAccent`)**.

**In-app:**
- Add the Coin S as a dedicated brand mark. Because it is two paths (circle + S-curve), it does not fit the single-path `P`-spread convention of `Icon.tsx`. Add it either as a new multi-path case in `Icon.tsx` (e.g. `"coin"`) or as a small dedicated `Brand`/`Logo` component under `src/components/`. Reference geometry (32×32 viewBox, `none` fill, `onAccent` stroke):
  - Circle: `cx=16 cy=16 r=11`, stroke-width ~2.4.
  - S-curve: `M20 12 C20 9.6 12.8 9 12.8 12.8 C12.8 15.8 19.6 15.3 19.6 18.8 C19.6 22.4 12.2 21.8 11.4 19.4`, stroke-width ~2.6, round caps.
- Replace the `<Icon name="sparkle" …>` in the sidebar header with the new mark. Used at 16px in the 30px tile (expanded) and in the rail (collapsed).
- The `"sparkle"` icon stays in `Icon.tsx` for any other uses; only the brand header swaps.

**OS / window app icons:**
- Author a 1024×1024 source PNG of the Coin S mark (cyan rounded tile, dark glyph) at `src-tauri/icons/source-icon.png` (or a tracked `assets/` path).
- Regenerate the platform icon set with the Tauri CLI: `export PATH="$HOME/.cargo/bin:$PATH" && npm run tauri icon <source>`. This overwrites `src-tauri/icons/*` (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, and the `Square*Logo.png`/`StoreLogo.png` set). The `tauri.conf.json` `bundle.icon` list already references these paths — no config edit needed beyond confirming the list.
- Validate by rebuilding the desktop binary so the new `.icns`/`.ico` are bundled.

---

## 5. Remove the gap above the logo

The empty band above the sidebar logo is the `data-tauri-drag-region` header, currently **46px** tall. It exists to clear the macOS traffic-light window controls (`titleBarStyle: "Overlay"`, `hiddenTitle: true`).

- Reduce the drag-region height from **46px → 28px** — enough to clear the macOS traffic lights while eliminating the visible empty gap, so the brand mark sits close to the top.
- Keep the brand-header block's own top padding minimal so the logo reads as anchored to the top.
- Verify on macOS that the traffic lights do not overlap the brand mark or the collapse chevron; if 28px proves tight in the real window, nudge up by a few px (document the final value).

---

## 6. Structural cleanup — extract Sidebar and TopBar

`src/App.tsx` is ~440 lines and currently holds shell layout, the sidebar, the top bar, the nav config, modal orchestration, and app-data wiring. Adding collapse logic increases this. To keep units focused:

- Extract **`src/components/Sidebar.tsx`** — brand header + collapse toggle, nav sections/rail, net-worth card, theme toggle. Props: active screen, `go`, nav data, accounts/categories counts, net-worth figures, collapsed state + setter.
- Extract **`src/components/TopBar.tsx`** — title/subtitle, dashboard month picker, the Transaction Add button. Props: active nav meta, month state + handlers, `onAddTransaction`.
- `App.tsx` retains: providers, app-data/state, the `localStorage`-backed sidebar collapse state, screen routing, and the AddTransaction modal — composing `<Sidebar>` and `<TopBar>`.

No behavior change from the extraction itself; it is a mechanical move plus the §1–§5 changes landing in the new homes.

---

## Files touched

| File | Change |
|------|--------|
| `src/App.tsx` | Sidebar collapse state (localStorage) + composition; remove Add-menu popover; remove `showAcct`/`AddAccount`; compose extracted components. |
| `src/components/Sidebar.tsx` *(new)* | Collapsible sidebar, brand mark, rail + tooltips, gap fix. |
| `src/components/TopBar.tsx` *(new)* | Top bar with Transaction-only Add. |
| `src/components/Icon.tsx` *(or new `Brand`)* | New Coin S brand mark. |
| `src/screens/Accounts.tsx` | "Add account" button + local `AddAccount` modal; empty-state hint. |
| `src-tauri/icons/*` | Regenerated from new Coin S source via `tauri icon`. |
| `src-tauri/icons/source-icon.png` *(new)* | 1024×1024 Coin S source. |
| `CLAUDE.md` | Update the frontend "shell" description (collapsible sidebar, Transaction-only Add, account-add on Accounts screen, brand mark). |
| `CHANGELOG.md` | New `[Unreleased]` entries. |

## Testing / verification

- `npm run build` — strict TS gate stays clean (no unused locals/params after the extraction and `showAcct` removal).
- `npm test` — existing Vitest suite stays green (no logic touched; shell is presentational).
- Manual (`npm run dev`, browser mock): toggle collapse and confirm persistence across reload; tooltips on rail; net worth hidden when collapsed; top-bar Add opens AddTransaction directly; Accounts "Add account" opens the modal and creates an account; empty-state copy; no visible gap above the logo.
- Manual (`npm run tauri dev`): traffic-light clearance at 28px; window still draggable from the sidebar header and top bar; new app icon shows in dock/taskbar after rebuild.

## Risks

- **macOS traffic-light overlap** at 28px — mitigated by visual check; the value is a documented knob.
- **Icon regeneration** overwrites the full `src-tauri/icons` set — verify the source mark looks correct at 32px before generating; commit the regenerated set together.
- **Extraction churn** — keep it mechanical; prop interfaces should be explicit and minimal so `Sidebar`/`TopBar` are understandable in isolation.
