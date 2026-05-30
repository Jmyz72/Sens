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
