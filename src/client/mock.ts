// In-memory mock backend used when the app runs outside Tauri (browser dev).
// Mirrors the Rust service logic closely enough to exercise the full UI:
// seeds templates + default categories, computes balances and dashboards the
// same way, and throws AppError-shaped errors. Not used in the packaged app.

import type {
  Account,
  AccountBalance,
  AccountGroup,
  AccountSubtype,
  AccountTemplate,
  AccountTypeName,
  Category,
  CategoryBreakdown,
  DashboardSummary,
  Transaction,
} from "../types";
import catalog from "../generated/seed-catalog.json";
import { postingsFor } from "../lib/kinds";

const fail = (code: string, message: string): never => {
  throw { code, message };
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ── taxonomy ──
const SUBTYPES: AccountSubtype[] = catalog.subtypes.map((s) => ({
  key: s.key,
  label: s.label,
  type: s.type as AccountTypeName,
  group: s.group as AccountGroup,
  sortOrder: s.sortOrder,
  isActive: true,
}));
const subtypeOf = (key: string) => SUBTYPES.find((s) => s.key === key);

// ── seed templates (from src/generated/seed-catalog.json → Rust seed) ──
const templates: AccountTemplate[] = catalog.templates.map((t) => ({
  key: t.key,
  name: t.name,
  groupName: t.groupName,
  defaultSubtype: t.defaultSubtype,
  iconAsset: t.key,
  brandColor: null,
  sortOrder: t.sortOrder,
  isActive: true,
}));

const categories: Category[] = [];

// Built from src/generated/seed-catalog.json (generated from the Rust seed).
// Top-level rows are created first so each child resolves its parent by
// (parentName, kind); sort orders come straight from the catalog.
function seedCategories() {
  categories.length = 0;
  const topLevelId = new Map<string, string>(); // `${kind}\x00${name}` -> id
  for (const c of catalog.categories) {
    if (c.parentName != null) continue;
    const id = uid();
    categories.push({
      id,
      name: c.name,
      kind: c.kind as Category["kind"],
      emoji: c.emoji,
      color: c.color,
      parentId: null,
      sortOrder: c.sortOrder,
      isArchived: false,
      isSystem: c.isSystem,
      createdAt: now(),
      updatedAt: now(),
    });
    topLevelId.set(`${c.kind}\x00${c.name}`, id);
  }
  for (const c of catalog.categories) {
    if (c.parentName == null) continue;
    const parentId = topLevelId.get(`${c.kind}\x00${c.parentName}`);
    if (!parentId) continue;
    categories.push({
      id: uid(),
      name: c.name,
      kind: c.kind as Category["kind"],
      emoji: c.emoji,
      color: c.color,
      parentId,
      sortOrder: c.sortOrder,
      isArchived: false,
      isSystem: c.isSystem,
      createdAt: now(),
      updatedAt: now(),
    });
  }
}
seedCategories();

// Mirrors Rust service::validate_splits: at least two positive lines, each in a
// non-system category matching the transaction kind, summing to the total.
function validateSplits(kind: string, splits: { categoryId: string; amountCents: number }[], total: number) {
  if (splits.length < 2) fail("ValidationError", "A split needs at least two categories");
  let sum = 0;
  for (const s of splits) {
    if (s.amountCents <= 0) fail("ValidationError", "Each split amount must be positive");
    const c = categories.find((x) => x.id === s.categoryId);
    if (c?.isSystem) fail("ValidationError", "That category can't be selected");
    else if (!c || c.kind !== kind) fail("ValidationError", "Category doesn't match this transaction");
    sum += s.amountCents;
  }
  if (sum !== total) fail("ValidationError", "Split amounts must add up to the total");
}

const accounts: Account[] = [];
const txns: Transaction[] = [];
const settings = new Map<string, string>();

function timeEnabled(): boolean {
  return settings.get("transaction_time_enabled") === "1";
}
function isHHMM(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59;
}
function resolveTime(supplied: unknown, fallback: string | null): string | null {
  if (!timeEnabled()) return fallback;
  const t = typeof supplied === "string" ? supplied.trim() : "";
  if (!t) fail("ValidationError", "A time is required");
  if (!isHHMM(t)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
  return t;
}

function balanceOf(a: Account): number {
  let b = 0;
  for (const t of txns) {
    for (const leg of postingsFor(t.kind, t.amountCents, t.accountId, t.toAccountId)) {
      if (leg.accountId === a.id) b += leg.amountCents;
    }
  }
  return b;
}
const openingOf = (id: string): number => txns.find((t) => t.kind === "opening" && t.accountId === id)?.amountCents ?? 0;
const hydrate = (a: Account): Account => {
  const s = subtypeOf(a.subtype);
  return { ...a, accountType: s?.type ?? "fund", group: s?.group ?? "own", openingBalanceCents: openingOf(a.id), balanceCents: balanceOf(a) };
};
const hasActivity = (id: string) => txns.some((t) => t.kind !== "opening" && (t.accountId === id || t.toAccountId === id));

function seedDemo() {
  if (accounts.length) return;
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    const s = subtypeOf(t.defaultSubtype)!;
    const id = uid();
    accounts.push({ id, templateKey: key, name, accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: opening, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
    txns.push({ id: uid(), kind: "opening", accountId: id, toAccountId: null, categoryId: null, amountCents: opening, description: "Opening balance", transactionDate: "2026-01-01", transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
  };
  mk("maybank", "Maybank Savings", 842000);
  mk("tng-ewallet", "Touch 'n Go", 12750);
  mk("stashaway", "StashAway", 1860000);
  const cat = (n: string) => categories.find((c) => c.name === n)!.id;
  const add = (kind: Transaction["kind"], acc: number, amt: number, catName: string | null, desc: string, date: string, to?: number) =>
    txns.push({ id: uid(), kind, accountId: accounts[acc].id, toAccountId: to != null ? accounts[to].id : null, categoryId: catName ? cat(catName) : null, amountCents: amt, description: desc, transactionDate: date, transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
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
    case "list_account_subtypes":
      return SUBTYPES as T;
    case "create_account": {
      if (!String(a.name).trim()) fail("ValidationError", "Account name cannot be empty");
      const s = subtypeOf(a.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.subtype}`);
      if (a.templateKey != null && !templates.find((x) => x.key === a.templateKey)) fail("NotFound", "Account template not found");
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
      return hydrate(acc) as T;
    }
    case "list_accounts":
      return accounts.filter((x) => a.includeArchived || !x.isArchived).map(hydrate) as T;
    case "update_account": {
      const acc = accounts.find((x) => x.id === a.input.id) ?? fail("NotFound", "Account not found");
      if (a.input.name != null) acc.name = String(a.input.name).trim();
      if (a.input.subtype != null) {
        const s = subtypeOf(a.input.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.input.subtype}`);
        acc.subtype = s.key;
        acc.accountType = s.type;
        acc.group = s.group;
      }
      if (a.input.openingBalanceCents != null) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.input.openingBalanceCents;
      }
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
      if (acc.isArchived) fail("Conflict", "Cannot reconcile an archived account");
      if (!hasActivity(acc.id)) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.realBalanceCents;
      } else {
        const diff = a.realBalanceCents - balanceOf(acc);
        if (diff !== 0) {
          if (a.recordAsIncomeExpense) {
            const kind = diff > 0 ? "income" : "expense";
            const cat = categories.find((c) => c.isSystem && c.kind === kind && c.parentId == null);
            txns.unshift({ id: uid(), kind, accountId: acc.id, toAccountId: null, categoryId: cat ? cat.id : null, amountCents: Math.abs(diff), description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
          } else {
            txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] });
          }
        }
      }
      return hydrate(acc) as T;
    }
    case "list_categories":
      return categories.filter((c) => (a.includeArchived || !c.isArchived) && (!a.kind || c.kind === a.kind)) as T;
    case "update_category": {
      const cat = categories.find((x) => x.id === a.input.id) ?? fail("NotFound", "Category not found");
      if (cat.isSystem) fail("Conflict", "This is a system category and can't be changed");
      if (a.input.name != null) cat.name = String(a.input.name).trim();
      if (a.input.emoji != null) cat.emoji = a.input.emoji;
      if ("color" in a.input) cat.color = a.input.color ?? null;
      if (a.input.sortOrder != null) cat.sortOrder = a.input.sortOrder;
      cat.updatedAt = now();
      return cat as T;
    }
    case "create_category": {
      const name = String(a.name).trim();
      let kind = a.kind;
      if (a.parentId != null) {
        const parent = categories.find((x) => x.id === a.parentId) ?? fail("NotFound", "Category not found");
        if (parent.parentId != null) fail("ValidationError", "Subcategories can only be nested one level deep");
        kind = parent.kind;
      }
      // Case-sensitive to match the SQLite unique indexes (binary collation).
      const clash = categories.find((x) =>
        x.name === name &&
        (a.parentId != null ? x.parentId === a.parentId : x.parentId == null && x.kind === kind),
      );
      if (clash) fail("Conflict", "A category with this name already exists at this level");
      const cat: Category = { id: uid(), name, kind, emoji: a.emoji, color: a.color ?? null, parentId: a.parentId ?? null, sortOrder: 100, isArchived: false, isSystem: false, createdAt: now(), updatedAt: now() };
      categories.push(cat);
      return cat as T;
    }
    case "archive_category":
    case "restore_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      if (c.isSystem) fail("Conflict", "This is a system category and can't be changed");
      const archiving = command === "archive_category";
      c.isArchived = archiving;
      c.updatedAt = now();
      if (c.parentId == null) {
        categories.forEach((x) => { if (x.parentId === c.id) { x.isArchived = archiving; x.updatedAt = now(); } });
      }
      return c as T;
    }
    case "delete_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      if (c.isSystem) fail("Conflict", "This is a system category and can't be changed");
      if (categories.some((x) => x.parentId === c.id)) fail("Conflict", "Remove or move its subcategories first");
      if (txns.some((t) => t.categoryId === c.id || t.splits.some((s) => s.categoryId === c.id))) fail("Conflict", "In use by transactions — archive it instead");
      categories.splice(categories.indexOf(c), 1);
      return undefined as T;
    }
    case "reorder_categories": {
      (a.ids as string[]).forEach((id, i) => {
        const c = categories.find((x) => x.id === id);
        if (c && c.isSystem) fail("Conflict", "This is a system category and can't be changed");
        if (c) { c.sortOrder = i; c.updatedAt = now(); }
      });
      return undefined as T;
    }
    case "set_categories_archived": {
      const archiving = a.archived === true;
      (a.ids as string[]).forEach((id) => {
        const c = categories.find((x) => x.id === id);
        if (!c) return;
        if (c.isSystem) fail("Conflict", "This is a system category and can't be changed");
        c.isArchived = archiving;
        c.updatedAt = now();
        if (c.parentId == null) {
          categories.forEach((x) => { if (x.parentId === c.id) { x.isArchived = archiving; x.updatedAt = now(); } });
        }
      });
      return undefined as T;
    }
    case "set_category_parent": {
      const cat = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
      if (cat.isSystem) fail("Conflict", "This is a system category and can't be changed");
      const pid: string | null = a.parentId ?? null;
      if (pid != null) {
        if (pid === cat.id) fail("ValidationError", "A category cannot be its own parent");
        const parent = categories.find((x) => x.id === pid) ?? fail("NotFound", "Category not found");
        if (parent.isSystem) fail("ValidationError", "That category can't be a parent");
        if (parent.parentId != null) fail("ValidationError", "The new parent must be a top-level category");
        if (parent.kind !== cat.kind) fail("ValidationError", "Cannot move a category to a different kind");
        if (cat.parentId == null && categories.some((x) => x.parentId === cat.id)) {
          fail("ValidationError", "Empty this category's subcategories before making it a subcategory");
        }
        // Sibling-name uniqueness under the new parent.
        if (categories.some((x) => x.id !== cat.id && x.parentId === pid && x.name === cat.name)) {
          fail("Conflict", "A category with this name already exists at this level");
        }
      } else if (categories.some((x) => x.id !== cat.id && x.parentId == null && x.kind === cat.kind && x.name === cat.name)) {
        fail("Conflict", "A category with this name already exists at this level");
      }
      cat.parentId = pid;
      cat.updatedAt = now();
      return cat as T;
    }
    case "create_income_transaction":
    case "create_expense_transaction": {
      const kind = command === "create_income_transaction" ? "income" : "expense";
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const hasSplits = Array.isArray(a.splits) && a.splits.length > 0;
      if (hasSplits) {
        validateSplits(kind, a.splits, a.amountCents);
      } else if (a.categoryId) {
        const c = categories.find((x) => x.id === a.categoryId);
        if (c && c.kind !== kind) fail("ValidationError", `Category kind '${c.kind}' does not match transaction kind '${kind}'`);
        if (c && c.isSystem) fail("ValidationError", "That category can't be selected");
      } else {
        fail("ValidationError", "A category is required");
      }
      const transactionTime = resolveTime(a.time, null);
      const tx: Transaction = {
        id: uid(), kind, accountId: a.accountId, toAccountId: null,
        categoryId: hasSplits ? a.splits[0].categoryId : a.categoryId,
        amountCents: a.amountCents, description: a.description,
        transactionDate: a.date, transactionTime,
        createdAt: now(), updatedAt: now(),
        excludedFromReporting: !!a.excludedFromReporting,
        splits: hasSplits ? a.splits.map((s: any) => ({ categoryId: s.categoryId, amountCents: s.amountCents })) : [],
      };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_transfer_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot transfer to the same account");
      const transactionTime = resolveTime(a.time, null);
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [] };
      txns.unshift(tx);
      return tx as T;
    }
    case "list_transactions": {
      const f = a.filters ?? {};
      let out = txns.slice();
      if (f.accountId) out = out.filter((t) => t.accountId === f.accountId || t.toAccountId === f.accountId);
      if (f.categoryId) out = out.filter((t) => t.categoryId === f.categoryId || t.splits.some((s) => s.categoryId === f.categoryId));
      if (f.kind) out = out.filter((t) => t.kind === f.kind);
      if (f.fromDate) out = out.filter((t) => t.transactionDate >= f.fromDate);
      if (f.toDate) out = out.filter((t) => t.transactionDate < f.toDate);
      const key = (t: Transaction) => t.transactionDate + "\x00" + (t.transactionTime ?? "") + "\x00" + t.createdAt;
      out.sort((x, y) => (key(y) < key(x) ? -1 : 1));
      return out.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200)) as T;
    }
    case "update_transaction": {
      const i = txns.findIndex((t) => t.id === a.input.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind === "opening" || a.input.kind === "opening") fail("ValidationError", "The opening balance can't be edited here; change it from the account's opening balance field");
      if (txns[i].kind === "adjustment" || a.input.kind === "adjustment") fail("ValidationError", "Adjustments cannot be edited; delete it and reconcile again");
      const exCat = categories.find((x) => x.id === txns[i].categoryId);
      if (exCat?.isSystem) fail("ValidationError", "Balance corrections can't be edited; delete it and reconcile again");
      if ((a.input.kind === "income" || a.input.kind === "expense") && a.input.categoryId) {
        const c = categories.find((x) => x.id === a.input.categoryId);
        if (c && c.kind !== a.input.kind) fail("ValidationError", `Category kind '${c.kind}' does not match transaction kind '${a.input.kind}'`);
        if (c && c.isSystem) fail("ValidationError", "That category can't be selected");
      }
      const excluded = (a.input.kind === "income" || a.input.kind === "expense") && !!a.input.excludedFromReporting;
      const transactionTime = resolveTime(a.input.transactionTime, txns[i].transactionTime);
      const hasSplits = Array.isArray(a.input.splits) && a.input.splits.length > 0;
      if (hasSplits) validateSplits(a.input.kind, a.input.splits, a.input.amountCents);
      const splits = hasSplits ? a.input.splits.map((s: any) => ({ categoryId: s.categoryId, amountCents: s.amountCents })) : [];
      const categoryId = hasSplits ? a.input.splits[0].categoryId : a.input.categoryId;
      txns[i] = { ...txns[i], ...a.input, categoryId, transactionTime, excludedFromReporting: excluded, splits, updatedAt: now() };
      return txns[i] as T;
    }
    case "delete_transaction": {
      const i = txns.findIndex((t) => t.id === a.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind === "opening") fail("ValidationError", "The opening balance can't be deleted");
      txns.splice(i, 1);
      return undefined as T;
    }
    case "get_account_balances":
      return accounts.filter((x) => !x.isArchived).map((x) => { const s = subtypeOf(x.subtype); return { accountId: x.id, name: x.name, accountType: s?.type ?? "fund", group: s?.group ?? "own", balanceCents: balanceOf(x) } as AccountBalance; }) as T;
    case "get_account_balance": {
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      return balanceOf(acc) as T;
    }
    case "get_dashboard_summary": {
      const [y, m] = String(a.month).split("-").map(Number);
      const from = `${y}-${String(m).padStart(2, "0")}-01`;
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const inRange = (t: Transaction) => t.transactionDate >= from && t.transactionDate < to;
      const income = txns.filter((t) => t.kind === "income" && !t.excludedFromReporting && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const expense = txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).reduce((s, t) => s + t.amountCents, 0);
      const parentOf = (cid: string) => categories.find((x) => x.id === cid)?.parentId ?? cid;
      const attrib: { cat: string; amt: number }[] = [];
      txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).forEach((t) => {
        if (t.splits.length) t.splits.forEach((s) => attrib.push({ cat: s.categoryId, amt: s.amountCents }));
        else if (t.categoryId) attrib.push({ cat: t.categoryId, amt: t.amountCents });
      });
      const byCat = new Map<string, number>();
      attrib.forEach(({ cat, amt }) => { const pid = parentOf(cat); byCat.set(pid, (byCat.get(pid) ?? 0) + amt); });
      const breakdown: CategoryBreakdown[] = [...byCat.entries()].map(([cid, total]) => {
        const c = categories.find((x) => x.id === cid)!;
        return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
      }).sort((x, y) => y.totalCents - x.totalCents);
      const active = accounts.filter((x) => !x.isArchived);
      const withGroup = active.map((x) => ({ x, s: subtypeOf(x.subtype), bal: balanceOf(x) }));
      const assetsCents = withGroup.filter((r) => (r.s?.group ?? "own") === "own").reduce((sum, r) => sum + r.bal, 0);
      const liabilitiesCents = withGroup.filter((r) => (r.s?.group ?? "own") === "owe").reduce((sum, r) => sum + r.bal, 0);
      const summary: DashboardSummary = {
        month: a.month,
        netWorthCents: assetsCents + liabilitiesCents,
        assetsCents, liabilitiesCents,
        incomeCents: income, expenseCents: expense, netCashflowCents: income - expense,
        spendingBreakdown: breakdown,
        accountBalances: active.map((x) => { const s = subtypeOf(x.subtype); return { accountId: x.id, name: x.name, accountType: s?.type ?? "fund", group: s?.group ?? "own", balanceCents: balanceOf(x) }; }),
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
    case "reset_app": {
      accounts.length = 0;
      txns.length = 0;
      settings.clear();
      seedCategories();
      return undefined as T;
    }
    default:
      return fail("DatabaseError", `Unknown command: ${command}`) as T;
  }
}
