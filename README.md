<div align="center">

# Sens

**A local-first desktop personal-finance tracker for Malaysian Ringgit (MYR).**

Track your accounts, transactions, and net worth — all on your own machine, no cloud, no bank logins, no subscription.

[![CI](https://github.com/Jmyz72/Sens/actions/workflows/ci.yml/badge.svg)](https://github.com/Jmyz72/Sens/actions/workflows/ci.yml)
[![Release](https://github.com/Jmyz72/Sens/actions/workflows/release.yml/badge.svg)](https://github.com/Jmyz72/Sens/actions/workflows/release.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)

</div>

---

## What is Sens?

Sens is a **manual** personal-finance tracker. You enter your accounts and transactions; Sens organises them, computes your balances and net worth, and shows you where your money goes each month. It is deliberately narrow:

- **Local-first** — your data lives in a single SQLite file on your machine. Nothing is sent anywhere.
- **MYR only** — all money is Malaysian Ringgit, stored as integer cents end-to-end (no floating-point rounding bugs).
- **Manual entry only** — no bank connections, no sync, no imports. You are in control of every number.
- **Desktop-native** — built with Tauri for a fast, lightweight macOS / Windows app.

> Looking for an **investment portfolio** tracker with market prices, multi-currency, and performance analytics? That's a different problem — Sens focuses on day-to-day cashflow and net worth.

## Screenshots

> _Add screenshots to [`docs/screenshots/`](./docs/screenshots/) and reference them here._

| Dashboard | Accounts | Transactions |
| --------- | -------- | ------------ |
| _coming soon_ | _coming soon_ | _coming soon_ |

## Features

- **Accounts** with a real taxonomy — 16 subtypes (cash, e-wallet, savings, current, fixed deposit, investment, unit trust, crypto, lent, borrowed, credit card, BNPL, personal/car/mortgage loans, and more) that classify into asset (`own`) vs. liability (`owe`) groups.
- **Transactions** — income, expense, transfer, and adjustment, all in integer MYR cents.
- **Computed balances** — balances are never stored; they're derived from each account's opening balance plus its signed transaction history.
- **Net worth** — assets + liabilities, shown live in the sidebar and on the dashboard.
- **Dashboard** — monthly income/expense, net cashflow, and spending breakdown (transfers & adjustments correctly excluded).
- **Categories** — manage your own spending/income categories.
- **Dark + light themes** — a macOS-native aesthetic with semantic theming.
- **Provider branding** — real provider logos (Maybank, Touch 'n Go, GrabPay, Wise, and more) when creating accounts.

## Tech stack

| Layer | Technology |
| ----- | ---------- |
| Shell | [Tauri v2](https://tauri.app) (Rust) |
| Frontend | React 19 + TypeScript + Vite |
| Backend | Rust |
| Database | SQLite (bundled, via `rusqlite`) |
| Tests | Vitest (frontend) + `cargo test` (backend) |

The codebase uses strict layering — the UI never touches SQL:

```
React UI (src/screens, src/modals, src/components)
  → typed client (src/client/index.ts)
    → dispatch seam (src/client/invoke.ts)        Tauri OR in-memory mock
      → Tauri commands (src-tauri/src/commands.rs)
        → services (src-tauri/src/service.rs)      all business rules
          → repositories (src-tauri/src/repo.rs)   all SQL
            → SQLite (src-tauri/src/db/)
```

## Download & install

Grab the latest build for your platform from the [**Releases**](https://github.com/Jmyz72/Sens/releases) page.

### macOS

Sens is **not notarized** by Apple (it's a free, open-source hobby project), so the first launch is blocked by Gatekeeper. After dragging **Sens.app** into **Applications**, do one of:

- **Right-click** (or Control-click) Sens.app → **Open** → **Open** in the dialog, or
- if you instead see **_"Sens is damaged and can't be opened"_**, that's just the macOS download-quarantine flag. Clear it once in Terminal:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Sens.app
  ```

  then open the app normally. (Adjust the path if you kept Sens.app somewhere other than `/Applications`.)

> This is expected for un-notarized apps and only needs doing once per download. Your data still stays entirely local.

## Getting started

> _Building from source. For a ready-to-run app, see [Download & install](#download--install) above._

### Prerequisites

- [Node.js](https://nodejs.org) (LTS) and npm
- The [Rust toolchain](https://www.rust-lang.org/tools/install) (for the desktop app) — `rustup` recommended
- Platform deps for Tauri: see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

### Run it

```bash
# Install frontend dependencies
npm install

# Fastest UI preview — runs in your browser against an in-memory mock backend
npm run dev

# The real desktop app — Rust backend + SQLite (requires the Rust toolchain)
npm run tauri dev
```

> On some setups Rust isn't on the default PATH. If `npm run tauri dev` can't find cargo, prefix with:
> `export PATH="$HOME/.cargo/bin:$PATH"`

### Build

```bash
npm run build        # tsc typecheck + vite build (the frontend gate)
npm run tauri build  # produce a packaged desktop binary
```

### Test

```bash
npm test                              # Vitest (frontend)
cd src-tauri && cargo test --lib      # Rust service/repo tests
```

## Documentation

- **Architecture & conventions** — [`CLAUDE.md`](./CLAUDE.md)
- **Design specs & implementation plans** — [`docs/superpowers/`](./docs/superpowers/)
- **Release process** — [`RELEASING.md`](./RELEASING.md)
- **Changelog** — [`CHANGELOG.md`](./CHANGELOG.md)
- **Contributing** — [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Security policy** — [`SECURITY.md`](./SECURITY.md)

## Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development workflow, coding conventions, and how to propose changes.

## License

Sens is licensed under the **GNU General Public License v3.0**. See [`LICENSE`](./LICENSE) for the full text.
