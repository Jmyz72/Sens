// Allocation math and display helpers for reimbursements. Pure, no React.
// `apportion` mirrors src-tauri/src/apportion.rs.

import type { Category, Transaction, TxnAllocation } from "../types";
import { txnSortKey } from "./kinds";

/**
 * Split `total` across `weights` in proportion, in whole cents (largest-remainder
 * method; ties go to the earliest line). `total` is clamped into 0..sum(weights),
 * the result sums to it, and no share exceeds its weight.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sum <= 0) return weights.map(() => 0);
  const t = Math.min(Math.max(total, 0), sum);
  const shares: number[] = [];
  const rems: { i: number; rem: number }[] = [];
  weights.forEach((w, i) => {
    const num = t * w;
    const rem = num % sum;
    shares.push((num - rem) / sum); // exact integer division
    rems.push({ i, rem });
  });
  let leftover = t - shares.reduce((s, x) => s + x, 0);
  rems.sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of rems) {
    if (leftover <= 0) break;
    shares[i] += 1;
    leftover -= 1;
  }
  return shares;
}

/** What an expense really cost: its amount minus what has been reimbursed. */
export function effectiveCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">): number {
  return t.amountCents - t.reimbursedCents;
}

/** The expectation not yet received. Never negative. */
export function outstandingCents(t: Pick<Transaction, "expectedReimbursementCents" | "reimbursedCents">): number {
  return Math.max((t.expectedReimbursementCents ?? 0) - t.reimbursedCents, 0);
}

/**
 * What can still be allocated to an expense. When editing a reimbursement, pass
 * that reimbursement's own share so it counts as available again.
 */
export function remainingCents(t: Pick<Transaction, "amountCents" | "reimbursedCents">, ownAllocatedCents = 0): number {
  return t.amountCents - t.reimbursedCents + ownAllocatedCents;
}

/** Default allocation when an expense is picked: what is still expected, capped at what is left. */
export function defaultAllocationCents(t: Transaction, ownAllocatedCents = 0): number {
  const rem = remainingCents(t, ownAllocatedCents);
  if (t.expectedReimbursementCents == null) return rem;
  const out = Math.max(t.expectedReimbursementCents - (t.reimbursedCents - ownAllocatedCents), 0);
  return out > 0 ? Math.min(out, rem) : rem;
}

export interface ReimbursementBadge {
  state: "pending" | "reimbursed";
  cents: number;
}

/** Row badge for an expense: still awaited, repaid, or nothing to show. */
export function reimbursementBadge(t: Transaction): ReimbursementBadge | null {
  const out = outstandingCents(t);
  if (out > 0) return { state: "pending", cents: out };
  if (t.reimbursedCents > 0) return { state: "reimbursed", cents: t.reimbursedCents };
  return null;
}

/**
 * Expenses a reimbursement can be allocated to: plain expenses (not balance
 * corrections) with something left. Ones with an outstanding expectation come
 * first, then newest first.
 */
export function candidateExpenses(
  txns: Transaction[],
  categories: Category[],
  ownAllocations: TxnAllocation[],
): Transaction[] {
  const system = new Set(categories.filter((c) => c.isSystem).map((c) => c.id));
  const own = new Map(ownAllocations.map((a) => [a.expenseId, a.amountCents]));
  return txns
    .filter((t) => t.kind === "expense" && !(t.categoryId && system.has(t.categoryId)) && remainingCents(t, own.get(t.id) ?? 0) > 0)
    .sort((a, b) => {
      const ra = outstandingCents(a) > 0 ? 0 : 1;
      const rb = outstandingCents(b) > 0 ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ka = txnSortKey(a);
      const kb = txnSortKey(b);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
}
