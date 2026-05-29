// In-memory mock backend used when the app runs outside Tauri (browser dev).
// Mirrors the Rust service logic closely enough to exercise the full UI:
// seeds templates + default categories, computes balances and dashboards the
// same way, and throws AppError-shaped errors. Not used in the packaged app.

import type {
  Account,
  AccountBalance,
  AccountTemplate,
  Category,
  CategoryBreakdown,
  DashboardSummary,
  Transaction,
} from "../types";

const fail = (code: string, message: string) => {
  throw { code, message };
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ── seed templates ──
const TPL_GROUPS: [string, string, [string, string][]][] = [
  ["Banks", "savings", [["maybank", "Maybank"], ["cimb", "CIMB"], ["public-bank", "Public Bank"], ["rhb", "RHB"], ["hong-leong-bank", "Hong Leong Bank"], ["ambank", "AmBank"], ["bank-islam", "Bank Islam"], ["ocbc", "OCBC"], ["uob", "UOB"], ["hsbc", "HSBC"]]],
  ["Digital banks", "savings", [["gxbank", "GXBank"], ["boost-bank", "Boost Bank"], ["aeon-bank", "AEON Bank"], ["ryt-bank", "Ryt Bank"]]],
  ["E-wallets", "ewallet", [["tng-ewallet", "Touch 'n Go eWallet"], ["grabpay", "GrabPay"], ["boost", "Boost"], ["shopeepay", "ShopeePay"], ["mae", "MAE"], ["bigpay", "BigPay"]]],
  ["Buy now, pay later", "bnpl", [["atome", "Atome"], ["shopee-paylater", "Shopee PayLater"], ["grab-paylater", "Grab PayLater"]]],
  ["Investment", "investment", [["asnb", "ASNB"], ["stashaway", "StashAway"], ["versa", "Versa"], ["wahed", "Wahed"], ["moomoo", "Moomoo"]]],
  ["Global fintech", "ewallet", [["paypal", "PayPal"], ["wise", "Wise"], ["revolut", "Revolut"], ["payoneer", "Payoneer"]]],
];
const GROUP_TYPE: Record<string, string> = {
  Banks: "bank", "Digital banks": "digital_bank", "E-wallets": "ewallet",
  "Buy now, pay later": "bnpl", Investment: "investment", "Global fintech": "global_fintech",
};

const templates: AccountTemplate[] = [];
TPL_GROUPS.forEach(([group, sub, list]) =>
  list.forEach(([key, name]) =>
    templates.push({ key, name, groupName: group, defaultSubtype: sub, iconAsset: key, brandColor: null, sortOrder: templates.length, isActive: true }),
  ),
);

const CAT_SEED: [string, Category["kind"], string, string][] = [
  ["Salary", "income", "💰", "#46d39a"], ["Bonus", "income", "🎉", "#3fcf8e"], ["Freelance", "income", "💻", "#5aa66d"], ["Gift", "income", "🎁", "#56b3c4"], ["Other Income", "income", "➕", "#7bbf8f"],
  ["Food", "expense", "🍔", "#e0a13c"], ["Transport", "expense", "🚗", "#8b7bd8"], ["Bills", "expense", "🧾", "#56b3c4"], ["Shopping", "expense", "🛍️", "#d9728f"], ["Health", "expense", "🏥", "#f0708c"], ["Entertainment", "expense", "🎬", "#a78bfa"], ["Groceries", "expense", "🛒", "#5aa66d"], ["Education", "expense", "📚", "#5b8def"], ["Travel", "expense", "✈️", "#33c9d6"], ["Other Expense", "expense", "💸", "#9aa4b2"],
  ["Transfer", "transfer", "🔄", "#9aa4b2"],
];
const categories: Category[] = CAT_SEED.map(([name, kind, emoji, color], i) => ({
  id: uid(), name, kind, emoji, color, sortOrder: i, isSystem: true, isArchived: false, createdAt: now(), updatedAt: now(),
}));

const accounts: Account[] = [];
const txns: Transaction[] = [];
const settings = new Map<string, string>();

function balanceOf(a: Account): number {
  let b = a.openingBalanceCents;
  for (const t of txns) {
    if (t.kind === "income" && t.accountId === a.id) b += t.amountCents;
    else if (t.kind === "expense" && t.accountId === a.id) b -= t.amountCents;
    else if (t.kind === "adjustment" && t.accountId === a.id) b += t.amountCents;
    else if (t.kind === "transfer") {
      if (t.accountId === a.id) b -= t.amountCents;
      if (t.toAccountId === a.id) b += t.amountCents;
    }
  }
  return b;
}
const hydrate = (a: Account): Account => ({ ...a, balanceCents: balanceOf(a) });
const hasTxns = (id: string) => txns.some((t) => t.accountId === id || t.toAccountId === id);

function seedDemo() {
  if (accounts.length) return;
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    accounts.push({ id: uid(), templateKey: key, name, accountType: GROUP_TYPE[t.groupName], subtype: t.defaultSubtype, openingBalanceCents: opening, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
  };
  mk("maybank", "Maybank Savings", 842000);
  mk("tng-ewallet", "Touch 'n Go", 12750);
  mk("stashaway", "StashAway", 1860000);
  const cat = (n: string) => categories.find((c) => c.name === n)!.id;
  const add = (kind: Transaction["kind"], acc: number, amt: number, catName: string | null, desc: string, date: string, to?: number) =>
    txns.push({ id: uid(), kind, accountId: accounts[acc].id, toAccountId: to != null ? accounts[to].id : null, categoryId: catName ? cat(catName) : null, amountCents: amt, description: desc, transactionDate: date, createdAt: now(), updatedAt: now() });
  const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  add("income", 0, 650000, "Salary", "Salary — Acme Sdn Bhd", d(2));
  add("expense", 1, 4250, "Food", "Nasi Lemak", d(1));
  add("expense", 0, 18900, "Groceries", "Jaya Grocer", d(1));
  add("expense", 1, 1590, "Transport", "Grab ride", d(0));
  add("transfer", 0, 200000, null, "To StashAway", d(3), 2);
  add("expense", 0, 12000, "Bills", "TNB electricity", d(4));
}
seedDemo();

export async function mockInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const a = args as any;
  await new Promise((r) => setTimeout(r, 30)); // mimic IPC latency
  switch (command) {
    case "list_account_templates":
      return templates as T;
    case "create_account_from_template": {
      const t = templates.find((x) => x.key === a.templateKey) ?? fail("NotFound", "Template not found");
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const acc: Account = { id: uid(), templateKey: t.key, name: String(a.name).trim(), accountType: GROUP_TYPE[t.groupName], subtype: t.defaultSubtype, openingBalanceCents: a.openingBalanceCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      return hydrate(acc) as T;
    }
    case "create_custom_account": {
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const acc: Account = { id: uid(), templateKey: null, name: String(a.name).trim(), accountType: a.accountType, subtype: a.subtype, openingBalanceCents: a.openingBalanceCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      return hydrate(acc) as T;
    }
    case "list_accounts":
      return accounts.filter((x) => a.includeArchived || !x.isArchived).map(hydrate) as T;
    case "update_account": {
      const acc = accounts.find((x) => x.id === a.input.id) ?? fail("NotFound", "Account not found");
      if (a.input.name != null) acc.name = String(a.input.name).trim();
      if (a.input.subtype != null) acc.subtype = a.input.subtype;
      if (a.input.openingBalanceCents != null) acc.openingBalanceCents = a.input.openingBalanceCents;
      acc.updatedAt = now();
      return hydrate(acc) as T;
    }
    case "archive_account":
    case "restore_account": {
      const acc = accounts.find((x) => x.id === a.id) ?? fail("NotFound", "Account not found");
      acc.isArchived = command === "archive_account";
      return hydrate(acc) as T;
    }
    case "set_account_balance": {
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (!hasTxns(acc.id)) {
        acc.openingBalanceCents = a.realBalanceCents;
      } else {
        const diff = a.realBalanceCents - balanceOf(acc);
        if (diff !== 0) txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), createdAt: now(), updatedAt: now() });
      }
      return hydrate(acc) as T;
    }
    case "list_categories":
      return categories.filter((c) => (a.includeArchived || !c.isArchived) && (!a.kind || c.kind === a.kind)) as T;
    case "update_category": {
      const cat = categories.find((x) => x.id === a.input.id) ?? fail("NotFound", "Category not found");
      if (a.input.name != null) cat.name = String(a.input.name).trim();
      if (a.input.emoji != null) cat.emoji = a.input.emoji;
      if ("color" in a.input) cat.color = a.input.color ?? null;
      if (a.input.sortOrder != null) cat.sortOrder = a.input.sortOrder;
      cat.updatedAt = now();
      return cat as T;
    }
    case "create_category": {
      const cat: Category = { id: uid(), name: String(a.name).trim(), kind: a.kind, emoji: a.emoji, color: a.color ?? null, sortOrder: 100, isSystem: false, isArchived: false, createdAt: now(), updatedAt: now() };
      categories.push(cat);
      return cat as T;
    }
    case "archive_category":
    case "restore_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      if (command === "archive_category" && c.isSystem) fail("Conflict", "System categories cannot be archived");
      c.isArchived = command === "archive_category";
      return c as T;
    }
    case "create_income_transaction":
    case "create_expense_transaction": {
      const kind = command === "create_income_transaction" ? "income" : "expense";
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const tx: Transaction = { id: uid(), kind, accountId: a.accountId, toAccountId: null, categoryId: a.categoryId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now() };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_transfer_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot transfer to the same account");
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now() };
      txns.unshift(tx);
      return tx as T;
    }
    case "list_transactions": {
      const f = a.filters ?? {};
      let out = txns.slice();
      if (f.accountId) out = out.filter((t) => t.accountId === f.accountId || t.toAccountId === f.accountId);
      if (f.kind) out = out.filter((t) => t.kind === f.kind);
      if (f.fromDate) out = out.filter((t) => t.transactionDate >= f.fromDate);
      if (f.toDate) out = out.filter((t) => t.transactionDate < f.toDate);
      out.sort((x, y) => (y.transactionDate + y.createdAt < x.transactionDate + x.createdAt ? -1 : 1));
      return out.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200)) as T;
    }
    case "update_transaction": {
      const i = txns.findIndex((t) => t.id === a.input.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind === "adjustment" || a.input.kind === "adjustment") fail("ValidationError", "Adjustments cannot be edited");
      txns[i] = { ...txns[i], ...a.input, updatedAt: now() };
      return txns[i] as T;
    }
    case "delete_transaction": {
      const i = txns.findIndex((t) => t.id === a.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      txns.splice(i, 1);
      return undefined as T;
    }
    case "get_account_balances":
      return accounts.filter((x) => !x.isArchived).map((x) => ({ accountId: x.id, name: x.name, accountType: x.accountType, balanceCents: balanceOf(x) } as AccountBalance)) as T;
    case "get_dashboard_summary": {
      const [y, m] = String(a.month).split("-").map(Number);
      const from = `${y}-${String(m).padStart(2, "0")}-01`;
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const inRange = (t: Transaction) => t.transactionDate >= from && t.transactionDate < to;
      const income = txns.filter((t) => t.kind === "income" && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const expense = txns.filter((t) => t.kind === "expense" && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const byCat = new Map<string, number>();
      txns.filter((t) => t.kind === "expense" && inRange(t)).forEach((t) => byCat.set(t.categoryId!, (byCat.get(t.categoryId!) ?? 0) + t.amountCents));
      const breakdown: CategoryBreakdown[] = [...byCat.entries()].map(([cid, total]) => {
        const c = categories.find((x) => x.id === cid)!;
        return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
      }).sort((x, y) => y.totalCents - x.totalCents);
      const active = accounts.filter((x) => !x.isArchived);
      const summary: DashboardSummary = {
        month: a.month, totalBalanceCents: active.reduce((s, x) => s + balanceOf(x), 0),
        incomeCents: income, expenseCents: expense, netCashflowCents: income - expense,
        spendingBreakdown: breakdown,
        accountBalances: active.map((x) => ({ accountId: x.id, name: x.name, accountType: x.accountType, balanceCents: balanceOf(x) })),
        recentTransactions: txns.slice().sort((x, y) => (y.transactionDate < x.transactionDate ? -1 : 1)).slice(0, 8),
      };
      return summary as T;
    }
    case "get_setting":
      return (settings.get(String(a.key)) ?? null) as T;
    case "set_setting": {
      if (!String(a.key).trim()) fail("ValidationError", "Key cannot be empty");
      settings.set(String(a.key), String(a.value));
      return undefined as T;
    }
    default:
      return fail("DatabaseError", `Unknown command: ${command}`) as T;
  }
}
