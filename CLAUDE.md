# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sens is a **local-first desktop personal-finance tracker** for Malaysian Ringgit (MYR). Stack: **Tauri v2 (Rust) + React 19 + TypeScript + Vite + SQLite (rusqlite, bundled)**. v1 is manual entry only — no sync, no bank connections, no multi-currency. The authoritative design/spec lives at `docs/superpowers/specs/2026-05-30-sens-desktop-finance-tracker-design.md`; read it before changing data-model or business-rule behavior.

## Commands

Rust is not on the default PATH — prefix Rust/Tauri commands with `export PATH="$HOME/.cargo/bin:$PATH"`.

- `npm run dev` — Vite dev server in the **browser** (uses the in-memory mock backend; see seam below). Fastest way to see UI.
- `npm run tauri dev` — the **real desktop app** (Rust backend + SQLite). Requires the Rust toolchain.
- `npm run build` — `tsc` typecheck + `vite build`. This is the frontend gate; must stay clean (strict TS, `noUnusedLocals`/`noUnusedParameters`).
- `npm test` — Vitest suite (`vitest run`). `npm run test:watch` to watch. Run a single file: `npx vitest run src/__tests__/format.test.ts`. Filter by name: `npx vitest run -t "signedFor"`.
- `cd src-tauri && cargo test --lib` — Rust service/repo tests (in `src-tauri/src/lib.rs` `#[cfg(test)]`). Run one: `cargo test --lib settings_roundtrip`.
- `cd src-tauri && cargo build` — compile the desktop binary (validates Tauri command registration + config).

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
- **Dashboard excludes transfers AND adjustments** from income/expense/net-cashflow/spending-breakdown; they affect balances only. Total balance excludes archived accounts.
- **Balance correction** (`set_account_balance`): no transactions → edits opening balance; with transactions → inserts a signed `adjustment` dated today.

### Backend conventions
- Backend is the source of truth for **UUIDs and timestamps** (generated in Rust, never sent from the frontend). Structs serialize `rename_all = "camelCase"` to match TS types in `src/types.ts`.
- Errors: `AppError` (`ValidationError | NotFound | Conflict | DatabaseError`) serializes to `{code, message}`; the TS `AppError` and the mock throw the same shape. Surface via toast (page-level) or inline (form-level).
- DB lives in the Tauri app-data dir; every connection sets `PRAGMA foreign_keys = ON`. Migrations are append-only in `db/migrations.rs`, each in its own transaction; first-run seeding + the `seeded` flag commit atomically. **Default categories seed once** (idempotent insert-or-ignore on the unique `(kind, name)` index); **system categories cannot be archived**.

### Current account-type caveat
`account_type` (bank/digital_bank/ewallet/bnpl/investment/global_fintech/custom) and `subtype` exist on accounts and are derived from the chosen template, but in v1 they are **labels only — they drive no behavior**; every account is treated as a cash asset. (Asset/liability semantics for credit/BNPL/loans are a known future consideration, not yet implemented.)

### Frontend conventions
- Theming: `src/theme/tokens.ts` defines semantic tokens for **dark (default) + light**; `ThemeProvider.tsx` injects base CSS and persists the mode to `localStorage`. **Never hardcode colors in components** — use `useTheme()` tokens. The only allowed raw hex is data constants (`src/lib/brand.ts` provider brand colors, category color palettes).
- The UI color system maps kinds to tokens (income green / expense red / transfer blue / adjustment amber); color is never the only cue — amounts also carry sign + icon (`src/lib/kinds.ts`, `src/components/TxnRow.tsx`).
- New work uses the existing atoms in `src/components/ui.tsx` (Card, Btn, Modal, Money, GlyphTile, …) and the macOS-native aesthetic.
