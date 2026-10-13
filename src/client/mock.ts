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
  TxnAllocation,
} from "../types";
import catalog from "../generated/seed-catalog.json";
import { postingsFor } from "../lib/kinds";
import { apportion } from "../lib/reimbursements";

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

function limitSubtype(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}

function resolveCreditLimit(subtype: string, incoming: number | null | undefined, existing: number | null): number | null {
  if (limitSubtype(subtype)) {
    if (incoming == null) {
      if (existing != null && existing > 0) return existing;
      return fail("ValidationError", "Credit limit is required for this account.");
    }
    if (incoming <= 0) return fail("ValidationError", "Credit limit must be greater than zero.");
    return incoming;
  }
  if (incoming != null) return fail("ValidationError", "Credit limit only applies to credit cards and BNPL.");
  return null;
}

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

// Reimbursement links, mirroring the `reimbursement_allocations` table. Each
// Transaction's `reimbursedCents` / `allocations` are derived from these.
interface AllocRow { id: string; reimbursementId: string; expenseId: string; amountCents: number }
const allocs: AllocRow[] = [];

const reimbDefaults = () => ({
  expectedReimbursementCents: null as number | null,
  reimbursedCents: 0,
  allocations: [] as TxnAllocation[],
});

function syncDerived() {
  for (const t of txns) {
    t.reimbursedCents = allocs.filter((a) => a.expenseId === t.id).reduce((s, a) => s + a.amountCents, 0);
    t.allocations = t.kind === "reimbursement"
      ? allocs.filter((a) => a.reimbursementId === t.id).map((a) => ({ expenseId: a.expenseId, amountCents: a.amountCents }))
      : [];
  }
}

const allocatedOn = (expenseId: string, exceptReimbursementId?: string) =>
  allocs
    .filter((a) => a.expenseId === expenseId && a.reimbursementId !== exceptReimbursementId)
    .reduce((s, a) => s + a.amountCents, 0);

// Mirrors Rust service::is_plain_expense: an expense that is not a balance correction.
const isPlainExpense = (t: Transaction) =>
  t.kind === "expense" && !categories.find((c) => c.id === t.categoryId)?.isSystem;

// Mirrors Rust service::validate_allocations.
function validateAllocations(amountCents: number, list: TxnAllocation[], exceptReimbursementId?: string): void {
  if (!Array.isArray(list) || list.length === 0) return fail("ValidationError", "Pick at least one expense to reimburse.");
  const seen = new Set<string>();
  let sum = 0;
  for (const l of list) {
    if (l.amountCents <= 0) return fail("ValidationError", "Each allocation must be greater than zero.");
    if (seen.has(l.expenseId)) return fail("ValidationError", "An expense can only be listed once.");
    seen.add(l.expenseId);
    const e = txns.find((t) => t.id === l.expenseId);
    if (!e || !isPlainExpense(e)) return fail("ValidationError", "Only expenses can be reimbursed.");
    if (l.amountCents > e.amountCents - allocatedOn(l.expenseId, exceptReimbursementId)) {
      return fail("ValidationError", "Allocation exceeds what's left on that expense.");
    }
    sum += l.amountCents;
  }
  if (sum !== amountCents) fail("ValidationError", "Allocations must add up to the reimbursement amount.");
}
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

function isPaymentDestination(subtype: string): boolean {
  return subtype === "credit-card" || subtype === "bnpl";
}
function isPaymentSource(subtype: string): boolean {
  return subtype === "cash" || subtype === "ewallet" || subtype === "savings" || subtype === "current";
}

