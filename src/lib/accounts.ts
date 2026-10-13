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

/** Label for an account that holds money someone owes you (the `lent` subtype). */
export function lentLabel(subtype: string, balanceCents: number): string | null {
  return subtype === "lent" && balanceCents > 0 ? "Owes you" : null;
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

/** Subtypes that store a required credit limit. */
export function subtypeHasCreditLimit(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}

export interface CreditReadout {
  availableCents: number;
  usedPercent: number;
  overLimit: boolean;
}

/**
 * Available credit and utilization for a card or BNPL account.
 * Call only when `creditLimitCents` is a positive integer.
 * In credit (balance >= 0) reports the full limit and 0% used.
 * Past the limit, available credit stays 0 and `overLimit` is true.
 */
export function creditReadout(balanceCents: number, creditLimitCents: number): CreditReadout {
  const owed = balanceCents < 0 ? -balanceCents : 0;
  const availableCents = balanceCents < 0 ? Math.max(0, creditLimitCents - owed) : creditLimitCents;
  const usedPercent = Math.round((owed * 100) / creditLimitCents);
  return { availableCents, usedPercent, overLimit: usedPercent > 100 };
}
