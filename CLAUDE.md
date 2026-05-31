# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sens is a **local-first desktop personal-finance tracker** for Malaysian Ringgit (MYR). Stack: **Tauri v2 (Rust) + React 19 + TypeScript + Vite + SQLite (rusqlite, bundled)**. Manual entry only — no sync, no bank connections, no multi-currency. The authoritative design/spec lives at `docs/superpowers/specs/2026-05-30-sens-desktop-finance-tracker-design.md`; **v0.2.0** then added the account taxonomy (asset/liability classification + net worth) — see `docs/superpowers/specs/2026-05-30-account-type-subtype-system-design.md`. Read the relevant spec before changing data-model or business-rule behavior.

## Commands

Rust is not on the default PATH — prefix Rust/Tauri commands with `export PATH="$HOME/.cargo/bin:$PATH"`.

- `npm run dev` — Vite dev server in the **browser** (uses the in-memory mock backend; see seam below). Fastest way to see UI.
- `npm run tauri dev` — the **real desktop app** (Rust backend + SQLite). Requires the Rust toolchain.
- `npm run build` — `tsc` typecheck + `vite build`. This is the frontend gate; must stay clean (strict TS, `noUnusedLocals`/`noUnusedParameters`).
- `npm test` — Vitest suite (`vitest run`). `npm run test:watch` to watch. Run a single file: `npx vitest run src/__tests__/format.test.ts`. Filter by name: `npx vitest run -t "signedFor"`.
- `cd src-tauri && cargo test --lib` — Rust service/repo tests (in `src-tauri/src/lib.rs` `#[cfg(test)]`). Run one: `cargo test --lib settings_roundtrip`.
- `cd src-tauri && cargo build` — compile the desktop binary (validates Tauri command registration + config).

## Releasing

Releases follow `RELEASING.md` and **GitHub Flow** (SemVer, `main` always releasable).
Use `npm run release -- <major|minor|patch>` to cut a release — it bumps all three
version files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) plus
`Cargo.lock`, rolls the CHANGELOG `[Unreleased]` section, commits, and tags. **Never
hand-edit the version files.** Pushing the resulting `v*` tag (`git push --follow-tags`)
triggers `.github/workflows/release.yml`, which builds unsigned macOS/Windows
binaries and publishes a GitHub Release. `.github/workflows/ci.yml` gates every PR.

## Architecture

Strict layering, UI never touches SQL:

```
React UI (src/screens, src/modals, src/components)
  → typed client (src/client/index.ts)        one wrapper fn per command
    → dispatch seam (src/client/invoke.ts)     Tauri OR mock
      → Tauri commands (src-tauri/src/commands.rs)   thin, action-oriented
        → services (src-tauri/src/service.rs)        ALL business rules/validation
          → repositories (src-tauri/src/repo.rs)     ALL SQL + row→struct mapping
            → SQLite (src-tauri/src/db/)             migrations + idempotent seeds
```

### The Tauri/mock seam (most important non-obvious thing)
`src/client/invoke.ts` checks for `window.__TAURI_INTERNALS__`. In Tauri it calls the real Rust commands; in a plain browser it routes to **`src/client/mock.ts`**, an in-memory backend that mirrors the Rust logic (seeds, balance math, validation, errors). **Any change to a command's behavior, signature, or args must be made in BOTH the Rust chain and the mock**, or browser-dev and the packaged app diverge. The mock is dev-only and never ships.

