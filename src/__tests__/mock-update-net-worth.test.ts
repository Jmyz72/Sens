import { describe, it, expect } from "vitest";
import { mockInvoke } from "../client/mock";
import type { Account, Category, Transaction } from "../types";

async function categoriesOf(kind: "income" | "expense", includeArchived = false): Promise<Category[]> {
  return mockInvoke<Category[]>("list_categories", { kind, includeArchived });
}

async function userCategory(kind: "income" | "expense"): Promise<Category> {
  const cat = (await categoriesOf(kind)).find((c) => !c.isSystem && c.parentId == null);
  if (!cat) throw new Error(`no ${kind} category`);
  return cat;
}

async function systemCategory(kind: "income" | "expense"): Promise<Category> {
  const cat = (await categoriesOf(kind, true)).find((c) => c.isSystem);
  if (!cat) throw new Error(`no system ${kind} category`);
  return cat;
}

async function rowsFor(accountId: string): Promise<Transaction[]> {
  return mockInvoke<Transaction[]>("list_transactions", { filters: { accountId } });
}

async function valueRows(accountId: string): Promise<Transaction[]> {
  return (await rowsFor(accountId)).filter((t) => t.description === "Value update");
}

async function reread(id: string): Promise<Account> {
  const all = await mockInvoke<Account[]>("list_accounts", { includeArchived: true });
  const acc = all.find((a) => a.id === id);
  if (!acc) throw new Error("account missing");
  return acc;
}

function createAccount(input: {
  name: string;
  subtype: string;
  openingBalanceCents: number;
  gainCategoryId?: string | null;
  lossCategoryId?: string | null;
}): Promise<Account> {
  return mockInvoke<Account>("create_account", {
    name: input.name,
    subtype: input.subtype,
    openingBalanceCents: input.openingBalanceCents,
    templateKey: null,
    creditLimitCents: null,
    gainCategoryId: input.gainCategoryId ?? null,
    lossCategoryId: input.lossCategoryId ?? null,
  });
}

