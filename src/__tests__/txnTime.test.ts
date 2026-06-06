import { describe, it, expect } from "vitest";
import { txnSortKey } from "../lib/kinds";
import type { Transaction } from "../types";

function tx(p: Partial<Transaction>): Transaction {
  return {
    id: "x", kind: "expense", accountId: "a", toAccountId: null, categoryId: "c",
    amountCents: 100, description: null, transactionDate: "2026-05-10",
    transactionTime: null, createdAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z", excludedFromReporting: false, splits: [], ...p,
  };
}

describe("txnSortKey time tiebreaker", () => {
  it("orders same-day rows by time ascending, nulls first (independent of createdAt)", () => {
    // createdAt order is deliberately the REVERSE of time order, so this only
    // passes if txnSortKey uses time as the tiebreaker, not createdAt.
    const a = tx({ id: "a", transactionTime: null, createdAt: "2026-05-10T09:00:00Z" });
    const b = tx({ id: "b", transactionTime: "08:00", createdAt: "2026-05-10T08:00:00Z" });
    const c = tx({ id: "c", transactionTime: "20:00", createdAt: "2026-05-10T07:00:00Z" });
    const sorted = [c, b, a].sort((x, y) => (txnSortKey(x) < txnSortKey(y) ? -1 : 1));
    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
  it("falls back to createdAt when times are equal/absent", () => {
    const a = tx({ id: "a", transactionTime: null, createdAt: "2026-05-10T01:00:00Z" });
    const b = tx({ id: "b", transactionTime: null, createdAt: "2026-05-10T02:00:00Z" });
    const sorted = [b, a].sort((x, y) => (txnSortKey(x) < txnSortKey(y) ? -1 : 1));
    expect(sorted.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