### Money, balances, and transaction kinds
- All money is **integer MYR cents** end-to-end. Format only at the edge via `src/lib/format.ts` (`fmtMoney`, `parseAmountToCents`).
- Transaction `kind` ∈ `income | expense | transfer | adjustment`. Balances are **never stored** — an account's balance is computed on read as opening + signed history (`balance_expr` in `repo.rs`; mirrored by `balanceOf` in `mock.ts`, and by `computeRunningBalances` / `signedFor` in `src/lib/kinds.ts` for the per-account "balance after" column). Transfer = `-amount` on source, `+amount` on destination; `adjustment.amount_cents` is signed (others are positive, enforced by a table CHECK).
- **Signed liabilities (v0.2.0):** liability (`owe`-group) accounts carry **negative** balances; the balance engine above is **identical for every account** — `type`/`group` only classify and present. The owe sign adapter is frontend-only: `balanceDisplay` (`src/lib/accounts.ts`) renders an owe balance as a positive "You owe RMx" (or "In credit" when overpaid), and AddAccount/SetBalance negate the positive "Amount owed" input before sending. The backend speaks **signed cents everywhere** and never enforces sign-by-group.
- **Dashboard excludes transfers AND adjustments** from income/expense/net-cashflow/spending-breakdown; they affect balances only. The dashboard reports **net worth = assets + liabilities** (`assetsCents` = Σ `own`-group balances; `liabilitiesCents` = Σ `owe`-group balances, already negative; `netWorthCents` = their sum); all exclude archived accounts.
- **Balance correction** (`set_account_balance`): no transactions → edits opening balance; with transactions → inserts a signed `adjustment` dated today. Takes a **signed** target; the frontend negates the "Amount owed" input for `owe` accounts.
- **Subcategories (v0.4.0):** `categories.parent_id` (nullable self-FK, migration 003) gives a **two-level** hierarchy — a top-level category (`parent_id IS NULL`) may have subcategories, but a subcategory cannot. A subcategory **inherits its parent's `kind`**; both invariants (parent-must-be-top-level, child-kind = parent-kind) are enforced in the **service layer** (`create_category`), mirrored in `mock.ts`, not by DB constraints. Uniqueness is **per-sibling** via two partial indexes: `idx_categories_top_kind_name` on `(kind, name) WHERE parent_id IS NULL` and `idx_categories_sub_parent_name` on `(parent_id, name) WHERE parent_id IS NOT NULL`. Transactions may reference a **parent or a subcategory** (no migration of existing data). Archiving a top-level category **cascades** archive/restore to its children (`set_children_archived`). The Dashboard spending breakdown **rolls subcategory spend up into the parent** (`GROUP BY COALESCE(parent_id, id)`, self-joined to label with the parent). The Categories screen (`src/screens/Categories.tsx`) is a **master–detail** layout; the transaction picker (`src/modals/AddTransaction.tsx`) groups subcategories indented under their parent via `categoryPickerItems`/`categoryTree` in `src/lib/categories.ts`. **v0.4.1 made categories fully user-managed** — Delete (any category with no subcategories and no transactions; FK `ON DELETE RESTRICT` is the backstop), drag-to-reorder (`reorder_categories`), move/convert via `set_category_parent` (new parent must be top-level and same kind; the moved category must be a leaf), and bulk archive/restore (`set_categories_archived`). The `is_system` flag was dropped (migration 004). The category form's emoji field uses a reusable searchable popover (`src/components/EmojiPicker.tsx`, logic in `src/lib/emoji.ts`) backed by a committed, lazy-loaded catalog (`src/assets/emoji-data.json`, regenerated via `scripts/gen-emoji.mjs`; `emojibase-data` is a dev-only dependency providing keyword tags — runtime ships no emoji dependency). The detail (subcategories) pane is **sticky** and viewport-capped with its own scroll and a pinned hero, so it follows the screen as the category list scrolls. Per-category and per-subcategory actions (archive, move, delete, …) are surfaced via a reusable **`ActionMenu`** ("⋯") popover (`src/components/ActionMenu.tsx`); Delete is always shown but rendered disabled with an explanatory tooltip when a top-level category still has subcategories.

