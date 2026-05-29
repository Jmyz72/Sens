// Transaction-kind presentation metadata. Implements the spec's UI Color
// System: color is never the only cue — every amount also carries a sign and a
// per-kind icon. `colorKey` resolves to a theme token (dark/light variants).

import type { Theme } from "../theme/tokens";
import type { TransactionKind } from "../types";
import type { IconName } from "../components/Icon";

export interface KindMeta {
  label: string;
  icon: IconName;
  colorKey: keyof Pick<Theme, "income" | "expense" | "transfer" | "adjustment">;
  /** Balance direction for a given account perspective: +1 raises, -1 lowers. */
  sign: 1 | -1 | 0;
}

export const KIND_META: Record<TransactionKind, KindMeta> = {
  income: { label: "Income", icon: "in", colorKey: "income", sign: 1 },
  expense: { label: "Expense", icon: "out", colorKey: "expense", sign: -1 },
  transfer: { label: "Transfer", icon: "swap", colorKey: "transfer", sign: 0 },
  adjustment: { label: "Balance adjustment", icon: "sliders", colorKey: "adjustment", sign: 0 },
};

export function kindColor(theme: Theme, kind: TransactionKind): string {
  return theme[KIND_META[kind].colorKey];
}

/** Signed display amount for a transaction from an account's perspective. */
export function signedFor(kind: TransactionKind, amountCents: number, isDestination = false): number {
  if (kind === "income") return amountCents;
  if (kind === "expense") return -amountCents;
  if (kind === "adjustment") return amountCents; // already signed
  // transfer
  return isDestination ? amountCents : -amountCents;
}
