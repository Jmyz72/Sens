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
   the GitHub Release for the tag has the macOS (Apple Silicon), Windows, and Linux
   artifacts attached.

## Notes

- **Unsigned macOS builds:** recipients must right-click the app and choose **Open** on
  first launch (Gatekeeper). Your own machine runs it normally.
- **Hotfix:** branch from `main`, fix via PR, then cut a **patch** release the same way.
