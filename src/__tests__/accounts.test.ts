import { describe, it, expect } from "vitest";
import { balanceDisplay, sidebarPortfolioSummary, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
import type { Account } from "../types";

describe("balanceDisplay", () => {
  it("own shows signed value as-is", () => {
    expect(balanceDisplay("own", 5000)).toMatchObject({ magnitude: 5000, tone: "text", label: null });
    expect(balanceDisplay("own", -5000)).toMatchObject({ magnitude: -5000, tone: "negative" });
  });
  it("owe with debt shows positive magnitude, negative tone, owe label", () => {
    expect(balanceDisplay("owe", -50000)).toMatchObject({ magnitude: 50000, tone: "negative", label: "You owe" });
  });
  it("owe in credit shows positive, in-credit label", () => {
    expect(balanceDisplay("owe", 2000)).toMatchObject({ magnitude: 2000, tone: "income", label: "In credit" });
  });
});

describe("type metadata", () => {
  it("labels all five types and orders them own→owe", () => {
    expect(TYPE_LABEL.fund).toBe("Cash & funds");
    expect(TYPE_ORDER).toEqual(["fund", "financial", "receivable", "payable", "credit"]);
  });
});

describe("sidebarPortfolioSummary", () => {
  it("sums active assets and liabilities into signed net worth", () => {
    const accounts: Pick<Account, "group" | "balanceCents" | "isArchived">[] = [
      { group: "own", balanceCents: 120000, isArchived: false },
      { group: "own", balanceCents: 30000, isArchived: false },
      { group: "owe", balanceCents: -45000, isArchived: false },
      { group: "owe", balanceCents: 5000, isArchived: false },
    ];

    expect(sidebarPortfolioSummary(accounts)).toEqual({
      assetsCents: 150000,
      liabilitiesCents: -40000,
      netWorthCents: 110000,
    });
  });

  it("ignores archived accounts", () => {
    const accounts: Pick<Account, "group" | "balanceCents" | "isArchived">[] = [
      { group: "own", balanceCents: 120000, isArchived: false },
      { group: "own", balanceCents: 900000, isArchived: true },
      { group: "owe", balanceCents: -25000, isArchived: true },
    ];

    expect(sidebarPortfolioSummary(accounts)).toEqual({
      assetsCents: 120000,
      liabilitiesCents: 0,
      netWorthCents: 120000,
    });
  });
});
