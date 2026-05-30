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
});

describe("setPackageJsonVersion", () => {
  it("replaces only the version field", () => {
    const src = `{\n  "name": "sens",\n  "version": "1.1.1",\n  "type": "module"\n}`;
    expect(setPackageJsonVersion(src, "1.2.0")).toContain(`"version": "1.2.0"`);
  });
});

describe("setCargoTomlVersion", () => {
  it("replaces the package version, not dependency versions", () => {
    const src = `[package]\nname = "sens"\nversion = "1.1.1"\n\n[dependencies]\ntauri = { version = "2" }\n`;
    const out = setCargoTomlVersion(src, "1.2.0");
    expect(out).toContain(`version = "1.2.0"`);
    expect(out).toContain(`tauri = { version = "2" }`);
  });
});

describe("setTauriConfVersion", () => {
  it("replaces the top-level version", () => {
    const src = `{\n  "productName": "Sens",\n  "version": "1.1.1",\n  "identifier": "com.sens.app"\n}`;
    expect(setTauriConfVersion(src, "1.2.0")).toContain(`"version": "1.2.0"`);
  });
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
});
