/**
 * Tests for the mock backend (mockInvoke). These exercise the command wrapper
 * input/output mapping and backend-contract behavior.
 *
 * The mock pre-seeds demo data at module load and keeps module-level mutable
 * state. Tests are written defensively:
 * - Each test creates its own fresh accounts so results are isolated.
 * - Balance/count assertions use deltas or work on the test's own accounts.
 * - Tests do NOT assume a specific total account count from list_accounts.
 */
import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import { client } from "../client";
import type { Account, AccountBalance, DashboardSummary, Transaction } from "../types";

// Helper to create a fresh custom account with zero opening balance
async function freshAccount(name = "Test Account", opening = 0): Promise<Account> {
  return mockInvoke<Account>("create_account", {
    name,
    subtype: "savings",
    openingBalanceCents: opening,
    templateKey: null,
  });
}

// Helper to find a category id for a given kind (income or expense)
async function firstCategoryId(kind: "income" | "expense"): Promise<string> {
  const cats = await mockInvoke<{ id: string; kind: string }[]>("list_categories", {
    kind,
    includeArchived: false,
  });
  if (cats.length === 0) throw new Error(`No ${kind} categories found`);
  return cats[0].id;
}

// ── create_account + list_accounts ───────────────────────────────────────────

describe("create_account + list_accounts", () => {
  it("a freshly created account appears in list_accounts", async () => {
    const uniqueName = `ListTest-${Date.now()}-${Math.random()}`;
    const created = await freshAccount(uniqueName, 50000);
    expect(created.name).toBe(uniqueName);

    const all = await mockInvoke<Account[]>("list_accounts", { includeArchived: false });
    const found = all.find((a) => a.id === created.id);
    expect(found).toBeDefined();
  });

  it("a fresh account has balanceCents equal to openingBalanceCents", async () => {
    const acc = await freshAccount(`BalanceCheck-${Date.now()}`, 75000);
    expect(acc.balanceCents).toBe(75000);
    expect(acc.openingBalanceCents).toBe(75000);
  });

  it("creating an account with empty name throws ValidationError", async () => {
    await expect(
      mockInvoke("create_account", {
        name: "   ",
        subtype: "savings",
        openingBalanceCents: 0,
        templateKey: null,
      }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });
});

// ── income raises balance ─────────────────────────────────────────────────────

describe("income transaction raises account balance", () => {
  it("creates income and balance increases by amount", async () => {
    const acc = await freshAccount(`IncomeTest-${Date.now()}`, 10000);
    const catId = await firstCategoryId("income");

    await mockInvoke<Transaction>("create_income_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 5000,
      description: "Test income",
      date: "2026-05-01",
    });

    const balances = await mockInvoke<AccountBalance[]>("get_account_balances", {});
    const updated = balances.find((b) => b.accountId === acc.id);
    expect(updated).toBeDefined();
    // 10000 opening + 5000 income = 15000
    expect(updated!.balanceCents).toBe(15000);
  });
});

// ── expense lowers balance ────────────────────────────────────────────────────

describe("expense transaction lowers account balance", () => {
  it("creates expense and balance decreases by amount", async () => {
    const acc = await freshAccount(`ExpenseTest-${Date.now()}`, 20000);
    const catId = await firstCategoryId("expense");

    await mockInvoke<Transaction>("create_expense_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 3000,
      description: "Test expense",
      date: "2026-05-01",
    });

    const balances = await mockInvoke<AccountBalance[]>("get_account_balances", {});
    const updated = balances.find((b) => b.accountId === acc.id);
    expect(updated).toBeDefined();
    // 20000 opening - 3000 expense = 17000
    expect(updated!.balanceCents).toBe(17000);
  });
});

// ── transfer: source down, destination up ────────────────────────────────────

