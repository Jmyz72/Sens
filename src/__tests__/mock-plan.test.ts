import { describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Category, Plan, PlanGoal } from "../types";
import { localToday } from "../lib/plan";

const month = localToday().slice(0, 7);

async function cats() {
  const all = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: true });
  const food = all.find((c) => c.name === "Food" && c.parentId == null)!;
  const dining = all.find((c) => c.name === "Dining out" && c.parentId === food.id)!;
  return { food, dining };
}

describe("mock plan", () => {
  it("keeps the envelope and the goal rules", async () => {
    await mockInvoke("reset_app", {});
    await mockInvoke("set_setting", { key: "transaction_time_enabled", value: "0" });
    const { food, dining } = await cats();
    const sav = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Savings", subtype: "savings", openingBalanceCents: 420_000, templateKey: null, creditLimitCents: null,
    });
    await mockInvoke("set_budgets", { items: [
      { categoryId: food.id, amountCents: 80_000 },
      { categoryId: dining.id, amountCents: 25_000 },
    ] });
    await expect(mockInvoke("set_budgets", { items: [{ categoryId: food.id, amountCents: 20_000 }] }))
      .rejects.toMatchObject({ message: "Subcategory budgets add up to more than the parent." });
    const kept = await mockInvoke<Plan>("get_plan", { month });
    expect(kept.budgets.find((b) => b.categoryId === food.id)?.amountCents).toBe(80_000);

    await mockInvoke("create_expense_transaction", {
      accountId: sav.id, categoryId: dining.id, amountCents: 30_000, description: null, date: `${month}-02`,
      time: null, excludedFromReporting: false, splits: null,
    });
    const other = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Other", subtype: "cash", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    await mockInvoke("create_transfer_transaction", {
      fromAccountId: sav.id, toAccountId: other.id, amountCents: 5_000, description: null, date: `${month}-03`, time: null,
    });
    const spent = await mockInvoke<Plan>("get_plan", { month });
    expect(spent.budgets.find((b) => b.categoryId === dining.id)?.spentCents).toBe(30_000);
    expect(spent.budgets.find((b) => b.categoryId === food.id)?.spentCents).toBe(30_000);

    const goal = await mockInvoke<PlanGoal>("create_goal", {
      input: { name: "Emergency", accountId: sav.id, targetCents: 1_000_000, targetDate: "2027-06-01" },
    });
    expect(goal.balanceCents).toBe(385_000);
    await expect(mockInvoke("create_goal", {
      input: { name: "Holiday", accountId: sav.id, targetCents: 1, targetDate: null },
    })).rejects.toMatchObject({ message: "This account already has a goal." });

    const card = await mockInvoke<{ id: string }>("create_account", {
      name: "Plan Card", subtype: "credit-card", openingBalanceCents: 0, templateKey: null, creditLimitCents: 500_000,
    });
    await expect(mockInvoke("create_goal", {
      input: { name: "Card", accountId: card.id, targetCents: 1, targetDate: null },
    })).rejects.toMatchObject({ message: "Goals can only sit on cash, an e-wallet, savings, or a current account." });

    await mockInvoke("reset_app", {});
    const cleared = await mockInvoke<Plan>("get_plan", { month: "2026-10" });
    expect(cleared.budgets).toEqual([]);
    expect(cleared.goals).toEqual([]);
  });
});
