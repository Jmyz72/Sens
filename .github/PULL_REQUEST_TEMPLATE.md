## Summary

<!-- What does this PR change, and why? Link any related issue (e.g. "Closes #12"). -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Build / CI / release tooling

## Checklist

- [ ] `npm run build` passes (tsc typecheck + vite build is clean)
- [ ] `npm test` passes (frontend Vitest suite)
- [ ] `cd src-tauri && cargo test --lib` passes (backend tests), if the backend changed
- [ ] If I changed a command's behavior/signature/args, I updated **both** the Rust chain **and** `src/client/mock.ts`
- [ ] No hardcoded colors — I used `useTheme()` semantic tokens
- [ ] Money stays as integer MYR cents end-to-end (formatted only at the edge)
- [ ] I updated the relevant docs (`CLAUDE.md` + its identical mirror `AGENTS.md`, design spec, `ROADMAP.md` if a phase shipped) and the `CHANGELOG.md` `[Unreleased]` section
- [ ] If I changed the Rust seed data, I ran `npm run gen:seed-catalog` and committed `src/generated/seed-catalog.json`
- [ ] I did **not** hand-edit version files (releases are cut via `npm run release`)

## Screenshots / recordings

<!-- For UI changes, before/after screenshots or a short clip really help. -->

## Notes for reviewers

<!-- Anything reviewers should focus on, known limitations, or follow-ups. -->