### Backend conventions
- Backend is the source of truth for **UUIDs and timestamps** (generated in Rust, never sent from the frontend). Structs serialize `rename_all = "camelCase"` to match TS types in `src/types.ts`.
- Errors: `AppError` (`ValidationError | NotFound | Conflict | DatabaseError`) serializes to `{code, message}`; the TS `AppError` and the mock throw the same shape. Surface via toast (page-level) or inline (form-level).
- DB lives in the Tauri app-data dir; every connection sets `PRAGMA foreign_keys = ON`. Migrations are append-only in `db/migrations.rs`, each in its own transaction; first-run seeding + the `seeded` flag commit atomically. **Default categories and subcategories seed once** on first run and are **backfilled to existing users** via a gated step (`defaults_v2_seeded`, idempotent INSERT OR IGNORE so deleted defaults don't resurrect); all defaults are normal (non-system) rows that users can archive or delete. Top-level categories are deduped by the partial unique index `idx_categories_top_kind_name` on `(kind, name) WHERE parent_id IS NULL`. A `reset_app` command (`service::reset_app` → `db::reset_to_defaults`) performs a factory reset: wipes `transactions`/`categories`/`accounts`/`app_settings` in one transaction and re-runs the idempotent seed, re-setting the `seeded`/`defaults_v2_seeded` flags; mirrored by `resetApp()` in `mock.ts`.

### Account taxonomy: subtype → type → group (v0.2.0)
Each account stores a single classifier, **`subtype`** (16 of them: cash/ewallet/savings/current, fixed-deposit/investment/unit-trust/crypto, lent, borrowed, credit-card/bnpl/personal-loan/mortgage/car-loan/other-debt). It maps to a derived **`type`** (`fund | financial | receivable | payable | credit`) and **`group`** (`own | owe`). The canonical mapping is the **`account_subtypes`** reference table — created + seeded by **migration 002**, mirrored by `SUBTYPE_ROWS` in `mock.ts`. `type`/`group` are **derived on read via JOIN**, never stored on `accounts`, and exposed on the serialized `Account` (the `accountType` field holds the *type*; plus `group`). Subtype validity is enforced in the **service layer** (`subtype_exists` on create/update), not a DB foreign key (a FK would require an accounts-table rebuild the in-transaction migration runner can't do).

- **Create:** the unified **`create_account(name, subtype, openingBalanceCents, templateKey?)`** command (replaced the old `create_account_from_template` / `create_custom_account`). The taxonomy is read via **`list_account_subtypes`**.
- **Providers are branding only:** a template's `group_name` just organizes the provider picker and `default_subtype` is a *suggestion* — the template no longer determines type. Same provider (e.g. Maybank) can back a savings account *or* a credit card.
- **Frontend:** display helpers `TYPE_LABEL` / `TYPE_ORDER` / `balanceDisplay` / `toneColor` live in `src/lib/accounts.ts`; the Accounts screen groups by type, AddAccount/EditAccount pick type → subtype.

Per-subtype **behavior** (credit limits & utilization, installment/payoff schedules, interest, investment cost-vs-value) is **deferred** to later phases — v0.2.0 is classification + net worth only. See `ROADMAP.md` for the phase plan (these land in v0.5.0/v0.6.0).

### Frontend conventions
- Theming: `src/theme/tokens.ts` defines semantic tokens for **dark (default) + light**; `ThemeProvider.tsx` injects base CSS and persists the mode to `localStorage`. **Never hardcode colors in components** — use `useTheme()` tokens. The only allowed raw hex is data constants (`src/lib/brand.ts` provider brand colors, category color palettes).
- The UI color system maps kinds to tokens (income green / expense red / transfer blue / adjustment amber); color is never the only cue — amounts also carry sign + icon (`src/lib/kinds.ts`, `src/components/TxnRow.tsx`).
- New work uses the existing atoms in `src/components/ui.tsx` (Card, Btn, Modal, Money, GlyphTile, …) and the macOS-native aesthetic.
- The app **shell** is composed in `src/App.tsx` from `src/components/Sidebar.tsx` (collapsible: full 220px ↔ 56px icon rail with hover tooltips, collapse state persisted to `localStorage` under `sens.sidebar`; net-worth card shown only when expanded) and `src/components/TopBar.tsx` (title/subtitle, dashboard month picker, and a **Transaction-only** Add button). Nav config lives in `src/nav.ts`; the brand mark is `src/components/Brand.tsx` (Coin S). **Account creation lives on the Accounts screen** (`src/screens/Accounts.tsx` owns the `AddAccount` modal), not the top bar. `AddAccount` is a **two-step, provider-first** flow: Step 1 picks a provider (branding only) or "Custom account" from a searchable logo grid; Step 2 picks type → subtype (visual type-card picker + chips), name (pre-filled from the provider, editable), and opening balance. Only `subtype` is persisted — the type cards filter the chips. Provider logos are bundled SVGs in `src/assets/logos/<key>.svg`, resolved by `src/lib/logos.ts` (`logoFor`) and rendered by `src/components/ProviderLogo.tsx` (real logo on a white plate; brand-tinted monogram fallback when no logo is bundled). Logo coverage is best-effort, not exhaustive. The frontend provider catalog `src/lib/providers.ts` mirrors the Rust seed and feeds the mock; `ProviderLogo` is also used on the Accounts list rows.
