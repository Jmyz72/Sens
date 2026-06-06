import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";

async function expenseCats() {
  const cats = await mockInvoke<any[]>("list_categories", { kind: "expense", includeArchived: false });
  return cats.filter((c) => !c.isSystem);
}

// reset_app wipes accounts without re-seeding demo data, so each test creates
// its own account.
async function freshAccount() {
  return mockInvoke<any>("create_account", {
    name: `Acc-${Math.random()}`, subtype: "cash", openingBalanceCents: 0, templateKey: null,
  });
}

describe("mock splits", () => {
  it("creates a split expense, attributes breakdown per category, leaves balance whole", async () => {
    await mockInvoke("reset_app", {});
    const acc = await freshAccount();
    const cats = await expenseCats();
    const before = await mockInvoke<number>("get_account_balance", { accountId: acc.id });
    const tx = await mockInvoke<any>("create_expense_transaction", {
      accountId: acc.id, categoryId: null, amountCents: 15000, description: "Lotus",
      date: "2026-06-10", time: null, excludedFromReporting: false,
      splits: [ { categoryId: cats[0].id, amountCents: 10000 }, { categoryId: cats[1].id, amountCents: 5000 } ],
    });
    expect(tx.splits).toHaveLength(2);
    expect(tx.categoryId).toBe(cats[0].id);
    const after = await mockInvoke<number>("get_account_balance", { accountId: acc.id });
    expect(before - after).toBe(15000);
    const dash = await mockInvoke<any>("get_dashboard_summary", { month: "2026-06" });
    const sum = dash.spendingBreakdown.reduce((s: number, r: any) => s + r.totalCents, 0);
    expect(sum).toBeGreaterThanOrEqual(15000);
  });

  it("rejects a split whose lines don't sum to the total", async () => {
    await mockInvoke("reset_app", {});
    const acc = await freshAccount();
    const cats = await expenseCats();
    await expect(mockInvoke("create_expense_transaction", {
      accountId: acc.id, categoryId: null, amountCents: 15000, description: null,
      date: "2026-06-10", time: null, excludedFromReporting: false,
      splits: [ { categoryId: cats[0].id, amountCents: 10000 }, { categoryId: cats[1].id, amountCents: 4000 } ],
    })).rejects.toMatchObject({ code: "ValidationError" });
  });
});
