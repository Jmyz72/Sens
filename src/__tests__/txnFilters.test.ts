// src/__tests__/txnFilters.test.ts
import { describe, it, expect } from "vitest";
import { nextDay, rangeForPreset } from "../lib/txnFilters";

describe("nextDay", () => {
  it("advances one day", () => {
    expect(nextDay("2026-06-02")).toBe("2026-06-03");
  });
  it("rolls over a month boundary", () => {
    expect(nextDay("2026-05-31")).toBe("2026-06-01");
  });
  it("rolls over a year boundary", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("rangeForPreset", () => {
  const today = "2026-06-15";
  it("this month → [first, next-month-first)", () => {
    expect(rangeForPreset("thisMonth", today)).toEqual({ fromDate: "2026-06-01", toDate: "2026-07-01" });
  });
  it("last month → previous calendar month", () => {
    expect(rangeForPreset("lastMonth", today)).toEqual({ fromDate: "2026-05-01", toDate: "2026-06-01" });
  });
  it("all → no bounds", () => {
    expect(rangeForPreset("all", today)).toEqual({});
  });
  it("custom → inclusive end converted to exclusive toDate", () => {
    expect(rangeForPreset("custom", today, { fromDate: "2026-03-10", toDateInclusive: "2026-03-20" }))
      .toEqual({ fromDate: "2026-03-10", toDate: "2026-03-21" });
  });
  it("custom with only a start date", () => {
    expect(rangeForPreset("custom", today, { fromDate: "2026-03-10" })).toEqual({ fromDate: "2026-03-10" });
  });
});
