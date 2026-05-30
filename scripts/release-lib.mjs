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
  const parse = (v) => {
    const parts = v.split(".").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid version: ${v}`);
    return parts;
  };
  const a = parse(current);
  const b = parse(next);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

// Replaces the FIRST `"version": "..."` — the top-level field in package.json / tauri.conf.json.
function setJsonVersion(text, version) {
  const out = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (out === text) throw new Error('setJsonVersion: no "version" field found');
  return out;
}

export function setPackageJsonVersion(text, version) {
  return setJsonVersion(text, version);
}

export function setTauriConfVersion(text, version) {
  return setJsonVersion(text, version);
}

// Replaces the version inside [package] only — not a [workspace] root version
// nor inline dependency versions (e.g. `tauri = { version = "2" }`).
export function setCargoTomlVersion(text, version) {
  const out = text.replace(
    /(^\[package\][^\[]*?^version\s*=\s*)"[^"]+"/ms,
    `$1"${version}"`,
  );
  if (out === text) throw new Error("setCargoTomlVersion: no [package] version found");
  return out;
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
