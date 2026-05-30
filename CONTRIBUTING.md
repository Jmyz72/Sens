# Contributing to Sens

Thanks for your interest in improving Sens! This guide covers how to set up your environment, the conventions to follow, and how to get changes merged.

## Project philosophy

Sens is deliberately **narrow in scope**: a manual, local-first, MYR-only personal-finance tracker. Before proposing a feature, check that it fits this scope — things like bank sync, multi-currency, cloud, or investment-performance analytics are intentionally **out of scope**. When in doubt, open an issue to discuss first.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org) (LTS) + npm
- The [Rust toolchain](https://www.rust-lang.org/tools/install) (`rustup` recommended)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform

> Rust may not be on your default PATH. If Tauri/cargo commands fail to resolve, prefix them with:
> `export PATH="$HOME/.cargo/bin:$PATH"`

### Common commands

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Vite dev server in the **browser** (in-memory mock backend — fastest UI loop) |
| `npm run tauri dev` | The **real desktop app** (Rust backend + SQLite) |
| `npm run build` | `tsc` typecheck + `vite build` — the frontend gate, must stay clean |
| `npm test` | Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `cd src-tauri && cargo test --lib` | Rust service/repo tests |
| `cd src-tauri && cargo build` | Compile the desktop binary (validates Tauri command registration) |

Run a single frontend test file: `npx vitest run src/__tests__/format.test.ts`
Filter by name: `npx vitest run -t "signedFor"`
Run one Rust test: `cargo test --lib settings_roundtrip`

## Architecture you must respect

Sens uses **strict layering — the UI never touches SQL**:

```
React UI → typed client → dispatch seam → Tauri commands → services → repositories → SQLite
```

- **All money is integer MYR cents** end-to-end. Only format at the edge via `src/lib/format.ts`.
- **Balances are never stored** — they're computed from opening balance + signed history.
- The backend is the source of truth for **UUIDs and timestamps** — never send them from the frontend.

### The Tauri/mock seam (most important rule)

`src/client/invoke.ts` routes to the **real Rust backend** inside Tauri, or to an **in-memory mock** (`src/client/mock.ts`) in a plain browser. **Any change to a command's behavior, signature, or args must be made in BOTH the Rust chain and the mock**, or browser-dev and the packaged app will diverge. The mock is dev-only and never ships.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and conventions, and [`docs/superpowers/specs/`](./docs/superpowers/specs/) for design specs. **Read the relevant spec before changing data-model or business-rule behavior.**

### Frontend conventions

- **Never hardcode colors** — use `useTheme()` semantic tokens from `src/theme/tokens.ts`. The only allowed raw hex is data constants (brand colors, category palettes).
- Reuse the existing UI atoms in `src/components/ui.tsx` (Card, Btn, Modal, Money, …) and the macOS-native aesthetic.
- TypeScript is strict (`noUnusedLocals` / `noUnusedParameters`) — the build must stay clean.

## Workflow

Sens follows **[GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow)** with **[SemVer](https://semver.org)**; `main` is always releasable.

1. **Fork** the repo and create a topic branch off `main` (e.g. `feat/credit-utilization`, `fix/dashboard-totals`).
2. **Write tests first** where practical, and keep both the frontend (`npm test`) and backend (`cargo test --lib`) suites green.
3. **Keep the build clean** — `npm run build` must pass.
4. **Update documentation** — keep `CLAUDE.md`, the relevant spec, and `CHANGELOG.md` (`[Unreleased]` section) in sync with your change.
5. **Open a Pull Request** against `main` using the PR template. Link any related issue.

### Commit & PR conventions

- Use clear, conventional-style commit subjects where possible (`feat:`, `fix:`, `docs:`, `chore:`, `polish:`…).
- Keep PRs focused — one logical change per PR is easier to review.
- CI (`.github/workflows/ci.yml`) gates every PR; make sure it's green.

> **Do not hand-edit version files.** Releases are cut by maintainers via `npm run release -- <major|minor|patch>` (see [`RELEASING.md`](./RELEASING.md)), which bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `Cargo.lock` together.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Jmyz72/Sens/issues/new/choose). For security vulnerabilities, **do not open a public issue** — see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the project's [GPL-3.0 license](./LICENSE).
