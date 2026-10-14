import { describe, expect, it } from "vitest";
import { parseSliceBudgetField } from "../budgetAmount";

describe("parseSliceBudgetField", () => {
  it("treats blank as unset", () => {
    expect(parseSliceBudgetField("")).toEqual({ kind: "unset" });
    expect(parseSliceBudgetField("   ")).toEqual({ kind: "unset" });
  });

  it("parses zero as a real amount", () => {
    expect(parseSliceBudgetField("0")).toEqual({ kind: "amount", cents: 0 });
    expect(parseSliceBudgetField("0.00")).toEqual({ kind: "amount", cents: 0 });
  });

  it("rejects unreadable non-blank values", () => {
    expect(parseSliceBudgetField("1.2.3")).toEqual({ kind: "invalid" });
    expect(parseSliceBudgetField(".")).toEqual({ kind: "invalid" });
  });
});
