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
    const acc = await mockInvoke<Account>("create_account", { name: "Card", subtype: "credit-card", openingBalanceCents: -50000, templateKey: null, creditLimitCents: 1_000_000,
    });
    expect(acc.creditLimitCents).toBe(1_000_000);
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

  it("requires a positive limit only on credit-card and bnpl", async () => {
    const card = await mockInvoke<Account>("create_account", {
      name: "Visa", subtype: "credit-card", openingBalanceCents: -200000, templateKey: null, creditLimitCents: 1_000_000,
    });
    expect(card.creditLimitCents).toBe(1_000_000);
    const bnpl = await mockInvoke<Account>("create_account", {
      name: "Atome", subtype: "bnpl", openingBalanceCents: -50000, templateKey: null, creditLimitCents: 300_000,
    });
    expect(bnpl.creditLimitCents).toBe(300_000);

    await expect(mockInvoke("create_account", { name: "Visa", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: null }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit is required for this account." });
    await expect(mockInvoke("create_account", { name: "Visa", subtype: "bnpl", openingBalanceCents: 0, templateKey: null, creditLimitCents: 0 }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit must be greater than zero." });
    await expect(mockInvoke("create_account", { name: "Visa", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: -1 }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit must be greater than zero." });
    await expect(mockInvoke("create_account", { name: "Cash", subtype: "savings", openingBalanceCents: 100, templateKey: null, creditLimitCents: 500 }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit only applies to credit cards and BNPL." });
    const savings = await mockInvoke<Account>("create_account", { name: "Cash", subtype: "savings", openingBalanceCents: 100, templateKey: null, creditLimitCents: null });
    expect(savings.creditLimitCents).toBeNull();

    const replaced = await mockInvoke<Account>("update_account", { input: { id: card.id, creditLimitCents: 2_000_000 } });
    expect(replaced.creditLimitCents).toBe(2_000_000);
    const kept = await mockInvoke<Account>("update_account", { input: { id: card.id, name: "Visa Gold" } });
    expect(kept.creditLimitCents).toBe(2_000_000);
    const cleared = await mockInvoke<Account>("update_account", { input: { id: card.id, subtype: "savings" } });
    expect(cleared.creditLimitCents).toBeNull();

    const reread = async (id: string) =>
      (await mockInvoke<Account[]>("list_accounts", { includeArchived: true })).find((x) => x.id === id)!;

    await expect(mockInvoke("update_account", { input: { id: savings.id, name: "Renamed", subtype: "credit-card" } }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit is required for this account." });
    const afterReject1 = await reread(savings.id);
    expect(afterReject1.subtype).toBe("savings");
    expect(afterReject1.name).toBe("Cash");
    expect(afterReject1.creditLimitCents).toBeNull();
    expect(afterReject1.updatedAt).toBe(savings.updatedAt);
    const switched = await mockInvoke<Account>("update_account", { input: { id: savings.id, subtype: "bnpl", creditLimitCents: 400_000 } });
    expect(switched.creditLimitCents).toBe(400_000);
    await expect(mockInvoke("update_account", { input: { id: switched.id, name: "Renamed", subtype: "cash", creditLimitCents: 10 } }))
      .rejects.toMatchObject({ code: "ValidationError", message: "Credit limit only applies to credit cards and BNPL." });
    const afterReject2 = await reread(switched.id);
    expect(afterReject2.subtype).toBe("bnpl");
    expect(afterReject2.name).toBe("Cash");
    expect(afterReject2.creditLimitCents).toBe(400_000);
    expect(afterReject2.updatedAt).toBe(switched.updatedAt);
  });
});
