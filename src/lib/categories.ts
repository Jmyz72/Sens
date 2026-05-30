// Category hierarchy helpers. A subcategory is a Category whose `parentId`
// points at a top-level category (parentId === null). Two levels only.

import type { Category, CategoryKind } from "../types";

export interface CategoryNode {
  category: Category;
  children: Category[];
}

const bySort = (a: Category, b: Category) =>
  (a.isArchived ? 1 : 0) - (b.isArchived ? 1 : 0) ||
  a.sortOrder - b.sortOrder ||
  a.name.localeCompare(b.name);

/** Top-level categories of a kind, each with its sorted subcategories. */
export function categoryTree(cats: Category[], kind: CategoryKind): CategoryNode[] {
  const sorted = [...cats].sort(bySort);
  return sorted
    .filter((c) => c.kind === kind && c.parentId == null)
    .map((parent) => ({
      category: parent,
      // children share the parent's kind (enforced by the backend); filter on it
      // too so a mis-keyed row can never surface under the wrong-kind parent.
      children: sorted.filter((c) => c.kind === kind && c.parentId === parent.id),
    }));
}

export interface PickerItem {
  id: string;
  label: string;
  emoji: string;
  depth: 0 | 1;
}

/** Flattened, archive-filtered list for a <select>: each parent followed by
 *  its children. `depth` drives indentation. */
export function categoryPickerItems(cats: Category[], kind: CategoryKind): PickerItem[] {
  const out: PickerItem[] = [];
  for (const node of categoryTree(cats, kind)) {
    if (node.category.isArchived) continue;
    out.push({ id: node.category.id, label: node.category.name, emoji: node.category.emoji, depth: 0 });
    for (const child of node.children) {
      if (child.isArchived) continue;
      out.push({ id: child.id, label: child.name, emoji: child.emoji, depth: 1 });
    }
  }
  return out;
}
