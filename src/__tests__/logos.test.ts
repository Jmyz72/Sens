import { describe, it, expect } from "vitest";
import { logoFor } from "../lib/logos";
import { PROVIDER_KEYS } from "../lib/providers";

describe("logoFor", () => {
  it("returns null for null/undefined key", () => {
    expect(logoFor(null)).toBeNull();
    expect(logoFor(undefined)).toBeNull();
  });

  it("returns null for an unknown provider key", () => {
    expect(logoFor("definitely-not-a-provider")).toBeNull();
  });
});

describe("provider logo coverage", () => {
  it("resolves a logo URL for every canonical provider", () => {
    const missing = PROVIDER_KEYS.filter((k) => !logoFor(k));
    expect(missing).toEqual([]);
  });
});
