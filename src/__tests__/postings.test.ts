import { describe, it, expect } from "vitest";
import { postingsFor } from "../lib/kinds";

describe("postingsFor", () => {
  const cases = [
    { kind: "income" as const, amt: 5000, acc: "a", to: null },
    { kind: "expense" as const, amt: 2000, acc: "a", to: null },
    { kind: "transfer" as const, amt: 1000, acc: "a", to: "b" },
    { kind: "adjustment" as const, amt: -500, acc: "a", to: null },
    { kind: "opening" as const, amt: 7000, acc: "a", to: null },
  ];

  it("always produces legs that sum to zero", () => {
    for (const c of cases) {
      const legs = postingsFor(c.kind, c.amt, c.acc, c.to);
      const sum = legs.reduce((s, l) => s + l.amountCents, 0);
      expect(sum).toBe(0);
    }
  });

  it("the real-account leg matches the old per-account sign", () => {
    const inc = postingsFor("income", 5000, "a", null).filter((l) => l.accountId === "a");
    expect(inc.reduce((s, l) => s + l.amountCents, 0)).toBe(5000);
    const exp = postingsFor("expense", 2000, "a", null).filter((l) => l.accountId === "a");
    expect(exp.reduce((s, l) => s + l.amountCents, 0)).toBe(-2000);
    const xferSrc = postingsFor("transfer", 1000, "a", "b").filter((l) => l.accountId === "a");
    expect(xferSrc.reduce((s, l) => s + l.amountCents, 0)).toBe(-1000);
    const xferDst = postingsFor("transfer", 1000, "a", "b").filter((l) => l.accountId === "b");
    expect(xferDst.reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
  });
});