describe("transfer transaction", () => {
  it("decreases source and increases destination by transfer amount", async () => {
    const src = await freshAccount(`TransferSrc-${Date.now()}`, 30000);
    const dst = await freshAccount(`TransferDst-${Date.now()}`, 10000);

    await mockInvoke<Transaction>("create_transfer_transaction", {
      fromAccountId: src.id,
      toAccountId: dst.id,
      amountCents: 8000,
      description: "Test transfer",
      date: "2026-05-01",
    });

    const balances = await mockInvoke<AccountBalance[]>("get_account_balances", {});
    const srcBal = balances.find((b) => b.accountId === src.id);
    const dstBal = balances.find((b) => b.accountId === dst.id);

    expect(srcBal).toBeDefined();
    expect(dstBal).toBeDefined();
    // 30000 - 8000 = 22000
    expect(srcBal!.balanceCents).toBe(22000);
    // 10000 + 8000 = 18000
    expect(dstBal!.balanceCents).toBe(18000);
  });
});

// ── error cases ───────────────────────────────────────────────────────────────

describe("same-account transfer throws ValidationError", () => {
  it("throws when fromAccountId === toAccountId", async () => {
    const acc = await freshAccount(`SameAccTransfer-${Date.now()}`, 10000);

    await expect(
      mockInvoke("create_transfer_transaction", {
        fromAccountId: acc.id,
        toAccountId: acc.id,
        amountCents: 1000,
        description: null,
        date: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });
});

describe("expense on archived account throws Conflict", () => {
  it("throws when the account is archived", async () => {
    const acc = await freshAccount(`ArchivedTest-${Date.now()}`, 10000);
    await mockInvoke("archive_account", { id: acc.id });

    const catId = await firstCategoryId("expense");

    await expect(
      mockInvoke("create_expense_transaction", {
        accountId: acc.id,
        categoryId: catId,
        amountCents: 500,
        description: null,
        date: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "Conflict" });
  });
});

describe("amount <= 0 throws ValidationError", () => {
  it("throws for zero amount on income", async () => {
    const acc = await freshAccount(`ZeroAmt-${Date.now()}`, 10000);
    const catId = await firstCategoryId("income");

    await expect(
      mockInvoke("create_income_transaction", {
        accountId: acc.id,
        categoryId: catId,
        amountCents: 0,
        description: null,
        date: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("throws for negative amount on expense", async () => {
    const acc = await freshAccount(`NegAmt-${Date.now()}`, 10000);
    const catId = await firstCategoryId("expense");

    await expect(
      mockInvoke("create_expense_transaction", {
        accountId: acc.id,
        categoryId: catId,
        amountCents: -100,
        description: null,
        date: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("throws for zero amount on transfer", async () => {
    const src = await freshAccount(`ZeroTxSrc-${Date.now()}`, 10000);
    const dst = await freshAccount(`ZeroTxDst-${Date.now()}`, 10000);

    await expect(
      mockInvoke("create_transfer_transaction", {
        fromAccountId: src.id,
        toAccountId: dst.id,
        amountCents: 0,
        description: null,
        date: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });
});

// ── set_account_balance ───────────────────────────────────────────────────────

describe("set_account_balance", () => {
  it("on a fresh (no-txn) account, updates openingBalanceCents", async () => {
    const acc = await freshAccount(`SetBalNoTxn-${Date.now()}`, 5000);
    // No transactions yet → sets opening balance directly
    await mockInvoke("set_account_balance", {
      accountId: acc.id,
      realBalanceCents: 20000,
    });

    const balances = await mockInvoke<AccountBalance[]>("get_account_balances", {});
    const updated = balances.find((b) => b.accountId === acc.id);
    expect(updated).toBeDefined();
    expect(updated!.balanceCents).toBe(20000);
  });

  it("on an account with transactions, inserts an adjustment so balance equals the requested value", async () => {
    const acc = await freshAccount(`SetBalWithTxn-${Date.now()}`, 10000);
    const catId = await firstCategoryId("income");

    // Add an income transaction so hasTxns(acc.id) = true
    await mockInvoke("create_income_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 2000,
      description: "Pre-balance income",
      date: "2026-05-01",
    });
    // Current balance: 10000 + 2000 = 12000

    // Now set balance to 15000
    await mockInvoke("set_account_balance", {
      accountId: acc.id,
      realBalanceCents: 15000,
    });

    const balances = await mockInvoke<AccountBalance[]>("get_account_balances", {});
    const updated = balances.find((b) => b.accountId === acc.id);
    expect(updated).toBeDefined();
    expect(updated!.balanceCents).toBe(15000);
  });
});

// ── get_dashboard_summary: adjustments excluded from income/expense ───────────

describe("get_dashboard_summary: adjustments excluded from income/expense", () => {
  it("an adjustment does NOT change incomeCents/expenseCents but DOES change netWorthCents", async () => {
    const month = "2026-06";
    const acc = await freshAccount(`DashAdjTest-${Date.now()}`, 10000);

    // Baseline dashboard for this month (before any transactions on our account)
    const before = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });

    // Insert an income so hasTxns becomes true, then use set_account_balance to create an adjustment
    const catId = await firstCategoryId("income");
    await mockInvoke("create_income_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 1000,
      description: "Small income",
      date: "2026-06-10",
    });
    // Balance is now 10000 + 1000 = 11000
    // set_account_balance to 13000 → inserts an adjustment of +2000
    await mockInvoke("set_account_balance", {
      accountId: acc.id,
      realBalanceCents: 13000,
    });

    const after = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });

    // The income of 1000 should be in incomeCents
    expect(after.incomeCents).toBe(before.incomeCents + 1000);
    // The adjustment should NOT change expenseCents
    expect(after.expenseCents).toBe(before.expenseCents);
    // The adjustment DOES affect the net worth (it changed the account's balance by +2000)
    // netWorthCents reflects all accounts' current balances
    expect(after.netWorthCents).toBeGreaterThan(before.netWorthCents);
  });
});

// ── excludedFromReporting: flagged txns move balance but skip the dashboard ───

describe("get_dashboard_summary: excludedFromReporting txns excluded from income/expense", () => {
  it("a flagged expense moves balance but is excluded from the dashboard", async () => {
    const month = "2026-05";
    const acc = await freshAccount(`Flagged-${Date.now()}`, 10000);
    const catId = await firstCategoryId("expense");

    const before = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });

    // Normal expense — counts toward the dashboard.
    await mockInvoke("create_expense_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 700,
      description: "Counted",
      date: "2026-05-10",
    });
    // Flagged expense — money movement only, excluded from reporting.
    await mockInvoke("create_expense_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 300,
      description: "Excluded",
      date: "2026-05-11",
      excludedFromReporting: true,
    });

    // Both expenses move the balance: 10000 - 700 - 300 = 9000.
    const refreshed = (await mockInvoke<Account[]>("list_accounts", { includeArchived: false })).find(
      (x) => x.id === acc.id,
    )!;
    expect(refreshed.balanceCents).toBe(9000);

    // Only the unflagged 700 reaches the dashboard expense total.
    const after = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });
    expect(after.expenseCents).toBe(before.expenseCents + 700);
  });

  it("toggling excludedFromReporting via update_transaction re-classifies the row", async () => {
    const month = "2026-05";
    const acc = await freshAccount(`Toggle-${Date.now()}`, 10000);
    const catId = await firstCategoryId("expense");

    const before = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });

    // A normal (counted) expense.
    const tx = await mockInvoke<Transaction>("create_expense_transaction", {
      accountId: acc.id,
      categoryId: catId,
      amountCents: 800,
      description: "Maybe a reimbursement",
      date: "2026-05-12",
    });
    const counted = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });
    expect(counted.expenseCents).toBe(before.expenseCents + 800);

    // Flip it to money movement — it should drop out of the dashboard total
    // while leaving the balance untouched (still −800 from opening).
    await mockInvoke<Transaction>("update_transaction", {
      input: {
        id: tx.id,
        kind: "expense",
        accountId: acc.id,
        toAccountId: null,
        categoryId: catId,
        amountCents: 800,
        description: "Reimbursement",
        transactionDate: "2026-05-12",
        excludedFromReporting: true,
      },
    });

    const excluded = await mockInvoke<DashboardSummary>("get_dashboard_summary", { month });
    expect(excluded.expenseCents).toBe(before.expenseCents); // no longer counted
    const refreshed = (await mockInvoke<Account[]>("list_accounts", { includeArchived: false })).find(
      (x) => x.id === acc.id,
    )!;
    expect(refreshed.balanceCents).toBe(9200); // 10000 − 800, balance unaffected by the flag
  });
});

// ── get_setting / set_setting round-trip ─────────────────────────────────────

describe("get_setting / set_setting round-trip", () => {
  it("stores and retrieves a setting by key", async () => {
    const key = `test.key.${Date.now()}`;
    const value = "hello-world";

    // Before setting: should return null
    const before = await mockInvoke<string | null>("get_setting", { key });
    expect(before).toBeNull();

    // Set the value
    await mockInvoke("set_setting", { key, value });

    // After setting: should return the stored value
    const after = await mockInvoke<string | null>("get_setting", { key });
    expect(after).toBe(value);
  });

  it("overwrites a setting with a new value", async () => {
    const key = `test.overwrite.${Date.now()}`;

    await mockInvoke("set_setting", { key, value: "first" });
    await mockInvoke("set_setting", { key, value: "second" });

    const result = await mockInvoke<string | null>("get_setting", { key });
    expect(result).toBe("second");
  });

  it("empty key throws ValidationError", async () => {
    await expect(
      mockInvoke("set_setting", { key: "  ", value: "v" }),
    ).rejects.toMatchObject({ code: "ValidationError" });
  });
});

// ── balance correction as income/expense ──────────────────────────────────────

describe("balance correction as income/expense (mock)", () => {
  it("books income with the system category when diff > 0", async () => {
    const acc = await client.createAccount("Cash", "cash", 1_000_00, null);
    const expCat = (await client.listCategories("expense")).find((c) => !c.isSystem)!;
    await client.createExpense(acc.id, expCat.id, 100_00, null, "2026-06-01");
    await client.setAccountBalance(acc.id, 950_00, true);
    const txns = await client.listTransactions({ accountId: acc.id });
    const corr = txns.find((t) => t.kind === "income")!;
    const sys = (await client.listCategories("income", true)).find((c) => c.isSystem)!;
    expect(corr).toBeTruthy();
    expect(corr.amountCents).toBe(50_00);
    expect(corr.categoryId).toBe(sys.id);
    expect(await client.getAccountBalance(acc.id)).toBe(950_00);
  });

  it("books expense when diff < 0", async () => {
    const acc = await client.createAccount("Cash2", "cash", 1_000_00, null);
    const expCat = (await client.listCategories("expense")).find((c) => !c.isSystem)!;
    await client.createExpense(acc.id, expCat.id, 100_00, null, "2026-06-01");
    await client.setAccountBalance(acc.id, 850_00, true);
    const txns = await client.listTransactions({ accountId: acc.id });
    const sysExp = (await client.listCategories("expense", true)).find((c) => c.isSystem)!;
    const corr = txns.find((t) => t.kind === "expense" && t.description === "Balance adjustment")!;
    expect(corr).toBeTruthy();
    expect(corr.categoryId).toBe(sysExp.id);
    expect(corr.amountCents).toBe(50_00);
    expect(await client.getAccountBalance(acc.id)).toBe(850_00);
  });

  it("excludes system categories from the transaction picker tree", async () => {
    const { categoryTree } = await import("../lib/categories");
    const all = await client.listCategories(undefined, true);
    const tree = categoryTree(all, "expense");
    expect(tree.some((n) => n.category.isSystem)).toBe(false);
  });

  it("blocks deleting and editing a system category", async () => {
    const sys = (await client.listCategories("expense", true)).find((c) => c.isSystem)!;
    await expect(client.deleteCategory(sys.id)).rejects.toMatchObject({ code: "Conflict" });
    await expect(client.updateCategory({ id: sys.id, name: "Nope" })).rejects.toMatchObject({ code: "Conflict" });
  });
});
