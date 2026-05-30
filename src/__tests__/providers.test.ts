import { describe, it, expect } from "vitest";
import { PROVIDER_GROUPS, PROVIDER_KEYS } from "../lib/providers";

describe("provider catalog", () => {
  it("mirrors the full Rust seed: 50 providers, all keys unique", () => {
    expect(PROVIDER_KEYS.length).toBe(50);
    expect(new Set(PROVIDER_KEYS).size).toBe(50);
  });

  it("includes the providers the old 33-entry mock dropped", () => {
    for (const k of ["agrobank", "kaf-digital-bank", "bank-muamalat", "riipay", "kdi", "luno"]) {
      expect(PROVIDER_KEYS).toContain(k);
    }
  });

  it("every group's defaultSubtype is a real subtype key", () => {
    const VALID_SUBTYPES = new Set([
      "cash", "ewallet", "savings", "current", "fixed-deposit", "investment",
      "unit-trust", "crypto", "lent", "borrowed", "credit-card", "bnpl",
      "personal-loan", "mortgage", "car-loan", "other-debt",
    ]);
    for (const g of PROVIDER_GROUPS) expect(VALID_SUBTYPES.has(g.defaultSubtype)).toBe(true);
  });
});
