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
