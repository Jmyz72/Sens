import { describe, expect, it } from "vitest";
import { formatLastChecked, updatePanelCopy, updateProgressPercent } from "../lib/updater";

describe("updateProgressPercent", () => {
  it("returns null when the download total is unknown", () => {
    expect(updateProgressPercent(250, undefined)).toBeNull();
    expect(updateProgressPercent(250, 0)).toBeNull();
  });

  it("rounds progress and caps it at 100", () => {
    expect(updateProgressPercent(125, 500)).toBe(25);
    expect(updateProgressPercent(499, 500)).toBe(100);
    expect(updateProgressPercent(750, 500)).toBe(100);
  });
});

describe("formatLastChecked", () => {
  it("formats a stored timestamp for display", () => {
    expect(formatLastChecked("2026-05-30T10:15:00.000Z")).toContain("2026");
  });

  it("returns a quiet fallback when no check has run", () => {
    expect(formatLastChecked(null)).toBe("Not checked yet");
  });
});

describe("updatePanelCopy", () => {
  it("explains browser dev mode clearly", () => {
    expect(updatePanelCopy({ isDesktop: false, status: "idle", currentVersion: "1.1.3" })).toMatchObject({
      tone: "muted",
      title: "Desktop app only",
      detail: "Update checks are available in the installed Sens app.",
      primaryAction: "Check",
    });
  });

  it("shows current and latest versions when an update is available", () => {
    expect(
      updatePanelCopy({
        isDesktop: true,
        status: "available",
        currentVersion: "1.1.3",
        latestVersion: "1.1.4",
      }),
    ).toMatchObject({
      tone: "accent",
      title: "Update available",
      detail: "Sens 1.1.4 is ready to download. You are on 1.1.3.",
      primaryAction: "Download & Install",
    });
  });

  it("keeps failed install errors readable", () => {
    expect(
      updatePanelCopy({
        isDesktop: true,
        status: "error",
        currentVersion: "1.1.3",
        message: "signature mismatch",
      }),
    ).toMatchObject({
      tone: "error",
      title: "Update check failed",
      detail: "signature mismatch",
    });
  });
});
