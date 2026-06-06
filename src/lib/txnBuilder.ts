// Pure logic for the itemized Add-Transaction builder. One item = an ordinary
// single-category transaction; two or more = a split. Tested in isolation.

export interface BuilderItem {
  categoryId: string;
  amountCents: number;
}

export function addItem(items: BuilderItem[], item: BuilderItem): BuilderItem[] {
  return [...items, item];
}

export function removeItem(items: BuilderItem[], index: number): BuilderItem[] {
  return items.filter((_, i) => i !== index);
}

export function itemsTotal(items: BuilderItem[]): number {
  return items.reduce((s, it) => s + it.amountCents, 0);
}

export function isSplit(items: BuilderItem[]): boolean {
  return items.length >= 2;
}

/** True when a pending builder line is complete enough to add. */
export function isPendingValid(pending: BuilderItem): boolean {
  return !!pending.categoryId && pending.amountCents > 0;
}

/** Items to persist on Save: auto-append a valid pending line (forgiving). */
export function finalize(items: BuilderItem[], pending: BuilderItem): BuilderItem[] {
  return isPendingValid(pending) ? addItem(items, pending) : items;
}
