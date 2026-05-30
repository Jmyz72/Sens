import { describe, it, expect } from "vitest";
import { logoFor } from "../lib/logos";

describe("logoFor", () => {
  it("returns null for null/undefined key", () => {
    expect(logoFor(null)).toBeNull();
    expect(logoFor(undefined)).toBeNull();
  });

  it("returns null for an unknown provider key", () => {
    expect(logoFor("definitely-not-a-provider")).toBeNull();
  });
});