function seedDemo() {
  if (accounts.length) return;
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    const s = subtypeOf(t.defaultSubtype)!;
    const id = uid();
    accounts.push({ id, templateKey: key, name, accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: opening, creditLimitCents: null, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
    txns.push({ id: uid(), kind: "opening", accountId: id, toAccountId: null, categoryId: null, amountCents: opening, description: "Opening balance", transactionDate: "2026-01-01", transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
  };
  mk("maybank", "Maybank Savings", 842000);
  mk("tng-ewallet", "Touch 'n Go", 12750);
  mk("stashaway", "StashAway", 1860000);
  const cat = (n: string) => categories.find((c) => c.name === n)!.id;
  const add = (kind: Transaction["kind"], acc: number, amt: number, catName: string | null, desc: string, date: string, to?: number) =>
    txns.push({ id: uid(), kind, accountId: accounts[acc].id, toAccountId: to != null ? accounts[to].id : null, categoryId: catName ? cat(catName) : null, amountCents: amt, description: desc, transactionDate: date, transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
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
  const result = await mockInvokeInner<T>(command, args);
  syncDerived();
  return result;
}

async function mockInvokeInner<T>(command: string, args: Record<string, unknown>): Promise<T> {
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
      const creditLimitCents = resolveCreditLimit(s.key, a.creditLimitCents ?? null, null);
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, creditLimitCents, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
      accounts.push(acc);
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
      return hydrate(acc) as T;
    }
    case "list_accounts":
      return accounts.filter((x) => a.includeArchived || !x.isArchived).map(hydrate) as T;
    case "update_account": {
      const acc = accounts.find((x) => x.id === a.input.id) ?? fail("NotFound", "Account not found");
      // Validate everything before writing so a rejected update leaves the account untouched.
      const nextSub = a.input.subtype != null
        ? subtypeOf(a.input.subtype) ?? fail("ValidationError", `Invalid subtype: ${a.input.subtype}`)
        : null;
      const sent = Object.prototype.hasOwnProperty.call(a.input, "creditLimitCents") ? a.input.creditLimitCents : null;
      const nextLimit = resolveCreditLimit(nextSub ? nextSub.key : acc.subtype, sent ?? null, acc.creditLimitCents);
      if (a.input.name != null) acc.name = String(a.input.name).trim();
      if (nextSub) {
        acc.subtype = nextSub.key;
        acc.accountType = nextSub.type;
        acc.group = nextSub.group;
      }
      acc.creditLimitCents = nextLimit;
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
            txns.unshift({ id: uid(), kind, accountId: acc.id, toAccountId: null, categoryId: cat ? cat.id : null, amountCents: Math.abs(diff), description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
          } else {
            txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), transactionTime: null, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
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
        ...reimbDefaults(),
      };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_transfer_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot transfer to the same account");
      const src = accounts.find((x) => x.id === a.fromAccountId) ?? fail("NotFound", "Account not found");
      const dest = accounts.find((x) => x.id === a.toAccountId) ?? fail("NotFound", "Account not found");
      if (src.isArchived) fail("Conflict", "The source account is archived");
      if (dest.isArchived) fail("Conflict", "The destination account is archived");
      if (isPaymentDestination(dest.subtype)) fail("ValidationError", "Pay a credit card or BNPL as a payment.");
      const transactionTime = resolveTime(a.time, null);
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_payment_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot pay the same account.");
      const src = accounts.find((x) => x.id === a.fromAccountId) ?? fail("NotFound", "Account not found");
      const dest = accounts.find((x) => x.id === a.toAccountId) ?? fail("NotFound", "Account not found");
      if (src.isArchived) fail("Conflict", "The source account is archived");
      if (dest.isArchived) fail("Conflict", "The destination account is archived");
      if (!isPaymentDestination(dest.subtype)) fail("ValidationError", "Payments can only pay a credit card or BNPL.");
      if (!isPaymentSource(src.subtype)) fail("ValidationError", "Payments can only come from cash, an e-wallet, savings, or a current account.");
      const transactionTime = resolveTime(a.time, null);
      const tx: Transaction = { id: uid(), kind: "payment", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_reimbursement_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const transactionTime = resolveTime(a.time, null);
      validateAllocations(a.amountCents, a.allocations);
      const id = uid();
      const tx: Transaction = { id, kind: "reimbursement", accountId: a.accountId, toAccountId: null, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() };
      txns.unshift(tx);
      for (const l of a.allocations as TxnAllocation[]) allocs.push({ id: uid(), reimbursementId: id, expenseId: l.expenseId, amountCents: l.amountCents });
      return tx as T;
    }
    case "update_reimbursement_transaction": {
      const i = txns.findIndex((t) => t.id === a.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind !== "reimbursement") fail("ValidationError", "Only reimbursements can be edited here.");
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "The selected account is archived");
      const transactionTime = resolveTime(a.time, txns[i].transactionTime);
      validateAllocations(a.amountCents, a.allocations, a.id);
      txns[i] = { ...txns[i], accountId: a.accountId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, transactionTime, updatedAt: now() };
      for (let k = allocs.length - 1; k >= 0; k--) if (allocs[k].reimbursementId === a.id) allocs.splice(k, 1);
      for (const l of a.allocations as TxnAllocation[]) allocs.push({ id: uid(), reimbursementId: a.id, expenseId: l.expenseId, amountCents: l.amountCents });
      return txns[i] as T;
    }
    case "set_expected_reimbursement": {
      const e = txns.find((t) => t.id === a.expenseId) ?? fail("NotFound", "Transaction not found");
      if (!isPlainExpense(e)) fail("ValidationError", "Only expenses can expect a reimbursement.");
      const n: number | null = a.expectedCents ?? null;
      if (n != null && (n <= 0 || n > e.amountCents)) {
        fail("ValidationError", "Expected reimbursement must be more than zero and no more than the expense amount.");
      }
      e.expectedReimbursementCents = n;
      e.updatedAt = now();
      return e as T;
    }
    case "get_awaiting_reimbursement": {
      let count = 0;
      let totalCents = 0;
      for (const t of txns) {
        if (t.kind !== "expense" || t.expectedReimbursementCents == null) continue;
        const outstanding = t.expectedReimbursementCents - allocatedOn(t.id);
        if (outstanding > 0) { count += 1; totalCents += outstanding; }
      }
      return { count, totalCents } as T;
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
      if (txns[i].kind === "reimbursement" || a.input.kind === "reimbursement") fail("ValidationError", "Edit a reimbursement from its own form.");
      const reimbursed = allocatedOn(txns[i].id);
      if (reimbursed > 0) {
        if (a.input.kind !== "expense") fail("Conflict", "This expense has been reimbursed. Edit or delete the reimbursement first.");
        if (a.input.amountCents < reimbursed) fail("ValidationError", "Amount can't go below what's already been reimbursed.");
      }
      const exCat = categories.find((x) => x.id === txns[i].categoryId);
      if (exCat?.isSystem) fail("ValidationError", "Balance corrections can't be edited; delete it and reconcile again");
      if ((a.input.kind === "income" || a.input.kind === "expense") && a.input.categoryId) {
        const c = categories.find((x) => x.id === a.input.categoryId);
        if (c && c.kind !== a.input.kind) fail("ValidationError", `Category kind '${c.kind}' does not match transaction kind '${a.input.kind}'`);
        if (c && c.isSystem) fail("ValidationError", "That category can't be selected");
      }
      if (a.input.kind === "payment") {
        if (Array.isArray(a.input.splits) && a.input.splits.length > 0) fail("ValidationError", "Payments can't be split.");
        if (a.input.accountId === a.input.toAccountId) fail("ValidationError", "Cannot pay the same account.");
        const src = accounts.find((x) => x.id === a.input.accountId) ?? fail("NotFound", "Account not found");
        const dest = accounts.find((x) => x.id === a.input.toAccountId) ?? fail("NotFound", "Account not found");
        if (src.isArchived) fail("Conflict", "The source account is archived");
        if (dest.isArchived) fail("Conflict", "The destination account is archived");
        if (!isPaymentDestination(dest.subtype)) fail("ValidationError", "Payments can only pay a credit card or BNPL.");
        if (!isPaymentSource(src.subtype)) fail("ValidationError", "Payments can only come from cash, an e-wallet, savings, or a current account.");
      }
      if (a.input.kind === "transfer" && a.input.toAccountId) {
        const dest = accounts.find((x) => x.id === a.input.toAccountId) ?? fail("NotFound", "Account not found");
        if (isPaymentDestination(dest.subtype)) fail("ValidationError", "Pay a credit card or BNPL as a payment.");
      }
      const excluded = (a.input.kind === "income" || a.input.kind === "expense") && !!a.input.excludedFromReporting;
      const transactionTime = resolveTime(a.input.transactionTime, txns[i].transactionTime);
      const hasSplits = Array.isArray(a.input.splits) && a.input.splits.length > 0;
      if (hasSplits) validateSplits(a.input.kind, a.input.splits, a.input.amountCents);
      const splits = a.input.kind === "payment" ? [] : hasSplits ? a.input.splits.map((s: any) => ({ categoryId: s.categoryId, amountCents: s.amountCents })) : [];
      const categoryId = a.input.kind === "payment" ? null : hasSplits ? a.input.splits[0].categoryId : a.input.categoryId;
      const prevExpected = txns[i].expectedReimbursementCents;
      const expectedReimbursementCents = a.input.kind === "expense" && prevExpected != null ? Math.min(prevExpected, a.input.amountCents) : null;
      txns[i] = { ...txns[i], ...a.input, categoryId, transactionTime, excludedFromReporting: excluded, splits, expectedReimbursementCents, updatedAt: now() };
      return txns[i] as T;
    }
    case "delete_transaction": {
      const i = txns.findIndex((t) => t.id === a.id);
      if (i < 0) fail("NotFound", "Transaction not found");
      if (txns[i].kind === "opening") fail("ValidationError", "The opening balance can't be deleted");
      if (allocatedOn(txns[i].id) > 0) fail("Conflict", "This expense has been reimbursed. Edit or delete the reimbursement first.");
      const [removed] = txns.splice(i, 1);
      if (removed.kind === "reimbursement") {
        for (let k = allocs.length - 1; k >= 0; k--) if (allocs[k].reimbursementId === removed.id) allocs.splice(k, 1);
      }
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
      const inRangeExpenses = txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t));
      const expense = inRangeExpenses.reduce((s, t) => s + t.amountCents - allocatedOn(t.id), 0);
      const parentOf = (cid: string) => categories.find((x) => x.id === cid)?.parentId ?? cid;
      const attrib: { cat: string; amt: number }[] = [];
      inRangeExpenses.forEach((t) => {
        const lines = t.splits.length
          ? t.splits.map((s) => ({ cat: s.categoryId, amt: s.amountCents }))
          : t.categoryId ? [{ cat: t.categoryId, amt: t.amountCents }] : [];
        const shares = apportion(allocatedOn(t.id), lines.map((l) => l.amt));
        lines.forEach((l, k) => attrib.push({ cat: l.cat, amt: l.amt - shares[k] }));
      });
      const byCat = new Map<string, number>();
      attrib.forEach(({ cat, amt }) => { const pid = parentOf(cat); byCat.set(pid, (byCat.get(pid) ?? 0) + amt); });
      const breakdown: CategoryBreakdown[] = [...byCat.entries()]
        .filter(([, total]) => total > 0)
        .map(([cid, total]) => {
          const c = categories.find((x) => x.id === cid)!;
          return { categoryId: cid, categoryName: c.name, emoji: c.emoji, color: c.color, totalCents: total };
        })
        .sort((x, y) => y.totalCents - x.totalCents || (x.categoryName < y.categoryName ? -1 : x.categoryName > y.categoryName ? 1 : 0));
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
      allocs.length = 0;
      settings.clear();
      seedCategories();
      return undefined as T;
    }
    default:
      return fail("DatabaseError", `Unknown command: ${command}`) as T;
  }
}
