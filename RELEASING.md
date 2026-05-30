# Releasing Sens

Sens follows [Semantic Versioning](https://semver.org/) and uses **GitHub Flow**:
`main` is always releasable, work lands via short-lived branches + PRs, and
releases are cut from `main` by pushing a `vX.Y.Z` tag.

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

Before cutting updater-enabled releases, make sure the repository has these
GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of the updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — optional; leave unset for an unencrypted
  updater key.

The matching public key is committed in `src-tauri/tauri.conf.json`. Keep the
private key backed up; losing it means already-installed apps cannot accept future
updates.

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
   the GitHub Release for the tag has the macOS (Apple Silicon), Windows, and
   `latest.json` updater artifacts attached.

## Notes

- **Unsigned macOS builds:** recipients must right-click the app and choose **Open** on
  first launch (Gatekeeper). Your own machine runs it normally.
- **Updater bootstrap:** users must install one updater-enabled release manually; later
  releases can be installed from Settings → Updates.
- **Hotfix:** branch from `main`, fix via PR, then cut a **patch** release the same way.
