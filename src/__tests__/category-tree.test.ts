import { describe, it, expect } from "vitest";
import { categoryTree, categoryPickerItems, reorderIds, moveTargets } from "../lib/categories";
import type { Category } from "../types";

function cat(p: Partial<Category> & { id: string; name: string }): Category {
  return {
    id: p.id, name: p.name, kind: p.kind ?? "expense", emoji: p.emoji ?? "•",
    color: p.color ?? null, parentId: p.parentId ?? null, sortOrder: p.sortOrder ?? 0,
    isArchived: p.isArchived ?? false,
    createdAt: "t", updatedAt: "t",
  };
}

const data: Category[] = [
  cat({ id: "food", name: "Food", sortOrder: 1 }),
  cat({ id: "coffee", name: "Coffee", parentId: "food", sortOrder: 0 }),
  cat({ id: "dining", name: "Dining", parentId: "food", sortOrder: 1 }),
  cat({ id: "bills", name: "Bills", sortOrder: 2 }),
  cat({ id: "salary", name: "Salary", kind: "income", sortOrder: 0 }),
  cat({ id: "old", name: "Old", parentId: "food", isArchived: true }),
];

describe("categoryTree", () => {
  it("groups top-level expense categories with their children", () => {
    const tree = categoryTree(data, "expense");
    expect(tree.map((n) => n.category.id)).toEqual(["food", "bills"]);
    expect(tree[0].children.map((c) => c.id)).toEqual(["coffee", "dining", "old"]);
  });

  it("does not mix kinds", () => {
    expect(categoryTree(data, "income").map((n) => n.category.id)).toEqual(["salary"]);
  });
});

describe("categoryPickerItems", () => {
  it("returns parents then their non-archived children with depth", () => {
    const items = categoryPickerItems(data, "expense");
    expect(items).toEqual([
      { id: "food", label: "Food", emoji: "•", depth: 0 },
      { id: "coffee", label: "Coffee", emoji: "•", depth: 1 },
      { id: "dining", label: "Dining", emoji: "•", depth: 1 },
      { id: "bills", label: "Bills", emoji: "•", depth: 0 },
    ]);
  });
});

function mkCat(partial: Partial<Category> & { id: string }): Category {
  return { id: partial.id, name: partial.name ?? partial.id, kind: partial.kind ?? "expense", emoji: "x", color: null, parentId: partial.parentId ?? null, sortOrder: partial.sortOrder ?? 0, isArchived: partial.isArchived ?? false, createdAt: "", updatedAt: "" };
}

describe("reorderIds", () => {
  it("moves an item from one index to another", () => {
    expect(reorderIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderIds(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns the same order when from === to", () => {
    expect(reorderIds(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("moveTargets", () => {
  const food = mkCat({ id: "food", name: "Food", kind: "expense" });
  const fun = mkCat({ id: "fun", name: "Fun", kind: "expense" });
  const salary = mkCat({ id: "salary", name: "Salary", kind: "income" });
  const coffee = mkCat({ id: "coffee", name: "Coffee", kind: "expense", parentId: "food" });
  const all = [food, fun, salary, coffee];

  it("for a subcategory: same-kind top-level parents excluding the current one", () => {
    const targets = moveTargets(all, coffee).map((c) => c.id);
    expect(targets).toContain("fun");
    expect(targets).not.toContain("food"); // current parent
    expect(targets).not.toContain("salary"); // different kind
  });
  it("for a childless top-level: same-kind top-level parents excluding itself", () => {
    const targets = moveTargets(all, fun).map((c) => c.id);
    expect(targets).toContain("food");
    expect(targets).not.toContain("fun");
    expect(targets).not.toContain("salary");
  });
  it("for a top-level WITH children: returns empty (must empty it first)", () => {
    expect(moveTargets(all, food)).toEqual([]);
  });
  it("excludes archived parents as destinations", () => {
    const archivedFun = mkCat({ id: "fun", name: "Fun", kind: "expense", isArchived: true });
    const targets = moveTargets([food, archivedFun, salary, coffee], coffee).map((c) => c.id);
    expect(targets).not.toContain("fun"); // archived parent must not be offered
  });
});
