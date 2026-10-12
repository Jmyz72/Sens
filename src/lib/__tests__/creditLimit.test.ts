import { describe, expect, it } from "vitest";
import { creditReadout, subtypeHasCreditLimit } from "../accounts";

const LIMIT = 1_000_000; // RM 10,000

describe("subtypeHasCreditLimit", () => {
  it("is true only for credit-card and bnpl", () => {
    expect(subtypeHasCreditLimit("credit-card")).toBe(true);
    expect(subtypeHasCreditLimit("bnpl")).toBe(true);
    expect(subtypeHasCreditLimit("personal-loan")).toBe(false);
    expect(subtypeHasCreditLimit("savings")).toBe(false);
  });
});

describe("creditReadout", () => {
  it("matches the spec table", () => {
    expect(creditReadout(-400_000, LIMIT)).toEqual({ availableCents: 600_000, usedPercent: 40, overLimit: false });
    expect(creditReadout(0, LIMIT)).toEqual({ availableCents: LIMIT, usedPercent: 0, overLimit: false });
    expect(creditReadout(20_000, LIMIT)).toEqual({ availableCents: LIMIT, usedPercent: 0, overLimit: false });
    expect(creditReadout(-1_000_000, LIMIT)).toEqual({ availableCents: 0, usedPercent: 100, overLimit: false });
    expect(creditReadout(-1_200_000, LIMIT)).toEqual({ availableCents: 0, usedPercent: 120, overLimit: true });
  });
});
