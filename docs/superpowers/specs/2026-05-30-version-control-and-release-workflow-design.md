# Version-Control & Release Workflow — Design

**Date:** 2026-05-30
**Status:** Approved, pending implementation
**Scope:** Process + tooling only. No application/data-model changes.

## Problem

Sens already practices SemVer and Keep-a-Changelog (tags `v1.0.0`/`v1.1.0`/`v1.1.1`,
a maintained `CHANGELOG.md`, Conventional-Commit-style messages, PR/issue usage).
But the process is undocumented and entirely manual, with two concrete risks:

1. **Three version files** (`package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`) must be hand-edited in lockstep on every release.
   Easy to miss one, and `Cargo.lock` goes stale when `Cargo.toml` changes.
2. **No CI** — nothing guarantees `main` is releasable, and no automation builds or
   publishes the Tauri desktop binaries. Releases are source-tag only today.

## Decisions (locked)

| Area | Decision |
|------|----------|
| Branching | **GitHub Flow** (trunk-based; `main` always releasable) |
| Versioning | **SemVer**, three version files kept byte-identical |
| Version bump | **`npm run release` script** (Node, no new deps) |
| Release artifacts | **GitHub Actions full release** via `tauri-apps/tauri-action` |
| OS targets | **macOS (Apple Silicon + Intel), Windows, Linux** |
| macOS signing | **Unsigned** for now (Gatekeeper right-click→Open on other Macs) |

## Design

### 1. Branching model — GitHub Flow

- `main` is always releasable; no long-lived `develop` branch.
- Short-lived branches named by Conventional-Commit type: `feat/…`, `fix/…`,
  `docs/…`, `chore/…`, `refactor/…`.
- Flow: branch → commit → **PR into `main`** → CI green → merge → delete branch.
- **Hotfix:** identical flow (branch from `main`, fix, PR), then cut a **patch** release.
- Commit messages follow **Conventional Commits**, which also signals the SemVer bump:
  `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major.

### 2. Versioning — SemVer

`MAJOR.MINOR.PATCH`. Breaking data-model/command changes → **major**; backward-compatible
features (e.g. the v1.1 account taxonomy) → **minor**; bug fixes (e.g. v1.1.1) → **patch**.
The three version files are **never hand-edited** — only the bump script writes them.

### 3. Version bump script — `scripts/release.mjs`

Plain Node ESM, zero new dependencies. Invoked as:

```
npm run release -- <major|minor|patch>      # or an explicit x.y.z
```

Steps performed:

1. Read current version from `package.json`; compute the next version
   (or use the explicit version argument). Validate it is strictly greater.
2. Rewrite the `version` field in all **three** files:
   - `package.json`
   - `src-tauri/Cargo.toml` (the `[package]` `version`)
   - `src-tauri/tauri.conf.json`
3. **Refresh `Cargo.lock`** by running `cargo update -p sens` (package name confirmed
   `sens`). Requires cargo on PATH (`export PATH="$HOME/.cargo/bin:$PATH"`); if cargo
   is unavailable the script aborts with a clear message rather than leaving a stale lock.
4. **Roll the CHANGELOG:** rename the top `## [Unreleased]` section to
   `## [x.y.z] — YYYY-MM-DD` and insert a fresh empty `## [Unreleased]` above it.
5. `git add` the touched files, commit `chore: release vX.Y.Z`, and create an
   **annotated tag** `vX.Y.Z`.
6. **Stop. Do not push.** Print the next step (`git push --follow-tags`).

**Guards:** abort if the working tree is dirty (uncommitted changes outside the bump),
if not on `main`, or if the target tag already exists.

### 4. CHANGELOG discipline

A permanent **`## [Unreleased]`** section lives at the top of `CHANGELOG.md`. Every PR
adds its line(s) under it. The release script just renames it to a dated version heading.
Implementation adds the `[Unreleased]` header to the current CHANGELOG (which starts at
`[1.1.1]`).

### 5. GitHub Actions — two workflows

**`.github/workflows/ci.yml`** — the gate that keeps `main` releasable.
- Triggers: `pull_request` and `push` to `main`.
- Job **frontend** (ubuntu): `npm ci` → `npm run build` (tsc + vite) → `npm test`.
- Job **rust** (ubuntu, with system deps for Tauri): `cargo test --lib` → `cargo build`
  in `src-tauri`. Cache cargo + npm for speed.

**`.github/workflows/release.yml`** — builds and publishes desktop binaries.
- Trigger: `push` of tags matching `v*`.
- Matrix using `tauri-apps/tauri-action`:
  - `macos-latest` (Apple Silicon, `aarch64-apple-darwin`)
  - `macos-13` (Intel, `x86_64-apple-darwin`)
  - `windows-latest`
  - `ubuntu-22.04` (installs webkit2gtk + build deps)
- Creates a **GitHub Release** named for the tag, uploads artifacts
  (`.dmg`/`.app.tar.gz`, `.msi`/`.exe`, `.AppImage`/`.deb`).
- **Unsigned:** no signing/notarization secrets. Document the macOS first-launch
  right-click→Open step in the release notes / RELEASING.md.
- Uses the built-in `GITHUB_TOKEN`; no extra secrets required.

### 6. Documentation — `RELEASING.md` + `CLAUDE.md` pointer

`RELEASING.md` (human-facing checklist):

1. Ensure `main` is green (CI passing).
2. Confirm `## [Unreleased]` in `CHANGELOG.md` lists everything in this release.
3. `export PATH="$HOME/.cargo/bin:$PATH" && npm run release -- <major|minor|patch>`.
4. Review the release commit diff + tag.
5. `git push --follow-tags`.
6. Watch the **Release** workflow; confirm the GitHub Release has all artifacts.
7. (macOS install note for recipients: right-click → Open on first launch.)

`CLAUDE.md` gets a one-line pointer under a new "Releasing" note:
> Releases follow `RELEASING.md` — use `npm run release -- <bump>`; never hand-edit the
> three version files; pushing a `v*` tag triggers the build/publish workflow.

## End-to-end loop

```
feature branch → PR → ci.yml green → merge to main
   → npm run release -- <bump>  (bumps 3 files + Cargo.lock + CHANGELOG, commits, tags)
   → review diff → git push --follow-tags
   → release.yml builds mac/Win/Linux → publishes GitHub Release with artifacts
```

## Out of scope (YAGNI)

- macOS code signing / notarization (revisit if distributing beyond personal use).
- Auto-update / Tauri updater endpoint.
- Release-notes auto-generation from commits (CHANGELOG is hand-curated).
- Git Flow `release/`/`hotfix/` long-lived branches.
