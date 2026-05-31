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

/** Return `ids` with the item at `from` moved to index `to`. */
export function reorderIds(ids: string[], from: number, to: number): string[] {
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Valid top-level parents a category may be moved under: same kind, top-level,
 *  not itself, not its current parent. A top-level that still has children
 *  cannot be moved (would create a third level), so it returns []. */
export function moveTargets(cats: Category[], category: Category): Category[] {
  const hasChildren = cats.some((c) => c.parentId === category.id);
  if (category.parentId == null && hasChildren) return [];
  return cats.filter(
    (c) =>
      c.parentId == null &&
      c.kind === category.kind &&
      c.id !== category.id &&
      c.id !== category.parentId,
  );
}
