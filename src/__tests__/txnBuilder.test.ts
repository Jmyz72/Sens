import { describe, it, expect } from "vitest";
import { addItem, removeItem, itemsTotal, finalize, isSplit, isPendingValid, type BuilderItem } from "../lib/txnBuilder";

const A: BuilderItem = { categoryId: "a", amountCents: 10000 };
const B: BuilderItem = { categoryId: "b", amountCents: 5000 };

describe("txnBuilder", () => {
  it("adds and totals items", () => {
    let items: BuilderItem[] = [];
    items = addItem(items, A);
    items = addItem(items, B);
    expect(items).toHaveLength(2);
    expect(itemsTotal(items)).toBe(15000);
  });
  it("removes by index", () => {
    expect(removeItem([A, B], 0)).toEqual([B]);
  });
  it("isSplit only when >= 2", () => {
    expect(isSplit([A])).toBe(false);
    expect(isSplit([A, B])).toBe(true);
  });
  it("isPendingValid requires category and positive amount", () => {
    expect(isPendingValid({ categoryId: "a", amountCents: 100 })).toBe(true);
    expect(isPendingValid({ categoryId: "", amountCents: 100 })).toBe(false);
    expect(isPendingValid({ categoryId: "a", amountCents: 0 })).toBe(false);
  });
  it("finalize auto-adds a valid pending item", () => {
    const out = finalize([A], { categoryId: "b", amountCents: 5000 });
    expect(out).toHaveLength(2);
  });
  it("finalize ignores an empty/invalid pending item", () => {
    expect(finalize([A], { categoryId: "", amountCents: 0 })).toEqual([A]);
    expect(finalize([A], { categoryId: "b", amountCents: 0 })).toEqual([A]);
  });
  it("addItem/removeItem are pure (do not mutate input)", () => {
    const base = [A];
    addItem(base, B);
    removeItem(base, 0);
    expect(base).toEqual([A]);
  });
});
