# Roadmap & version re-baseline — design

**Date:** 2026-05-31
**Status:** Approved (brainstorming)
**Topic:** A durable `ROADMAP.md` planning system + a one-time re-baseline of all published versions from the `1.x` line into a deliberate `0.x` line that climbs toward a feature-complete `1.0.0`.

## Why

Two linked frustrations:

1. **Features are tackled one by one.** There is no artifact *above* a single feature — every spec/plan starts cold. We want a single living roadmap that captures the full product vision once, grouped into phases, each phase stamped with the release it ships under. Picking up work becomes "do the next phase," not "re-explain the backlog."
2. **Versions were chosen by preference.** The published `v1.0.0`–`v1.2.1` tags do not reflect a deliberate scheme, and the app — still missing budgets, recurring transactions, reports, goals, and data export — has not earned a 1.0. We re-baseline the entire history into `0.x` and reserve `1.0.0` for feature-complete.

These are designed together because the roadmap's release tags and the version scheme must agree.

## Part A — The `ROADMAP.md` system

A single living file at the **repo root** (`ROADMAP.md`). It is the *index*; the existing `docs/superpowers/specs/` + `docs/superpowers/plans/` remain the *detail*. No duplication: the roadmap links out to a phase's spec once that phase is brainstormed.

### Structure

1. **Header** — one paragraph on what the roadmap is, plus the core rule: *one phase = one release; a phase begins with brainstorming and ends when its `v*` tag ships.*
2. **Now / Next / Later snapshot** — three lines at the top showing current state at a glance.
3. **Status legend** — `🟢 shipped` · `🟡 in progress` · `⚪ planned`.
4. **One section per phase**, each containing:
   - Release tag + theme title + status marker.
   - A one-paragraph goal.
   - A checklist of features, each a one-line scope.
   - A **spec link** (filled in when that phase is brainstormed; left as `— spec: _TBD_` until then).
5. **Conventions footer** — the SemVer policy (Part C), how to add a new idea (drop it into the right phase, or into a "Later / unscheduled" bucket), and how to mark a phase done (flip the status marker, ship the tag, link the spec).

### How it is used going forward

- Starting a phase: invoke `brainstorming` → `writing-plans` → implement, exactly as today. The roadmap entry is the seed.
- Finishing a phase: `npm run release -- <major|minor|patch>` per `RELEASING.md`, then flip the phase marker to 🟢 and record the shipped tag.
- New ideas mid-stream: append to the appropriate phase's checklist, or to the "Later / unscheduled" bucket if it doesn't belong to a planned phase yet. The roadmap never blocks an idea from being captured.

## Part B — Roadmap content (full product vision)

Phases climb the `0.x` line; **`1.0.0` is the feature-complete milestone**.

| Phase | Release | Theme | Headline features |
|---|---|---|---|
| 0 | **v0.4.0** 🟡 | Subcategories *(in flight)* | two-level categories, master–detail Categories screen, subcategory-aware transaction picker & dashboard roll-up *(already built; sitting in `[Unreleased]`)* |
| 1 | **v0.5.0** ⚪ | Credit & debt behavior | credit limits + utilization (credit-card, BNPL); installment / payoff schedules + interest (personal-loan, mortgage, car-loan, borrowed) |
| 2 | **v0.6.0** ⚪ | Investment value | cost basis vs current value, unrealized gain/loss (investment, unit-trust, crypto); fixed-deposit maturity — **completes the deferred taxonomy work promised in CLAUDE.md** |
| 3 | **v0.7.0** ⚪ | Budgets & goals | monthly budget per category, budget-vs-actual, overspend warnings; savings goals (target amounts + progress) |
| 4 | **v0.8.0** ⚪ | Recurring & reminders | recurring/scheduled transactions, upcoming list, one-tap post; bill due-date reminders |
| 5 | **v0.9.0** ⚪ | Search, filter & tags | full transaction search, advanced filters (date/account/kind/amount), free-form tags |
| 6 | **v0.10.0** ⚪ | Reports & insights | spending/cashflow trends & charts beyond the dashboard; net-worth history over time |
| 7 | **v0.11.0** ⚪ | Data integrity & ownership | CSV import/export; full backup & restore; account reconciliation against a statement balance |
| 8 | **🎉 v1.0.0** ⚪ | Onboarding & polish *(milestone)* | receipts/attachments on transactions; first-run onboarding; 1.0 polish pass |

Granularity is deliberately **one theme per minor release** — matches the project's fast cadence and keeps each phase a digestible batch. Phases 1–2 clear the behavior debt CLAUDE.md already promises; 3–8 are the forward product vision. All 16 features selected for the 1.0 goal are placed; nothing is deferred to a "Later / unscheduled" bucket.

Each phase's feature list is a starting scope, not a contract — the per-phase brainstorming session refines it.

## Part C — Version re-baseline (`1.x` → `0.x`)

### SemVer policy (the new rule, so versions stop being "by preference")

