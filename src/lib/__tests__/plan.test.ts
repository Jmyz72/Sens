import { describe, expect, it } from "vitest";
import { monthlyRequired, resolveAmount } from "../plan";

describe("resolveAmount", () => {
  const versions = [
    { effectiveMonth: "2026-10", amountCents: 80000 },
    { effectiveMonth: "2026-11", amountCents: null },
  ];
  it("keeps October and clears November onward", () => {
    expect(resolveAmount(versions, "2026-09")).toBeNull();
    expect(resolveAmount(versions, "2026-10")).toBe(80000);
    expect(resolveAmount(versions, "2026-12")).toBeNull();
  });
});

describe("monthlyRequired", () => {
  it("matches the worked examples", () => {
    expect(monthlyRequired("2026-10-14", "2027-06-01", 420_000, 1_000_000)).toBe(72_500);
    // Eight months (Oct through May), so ceil(1001/8) is 126. 334 is that gap over three months.
    expect(monthlyRequired("2026-10-14", "2027-06-01", 0, 1_001)).toBe(126);
    expect(monthlyRequired("2026-10-14", "2027-01-01", 0, 1_001)).toBe(334);
    expect(monthlyRequired("2026-10-14", null, 0, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2026-06-01", 0, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2027-06-01", 1_000, 1_000)).toBeNull();
    expect(monthlyRequired("2026-10-14", "2026-10-20", 0, 500)).toBe(500);
  });
});
