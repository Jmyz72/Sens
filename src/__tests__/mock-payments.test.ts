import { beforeEach, describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, DashboardSummary, Transaction } from "../types";

async function pair() {
  const savings = await mockInvoke<Account>("create_account", {
    name: "Maybank", subtype: "savings", openingBalanceCents: 500_000, templateKey: null, creditLimitCents: null,
  });
  const card = await mockInvoke<Account>("create_account", {
    name: "Visa", subtype: "credit-card", openingBalanceCents: -80_000, templateKey: null, creditLimitCents: 1_000_000,
  });
  return { savings, card };
}

describe("mock payments", () => {
  beforeEach(async () => {
    await mockInvoke("set_setting", { key: "transaction_time_enabled", value: "0" });
  });

  it("moves both balances and stays out of the dashboard", async () => {
    const { savings, card } = await pair();
    const before = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-06" });
    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 30_000,
      description: "Card payment", date: "2026-06-01", time: null,
    });
    expect(pay.kind).toBe("payment");
    const accounts = await mockInvoke<Account[]>("list_accounts", {});
    expect(accounts.find((a) => a.id === savings.id)?.balanceCents).toBe(470_000);
    expect(accounts.find((a) => a.id === card.id)?.balanceCents).toBe(-50_000);
    const after = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month: "2026-06" });
    expect(after.incomeCents).toBe(before.incomeCents);
    expect(after.expenseCents).toBe(before.expenseCents);
  });

  it("rejects a bad source, a transfer onto a card, and a split edit", async () => {
    const { savings, card } = await pair();
    const invest = await mockInvoke<Account>("create_account", {
      name: "Stash", subtype: "investment", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    await expect(mockInvoke("create_payment_transaction", {
      fromAccountId: invest.id, toAccountId: card.id, amountCents: 100, description: null, date: "2026-06-01", time: null,
    })).rejects.toMatchObject({ message: "Payments can only come from cash, an e-wallet, savings, or a current account." });
    await expect(mockInvoke("create_transfer_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 100, description: null, date: "2026-06-01", time: null,
    })).rejects.toMatchObject({ message: "Pay a credit card or BNPL as a payment." });

    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 5_000, description: null, date: "2026-06-01", time: null,
    });
    await expect(mockInvoke("update_transaction", {
      input: {
        id: pay.id, kind: "payment", accountId: savings.id, toAccountId: card.id, categoryId: null,
        amountCents: 5_000, description: null, transactionDate: "2026-06-01", transactionTime: null,
        excludedFromReporting: false, splits: [{ categoryId: "x", amountCents: 5_000 }],
      },
    })).rejects.toMatchObject({ message: "Payments can't be split." });
  });

  it("flips kind when the destination changes and restores balances on delete", async () => {
    const { savings, card } = await pair();
    const wallet = await mockInvoke<Account>("create_account", {
      name: "TNG", subtype: "ewallet", openingBalanceCents: 0, templateKey: null, creditLimitCents: null,
    });
    const pay = await mockInvoke<Transaction>("create_payment_transaction", {
      fromAccountId: savings.id, toAccountId: card.id, amountCents: 5_000, description: null, date: "2026-06-01", time: null,
    });
    const flipped = await mockInvoke<Transaction>("update_transaction", {
      input: {
        id: pay.id, kind: "transfer", accountId: savings.id, toAccountId: wallet.id, categoryId: null,
        amountCents: 5_000, description: null, transactionDate: "2026-06-04", transactionTime: null,
        excludedFromReporting: false, splits: null,
      },
    });
    expect(flipped.kind).toBe("transfer");
    await mockInvoke("delete_transaction", { id: pay.id });
    const accounts = await mockInvoke<Account[]>("list_accounts", {});
    expect(accounts.find((a) => a.id === savings.id)?.balanceCents).toBe(500_000);
    expect(accounts.find((a) => a.id === card.id)?.balanceCents).toBe(-80_000);
  });
});