- The project is **pre-1.0**: in `0.x`, the **minor** carries feature releases and **patch** carries fixes/small follow-ups.
- One roadmap **phase = one minor bump** (`0.N.0`); follow-up fixes to a shipped phase are **patches** (`0.N.x`).
- **`1.0.0` is reserved** for the feature-complete milestone (Phase 8). It is the only major bump on the current horizon.
- Versions are produced **only** by `npm run release -- <…>` per `RELEASING.md`. The hand-edit in this refactor (below) is a one-time exception.

### Tag mapping (each tag stays on its original commit content; only the name/message changes)

| Old tag | → New tag | Release meaning |
|---|---|---|
| `v1.0.0` | **`v0.1.0`** | Initial release |
| `v1.1.0` | **`v0.2.0`** | Account taxonomy, signed liabilities, net worth |
| `v1.1.1` | **`v0.2.1`** | JOIN robustness + owe-account balance correction |
| `v1.1.2` | **`v0.2.2`** | patch |
| `v1.1.3` | **`v0.2.3`** | patch |
| `v1.1.4` | **`v0.2.4`** | advanced sidebar shell |
| `v1.2.0` | **`v0.3.0`** | Accounts screen + shell redesign |
| `v1.2.1` | **`v0.3.1`** | New Account modal redesign + provider logos |

After the refactor, the working tree's "current version" is **`0.3.1`**, so the next release (subcategories) is `npm run release -- minor` → **`v0.4.0`**.

### Scope of the rewrite (maximal cleanliness — user opted in)

This is a **full history rewrite**. Every commit SHA from the first rewritten commit onward changes, and the branch + all tags force-push.

**Rewritten:**
1. **Commit messages** — any commit message referencing a version (release commits like `chore: release v1.2.1`, CHANGELOG-roll commits, version-bearing merge/subject lines) is rewritten to its `0.x` equivalent via the mapping above.
2. **Git tags** — the 8 `v1.x` tags are recreated as `v0.x` on the corresponding rewritten commits; old tags deleted locally and on `origin`.
3. **GitHub Releases** — the 8 existing releases are deleted and recreated against the new `v0.x` tags, with titles/notes renumbered.
4. **`CHANGELOG.md`** (working tree) — every `## [1.x] — date` header renumbered to `## [0.x]`; dates and body content unchanged. The `[Unreleased]` section is untouched (it becomes `v0.4.0` at next release).
5. **Version files** (working tree, one-time hand edit) — `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `Cargo.lock` set to `0.3.1`. This is the sanctioned exception to CLAUDE.md's "never hand-edit version files" rule because it is a history refactor, not a release.

**Explicitly NOT rewritten (non-goals, with rationale):**
- **Historical in-tree file contents** (e.g. `package.json` *as committed at the old `v1.2.1` commit* still reading `1.2.1`). Rewriting tree blobs across all history is far more invasive and error-prone than message+tag rewriting, and historical file contents are rarely inspected. Only the **current working tree** version files are corrected. If the user wants byte-perfect historical version files too, that is a separate, larger filter-repo blob-replacement pass.
- **Spec/plan filenames and `docs/` content** referencing old versions stay as-is (they are dated historical records).

### Tooling

`git-filter-repo` is **not installed**; `git` is `2.52.0`. The implementation plan chooses between:
- installing `git-filter-repo` (preferred — safer, handles tag rewriting cleanly), or
- `git filter-branch --msg-filter` + `--tag-name-filter` (built-in fallback, slower, emits warnings).

Either way the rewrite runs against a **fresh backup clone / backup branch** first, is verified locally (`git log`, `git tag`, build + tests green), and only then force-pushed.

### Execution order (high level — detailed steps go in the plan)

1. Hard prerequisite: clean working tree, full backup (mirror clone of the repo) so the rewrite is recoverable.
2. Rewrite commit messages + tags on a working copy; verify the new `v0.x` tags sit on the right commits.
3. Renumber `CHANGELOG.md` and the version files in the working tree; commit.
4. Run the gates (`npm run build`, `npm test`, `cargo build`/`cargo test`) — must be green.
5. Force-push the rewritten branch and tags to `origin`; delete old remote tags.
6. Delete + recreate the 8 GitHub Releases against the new tags.
7. Create `ROADMAP.md` (Parts A + B) and commit.

### Repo context & risks the user has accepted

The repo `Jmyz72/Sens` is **public** on GitHub but currently has **0 forks and 0 stars** — no downstream clones depend on the existing tags/SHAs. The user confirmed the **full history rewrite** (commit messages + SHAs) with this public context explicit; doing it now, before there is any audience, is the lowest-impact moment to rewrite. The repo recently gained an open-source presentation layer (LICENSE, README, CONTRIBUTING, SECURITY, issue/PR templates) — the clean `0.x` history is what every future clone/fork will see.

- Force-pushing rewritten history + tags and deleting/recreating Releases permanently rewrites public history; any pre-existing clone or downloaded `v1.x` reference is broken. Acceptable given 0 forks/0 stars.
- Every commit SHA changes; any external link to an old SHA/tag dies.

## Out of scope

- Per-phase feature design — each phase gets its own brainstorming → spec → plan cycle when it starts.
- Any code/business-logic change. This work is the roadmap document + a version/metadata refactor only.
- Byte-perfect historical version-file contents (see non-goals).
