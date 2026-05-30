# Version-Control & Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repeatable, mostly-automated release process for Sens: a `npm run release` bump script that keeps all three version files + `Cargo.lock` + CHANGELOG in sync, two GitHub Actions workflows (CI gate + tag-triggered desktop-binary release), and human/agent-facing docs.

**Architecture:** Pure version-manipulation functions live in `scripts/release-lib.mjs` (unit-tested with Vitest). A thin CLI orchestrator `scripts/release.mjs` reads/writes the real files and runs git/cargo (guarded, never pushes). CI (`ci.yml`) keeps `main` releasable; `release.yml` builds unsigned binaries via `tauri-apps/tauri-action` on a `v*` tag push and publishes a GitHub Release. Docs go in `RELEASING.md` with a pointer in `CLAUDE.md`.

**Tech Stack:** Node 22 ESM (no new deps), Vitest, GitHub Actions, `tauri-apps/tauri-action@v0`, `dtolnay/rust-toolchain`, `Swatinem/rust-cache`.

**Spec:** `docs/superpowers/specs/2026-05-30-version-control-and-release-workflow-design.md`

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `CHANGELOG.md` | Add a permanent `## [Unreleased]` section the script rolls forward | Modify |
| `scripts/release-lib.mjs` | Pure functions: bump math + version-string rewriting + changelog roll | Create |
| `scripts/__tests__/release-lib.test.ts` | Unit tests for the pure functions | Create |
| `scripts/release.mjs` | CLI orchestrator: guards → rewrite files → cargo → commit + tag | Create |
| `package.json` | Add `"release"` npm script | Modify |
| `.github/workflows/ci.yml` | PR/push gate: frontend build+test, rust test+build | Create |
| `.github/workflows/release.yml` | Tag-triggered cross-platform build + GitHub Release | Create |
| `RELEASING.md` | Human release checklist | Create |
| `CLAUDE.md` | One-line pointer to the release process | Modify |

Note: `scripts/*.mjs` are intentionally NOT TypeScript and NOT under `src/`, so `npm run build` (tsc, `include: ["src"]`) never touches them. Vitest's default glob still discovers the `.test.ts` under `scripts/__tests__/`.

---

## Task 1: Add `[Unreleased]` section to CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (insert between the intro paragraph and `## [1.1.1]`)

- [ ] **Step 1: Add the Unreleased heading**

Use Edit on `CHANGELOG.md`. Find this exact block:

```
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-05-30
```

Replace with:

```
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] — 2026-05-30
```

- [ ] **Step 2: Verify the section exists**

Run: `grep -n '## \[Unreleased\]' CHANGELOG.md`
Expected: one matching line (e.g. `8:## [Unreleased]`).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add [Unreleased] section to CHANGELOG"
```

---

## Task 2: Pure release-lib functions (TDD)

**Files:**
- Create: `scripts/release-lib.mjs`
- Test: `scripts/__tests__/release-lib.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/release-lib.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  bumpVersion,
  isGreater,
  setPackageJsonVersion,
  setCargoTomlVersion,
  setTauriConfVersion,
  rollChangelog,
} from "../release-lib.mjs";

describe("bumpVersion", () => {
  it("bumps patch", () => expect(bumpVersion("1.1.1", "patch")).toBe("1.1.2"));
  it("bumps minor and zeroes patch", () => expect(bumpVersion("1.1.1", "minor")).toBe("1.2.0"));
  it("bumps major and zeroes minor+patch", () => expect(bumpVersion("1.1.1", "major")).toBe("2.0.0"));
  it("accepts an explicit version", () => expect(bumpVersion("1.1.1", "1.5.0")).toBe("1.5.0"));
  it("rejects an unknown level", () => expect(() => bumpVersion("1.1.1", "huge")).toThrow());
  it("rejects a malformed current version", () => expect(() => bumpVersion("1.1", "patch")).toThrow());
});

describe("isGreater", () => {
  it("true when next > current", () => expect(isGreater("1.2.0", "1.1.1")).toBe(true));
  it("false when equal", () => expect(isGreater("1.1.1", "1.1.1")).toBe(false));
  it("false when next < current", () => expect(isGreater("1.0.9", "1.1.0")).toBe(false));
});

describe("setPackageJsonVersion", () => {
  it("replaces only the version field", () => {
    const src = `{\n  "name": "sens",\n  "version": "1.1.1",\n  "type": "module"\n}`;
    expect(setPackageJsonVersion(src, "1.2.0")).toContain(`"version": "1.2.0"`);
  });
});

