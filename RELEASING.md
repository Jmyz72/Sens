# Releasing Sens

Sens follows [Semantic Versioning](https://semver.org/) and uses **GitHub Flow**:
`main` is always releasable, work lands via short-lived branches + PRs, and
releases are cut from `main` via a `release/vX.Y.Z` PR; merging it tags `vX.Y.Z`
and builds. `main` is protected (PR + 2 required CI checks), so nothing — not even
a release — is pushed to it directly.

## Versioning

Sens is **pre-1.0**: `1.0.0` is reserved for the feature-complete milestone (see
`ROADMAP.md`). While on `0.x`, the **minor** carries features and the **patch**
carries fixes.

- **patch** — bug fixes only (e.g. 0.3.1 → 0.3.2)
- **minor** — backward-compatible features; one roadmap phase = one minor (e.g. 0.3.x → 0.4.0)
- **major** — reserved: `0.x → 1.0.0` marks feature-complete; breaking changes thereafter

The three version files (`package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`) are kept identical by the release script. **Never edit
them by hand.**

## Cutting a release

There are two equivalent paths; both end with the **Release** workflow building and
publishing the macOS + Windows bundles. Pick whichever fits the moment:

- **One-click (Actions tab):** the **Cut release** workflow — quickest when you
  already know the level. See [One-click release](#one-click-release-cut-release).
- **Local (guided):** the `npm run release` script from your terminal — gives you a
  pre-flight look at the changelog and a level recommendation. See
  [Local release](#local-release).

Both call the same `scripts/release.mjs --branch` to bump versions, roll the
changelog (and its link references), and commit on a `release/vX.Y.Z` branch. Both
end at the same place: a release PR. **Merging it** fires the **Tag release**
workflow, which tags the merge commit and calls **Release** to build and publish.

Before cutting updater-enabled releases, make sure the repository has these
GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of the updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — optional; leave unset for an unencrypted
  updater key.

The matching public key is committed in `src-tauri/tauri.conf.json`. Keep the
private key backed up; losing it means already-installed apps cannot accept future
updates.

### One-click release (Cut release)

1. Confirm the `## [Unreleased]` section in `CHANGELOG.md` lists everything in this
   release (the workflow rolls it as-is — it can't draft entries for you).
2. GitHub → **Actions** → **Cut release** → **Run workflow**. Pick the bump level
   (`patch` / `minor` / `major`) and run it. (CLI equivalent:
   `gh workflow run "Cut release" -f level=minor`.)
3. The workflow pushes `release/vX.Y.Z`, opens a **`chore(release): vX.Y.Z`** PR, and
   dispatches **CI** on that branch. (A PR opened with `GITHUB_TOKEN` does not fire
   `pull_request` workflows, so CI is started with `workflow_dispatch`; its checks
   land on the PR's head commit and satisfy branch protection.)
4. When the PR is green, merge it (squash or merge commit).
5. **Tag release** tags the merge commit `vX.Y.Z`, deletes the branch, and calls
   **Release** directly (a tag pushed with `GITHUB_TOKEN` does not re-fire the tag
   trigger). Confirm the GitHub Release has the macOS, Windows, and `latest.json`
   artifacts.

Requires the repo setting **Settings → Actions → General → Workflow permissions →
"Allow GitHub Actions to create and approve pull requests"**.

### Local release

1. Make sure `main` is green, you are on `main`, up to date, with a clean tree.
2. Confirm the `## [Unreleased]` section in `CHANGELOG.md` lists everything.
3. Prepare the release branch:
   ```bash
   export PATH="$HOME/.cargo/bin:$PATH"
   npm run release -- <major|minor|patch> --branch   # or an explicit x.y.z
   ```
   This updates the three version files + `Cargo.lock`, rolls `[Unreleased]` into a
   dated section, updates the changelog link references, and commits
   `chore: release vX.Y.Z` on a new `release/vX.Y.Z` branch. It does **not** tag or push.
4. Review (`git show HEAD`), then push and open the PR:
   ```bash
   git push -u origin release/vX.Y.Z
   gh pr create --base main --title "chore(release): vX.Y.Z" --fill
   ```
   (A PR you open yourself triggers CI normally.)
5. Merge when green; **Tag release** tags and builds as above.

Without `--branch` the script keeps its legacy behaviour (commit + tag on `main`),
which only works if `main` is unprotected — don't use it here.

### Rebuilding a tag

If a build fails or never ran, re-run it from **Actions → Release → Run workflow**
with the existing tag (e.g. `v0.10.0`), or `gh workflow run release.yml -f tag=v0.10.0`.

## Notes

- **Un-notarized macOS builds:** the macOS bundle is ad-hoc signed but not notarized, so
  recipients hit a Gatekeeper block on first launch. On recent macOS they must use
  **System Settings → Privacy & Security → Open Anyway**; on older versions right-click →
  **Open** works; clearing the quarantine flag (`xattr -dr com.apple.quarantine
  /Applications/Sens.app`) works everywhere. See the README's *Download & install*.
  (The GitHub release body in `release.yml` still only mentions right-click → Open.)
- **Platforms:** releases ship **macOS Apple Silicon (aarch64)** and **Windows x64** only —
  there is no Intel-Mac build.
- **Changelog links:** `npm run release` now also adds the `[x.y.z]: …/releases/tag/vx.y.z`
  link and bumps the `[Unreleased]` compare link — no manual step.
- **Updater bootstrap:** users must install one updater-enabled release manually; later
  releases can be installed from Settings → Updates.
- **Hotfix:** branch from `main`, fix via PR, then cut a **patch** release the same way.
- **Release branches:** only PRs from `release/v*` branches in this repo trigger tagging.
  If a release PR is closed without merging, delete its branch before cutting again.
