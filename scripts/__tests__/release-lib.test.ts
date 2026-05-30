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
  it("throws on malformed input", () => expect(() => isGreater("bad", "1.0.0")).toThrow());
});

describe("setPackageJsonVersion", () => {
  it("replaces only the version field", () => {
    const src = `{\n  "name": "sens",\n  "version": "1.1.1",\n  "type": "module"\n}`;
    const out = setPackageJsonVersion(src, "1.2.0");
    expect(out).toContain(`"version": "1.2.0"`);
    expect(out).not.toContain(`"version": "1.1.1"`);
  });
  it("throws when there is no version field", () =>
    expect(() => setPackageJsonVersion(`{\n  "name": "sens"\n}`, "1.2.0")).toThrow());
});

describe("setCargoTomlVersion", () => {
  it("replaces the package version, not dependency versions", () => {
    const src = `[package]\nname = "sens"\nversion = "1.1.1"\n\n[dependencies]\ntauri = { version = "2" }\n`;
    const out = setCargoTomlVersion(src, "1.2.0");
    expect(out).toContain(`version = "1.2.0"`);
    expect(out).toContain(`tauri = { version = "2" }`);
  });
  it("throws when there is no [package] version", () =>
    expect(() => setCargoTomlVersion(`[dependencies]\ntauri = "2"\n`, "1.2.0")).toThrow());
});

describe("setTauriConfVersion", () => {
  it("replaces the top-level version", () => {
    const src = `{\n  "productName": "Sens",\n  "version": "1.1.1",\n  "identifier": "com.sens.app"\n}`;
    const out = setTauriConfVersion(src, "1.2.0");
    expect(out).toContain(`"version": "1.2.0"`);
    expect(out).not.toContain(`"version": "1.1.1"`);
  });
  it("throws when there is no version field", () =>
    expect(() => setTauriConfVersion(`{\n  "name": "sens"\n}`, "1.2.0")).toThrow());
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
  it("keeps clean single blank lines when Unreleased is empty", () => {
    const real = `# Changelog\n\n## [Unreleased]\n\n## [1.1.1] — 2026-05-30\n`;
    const out = rollChangelog(real, "1.2.0", "2026-06-01");
    expect(out).toBe(`# Changelog\n\n## [Unreleased]\n\n## [1.2.0] — 2026-06-01\n\n## [1.1.1] — 2026-05-30\n`);
    expect(out).not.toContain("\n\n\n");
  });
});
