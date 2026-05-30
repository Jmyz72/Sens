import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Category, DashboardSummary } from "../types";

async function expenseParent(name: string): Promise<Category> {
  return mockInvoke<Category>("create_category", { name, kind: "expense", emoji: "🍔", color: null, parentId: null });
}

describe("mock subcategories", () => {
  it("a subcategory inherits its parent's kind", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "income", emoji: "☕", color: null, parentId: food.id });
    expect(sub.kind).toBe("expense");
    expect(sub.parentId).toBe(food.id);
  });

  it("rejects nesting under a subcategory", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await expect(mockInvoke("create_category", { name: "Latte", kind: "expense", emoji: "🥛", color: null, parentId: sub.id }))
      .rejects.toMatchObject({ code: "ValidationError" });
  });

  it("archiving a parent cascades to children and restoring un-archives them", async () => {
    const food = await expenseParent(`Food-${Math.random()}`);
    const sub = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await mockInvoke("archive_category", { id: food.id });
    let all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === sub.id)!.isArchived).toBe(true);
    await mockInvoke("restore_category", { id: food.id });
    all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === sub.id)!.isArchived).toBe(false);
  });

  it("dashboard rolls subcategory spend into the parent", async () => {
    const acc = await mockInvoke<{ id: string }>("create_account", { name: `Acc-${Math.random()}`, subtype: "cash", openingBalanceCents: 0, templateKey: null });
    const food = await expenseParent(`Food-${Math.random()}`);
    const coffee = await mockInvoke<Category>("create_category", { name: "Coffee", kind: "expense", emoji: "☕", color: null, parentId: food.id });
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: food.id, amountCents: 1000, description: null, date: "2026-07-10" });
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: coffee.id, amountCents: 500, description: null, date: "2026-07-11" });
    const d = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-07" });
    const row = d.spendingBreakdown.find((b) => b.categoryId === food.id)!;
    expect(row.totalCents).toBe(1500);
    expect(d.spendingBreakdown.some((b) => b.categoryId === coffee.id)).toBe(false);
  });
});
