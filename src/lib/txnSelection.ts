// src/lib/txnSelection.ts
// Pure logic for the multi-select panel and bulk preview sheet.
import type { Transaction } from "../types";

export type BulkAction = "recategorize" | "move" | "exclude" | "include" | "delete";

export interface BulkTarget {
  accountId?: string;
  accountName?: string;
  incomeCategory?: { id: string; name: string };
  expenseCategory?: { id: string; name: string };
}

export interface SelectionSummary {
  count: number;
  inCents: number;
  outCents: number; // positive magnitude
  netCents: number; // in - out
  otherCounts: { transfer: number; adjustment: number; opening: number };
  excludedCount: number; // income/expense already excluded
}

export function summarizeSelection(txns: Transaction[]): SelectionSummary {
  let inCents = 0, outCents = 0, excludedCount = 0;
  const otherCounts = { transfer: 0, adjustment: 0, opening: 0 };
  for (const t of txns) {
    if (t.kind === "income") inCents += t.amountCents;
    else if (t.kind === "expense") outCents += t.amountCents;
    else otherCounts[t.kind] += 1;
    if ((t.kind === "income" || t.kind === "expense") && t.excludedFromReporting) excludedCount += 1;
  }
  return { count: txns.length, inCents, outCents, netCents: inCents - outCents, otherCounts, excludedCount };
}

export interface LockedRow { tx: Transaction; reason: string }
export interface BulkPlan { action: BulkAction; changeable: Transaction[]; lockedSkipped: LockedRow[] }

const isCashflow = (t: Transaction) => t.kind === "income" || t.kind === "expense";

/** Reason a row can't take part in an editing action (recategorize/move). */
function editLockReason(t: Transaction, action: BulkAction): string {
  if (t.kind === "transfer") {
    return action === "recategorize" ? "Transfers have no category" : "Transfers move between two accounts";
  }
  if (t.kind === "adjustment") return "Adjustments can't be edited";
  return "Opening balances can't be edited"; // opening
}

export function planBulk(action: BulkAction, txns: Transaction[], target?: BulkTarget): BulkPlan {
  const changeable: Transaction[] = [];
  const lockedSkipped: LockedRow[] = [];

  for (const t of txns) {
    switch (action) {
      case "recategorize": {
        if (t.kind === "income" || t.kind === "expense") {
          if (!target) { changeable.push(t); break; }            // no target chosen yet → potential (panel count)
          const has = t.kind === "income" ? !!target.incomeCategory : !!target.expenseCategory;
          if (has) changeable.push(t);
          else lockedSkipped.push({ tx: t, reason: t.kind === "income" ? "No income category chosen" : "No expense category chosen" });
        } else {
          lockedSkipped.push({ tx: t, reason: editLockReason(t, "recategorize") });
        }
        break;
      }
      case "move":
        if (isCashflow(t)) changeable.push(t);
        else lockedSkipped.push({ tx: t, reason: editLockReason(t, action) });
        break;
      case "delete":
        if (t.kind === "opening") lockedSkipped.push({ tx: t, reason: "Opening balances can't be deleted" });
        else changeable.push(t);
        break;
      case "exclude":
        if (isCashflow(t)) { if (!t.excludedFromReporting) changeable.push(t); /* already-excluded omitted */ }
        else lockedSkipped.push({ tx: t, reason: "Only income & expense affect reporting" });
        break;
      case "include":
        if (isCashflow(t)) { if (t.excludedFromReporting) changeable.push(t); /* already-included omitted */ }
        else lockedSkipped.push({ tx: t, reason: "Only income & expense affect reporting" });
        break;
    }
  }
  return { action, changeable, lockedSkipped };
}
