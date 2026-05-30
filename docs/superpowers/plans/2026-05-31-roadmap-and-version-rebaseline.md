# Roadmap & Version Re-baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable `ROADMAP.md` (full product vision, phases → release tags climbing to a feature-complete `1.0.0`) and re-baseline all published version history from the preference-driven `1.x` line into a deliberate `0.x` line via a full history rewrite (commit messages + tags + GitHub Releases + CHANGELOG + version files).

**Architecture:** Two independent deliverables. (A) A new root `ROADMAP.md` — pure docs, zero risk, done first. (B) A destructive, irreversible-on-`origin` history rewrite: forward content commits on `main` (CHANGELOG renumber + version files + ROADMAP), then a `git-filter-repo` pass over a **mirror clone of `origin`** that rewrites the 7 version-bearing commit messages and renames the 8 annotated tags consistently across **all refs** (so the unmerged `feat/subcategories` branch is rewritten too), verified locally, then force-pushed; finally the 8 GitHub Releases are deleted and recreated, and the local working clone is re-synced.

**Tech Stack:** git 2.52, `git-filter-repo` (to be installed), `gh` CLI (authenticated — Releases already exist under `Jmyz72/Sens`), Node/Vite + Cargo (the build/test gates).

**Spec:** `docs/superpowers/specs/2026-05-31-roadmap-and-version-rebaseline-design.md`

---

## The tag mapping (single source of truth for this plan)

| Old tag | Old tag→commit | New tag | New release title |
|---|---|---|---|
| `v1.0.0` | `5423bad` | **`v0.1.0`** | `Sens v0.1.0` |
| `v1.1.0` | `6142c9c` | **`v0.2.0`** | `Sens v0.2.0` |
| `v1.1.1` | `efd6a59` | **`v0.2.1`** | `Sens v0.2.1` |
| `v1.1.2` | `c44116f` | **`v0.2.2`** | `Sens v0.2.2` |
| `v1.1.3` | `39e037e` | **`v0.2.3`** | `Sens v0.2.3` |
| `v1.1.4` | `69a39a7` | **`v0.2.4`** | `Sens v0.2.4` |
| `v1.2.0` | `0955d4e` | **`v0.3.0`** | `Sens v0.3.0` |
| `v1.2.1` | `d0eb05a` | **`v0.3.1`** | `Sens v0.3.1` |

(Old-tag→commit are the *dereferenced* commits, i.e. `vX^{}`. They change after the rewrite — never hardcode the new SHAs; always resolve tags by name.)

**Commit messages to rewrite** (the only 7 commit subjects/bodies containing version tokens; verified via `git log --all --format='%s' | grep -E 'v?[0-9]+\.[0-9]+\.[0-9]+'`):

| Commit | Old message fragment | New message fragment |
|---|---|---|
| `d0eb05a` | `release v1.2.1` | `release v0.3.1` |
| `0955d4e` | `release v1.2.0` | `release v0.3.0` |
| `69a39a7` | `release v1.1.4` | `release v0.2.4` |
| `39e037e` | `release v1.1.3` | `release v0.2.3` |
| `c44116f` | `release v1.1.2` | `release v0.2.2` |
| `6142c9c` | `release v1.1.0 — add CHANGELOG, bump version 0.1.0 → 1.1.0` | `release v0.2.0 — add CHANGELOG, bump version 0.1.0 → 0.2.0` |
| `c270475` | `sync package-lock version field to 1.2.1` | `sync package-lock version field to 0.3.1` |

(`v1.1.1`'s and `v1.0.0`'s commit subjects contain no version token — they only need the **tag** renamed, handled in Task 6.)

---

## Task 1: Create `ROADMAP.md` (independent, zero-risk — do first)

**Files:**
- Create: `ROADMAP.md` (repo root)

- [ ] **Step 1: Write `ROADMAP.md`**

Create `ROADMAP.md` with exactly this content:

