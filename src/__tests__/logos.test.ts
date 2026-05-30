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

// Policy: logo where one is bundled, brand-tinted monogram fallback otherwise.
// (No completeness requirement — gaps are expected and handled by ProviderLogo.)
describe("provider logo coverage", () => {
  const BUNDLED = [
    "aeon-bank", "affin-bank", "agrobank", "al-rajhi-bank", "alliance-bank",
    "ambank", "bank-rakyat", "cimb", "hong-leong-bank", "luno", "maybank",
    "ocbc", "public-bank", "rakuten-trade", "rhb", "standard-chartered",
    "stashaway", "tng-ewallet", "uob",
    "paypal", "wise", "revolut", "n26", "payoneer", "hsbc",
    "grabpay", "grab-paylater", "shopeepay", "shopee-paylater",
  ];

  it("resolves a logo URL for every bundled provider", () => {
    const missing = BUNDLED.filter((k) => !logoFor(k));
    expect(missing).toEqual([]);
  });

  it("returns null for a provider with no bundled logo (monogram fallback path)", () => {
    expect(logoFor("gxbank")).toBeNull();
  });
});
