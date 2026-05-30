// Account taxonomy display helpers. The backend supplies each account's derived
// `type` and `group`; this module owns the *presentation* of that classification
// (section labels, ordering) and the sign adapter for owe (liability) balances —
// the one place that knows "a liability shows as a positive amount you owe".

import type { Account, AccountGroup, AccountTypeName } from "../types";

export const TYPE_LABEL: Record<AccountTypeName, string> = {
  fund: "Cash & funds",
  financial: "Investments",
  receivable: "Receivables",
  payable: "Payables",
  credit: "Credit & loans",
};

export const TYPE_ORDER: AccountTypeName[] = ["fund", "financial", "receivable", "payable", "credit"];

export type BalanceTone = "text" | "negative" | "income";

export interface BalanceView {
  /** Value to render via <Money cents={magnitude}>. Always already sign-adjusted. */
  magnitude: number;
  tone: BalanceTone;
  /** Prefix label for owe accounts ("You owe" / "In credit"), else null. */
  label: string | null;
}

/**
 * Map an account's (group, signed balance) to how it should be displayed.
 *   own:                 signed as-is (negative = overdraft, red)
 *   owe & balance <= 0:  abs, red,   "You owe"
 *   owe & balance  > 0:  positive,   "In credit" (overpaid)
 */
export function balanceDisplay(group: AccountGroup, balanceCents: number): BalanceView {
  if (group === "owe") {
    if (balanceCents <= 0) return { magnitude: Math.abs(balanceCents), tone: "negative", label: "You owe" };
    return { magnitude: balanceCents, tone: "income", label: "In credit" };
  }
  return { magnitude: balanceCents, tone: balanceCents < 0 ? "negative" : "text", label: null };
}

/** Resolve a BalanceTone to a theme color. */
export function toneColor(tone: BalanceTone, t: { text: string; negative: string; income: string }): string {
  return tone === "negative" ? t.negative : tone === "income" ? t.income : t.text;
}

export interface SidebarPortfolioSummary {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
}

export function sidebarPortfolioSummary(accounts: Pick<Account, "group" | "balanceCents" | "isArchived">[]): SidebarPortfolioSummary {
  return accounts.reduce<SidebarPortfolioSummary>((summary, account) => {
    if (account.isArchived) return summary;
    if (account.group === "own") summary.assetsCents += account.balanceCents;
    else summary.liabilitiesCents += account.balanceCents;
    summary.netWorthCents = summary.assetsCents + summary.liabilitiesCents;
    return summary;
  }, { assetsCents: 0, liabilitiesCents: 0, netWorthCents: 0 });
}
