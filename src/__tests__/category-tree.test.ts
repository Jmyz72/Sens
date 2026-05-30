import { describe, it, expect } from "vitest";
import { categoryTree, categoryPickerItems } from "../lib/categories";
import type { Category } from "../types";

function cat(p: Partial<Category> & { id: string; name: string }): Category {
  return {
    id: p.id, name: p.name, kind: p.kind ?? "expense", emoji: p.emoji ?? "•",
    color: p.color ?? null, parentId: p.parentId ?? null, sortOrder: p.sortOrder ?? 0,
    isSystem: p.isSystem ?? false, isArchived: p.isArchived ?? false,
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
