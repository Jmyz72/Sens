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

  it("deletes an unused category but blocks ones with children or transactions", async () => {
    const unused = await expenseParent(`Trash-${Math.random()}`);
    await mockInvoke("delete_category", { id: unused.id });
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.some((c) => c.id === unused.id)).toBe(false);

    const parent = await expenseParent(`HasKid-${Math.random()}`);
    await mockInvoke<Category>("create_category", { name: "Kid", kind: "expense", emoji: "🧒", color: null, parentId: parent.id });
    await expect(mockInvoke("delete_category", { id: parent.id })).rejects.toMatchObject({ code: "Conflict" });

    const acc = await mockInvoke<{ id: string }>("create_account", { name: `A-${Math.random()}`, subtype: "cash", openingBalanceCents: 0, templateKey: null });
    const used = await expenseParent(`Used-${Math.random()}`);
    await mockInvoke("create_expense_transaction", { accountId: acc.id, categoryId: used.id, amountCents: 100, description: null, date: "2026-05-10" });
    await expect(mockInvoke("delete_category", { id: used.id })).rejects.toMatchObject({ code: "Conflict" });
  });

  it("reorder_categories assigns sort_order by index", async () => {
    const a = await expenseParent(`Ord-A-${Math.random()}`);
    const b = await expenseParent(`Ord-B-${Math.random()}`);
    await mockInvoke("reorder_categories", { ids: [b.id, a.id] });
    const all = await mockInvoke<Category[]>("list_categories", { kind: null, includeArchived: true });
    expect(all.find((c) => c.id === b.id)!.sortOrder).toBe(0);
    expect(all.find((c) => c.id === a.id)!.sortOrder).toBe(1);
  });

  it("set_category_parent moves, promotes, and rejects cross-kind", async () => {
    const food = await expenseParent(`Food-SP-${Math.random()}`);
    const fun = await expenseParent(`Fun-SP-${Math.random()}`);
    const salary = await mockInvoke<Category>("create_category", { name: `Sal-SP-${Math.random()}`, kind: "income", emoji: "💰", color: null, parentId: null });
    const coffee = await mockInvoke<Category>("create_category", { name: "Coffee SP", kind: "expense", emoji: "☕", color: null, parentId: food.id });

    const moved = await mockInvoke<Category>("set_category_parent", { id: coffee.id, parentId: fun.id });
    expect(moved.parentId).toBe(fun.id);

    const promoted = await mockInvoke<Category>("set_category_parent", { id: coffee.id, parentId: null });
    expect(promoted.parentId).toBe(null);

    await expect(mockInvoke("set_category_parent", { id: coffee.id, parentId: salary.id }))
      .rejects.toMatchObject({ code: "ValidationError" });
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