```markdown
# Sens Roadmap

Sens is built one **phase** at a time. **One phase = one release.** A phase begins
with a brainstorming session (turning its line below into a spec under
`docs/superpowers/specs/`), proceeds through an implementation plan in
`docs/superpowers/plans/`, and ends when its `v*` tag ships per `RELEASING.md`.
This file is the index; the specs and plans hold the detail.

The project is **pre-1.0**. In `0.x`, the **minor** carries feature releases and the
**patch** carries fixes/follow-ups. **`1.0.0` is reserved for feature-complete.**

**Now:** `v0.4.0` — Subcategories (in flight) ·
**Next:** `v0.5.0` — Credit & debt behavior ·
**Later:** the climb to `v1.0.0`

Legend: 🟢 shipped · 🟡 in progress · ⚪ planned

## Shipped — the `0.x` foundation

| Release | What landed |
|---|---|
| 🟢 `v0.1.0` | Initial release — accounts, transactions (income/expense/transfer/adjustment), categories, dashboard, dark/light theme |
| 🟢 `v0.2.0` | Account taxonomy (asset/liability), signed liabilities, net worth |
| 🟢 `v0.2.1` | JOIN robustness + owe-account balance correction |
| 🟢 `v0.2.2`–`v0.2.3` | Fixes & follow-ups |
| 🟢 `v0.2.4` | Advanced sidebar shell (net worth, assets, debts) |
| 🟢 `v0.3.0` | Accounts screen redesign + collapsible app shell, new brand mark |
| 🟢 `v0.3.1` | Two-step New Account modal + provider logos |

## In progress

### 🟡 v0.4.0 — Subcategories
Two-level categories with a master–detail Categories screen, a subcategory-aware
transaction picker, and dashboard spend roll-up into the parent.
— spec: `docs/superpowers/specs/2026-05-31-categories-subcategories-redesign-design.md`

## Planned — the climb to 1.0

### ⚪ v0.5.0 — Credit & debt behavior
Credit limits + utilization (credit-card, BNPL); installment/payoff schedules and
interest for loans (personal-loan, mortgage, car-loan, borrowed).
- [ ] credit limit + utilization % + available credit
- [ ] installment / payoff schedules
- [ ] interest + principal-vs-interest split
— spec: _TBD_

### ⚪ v0.6.0 — Investment value
Completes the deferred taxonomy work.
- [ ] cost basis vs current value
- [ ] unrealized gain/loss (investment, unit-trust, crypto)
- [ ] fixed-deposit maturity
— spec: _TBD_

### ⚪ v0.7.0 — Budgets & goals
- [ ] monthly budget per category
- [ ] budget-vs-actual + overspend warnings
- [ ] savings goals (target amounts + progress)
— spec: _TBD_

### ⚪ v0.8.0 — Recurring & reminders
- [ ] recurring/scheduled transactions
- [ ] upcoming list + one-tap post
- [ ] bill due-date reminders
— spec: _TBD_

### ⚪ v0.9.0 — Search, filter & tags
- [ ] full transaction search
- [ ] advanced filters (date / account / kind / amount)
- [ ] free-form tags
— spec: _TBD_

### ⚪ v0.10.0 — Reports & insights
- [ ] spending & cashflow trends/charts beyond the dashboard
- [ ] net-worth history over time
— spec: _TBD_

### ⚪ v0.11.0 — Data integrity & ownership
- [ ] CSV import/export
- [ ] full backup & restore
- [ ] account reconciliation against a statement balance
— spec: _TBD_

### 🎉 ⚪ v1.0.0 — Onboarding & polish (feature-complete milestone)
- [ ] receipts/attachments on transactions
- [ ] first-run onboarding
- [ ] 1.0 polish pass
— spec: _TBD_

## Later / unscheduled
_Nothing yet — every selected feature is placed above. New ideas land here (or in
the right phase) before they're scheduled._

## Conventions
- **Versioning:** one phase = one minor bump (`0.N.0`); fixes are patches (`0.N.x`);
  `1.0.0` is the feature-complete milestone. Versions are produced only by
  `npm run release -- <major|minor|patch>` per `RELEASING.md`.
- **Adding an idea:** append it to the relevant phase's checklist, or to
  *Later / unscheduled* if it has no home yet. The roadmap never blocks capture.
- **Finishing a phase:** flip its marker to 🟢, record the shipped tag, and fill in
  its `spec:` link.
```

- [ ] **Step 2: Verify the file renders and references resolve**

Run: `test -f ROADMAP.md && ls docs/superpowers/specs/2026-05-31-categories-subcategories-redesign-design.md`
Expected: both paths exist (the v0.4.0 spec link is valid; planned phases intentionally say `_TBD_`).

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: add ROADMAP.md (0.x → 1.0.0 product vision)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Renumber `CHANGELOG.md` to `0.x`

**Files:**
- Modify: `CHANGELOG.md` (8 `## [1.x]` headers + the link-reference footer)

