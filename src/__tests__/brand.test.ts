import { describe, it, expect } from "vitest";
import { BRAND_COLORS, accountTone } from "../lib/brand";

// ── BRAND_COLORS ──────────────────────────────────────────────────────────────

describe("BRAND_COLORS", () => {
  it("has an entry for 'maybank'", () => {
    expect(BRAND_COLORS).toHaveProperty("maybank");
    expect(typeof BRAND_COLORS["maybank"]).toBe("string");
  });

  it("has an entry for 'grabpay'", () => {
    expect(BRAND_COLORS).toHaveProperty("grabpay");
    expect(typeof BRAND_COLORS["grabpay"]).toBe("string");
  });

  it("has an entry for 'stashaway'", () => {
    expect(BRAND_COLORS).toHaveProperty("stashaway");
    expect(typeof BRAND_COLORS["stashaway"]).toBe("string");
  });

  it("has an entry for 'cimb'", () => {
    expect(BRAND_COLORS).toHaveProperty("cimb");
  });

  it("has an entry for 'tng-ewallet'", () => {
    expect(BRAND_COLORS).toHaveProperty("tng-ewallet");
  });

  it("all values are hex color strings", () => {
    for (const [key, color] of Object.entries(BRAND_COLORS)) {
      expect(color, `BRAND_COLORS['${key}'] should be a hex color`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ── accountTone ───────────────────────────────────────────────────────────────

describe("accountTone", () => {
  it("returns brand color when templateKey is a known brand", () => {
    expect(accountTone({ templateKey: "maybank" }, "#fallback")).toBe(BRAND_COLORS["maybank"]);
  });

  it("returns accentFallback when templateKey is null", () => {
    expect(accountTone({ templateKey: null }, "#acc")).toBe("#acc");
  });

  it("returns accentFallback when no opts are provided", () => {
    expect(accountTone({}, "#acc")).toBe("#acc");
  });

  it("returns a deterministic color for the same fallbackSeed", () => {
    const color1 = accountTone({ fallbackSeed: "same-id" }, "#acc");
    const color2 = accountTone({ fallbackSeed: "same-id" }, "#acc");
    expect(color1).toBe(color2);
  });

  it("returns a value from FALLBACK_PALETTE (not the accentFallback) when fallbackSeed is set", () => {
    const color = accountTone({ fallbackSeed: "some-account-id" }, "#ffffff");
    // Should NOT be the fallback — it should be from the palette
    expect(color).not.toBe("#ffffff");
    // Should be a valid hex color
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("different seeds can produce different results (palette has 8 entries)", () => {
    // Collect results for many different seeds; expect some variation
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(accountTone({ fallbackSeed: `account-${i}` }, "#fallback"));
    }
    // With 20 different seeds across 8 palette slots, we expect > 1 distinct color
    expect(results.size).toBeGreaterThan(1);
  });

  it("templateKey takes precedence over fallbackSeed", () => {
    const color = accountTone({ templateKey: "maybank", fallbackSeed: "some-id" }, "#acc");
    expect(color).toBe(BRAND_COLORS["maybank"]);
  });
});
