import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, AccountSubtype, DashboardSummary } from "../types";

describe("mock taxonomy + net worth", () => {
  it("lists 16 subtypes with type+group", async () => {
    const subs = await mockInvoke<AccountSubtype[]>("list_account_subtypes", {});
    expect(subs).toHaveLength(16);
    const card = subs.find((s) => s.key === "credit-card")!;
    expect(card.type).toBe("credit");
    expect(card.group).toBe("owe");
  });

  it("create_account derives type/group and rejects bad subtype", async () => {
    const acc = await mockInvoke<Account>("create_account", { name: "Card", subtype: "credit-card", openingBalanceCents: -50000, templateKey: null });
    expect(acc.accountType).toBe("credit");
    expect(acc.group).toBe("owe");
    await expect(mockInvoke("create_account", { name: "X", subtype: "nope", openingBalanceCents: 0, templateKey: null }))
      .rejects.toMatchObject({ code: "ValidationError" });
  });

  it("dashboard reports net worth = assets + liabilities", async () => {
    await mockInvoke("create_account", { name: "Cash", subtype: "cash", openingBalanceCents: 1000000, templateKey: null });
    await mockInvoke("create_account", { name: "Loan", subtype: "personal-loan", openingBalanceCents: -300000, templateKey: null });
    const d = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-05" });
    expect(d.netWorthCents).toBe(d.assetsCents + d.liabilitiesCents);
    expect(d.assetsCents).toBeGreaterThan(0);
    expect(d.liabilitiesCents).toBeLessThanOrEqual(0); // all owe-group balances here are negative
    expect(d.liabilitiesCents).toBeLessThan(d.assetsCents);
  });

  it("create_account rejects an unknown templateKey", async () => {
    await expect(mockInvoke("create_account", { name: "X", subtype: "cash", openingBalanceCents: 0, templateKey: "not-a-bank" }))
      .rejects.toMatchObject({ code: "NotFound" });
  });
});