describe("mock update net worth", () => {
  it("saves gain and loss categories on an investment", async () => {
    const gain = await userCategory("income");
    const loss = await userCategory("expense");
    const acc = await createAccount({
      name: "Stash",
      subtype: "investment",
      openingBalanceCents: 100000,
      gainCategoryId: gain.id,
      lossCategoryId: loss.id,
    });
    expect(acc.gainCategoryId).toBe(gain.id);
    expect(acc.lossCategoryId).toBe(loss.id);
  });

  it("rejects a gain category on savings", async () => {
    const gain = await userCategory("income");
    await expect(createAccount({
      name: "Cash",
      subtype: "savings",
      openingBalanceCents: 0,
      gainCategoryId: gain.id,
    })).rejects.toMatchObject({
      message: "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.",
    });
  });

  it("rejects a gain category that is not income", async () => {
    const expense = await userCategory("expense");
    await expect(createAccount({
      name: "FD",
      subtype: "fixed-deposit",
      openingBalanceCents: 0,
      gainCategoryId: expense.id,
    })).rejects.toMatchObject({ message: "Gain category must be an income category." });
  });

  it("rejects a loss category that is not expense", async () => {
    const income = await userCategory("income");
    await expect(createAccount({
      name: "UT",
      subtype: "unit-trust",
      openingBalanceCents: 0,
      lossCategoryId: income.id,
    })).rejects.toMatchObject({ message: "Loss category must be an expense category." });
  });

  it("rejects a system category when saving a value category", async () => {
    const system = await systemCategory("income");
    await expect(createAccount({
      name: "FD",
      subtype: "fixed-deposit",
      openingBalanceCents: 0,
      gainCategoryId: system.id,
    })).rejects.toMatchObject({ message: "That category can't be selected." });
  });

  it("rejects a missing category id when saving a value category", async () => {
    await expect(createAccount({
      name: "Crypto",
      subtype: "crypto",
      openingBalanceCents: 0,
      gainCategoryId: "missing-category",
    })).rejects.toMatchObject({ code: "NotFound", message: "Category not found" });
  });

  it("clears gain, keeps loss, and a rename leaves both", async () => {
    const loss = await userCategory("expense");
    const acc = await createAccount({ name: "Luno", subtype: "crypto", openingBalanceCents: 0 });
    const set = await mockInvoke<Account>("update_account", {
      input: { id: acc.id, valueCategories: { gainCategoryId: null, lossCategoryId: loss.id } },
    });
    expect(set.gainCategoryId).toBeNull();
    expect(set.lossCategoryId).toBe(loss.id);
    const kept = await mockInvoke<Account>("update_account", { input: { id: acc.id, name: "Luno 2" } });
    expect(kept.name).toBe("Luno 2");
    expect(kept.gainCategoryId).toBeNull();
    expect(kept.lossCategoryId).toBe(loss.id);
  });

  it("clears both ids when the subtype leaves the four", async () => {
    const gain = await userCategory("income");
    const loss = await userCategory("expense");
    const acc = await createAccount({
      name: "FD",
      subtype: "fixed-deposit",
      openingBalanceCents: 0,
      gainCategoryId: gain.id,
      lossCategoryId: loss.id,
    });
    expect(acc.gainCategoryId).toBe(gain.id);
    const cleared = await mockInvoke<Account>("update_account", { input: { id: acc.id, subtype: "savings" } });
    expect(cleared.subtype).toBe("savings");
    expect(cleared.gainCategoryId).toBeNull();
    expect(cleared.lossCategoryId).toBeNull();
  });

  it("writes a rise as income and keeps the saved gain category", async () => {
    const gain = await userCategory("income");
    const other = await mockInvoke<Category>("create_category", {
      name: `Other income ${crypto.randomUUID()}`,
      kind: "income",
      emoji: "💵",
      color: null,
      parentId: null,
    });
    const acc = await createAccount({
      name: "Stash",
      subtype: "investment",
      openingBalanceCents: 100000,
      gainCategoryId: gain.id,
    });
    const after = await mockInvoke<Account>("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: other.id,
      time: null,
    });
    expect(after.balanceCents).toBe(105000);
    expect(after.openingBalanceCents).toBe(100000);
    expect(after.gainCategoryId).toBe(gain.id);
    const opening = (await rowsFor(acc.id)).find((t) => t.kind === "opening");
    expect(opening?.amountCents).toBe(100000);
    const updates = await valueRows(acc.id);
    expect(updates).toHaveLength(1);
    expect(updates[0].kind).toBe("income");
    expect(updates[0].amountCents).toBe(5000);
    expect(updates[0].description).toBe("Value update");
    expect(updates[0].excludedFromReporting).toBe(false);
    expect(updates[0].categoryId).toBe(gain.id);
  });

  it("writes a drop as an expense against the saved loss category", async () => {
    const loss = await userCategory("expense");
    const acc = await createAccount({
      name: "FD",
      subtype: "fixed-deposit",
      openingBalanceCents: 100000,
      lossCategoryId: loss.id,
    });
    const after = await mockInvoke<Account>("update_net_worth", {
      accountId: acc.id,
      balanceCents: 99000,
      categoryId: null,
      time: null,
    });
    expect(after.balanceCents).toBe(99000);
    const updates = await valueRows(acc.id);
    expect(updates).toHaveLength(1);
    expect(updates[0].kind).toBe("expense");
    expect(updates[0].amountCents).toBe(1000);
    expect(updates[0].categoryId).toBe(loss.id);
    expect(updates[0].description).toBe("Value update");
    expect(updates[0].excludedFromReporting).toBe(false);
  });

  it("uses the passed category once when none is saved", async () => {
    const gain = await userCategory("income");
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    const after = await mockInvoke<Account>("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: gain.id,
      time: null,
    });
    expect(after.gainCategoryId).toBeNull();
    expect(after.lossCategoryId).toBeNull();
    const updates = await valueRows(acc.id);
    expect(updates).toHaveLength(1);
    expect(updates[0].categoryId).toBe(gain.id);
  });

  it("requires a category when none is saved", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: null,
      time: null,
    })).rejects.toMatchObject({ message: "Pick a category for this update." });
  });

  it("rejects a negative target", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: -1,
      categoryId: null,
      time: null,
    })).rejects.toMatchObject({ message: "Balance must be zero or more." });
  });

  it("rejects a savings account", async () => {
    const acc = await createAccount({ name: "Cash", subtype: "savings", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: null,
      time: null,
    })).rejects.toMatchObject({
      message: "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.",
    });
  });

  it("rejects an archived investment", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await mockInvoke("archive_account", { id: acc.id });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: null,
      time: null,
    })).rejects.toMatchObject({ message: "Cannot update an archived account" });
  });

  it("writes nothing when the balance is unchanged", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    const after = await mockInvoke<Account>("update_net_worth", {
      accountId: acc.id,
      balanceCents: 100000,
      categoryId: null,
      time: null,
    });
    expect(after.balanceCents).toBe(100000);
    expect(await valueRows(acc.id)).toHaveLength(0);
  });

  it("rejects the wrong category kind on a rise and on a drop", async () => {
    const expense = await userCategory("expense");
    const income = await userCategory("income");
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: expense.id,
      time: null,
    })).rejects.toMatchObject({ message: "Category kind 'expense' does not match transaction kind 'income'" });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 99000,
      categoryId: income.id,
      time: null,
    })).rejects.toMatchObject({ message: "Category kind 'income' does not match transaction kind 'expense'" });
  });

  it("rejects a system category on the value-update row", async () => {
    const system = await systemCategory("income");
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: system.id,
      time: null,
    })).rejects.toMatchObject({ message: "That category can't be selected." });
  });

  it("rejects a missing category on the value-update row", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    await expect(mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: "missing-category",
      time: null,
    })).rejects.toMatchObject({ code: "NotFound", message: "Category not found" });
  });

  it("requires a time only when the setting is on, and ignores a supplied time when it is off", async () => {
    const gain = await userCategory("income");
    const acc = await createAccount({
      name: "Stash",
      subtype: "investment",
      openingBalanceCents: 100000,
      gainCategoryId: gain.id,
    });
    await mockInvoke("set_setting", { key: "transaction_time_enabled", value: "1" });
    try {
      await expect(mockInvoke("update_net_worth", {
        accountId: acc.id,
        balanceCents: 105000,
        categoryId: null,
        time: null,
      })).rejects.toMatchObject({ message: "A time is required" });
      expect(await valueRows(acc.id)).toHaveLength(0);
      await mockInvoke("update_net_worth", {
        accountId: acc.id,
        balanceCents: 105000,
        categoryId: null,
        time: "09:30",
      });
      const timed = (await valueRows(acc.id)).find((t) => t.amountCents === 5000);
      expect(timed?.transactionTime).toBe("09:30");
      await mockInvoke("set_setting", { key: "transaction_time_enabled", value: "0" });
      await mockInvoke("update_net_worth", {
        accountId: acc.id,
        balanceCents: 106000,
        categoryId: null,
        time: "11:00",
      });
      const ignored = (await valueRows(acc.id)).find((t) => t.amountCents === 1000);
      expect(ignored?.transactionTime).toBeNull();
    } finally {
      await mockInvoke("set_setting", { key: "transaction_time_enabled", value: "0" });
    }
  });

  it("clears a saved category that is not used by a transaction", async () => {
    const gain = await mockInvoke<Category>("create_category", {
      name: `Growth ${crypto.randomUUID()}`,
      kind: "income",
      emoji: "📈",
      color: null,
      parentId: null,
    });
    const acc = await createAccount({
      name: "Stash",
      subtype: "investment",
      openingBalanceCents: 100000,
      gainCategoryId: gain.id,
    });
    expect(acc.gainCategoryId).toBe(gain.id);
    await mockInvoke("delete_category", { id: gain.id });
    expect((await reread(acc.id)).gainCategoryId).toBeNull();
  });

  it("keeps the column when the category is used by a value update", async () => {
    const gain = await mockInvoke<Category>("create_category", {
      name: `Growth ${crypto.randomUUID()}`,
      kind: "income",
      emoji: "📈",
      color: null,
      parentId: null,
    });
    const acc = await createAccount({
      name: "Stash",
      subtype: "investment",
      openingBalanceCents: 100000,
      gainCategoryId: gain.id,
    });
    await mockInvoke("update_net_worth", {
      accountId: acc.id,
      balanceCents: 105000,
      categoryId: null,
      time: null,
    });
    await expect(mockInvoke("delete_category", { id: gain.id })).rejects.toMatchObject({
      message: "In use by transactions — archive it instead",
    });
    expect((await reread(acc.id)).gainCategoryId).toBe(gain.id);
  });

  it("still rewrites an opening-only investment from set_account_balance", async () => {
    const acc = await createAccount({ name: "Stash", subtype: "investment", openingBalanceCents: 100000 });
    const after = await mockInvoke<Account>("set_account_balance", {
      accountId: acc.id,
      realBalanceCents: 400000,
      recordAsIncomeExpense: true,
    });
    expect(after.openingBalanceCents).toBe(400000);
    expect(after.balanceCents).toBe(400000);
    expect(await valueRows(acc.id)).toHaveLength(0);
    const opening = (await rowsFor(acc.id)).find((t) => t.kind === "opening");
    expect(opening?.amountCents).toBe(400000);
  });

  it("keeps the older Add Income system-category message without a period", async () => {
    const acc = await createAccount({ name: "Cash", subtype: "cash", openingBalanceCents: 0 });
    const system = await systemCategory("income");
    await expect(mockInvoke("create_income_transaction", {
      accountId: acc.id,
      categoryId: system.id,
      amountCents: 100,
      description: null,
      date: "2026-10-14",
      time: null,
    })).rejects.toMatchObject({ message: "That category can't be selected" });
  });
});