describe("setCargoTomlVersion", () => {
  it("replaces the package version, not dependency versions", () => {
    const src = `[package]\nname = "sens"\nversion = "1.1.1"\n\n[dependencies]\ntauri = { version = "2" }\n`;
    const out = setCargoTomlVersion(src, "1.2.0");
    expect(out).toContain(`version = "1.2.0"`);
    expect(out).toContain(`tauri = { version = "2" }`);
  });
});

describe("setTauriConfVersion", () => {
  it("replaces the top-level version", () => {
    const src = `{\n  "productName": "Sens",\n  "version": "1.1.1",\n  "identifier": "com.sens.app"\n}`;
    expect(setTauriConfVersion(src, "1.2.0")).toContain(`"version": "1.2.0"`);
  });
});

describe("rollChangelog", () => {
  const src = `# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.1.1] — 2026-05-30\n`;
  it("inserts a dated version heading below a fresh Unreleased", () => {
    const out = rollChangelog(src, "1.2.0", "2026-06-01");
    expect(out).toContain("## [Unreleased]\n\n## [1.2.0] — 2026-06-01");
    expect(out).toContain("## [1.2.0] — 2026-06-01\n\n### Added\n- a feature");
  });
  it("throws when there is no Unreleased section", () => {
    expect(() => rollChangelog("# Changelog\n", "1.2.0", "2026-06-01")).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/__tests__/release-lib.test.ts`
Expected: FAIL — cannot resolve `../release-lib.mjs` (module does not exist yet).

- [ ] **Step 3: Implement the library**

Create `scripts/release-lib.mjs`:

```js
// Pure, side-effect-free helpers for the release script. Unit-tested.

export function bumpVersion(current, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Invalid current version: ${current}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(level)) return level;
      throw new Error(`Unknown bump level: ${level} (use major|minor|patch|x.y.z)`);
  }
}

export function isGreater(next, current) {
  const a = current.split(".").map(Number);
  const b = next.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

// Replaces the FIRST `"version": "..."` — the top-level field in package.json / tauri.conf.json.
function setJsonVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
}

export function setPackageJsonVersion(text, version) {
  return setJsonVersion(text, version);
}

export function setTauriConfVersion(text, version) {
  return setJsonVersion(text, version);
}

// Replaces the FIRST line-start `version = "..."` — the [package] version in Cargo.toml.
// Dependency versions are inline (` version = "..." `) and never start at column 0, so they are safe.
export function setCargoTomlVersion(text, version) {
  return text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
}

// Renames the top `## [Unreleased]` heading's content into a dated version section,
// leaving a fresh empty `## [Unreleased]` above it.
export function rollChangelog(text, version, date) {
  if (!/^## \[Unreleased\]/m.test(text)) {
    throw new Error("CHANGELOG.md has no '## [Unreleased]' section");
  }
  return text.replace(
    /^## \[Unreleased\][^\n]*\n/m,
    (line) => `${line}\n## [${version}] — ${date}\n`,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/__tests__/release-lib.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Confirm the full suite + build still pass**

Run: `npm test && npm run build`
Expected: Vitest all-pass; tsc + vite build clean (the new `.mjs`/`.test.ts` do not break the `src`-only build).

- [ ] **Step 6: Commit**

```bash
git add scripts/release-lib.mjs scripts/__tests__/release-lib.test.ts
git commit -m "feat: add release-lib version + changelog helpers"
```

---

## Task 3: release.mjs CLI orchestrator + npm script

**Files:**
- Create: `scripts/release.mjs`
- Modify: `package.json` (add `"release"` script)

- [ ] **Step 1: Create the orchestrator**

Create `scripts/release.mjs`:

```js
#!/usr/bin/env node
// Bumps version across package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json,
// refreshes Cargo.lock, rolls the CHANGELOG, commits, and tags. Never pushes.
// Usage: npm run release -- <major|minor|patch|x.y.z>
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  bumpVersion,
  isGreater,
  setPackageJsonVersion,
  setCargoTomlVersion,
  setTauriConfVersion,
  rollChangelog,
} from "./release-lib.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const level = process.argv[2];
if (!level) fail("Usage: npm run release -- <major|minor|patch|x.y.z>");

// --- Guards ---
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`Refusing to release from '${branch}'. Switch to main first.`);
if (git(["status", "--porcelain"])) fail("Working tree is dirty. Commit or stash changes first.");

const PKG = "package.json";
const CARGO = "src-tauri/Cargo.toml";
const CONF = "src-tauri/tauri.conf.json";
const CHANGELOG = "CHANGELOG.md";

const current = JSON.parse(readFileSync(PKG, "utf8")).version;
const next = bumpVersion(current, level);
if (!isGreater(next, current)) fail(`Next version ${next} is not greater than current ${current}.`);
if (git(["tag", "--list", `v${next}`])) fail(`Tag v${next} already exists.`);

const today = new Date().toISOString().slice(0, 10);

// --- Rewrite files ---
writeFileSync(PKG, setPackageJsonVersion(readFileSync(PKG, "utf8"), next));
writeFileSync(CARGO, setCargoTomlVersion(readFileSync(CARGO, "utf8"), next));
writeFileSync(CONF, setTauriConfVersion(readFileSync(CONF, "utf8"), next));
writeFileSync(CHANGELOG, rollChangelog(readFileSync(CHANGELOG, "utf8"), next, today));

// --- Refresh Cargo.lock so --locked CI builds don't fail on a stale lock ---
try {
  execFileSync("cargo", ["update", "-p", "sens"], { cwd: "src-tauri", stdio: "inherit" });
} catch {
  fail('cargo update failed. Ensure cargo is on PATH: export PATH="$HOME/.cargo/bin:$PATH"');
}

// --- Commit + annotated tag (no push) ---
execFileSync("git", ["add", PKG, CARGO, CONF, CHANGELOG, "src-tauri/Cargo.lock"], { stdio: "inherit" });
execFileSync("git", ["commit", "-m", `chore: release v${next}`], { stdio: "inherit" });
execFileSync("git", ["tag", "-a", `v${next}`, "-m", `Release v${next}`], { stdio: "inherit" });

console.log(`\n✔ Released v${next}. Review the commit, then push to trigger the release build:\n    git push --follow-tags\n`);
```

- [ ] **Step 2: Add the npm script**

Use Edit on `package.json`. Find:

```
    "test": "vitest run",
    "test:watch": "vitest"
```

Replace with:

```
    "test": "vitest run",
    "test:watch": "vitest",
    "release": "node scripts/release.mjs"
```

- [ ] **Step 3: Verify the branch guard fires (non-destructive)**

You are on `chore/release-workflow`, not `main`, so the script must refuse before changing anything.

Run: `npm run release -- patch`
Expected: exits non-zero with `✖ Refusing to release from 'chore/release-workflow'. Switch to main first.`

- [ ] **Step 4: Verify nothing was modified**

Run: `git status --porcelain`
Expected: only the staged/committed plan changes from prior tasks — NO changes to `package.json` version, `Cargo.toml`, `tauri.conf.json`, or `CHANGELOG.md` (the guard ran before any write).

- [ ] **Step 5: Commit**

```bash
git add scripts/release.mjs package.json
git commit -m "feat: add npm run release bump-and-tag script"
```

---

## Task 4: CI gate workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test

  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - run: cargo test --lib
        working-directory: src-tauri
      - run: cargo build
        working-directory: src-tauri
```

- [ ] **Step 2: Verify it is valid YAML**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!s.includes('jobs:'))throw new Error('missing jobs');console.log('ci.yml OK, '+s.split(String.fromCharCode(10)).length+' lines')"`
Expected: prints `ci.yml OK, N lines` (full validation happens on push; GitHub will report syntax errors in the Actions tab).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add frontend + rust gate workflow"
```

---

## Task 5: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            target: aarch64-apple-darwin
            args: "--target aarch64-apple-darwin"
          - platform: macos-13
            target: x86_64-apple-darwin
            args: "--target x86_64-apple-darwin"
          - platform: ubuntu-22.04
            target: ""
            args: ""
          - platform: windows-latest
            target: ""
            args: ""
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Sens ${{ github.ref_name }}"
          releaseBody: "See CHANGELOG.md for details. macOS users: this build is unsigned — on first launch, right-click the app and choose Open."
          releaseDraft: false
          prerelease: false
          args: ${{ matrix.args }}
```

- [ ] **Step 2: Verify it is valid YAML and references tauri-action**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/release.yml','utf8');if(!s.includes('tauri-apps/tauri-action'))throw new Error('missing tauri-action');if(!s.includes('tags:'))throw new Error('missing tag trigger');console.log('release.yml OK, '+s.split(String.fromCharCode(10)).length+' lines')"`
Expected: prints `release.yml OK, N lines`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered cross-platform release workflow"
```

---

## Task 6: RELEASING.md checklist

**Files:**
- Create: `RELEASING.md`

- [ ] **Step 1: Create the doc**

Create `RELEASING.md`:

```markdown
# Releasing Sens

Sens follows [Semantic Versioning](https://semver.org/) and uses **GitHub Flow**:
`main` is always releasable, work lands via short-lived branches + PRs, and
releases are cut from `main` by pushing a `vX.Y.Z` tag.

## Versioning

- **patch** — bug fixes only (e.g. 1.1.1 → 1.1.2)
- **minor** — backward-compatible features (e.g. 1.1.x → 1.2.0)
- **major** — breaking data-model / command changes (e.g. 1.x → 2.0.0)

The three version files (`package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`) are kept identical by the release script. **Never edit
them by hand.**

## Cutting a release

1. Make sure `main` is green (the **CI** workflow passes) and you are on `main`
   with a clean working tree.
2. Confirm the `## [Unreleased]` section in `CHANGELOG.md` lists everything in this
   release.
3. Bump, roll the changelog, commit, and tag:
   ```bash
   export PATH="$HOME/.cargo/bin:$PATH"
   npm run release -- <major|minor|patch>   # or an explicit x.y.z
   ```
   This updates the three version files + `Cargo.lock`, rolls `[Unreleased]` into a
   dated section, commits `chore: release vX.Y.Z`, and creates the tag. It does **not**
   push.
4. Review the release commit and tag (`git show HEAD`, `git tag`).
5. Push to trigger the build:
   ```bash
   git push --follow-tags
   ```
6. Watch the **Release** workflow in the GitHub Actions tab. When it finishes, confirm
   the GitHub Release for the tag has the macOS (Apple Silicon + Intel), Windows, and
   Linux artifacts attached.

## Notes

- **Unsigned macOS builds:** recipients must right-click the app and choose **Open** on
  first launch (Gatekeeper). Your own machine runs it normally.
- **Hotfix:** branch from `main`, fix via PR, then cut a **patch** release the same way.
```

- [ ] **Step 2: Verify**

Run: `test -f RELEASING.md && grep -c 'npm run release' RELEASING.md`
Expected: prints a count ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add RELEASING.md
git commit -m "docs: add RELEASING checklist"
```

---

## Task 7: CLAUDE.md pointer

**Files:**
- Modify: `CLAUDE.md` (insert a `## Releasing` section before `## Architecture`)

- [ ] **Step 1: Add the pointer section**

Use Edit on `CLAUDE.md`. Find this exact text:

```
## Architecture

Strict layering, UI never touches SQL:
```

Replace with:

```
## Releasing

Releases follow `RELEASING.md` and **GitHub Flow** (SemVer, `main` always releasable).
Use `npm run release -- <major|minor|patch>` to cut a release — it bumps all three
version files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) plus
`Cargo.lock`, rolls the CHANGELOG `[Unreleased]` section, commits, and tags. **Never
hand-edit the version files.** Pushing the resulting `v*` tag (`git push --follow-tags`)
triggers `.github/workflows/release.yml`, which builds unsigned mac/Windows/Linux
binaries and publishes a GitHub Release. `.github/workflows/ci.yml` gates every PR.

## Architecture

Strict layering, UI never touches SQL:
```

- [ ] **Step 2: Verify**

Run: `grep -n '## Releasing' CLAUDE.md`
Expected: one matching line.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: point CLAUDE.md at the release workflow"
```

---

## Task 8: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin chore/release-workflow
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "chore: version-control & release workflow" \
  --body "Implements docs/superpowers/specs/2026-05-30-version-control-and-release-workflow-design.md: npm run release bump script, CI gate + tag-triggered release workflows (mac/Win/Linux, unsigned), RELEASING.md, and CLAUDE.md pointer."
```

Expected: the new CI workflow runs against the PR. Confirm both `frontend` and `rust` jobs pass before merging.

- [ ] **Step 3: After merge, do a trial release (optional, real)**

On `main`, after merge: `npm run release -- patch` → `git push --follow-tags`, then confirm the Release workflow publishes `v1.1.2` artifacts. This is the first real end-to-end validation of `release.yml` (Actions only run once the workflow file is on the default branch).

---

## Self-Review

**Spec coverage:**
- Branching model (GitHub Flow) → documented in RELEASING.md (Task 6) + CLAUDE.md (Task 7). ✓
- SemVer + three-file sync → release-lib + release.mjs (Tasks 2–3). ✓
- `npm run release` script with Cargo.lock refresh + guards + no-push → Task 3. ✓
- CHANGELOG `[Unreleased]` discipline → Task 1 (section) + `rollChangelog` (Task 2). ✓
- `ci.yml` frontend + rust jobs → Task 4. ✓
- `release.yml` tauri-action matrix (mac AS+Intel, Win, Linux), unsigned, GITHUB_TOKEN → Task 5. ✓
- RELEASING.md + CLAUDE.md pointer → Tasks 6–7. ✓
- Out-of-scope items (signing, updater, auto-notes, Git Flow) → correctly omitted. ✓

**Placeholder scan:** No TBD/TODO; every code/config step shows full content. ✓

**Type/name consistency:** `bumpVersion`, `isGreater`, `setPackageJsonVersion`, `setCargoTomlVersion`, `setTauriConfVersion`, `rollChangelog` are defined in Task 2 and imported with identical names in Tasks 2-test and 3. Cargo package name `sens` matches `cargo update -p sens`. npm script name `release` matches `npm run release`. ✓