- [ ] **Step 1: Renumber the version headers**

Edit every `## [1.x] — <date>` header (dates unchanged). Apply this exact mapping; leave `## [Unreleased]` as-is:
- `## [1.2.1]` → `## [0.3.1]`
- `## [1.2.0]` → `## [0.3.0]`
- `## [1.1.4]` → `## [0.2.4]`
- `## [1.1.3]` → `## [0.2.3]`
- `## [1.1.2]` → `## [0.2.2]`
- `## [1.1.1]` → `## [0.2.1]`
- `## [1.1.0]` → `## [0.2.0]`
- `## [1.0.0]` → `## [0.1.0]`

- [ ] **Step 2: Fix and complete the link-reference footer**

The current footer only has `[1.1.1]`, `[1.1.0]`, `[1.0.0]`. Replace the entire footer block with a complete, renumbered one (this is what `RELEASING.md`'s tooling expects to extend):

```
[Unreleased]: https://github.com/Jmyz72/Sens/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Jmyz72/Sens/releases/tag/v0.3.1
[0.3.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.3.0
[0.2.4]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.4
[0.2.3]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.3
[0.2.2]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.2
[0.2.1]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.1
[0.2.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.2.0
[0.1.0]: https://github.com/Jmyz72/Sens/releases/tag/v0.1.0
```

- [ ] **Step 3: Verify no `1.x` version tokens remain in the CHANGELOG**

Run: `grep -nE '\[1\.[0-9]' CHANGELOG.md ; grep -cE '^## \[0\.' CHANGELOG.md`
Expected: first grep prints **nothing** (exit 1); second prints `8`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: renumber CHANGELOG to the 0.x baseline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Re-baseline the working-tree version files to `0.3.1`

**Files:**
- Modify: `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`, `src-tauri/Cargo.lock:3192`, `package-lock.json` (root `version` + `packages."".version`)

> This is the one sanctioned exception to CLAUDE.md's "never hand-edit version files" rule — it is a history refactor, not a release. After this, the next `npm run release -- minor` correctly yields `v0.4.0`.

- [ ] **Step 1: Set every version field from `1.2.1` to `0.3.1`**

Edit:
- `package.json` → `"version": "0.3.1",`
- `src-tauri/Cargo.toml` → `version = "0.3.1"`
- `src-tauri/tauri.conf.json` → `"version": "0.3.1",`
- `src-tauri/Cargo.lock` → the `[[package]] name = "sens"` block's `version = "0.3.1"`
- `package-lock.json` → both the top-level `"version": "0.3.1"` and `packages[""]."version": "0.3.1"` (if present)

- [ ] **Step 2: Verify no version file still reads `1.2.1`**

Run: `grep -rn '1\.2\.1' package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock`
Expected: prints **nothing** (exit 1).

- [ ] **Step 3: Confirm the build gate is green (validates Cargo.lock/tauri.conf consistency)**

Run: `npm run build`
Expected: `tsc` + `vite build` succeed, no errors.

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build && cd ..`
Expected: compiles clean (confirms `Cargo.toml`/`Cargo.lock` agree on `0.3.1`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock
git commit -m "chore: re-baseline version files to 0.3.1

One-time history refactor (not a release) so the next minor ships as v0.4.0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push the three forward content commits to `origin/main`**

```bash
git push origin main
```
Expected: `main` on `origin` now carries the ROADMAP + CHANGELOG + version commits. (These are normal fast-forward commits — the destructive rewrite is later.)

---

## Task 4: Safety net — full backup before any rewrite

**Files:** none (creates a bundle + a backup branch/tags on `origin`)

- [ ] **Step 1: Bundle the entire repo (all refs) to a file outside the repo**

```bash
git bundle create "$HOME/sens-prerebaseline-backup.bundle" --all
git bundle verify "$HOME/sens-prerebaseline-backup.bundle"
```
Expected: "The bundle records a complete history" / "is okay".

- [ ] **Step 2: Push namespaced backup copies of the live refs to `origin` (recoverable remotely)**

```bash
git push origin \
  refs/remotes/origin/main:refs/heads/backup/pre-rebaseline-main \
  refs/remotes/origin/feat/subcategories:refs/heads/backup/pre-rebaseline-feat-subcategories \
  refs/remotes/origin/docs/add-public-docs:refs/heads/backup/pre-rebaseline-docs-add-public-docs
```
Expected: three new `backup/*` branches created on `origin`.

- [ ] **Step 3: Snapshot the old tag→commit map for post-rewrite verification**

```bash
for t in v1.0.0 v1.1.0 v1.1.1 v1.1.2 v1.1.3 v1.1.4 v1.2.0 v1.2.1; do \
  echo "$t -> $(git rev-list -n1 $t)"; done | tee "$HOME/sens-old-tagmap.txt"
```
Expected: 8 lines, each `v1.x.y -> <40-hex>`. Keep this file for Task 7 sanity checks.

---

## Task 5: Install `git-filter-repo`

**Files:** none

- [ ] **Step 1: Install (try pip, then Homebrew)**

```bash
python3 -m pip install --user git-filter-repo 2>/dev/null || brew install git-filter-repo
```

- [ ] **Step 2: Verify it is callable**

Run: `git filter-repo --version`
Expected: prints a version (e.g. `git-filter-repo version 2.x`). If "not a git command", ensure the install bin dir is on PATH (`python3 -m site --user-base`/bin) and re-run.

---

## Task 6: Rewrite messages + tags on a mirror clone

**Files:**
- Create (scratch): `$HOME/sens-rewrite.git` (mirror clone — deleted at end), `$HOME/sens-msg-replacements.txt`

> `git-filter-repo` rewrites **all refs and annotated tags** in the mirror at once, keeping tags pointing at their rewritten commits. We then rename the 8 tags. Working on a mirror leaves `origin` untouched until Task 7's explicit force-push.

- [ ] **Step 1: Fresh mirror clone of `origin`**

```bash
rm -rf "$HOME/sens-rewrite.git"
git clone --mirror https://github.com/Jmyz72/Sens.git "$HOME/sens-rewrite.git"
```
Expected: a bare mirror with `main`, `feat/subcategories`, `docs/add-public-docs`, the `backup/*` branches, and all `v1.x` tags.

- [ ] **Step 2: Write the message-replacement file**

Create `$HOME/sens-msg-replacements.txt` with exactly these lines (literal substring replacements; the longer `v1.1.0` rule is listed before the bare `1.1.0` rule so it wins):

```
release v1.2.1==>release v0.3.1
release v1.2.0==>release v0.3.0
release v1.1.4==>release v0.2.4
release v1.1.3==>release v0.2.3
release v1.1.2==>release v0.2.2
release v1.1.0==>release v0.2.0
bump version 0.1.0 → 1.1.0==>bump version 0.1.0 → 0.2.0
sync package-lock version field to 1.2.1==>sync package-lock version field to 0.3.1
```

- [ ] **Step 3: Run the message rewrite in the mirror**

```bash
git -C "$HOME/sens-rewrite.git" filter-repo --force --replace-message "$HOME/sens-msg-replacements.txt"
```
Expected: filter-repo reports it parsed/rewrote commits and wrote `.git/filter-repo/commit-map`. All SHAs from the first rewritten commit forward now differ.

- [ ] **Step 4: Verify no `1.x` release token survives in any commit message**

Run: `git -C "$HOME/sens-rewrite.git" log --all --format='%s %b' | grep -nE 'release v1\.|version field to 1\.2\.1|→ 1\.1\.0'`
Expected: prints **nothing** (exit 1).

- [ ] **Step 5: Rename the 8 annotated tags (old → new), in the mirror**

```bash
cd "$HOME/sens-rewrite.git"
# pairs: old new
set -- v1.0.0 v0.1.0 v1.1.0 v0.2.0 v1.1.1 v0.2.1 v1.1.2 v0.2.2 \
       v1.1.3 v0.2.3 v1.1.4 v0.2.4 v1.2.0 v0.3.0 v1.2.1 v0.3.1
while [ "$#" -gt 0 ]; do old=$1; new=$2; shift 2; \
  git tag -a "$new" "$old^{}" -m "Sens $new"; \
  git tag -d "$old"; \
done
cd -
```
Expected: 8 new `v0.x` annotated tags created, 8 old `v1.x` tags deleted.

- [ ] **Step 6: Verify the final tag set**

Run: `git -C "$HOME/sens-rewrite.git" tag --sort=v:refname`
Expected: exactly `v0.1.0 v0.2.0 v0.2.1 v0.2.2 v0.2.3 v0.2.4 v0.3.0 v0.3.1` — no `v1.x`.

Run: `for t in v0.1.0 v0.3.1; do echo "$t:"; git -C "$HOME/sens-rewrite.git" cat-file -t $(git -C "$HOME/sens-rewrite.git" rev-parse $t); done`
Expected: each resolves to a `tag` object (annotation preserved).

---

## Task 7: Verify the rewritten history builds, then force-push to `origin`

**Files:** none (operates on the mirror, then `origin`)

- [ ] **Step 1: Worktree-check the rewritten `main` builds & tests green**

```bash
rm -rf "$HOME/sens-verify"
git clone "$HOME/sens-rewrite.git" "$HOME/sens-verify"
cd "$HOME/sens-verify"
npm ci && npm run build && npm test
export PATH="$HOME/.cargo/bin:$PATH" && (cd src-tauri && cargo test --lib && cargo build)
cd -
```
Expected: frontend build + Vitest pass; `cargo test --lib` + `cargo build` pass. (Confirms the rewrite didn't corrupt tree content — only messages/tags changed.)

- [ ] **Step 2: Confirm `feat/subcategories` survived the rewrite (not stranded)**

Run: `git -C "$HOME/sens-rewrite.git" log --oneline origin/feat/subcategories 2>/dev/null || git -C "$HOME/sens-rewrite.git" log --oneline feat/subcategories | head -3`
Expected: the subcategories commits are present; the `sync package-lock version field to 0.3.1` subject is rewritten.

- [ ] **Step 3: Force-push the rewritten branches and tags to `origin`**

```bash
cd "$HOME/sens-rewrite.git"
git push --force origin \
  refs/heads/main:refs/heads/main \
  refs/heads/feat/subcategories:refs/heads/feat/subcategories \
  refs/heads/docs/add-public-docs:refs/heads/docs/add-public-docs
git push --force --tags origin
git push origin --delete v1.0.0 v1.1.0 v1.1.1 v1.1.2 v1.1.3 v1.1.4 v1.2.0 v1.2.1
cd -
```
Expected: branches updated (forced), 8 `v0.x` tags pushed, 8 `v1.x` tags deleted from `origin`.

- [ ] **Step 4: Verify `origin` shows only `0.x` tags**

Run: `git ls-remote --tags origin | grep -vE 'v0\.[0-9]' | grep -E 'refs/tags/v1\.' || echo "clean: no v1.x tags on origin"`
Expected: `clean: no v1.x tags on origin`.

---

## Task 8: Delete and recreate the 8 GitHub Releases

**Files:** none (`gh` operations against `Jmyz72/Sens`)

> Releases are tied to a tag; the old `v1.x` tags are gone, so the old Releases are now orphaned drafts/broken. Delete them and create fresh Releases on the new tags.

- [ ] **Step 1: Delete the 8 old Releases (keep nothing — tags already gone)**

```bash
for r in v1.0.0 v1.1.0 v1.1.1 v1.1.2 v1.1.3 v1.1.4 v1.2.0 v1.2.1; do \
  gh release delete "$r" --repo Jmyz72/Sens --yes 2>/dev/null && echo "deleted $r" || echo "skip $r (already gone)"; \
done
```
Expected: each old release deleted (or already absent).

- [ ] **Step 2: Recreate Releases on the new tags, notes pulled from the renumbered CHANGELOG**

```bash
gh release create v0.1.0 --repo Jmyz72/Sens --title "Sens v0.1.0" --notes "Initial release — accounts, transactions, categories, dashboard, dark/light theme. (Re-baselined from the former v1.0.0.)"
gh release create v0.2.0 --repo Jmyz72/Sens --title "Sens v0.2.0" --notes "Account taxonomy (asset/liability), signed liabilities, net worth. (Former v1.1.0.)"
gh release create v0.2.1 --repo Jmyz72/Sens --title "Sens v0.2.1" --notes "JOIN robustness + owe-account balance correction. (Former v1.1.1.)"
gh release create v0.2.2 --repo Jmyz72/Sens --title "Sens v0.2.2" --notes "Fixes & follow-ups. (Former v1.1.2.)"
gh release create v0.2.3 --repo Jmyz72/Sens --title "Sens v0.2.3" --notes "Fixes & follow-ups. (Former v1.1.3.)"
gh release create v0.2.4 --repo Jmyz72/Sens --title "Sens v0.2.4" --notes "Advanced sidebar shell (net worth, assets, debts). (Former v1.1.4.)"
gh release create v0.3.0 --repo Jmyz72/Sens --title "Sens v0.3.0" --notes "Accounts screen redesign + collapsible app shell, new brand mark. (Former v1.2.0.)"
gh release create v0.3.1 --repo Jmyz72/Sens --title "Sens v0.3.1" --notes "Two-step New Account modal + provider logos. (Former v1.2.1.)" --latest
```
Expected: 8 Releases created; `v0.3.1` marked Latest.

- [ ] **Step 3: Verify the Release list**

Run: `gh release list --repo Jmyz72/Sens`
Expected: 8 rows, all `v0.x`, `Sens v0.3.1` = Latest, no `v1.x`.

---

## Task 9: Re-sync the local working clone & final verification

**Files:** none (operates on the working repo `/Users/jimmyhew/Documents/Sens`)

> The local `main` still points at the *old* (pre-rewrite) SHAs and has diverged from the rewritten `origin/main`. Reset it to match, and refresh tags.

- [ ] **Step 1: Fetch the rewritten origin and prune deleted tags**

```bash
git fetch origin --prune --prune-tags --tags
```

- [ ] **Step 2: Hard-reset local branches to the rewritten remotes**

```bash
git checkout main && git reset --hard origin/main
git branch -f feat/subcategories origin/feat/subcategories 2>/dev/null || true
```
Expected: local `main` now equals rewritten `origin/main`; working tree clean.

- [ ] **Step 3: Delete stale local tags that no longer exist on origin**

```bash
for t in v1.0.0 v1.1.0 v1.1.1 v1.1.2 v1.1.3 v1.1.4 v1.2.0 v1.2.1; do git tag -d "$t" 2>/dev/null; done
git tag --sort=v:refname
```
Expected: only `v0.1.0 … v0.3.1` remain locally.

- [ ] **Step 4: Full final gate on the working clone**

```bash
git status
grep -c '0.3.1' package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
test -f ROADMAP.md && echo "ROADMAP present"
npm run build && npm test
export PATH="$HOME/.cargo/bin:$PATH" && (cd src-tauri && cargo test --lib)
```
Expected: clean status; each version file shows `0.3.1`; ROADMAP present; build + both test suites green.

- [ ] **Step 5: Clean up scratch artifacts (keep the backup bundle)**

```bash
rm -rf "$HOME/sens-rewrite.git" "$HOME/sens-verify" "$HOME/sens-msg-replacements.txt"
```
Expected: scratch removed. Keep `$HOME/sens-prerebaseline-backup.bundle`, `$HOME/sens-old-tagmap.txt`, and the `origin` `backup/*` branches until you're confident, then delete the `backup/*` branches with `git push origin --delete backup/pre-rebaseline-main backup/pre-rebaseline-feat-subcategories backup/pre-rebaseline-docs-add-public-docs`.

---

## Rollback (if anything goes wrong before you delete the backups)

- **Before force-push (Tasks 1–6):** discard the mirror (`rm -rf $HOME/sens-rewrite.git`) and the forward commits (`git reset --hard origin/main` after re-fetch); nothing on `origin`'s history changed irreversibly except the additive content commits + `backup/*` branches.
- **After force-push (Task 7+):** restore from the remote backups —
  `git push --force origin backup/pre-rebaseline-main:main` (and likewise for the other two branches), recreate old tags from `$HOME/sens-old-tagmap.txt`, and re-run the old `gh release create v1.x` commands. Or restore the whole repo from `$HOME/sens-prerebaseline-backup.bundle` (`git clone $HOME/sens-prerebaseline-backup.bundle restored && cd restored && git push --force --mirror origin`).

---

## Self-Review (completed)

- **Spec coverage:** Part A (ROADMAP system) → Task 1. Part B (phases/features) → Task 1's content. Part C tag mapping → mapping table + Tasks 6–8; SemVer policy → ROADMAP "Conventions" + Task 3; rewrite scope (messages+tags+releases+CHANGELOG+version files) → Tasks 2–8; non-goal (no historical tree-blob rewrite) → honored (filter-repo only touches messages); risks/backup → Task 4 + Rollback. ✓
- **Placeholder scan:** the only `_TBD_`/`Later — Nothing yet` strings are intentional ROADMAP content for not-yet-brainstormed phases, not plan gaps. ✓
- **Consistency:** the tag mapping, message-replacement rules, CHANGELOG headers, and version-file target (`0.3.1`) all agree; tags are always resolved by name (never hardcoded post-rewrite SHAs). ✓
```
