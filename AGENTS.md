# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, Codex, …) working in this repo.
`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## What this is

Sens is a **local-first desktop personal-finance tracker** for Malaysian Ringgit (MYR).

- **Stack:** Tauri v2 (Rust) + React 19 + TypeScript + Vite + SQLite (`rusqlite`, bundled).
- **Scope:** manual entry only. No sync, no bank connections, no multi-currency.
- **Authoritative design:** `docs/superpowers/specs/2026-05-30-sens-desktop-finance-tracker-design.md`.
  Newer features each have a spec in `docs/superpowers/specs/`. **Read the relevant spec before
  changing data-model or business-rule behavior.**

> **No existing users.** There is no released user base and no production database.
> Do not add backfill, upgrade prompts, or conversion of old rows for a prior user base.
> Migrations stay append-only so a local dev DB and a fresh install reach the same schema.

## Commands

Rust is not on the default PATH. Prefix Rust/Tauri commands with `export PATH="$HOME/.cargo/bin:$PATH"`.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server in the **browser**, using the in-memory mock backend. Fastest way to see UI. |
| `npm run tauri dev` | The **real desktop app** (Rust backend + SQLite). Needs the Rust toolchain. |
| `npm run build` | `tsc` typecheck + `vite build`. The frontend gate; must stay clean (strict TS, `noUnusedLocals` / `noUnusedParameters`). |
| `npm test` | Vitest suite. `npm run test:watch` to watch. |
| `npx vitest run <file>` | One file, e.g. `src/lib/__tests__/format.test.ts`. Add `-t "signedFor"` to filter by name. |
| `cd src-tauri && cargo test --lib` | Rust service/repo tests. One test: `cargo test --lib settings_roundtrip`. CI adds `--locked`. |
| `cd src-tauri && cargo build` | Compile the desktop binary (validates command registration + config). |
| `npm run gen:seed-catalog` | Regenerate `src/generated/seed-catalog.json` from the Rust seed. |

Test locations: frontend tests in `src/lib/__tests__/`, release-tooling tests in `scripts/__tests__/`,
Rust tests as `#[cfg(test)]` in `src-tauri/src/lib.rs` and `src-tauri/src/db/mod.rs`.

## Architecture

Strict layering. **The UI never touches SQL.**

```
React UI (src/screens, src/modals, src/components)
  → typed client (src/client/index.ts)        one wrapper fn per command
    → dispatch seam (src/client/invoke.ts)     Tauri OR mock
      → Tauri commands (src-tauri/src/commands.rs)   thin, action-oriented
        → services (src-tauri/src/service.rs)        ALL business rules/validation
          → repositories (src-tauri/src/repo.rs)     ALL SQL + row→struct mapping
            → SQLite (src-tauri/src/db/)             migrations + idempotent seeds
```

### The Tauri / mock seam (the most important non-obvious thing)

In the desktop app, commands hit Rust. In a plain browser, `src/client/invoke.ts` routes to
`src/client/mock.ts`, an in-memory backend that mirrors the Rust logic.

> ⚠ **Any change to a command's behavior, signature, or args must be made in BOTH the Rust chain and
> the mock.** Otherwise browser-dev and the packaged app diverge.

Seed data is the exception. It is generated from Rust into `src/generated/seed-catalog.json`.
After editing `db/seed.rs` (or a migration that changes subtypes), run `npm run gen:seed-catalog`
and commit the JSON. CI fails if it is stale. Details: [backend.md](docs/architecture/backend.md#the-tauri--mock-seam).

## Hard rules

1. **Money is integer MYR cents** end to end. Format only at the edge (`src/lib/format.ts`).
2. **Balances are never stored.** They are the sum of an account's `postings` (double-entry).
3. **Liabilities are negative.** The backend speaks signed cents everywhere; the owe sign adapter is frontend-only.
4. **Business rules live in `service.rs`** and are mirrored in `mock.ts`. SQL lives only in `repo.rs`.
5. **The backend generates UUIDs and timestamps.** The frontend never sends them.
6. **Migrations are append-only.** Don't naively rebuild `transactions` (it cascade-deletes postings and splits). Use `ALTER … ADD COLUMN` or a new table; if a CHECK must change, copy `postings` and `transaction_splits` first (see migrations 011 and 012).
7. **Never hardcode colors** in components. Use `useTheme()` tokens (`src/theme/tokens.ts`). Color is never the only cue; pair it with sign + icon.
8. **Enriching default categories?** Append only, and bump a new `defaults_vN_seeded` gate.
9. **Don't remove `dragDropEnabled: false`** from `tauri.conf.json` (it makes drag-to-reorder work).
10. **Errors** are `AppError` (`{code, message}`). The TS client and the mock throw the same shape.

## Before you change X, read Y

| If you're changing… | Read |
|---|---|
| Transaction kinds, postings/balances, opening balance, time, splits, balance correction, dashboard totals | [`docs/architecture/transactions.md`](docs/architecture/transactions.md) |
| Account types/subtypes, signed liabilities, credit limits, providers | [`docs/architecture/accounts.md`](docs/architecture/accounts.md) |
| Categories, subcategories, system categories, the Categories screen, emoji picker | [`docs/architecture/categories.md`](docs/architecture/categories.md) |
| Commands, migrations, seeding, factory reset, the mock seam | [`docs/architecture/backend.md`](docs/architecture/backend.md) |
| Theming, app shell, Transactions screen, Add Transaction builder, updater, settings | [`docs/architecture/frontend.md`](docs/architecture/frontend.md) |
| What's planned or shipped | [`ROADMAP.md`](ROADMAP.md) and [`CHANGELOG.md`](CHANGELOG.md) |

## Releasing

Follows [`RELEASING.md`](RELEASING.md) and **GitHub Flow** (SemVer, `main` always releasable).

- Cut a release with `npm run release -- <major|minor|patch>`, or run the **Cut release** workflow
  (`gh workflow run "Cut release" -f level=minor`).
- The script bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `Cargo.lock`,
  rolls the CHANGELOG `[Unreleased]` section, commits, and tags. **Never hand-edit the version files.**
- Pushing the `v*` tag (`git push --follow-tags`) triggers `.github/workflows/release.yml`. It builds
  **macOS (Apple Silicon only) and Windows** bundles and publishes a GitHub Release with updater artifacts.
  - The macOS app is ad-hoc signed but **not notarized**, so Gatekeeper blocks first launch.
- The script only inserts the new CHANGELOG heading. **Add the `[x.y.z]` tag link and bump the
  `[Unreleased]` compare link at the bottom of `CHANGELOG.md` by hand.**
- `.github/workflows/ci.yml` gates every PR: `npm run build`, `npm test`, `cargo test --lib --locked`, `cargo build --locked`.

## Keeping docs in sync

> **Always update `CHANGELOG.md` and `ROADMAP.md`.** Do this in the same change as the code, every
> time, without being asked. Don't finish a task until both are current.

| File | What to update |
|---|---|
| `CHANGELOG.md` | Add an entry under `[Unreleased]` for every user-visible or behavior change (and notable docs/tooling changes). |
| `ROADMAP.md` | Tick the matching checklist item, move a finished phase into *Shipped* with its tag and spec link, and refresh the **Last shipped / Next up** block. Add any new idea to its phase or to *Later / unscheduled*. |

Also update, as relevant: the matching `docs/architecture/*.md` topic, the spec in
`docs/superpowers/specs/`, and `AGENTS.md` itself if a hard rule changed.
