import { describe, expect, it } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, AwaitingReimbursement, Category, DashboardSummary, Transaction } from "../types";

async function account(name: string, subtype: string, opening: number, limit: number | null = null) {
  return mockInvoke<Account>("create_account", {
    name, subtype, openingBalanceCents: opening, templateKey: null, creditLimitCents: limit,
  });
}

async function expenseCats() {
  const cats = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: false });
  return cats.filter((c) => !c.isSystem && c.parentId == null);
}

async function spend(accountId: string, cents: number, date: string, excluded = false) {
  const [cat] = await expenseCats();
  return mockInvoke<Transaction>("create_expense_transaction", {
    accountId, categoryId: cat.id, amountCents: cents, description: "Dinner", date, time: null,
    excludedFromReporting: excluded, splits: null,
  });
}

const alloc = (e: Transaction, cents: number) => ({ expenseId: e.id, amountCents: cents });

async function reimburse(accountId: string, cents: number, date: string, allocations: { expenseId: string; amountCents: number }[]) {
  return mockInvoke<Transaction>("create_reimbursement_transaction", {
    accountId, amountCents: cents, description: "Back", date, time: null, allocations,
  });
}

const balanceOf = async (id: string) =>
  (await mockInvoke<Account[]>("list_accounts", {})).find((a) => a.id === id)!.balanceCents;

const txnOf = async (id: string) =>
  (await mockInvoke<Transaction[]>("list_transactions", { filters: { limit: 1000 } })).find((t) => t.id === id)!;

const month = (m: string) => mockInvoke<DashboardSummary>("get_dashboard_summary", { month: m });

const expenseUpdate = (e: Transaction, amount: number, over: Record<string, unknown> = {}) => ({
  id: e.id, kind: "expense", accountId: e.accountId, toAccountId: null, categoryId: e.categoryId,
  amountCents: amount, description: e.description, transactionDate: e.transactionDate, transactionTime: null,
  excludedFromReporting: false, splits: null, ...over,
});

describe("mock reimbursements", () => {
  it("raises the balance, hydrates both sides, and reports true cost in the original month", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 20_000, "2027-03-10");
    expect(await balanceOf(savings.id)).toBe(480_000);
    const before = await month("2027-03");

    const r = await reimburse(savings.id, 15_000, "2027-04-03", [alloc(e, 15_000)]);

    expect(r.kind).toBe("reimbursement");
    expect(r.categoryId).toBeNull();
    expect(r.allocations).toEqual([alloc(e, 15_000)]);
    expect(await balanceOf(savings.id)).toBe(495_000);
    expect((await txnOf(e.id)).reimbursedCents).toBe(15_000);

    const march = await month("2027-03");
    expect(march.expenseCents).toBe(5_000);
    expect(march.incomeCents).toBe(before.incomeCents);
    expect(march.netCashflowCents).toBe(before.incomeCents - 5_000);
    expect(march.spendingBreakdown.reduce((s, b) => s + b.totalCents, 0)).toBe(5_000);
    const april = await month("2027-04");
    expect(april.expenseCents).toBe(0);
    expect(april.incomeCents).toBe(0);
  });

  it("lets a refund land on the card that was charged", async () => {
    const card = await account("Visa", "credit-card", -80_000, 1_000_000);
    const e = await spend(card.id, 8_000, "2027-03-01");
    expect(await balanceOf(card.id)).toBe(-88_000);
    await reimburse(card.id, 8_000, "2027-03-03", [alloc(e, 8_000)]);
    expect(await balanceOf(card.id)).toBe(-80_000);
  });

  it("covers many expenses with one reimbursement and takes one expense in parts", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e1 = await spend(savings.id, 10_000, "2027-03-01");
    const e2 = await spend(savings.id, 5_000, "2027-03-02");
    await reimburse(savings.id, 15_000, "2027-03-10", [alloc(e1, 10_000), alloc(e2, 5_000)]);
    expect((await txnOf(e1.id)).reimbursedCents).toBe(10_000);
    expect((await txnOf(e2.id)).reimbursedCents).toBe(5_000);

    const e3 = await spend(savings.id, 10_000, "2027-03-03");
    await reimburse(savings.id, 3_000, "2027-03-11", [alloc(e3, 3_000)]);
    await reimburse(savings.id, 2_000, "2027-03-12", [alloc(e3, 2_000)]);
    expect((await txnOf(e3.id)).reimbursedCents).toBe(5_000);
    await expect(reimburse(savings.id, 6_000, "2027-03-13", [alloc(e3, 6_000)]))
      .rejects.toMatchObject({ code: "ValidationError", message: "Allocation exceeds what's left on that expense." });
  });

  it("rejects each bad shape with the Rust messages", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e = await spend(savings.id, 10_000, "2027-03-01");
    const e2 = await spend(savings.id, 4_000, "2027-03-02");
    const [incCat] = (await mockInvoke<Category[]>("list_categories", { kind: "income", includeArchived: false })).filter((c) => !c.isSystem);
    const income = await mockInvoke<Transaction>("create_income_transaction", {
      accountId: savings.id, categoryId: incCat.id, amountCents: 1_000, description: null, date: "2027-03-01",
      time: null, excludedFromReporting: false, splits: null,
    });
    const msg = (amount: number, allocations: { expenseId: string; amountCents: number }[]) =>
      reimburse(savings.id, amount, "2027-03-02", allocations).catch((x) => x.message);

    expect(await msg(0, [alloc(e, 1)])).toBe("Amount must be greater than zero");
    expect(await msg(100, [])).toBe("Pick at least one expense to reimburse.");
    expect(await msg(100, [alloc(e, 0)])).toBe("Each allocation must be greater than zero.");
    expect(await msg(200, [alloc(e, 100), alloc(e, 100)])).toBe("An expense can only be listed once.");
    expect(await msg(100, [alloc(income, 100)])).toBe("Only expenses can be reimbursed.");
    expect(await msg(100, [{ expenseId: "nope", amountCents: 100 }])).toBe("Only expenses can be reimbursed.");
    expect(await msg(100, [alloc(e, 60), alloc(e2, 30)])).toBe("Allocations must add up to the reimbursement amount.");
    expect(await msg(20_000, [alloc(e, 20_000)])).toBe("Allocation exceeds what's left on that expense.");
  });

  it("rejects balance corrections and archived accounts", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const e = await spend(savings.id, 10_000, "2027-03-01");
    await mockInvoke("set_account_balance", { accountId: savings.id, realBalanceCents: 50_000, recordAsIncomeExpense: true });
    const cats = await mockInvoke<Category[]>("list_categories", { kind: "expense", includeArchived: true });
    const sysId = cats.find((c) => c.isSystem)!.id;
    const all = await mockInvoke<Transaction[]>("list_transactions", { filters: { limit: 1000 } });
    const correction = all.find((t) => t.kind === "expense" && t.categoryId === sysId && t.accountId === savings.id)!;
    await expect(reimburse(savings.id, 100, "2027-03-02", [alloc(correction, 100)]))
      .rejects.toMatchObject({ message: "Only expenses can be reimbursed." });

    await mockInvoke("archive_account", { id: savings.id });
    await expect(reimburse(savings.id, 100, "2027-03-02", [alloc(e, 100)]))
      .rejects.toMatchObject({ code: "Conflict", message: "The selected account is archived" });
  });

  it("splits the offset across a split expense by largest remainder", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const [a, b] = await expenseCats();
    const e = await mockInvoke<Transaction>("create_expense_transaction", {
      accountId: savings.id, categoryId: null, amountCents: 10_000, description: null, date: "2027-05-10", time: null,
      excludedFromReporting: false,
      splits: [{ categoryId: a.id, amountCents: 6_000 }, { categoryId: b.id, amountCents: 4_000 }],
    });
    await reimburse(savings.id, 5_000, "2027-05-20", [alloc(e, 5_000)]);
    const s = await month("2027-05");
    expect(s.expenseCents).toBe(5_000);
    expect(s.spendingBreakdown.find((x) => x.categoryId === a.id)?.totalCents).toBe(3_000);
    expect(s.spendingBreakdown.find((x) => x.categoryId === b.id)?.totalCents).toBe(2_000);
  });

  it("never goes negative for fully repaid or excluded expenses", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const full = await spend(savings.id, 10_000, "2027-06-02");
    await reimburse(savings.id, 10_000, "2027-06-03", [alloc(full, 10_000)]);
    const excluded = await spend(savings.id, 7_000, "2027-06-04", true);
    await reimburse(savings.id, 7_000, "2027-06-05", [alloc(excluded, 7_000)]);
    const s = await month("2027-06");
    expect(s.expenseCents).toBe(0);
    expect(s.spendingBreakdown).toEqual([]);
  });

  it("tracks expectations and what is awaited", async () => {
    const savings = await account("Maybank", "savings", 100_000);
    const base = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    const e = await spend(savings.id, 10_000, "2027-07-01");
    const range = "Expected reimbursement must be more than zero and no more than the expense amount.";
    await expect(mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_001 })).rejects.toMatchObject({ message: range });
    await expect(mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 0 })).rejects.toMatchObject({ message: range });

    const set = await mockInvoke<Transaction>("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_000 });
    expect(set.expectedReimbursementCents).toBe(10_000);
    let s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([1, 10_000]);

    await reimburse(savings.id, 4_000, "2027-07-05", [alloc(e, 4_000)]);
    s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([1, 6_000]);

    await reimburse(savings.id, 6_000, "2027-07-06", [alloc(e, 6_000)]);
    s = await mockInvoke<AwaitingReimbursement>("get_awaiting_reimbursement", {});
    expect([s.count - base.count, s.totalCents - base.totalCents]).toEqual([0, 0]);

    const cleared = await mockInvoke<Transaction>("set_expected_reimbursement", { expenseId: e.id, expectedCents: null });
    expect(cleared.expectedReimbursementCents).toBeNull();
  });

  it("rewrites a reimbursement and refuses to edit one through update_transaction", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const cash = await account("Wallet", "cash", 0);
    const e1 = await spend(savings.id, 20_000, "2027-08-01");
    const e2 = await spend(savings.id, 5_000, "2027-08-02");
    const r = await reimburse(savings.id, 10_000, "2027-08-05", [alloc(e1, 10_000)]);

    const u = await mockInvoke<Transaction>("update_reimbursement_transaction", {
      id: r.id, accountId: cash.id, amountCents: 6_000, description: "Fixed", date: "2027-08-09", time: null,
      allocations: [alloc(e1, 1_000), alloc(e2, 5_000)],
    });
    expect(u.amountCents).toBe(6_000);
    expect(u.accountId).toBe(cash.id);
    expect(u.allocations).toEqual([alloc(e1, 1_000), alloc(e2, 5_000)]);
    expect((await txnOf(e1.id)).reimbursedCents).toBe(1_000);
    expect(await balanceOf(cash.id)).toBe(6_000);
    expect(await balanceOf(savings.id)).toBe(475_000);

    await expect(mockInvoke("update_reimbursement_transaction", {
      id: r.id, accountId: cash.id, amountCents: 21_000, description: null, date: "2027-08-09", time: null,
      allocations: [alloc(e1, 21_000)],
    })).rejects.toMatchObject({ message: "Allocation exceeds what's left on that expense." });
    expect((await txnOf(r.id)).allocations).toEqual([alloc(e1, 1_000), alloc(e2, 5_000)]);

    await expect(mockInvoke("update_reimbursement_transaction", {
      id: e1.id, accountId: savings.id, amountCents: 100, description: null, date: "2027-08-09", time: null,
      allocations: [alloc(e1, 100)],
    })).rejects.toMatchObject({ message: "Only reimbursements can be edited here." });

    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e1, 4_000, { id: r.id, kind: "reimbursement" }) }))
      .rejects.toMatchObject({ message: "Edit a reimbursement from its own form." });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e1, 4_000, { id: r.id }) }))
      .rejects.toMatchObject({ message: "Edit a reimbursement from its own form." });
  });

  it("locks a reimbursed expense and frees it when the reimbursement is deleted", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 10_000, "2027-09-01");
    const r = await reimburse(savings.id, 6_000, "2027-09-05", [alloc(e, 6_000)]);
    const locked = "This expense has been reimbursed. Edit or delete the reimbursement first.";

    await expect(mockInvoke("delete_transaction", { id: e.id })).rejects.toMatchObject({ code: "Conflict", message: locked });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e, 5_000) }))
      .rejects.toMatchObject({ message: "Amount can't go below what's already been reimbursed." });
    await mockInvoke("update_transaction", { input: expenseUpdate(e, 6_000) });
    await expect(mockInvoke("update_transaction", { input: expenseUpdate(e, 6_000, { kind: "income", categoryId: null }) }))
      .rejects.toMatchObject({ code: "Conflict", message: locked });

    await mockInvoke("delete_transaction", { id: r.id });
    expect((await txnOf(e.id)).reimbursedCents).toBe(0);
    expect(await balanceOf(savings.id)).toBe(494_000);
    await mockInvoke("delete_transaction", { id: e.id });
  });

  it("clamps the expectation when an expense shrinks and clears it when the kind changes", async () => {
    const savings = await account("Maybank", "savings", 500_000);
    const e = await spend(savings.id, 10_000, "2027-10-01");
    await mockInvoke("set_expected_reimbursement", { expenseId: e.id, expectedCents: 10_000 });

    const shrunk = await mockInvoke<Transaction>("update_transaction", { input: expenseUpdate(e, 8_000) });
    expect(shrunk.expectedReimbursementCents).toBe(8_000);

    const [incCat] = (await mockInvoke<Category[]>("list_categories", { kind: "income", includeArchived: false })).filter((c) => !c.isSystem);
    const flipped = await mockInvoke<Transaction>("update_transaction", {
      input: expenseUpdate(e, 8_000, { kind: "income", categoryId: incCat.id }),
    });
    expect(flipped.kind).toBe("income");
    expect(flipped.expectedReimbursementCents).toBeNull();
  });
});
