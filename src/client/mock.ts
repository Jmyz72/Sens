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
  AiSettings,
  BudgetWrite,
  Category,
  CategoryBreakdown,
  DashboardSummary,
  DraftFields,
  GoalWrite,
  ImportDraft,
  Plan,
  PlanBudget,
  PlanGoal,
  Schedule,
  SchedulePass,
  ScheduleWrite,
  Transaction,
  TxnAllocation,
  UpcomingOccurrence,
} from "../types";
import catalog from "../generated/seed-catalog.json";
import { postingsFor } from "../lib/kinds";
import { localToday, monthlyRequired, resolveAmount } from "../lib/plan";
import { datesThrough, nextDue, validateRule, type End, type MonthMode, type Ordinal, type Rule } from "../lib/recurrence";
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

function isValueSubtype(subtype: string): boolean {
  return subtype === "fixed-deposit" || subtype === "investment" || subtype === "unit-trust" || subtype === "crypto";
}

function validateSavedValueCategory(id: string, expectedKind: string, wrongKindMessage: string): void {
  const cat = categories.find((c) => c.id === id) ?? fail("NotFound", "Category not found");
  if (cat.isSystem) fail("ValidationError", "That category can't be selected.");
  if (cat.kind !== expectedKind) fail("ValidationError", wrongKindMessage);
}

// Mirrors Rust service::resolve_value_categories. `incoming` null means the
// caller omitted the pair; a present pair is applied, and a non-qualifying
// subtype clears both.
function resolveValueCategories(
  subtype: string,
  incoming: { gainCategoryId: string | null; lossCategoryId: string | null } | null,
  existingGain: string | null,
  existingLoss: string | null,
): { gainCategoryId: string | null; lossCategoryId: string | null } {
  const qualifying = isValueSubtype(subtype);
  if (incoming != null) {
    if (!qualifying && (incoming.gainCategoryId != null || incoming.lossCategoryId != null)) {
      fail("ValidationError", "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.");
    }
    if (!qualifying) return { gainCategoryId: null, lossCategoryId: null };
    if (incoming.gainCategoryId != null) {
      validateSavedValueCategory(incoming.gainCategoryId, "income", "Gain category must be an income category.");
    }
    if (incoming.lossCategoryId != null) {
      validateSavedValueCategory(incoming.lossCategoryId, "expense", "Loss category must be an expense category.");
    }
    return { gainCategoryId: incoming.gainCategoryId, lossCategoryId: incoming.lossCategoryId };
  }
  if (!qualifying) return { gainCategoryId: null, lossCategoryId: null };
  return { gainCategoryId: existingGain, lossCategoryId: existingLoss };
}

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

interface BudgetVersion {
  categoryId: string;
  effectiveMonth: string;
  amountCents: number | null;
}
const budgetVersions: BudgetVersion[] = [];

interface GoalRecord {
  id: string;
  name: string;
  accountId: string;
  targetCents: number;
  targetDate: string | null;
}
const goals: GoalRecord[] = [];

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

// Test-only clock. `null` uses `new Date()`. A `YYYY-MM-DDTHH:MM` string is local wall time.
let mockNow: Date | null = null;

export function setMockNow(local: string | null): void {
  if (local == null) {
    mockNow = null;
    return;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return;
  mockNow = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
}

interface OccurrenceRow {
  scheduleId: string;
  occurrenceDate: string;
  status: "posted" | "skipped";
  transactionId: string | null;
}
const schedules: Schedule[] = [];
const occurrences: OccurrenceRow[] = [];

// ── Photo import (mirrors src-tauri/src/drafts.rs) ───────────────────────────

interface DraftRowMock {
  id: string;
  sourceName: string;
  createdAt: string;
  fields: DraftFields;
}
const drafts: DraftRowMock[] = [];
const MOCK_OCR_TEXT = "KOPITIAM LIM\n15/10/2026 13:42\nNasi lemak 8.00\nTeh ais 4.50\nTotal RM 12.50";

function draftProblems(f: DraftFields): string[] {
  const p: string[] = [];
  if (f.amountCents == null || f.amountCents <= 0) p.push("amount");
  if (!f.date) p.push("date");
  if (timeEnabled() && !f.time) p.push("time");
  if (!f.accountId) p.push("account");
  if (f.kind === "transfer") {
    if (!f.toAccountId || f.toAccountId === f.accountId) p.push("to_account");
  } else if (f.kind === "income" || f.kind === "expense") {
    if (!f.categoryId) p.push("category");
  } else {
    p.push("kind");
  }
  return p;
}

function presentDraft(d: DraftRowMock): ImportDraft {
  return { id: d.id, sourceName: d.sourceName, createdAt: d.createdAt, fields: { ...d.fields, hints: [...d.fields.hints] }, problems: draftProblems(d.fields) };
}

function findDraft(id: string): DraftRowMock {
  return drafts.find((d) => d.id === id) ?? fail("NotFound", "Draft not found");
}

function normalizeOptional(value: string | null | undefined, pattern: RegExp, message: string): string | null {
  const t = (value ?? "").trim();
  if (!t) return null;
  if (!pattern.test(t)) fail("ValidationError", message);
  return t;
}

function aiSettings(): AiSettings {
  return {
    baseUrl: settings.get("ai_base_url") ?? "",
    model: settings.get("ai_model") ?? "",
    hasKey: (settings.get("ai_api_key") ?? "") !== "",
  };
}

/** The last non-database reason a pass could not post a schedule; lists show it as the block reason. */
const passFailures = new Map<string, string>();

/** Test hook: a copy of the settled occurrence rows. */
export function mockOccurrences(): OccurrenceRow[] {
  return occurrences.map((row) => ({ ...row }));
}

/** The transaction and the settled date are recorded together. A failed create leaves neither. */
function settlePost(schedule: Schedule, amountCents: number, date: string): Transaction {
  const tx = createPosted(schedule, amountCents, date);
  occurrences.push({ scheduleId: schedule.id, occurrenceDate: date, status: "posted", transactionId: tx.id });
  return tx;
}

function timeEnabled(): boolean {
  return settings.get("transaction_time_enabled") !== "0";
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
function goalSubtype(subtype: string): boolean {
  return subtype === "cash" || subtype === "ewallet" || subtype === "savings" || subtype === "current";
}

function seedDemo() {
  if (accounts.length) return;
  const mk = (key: string, name: string, opening: number) => {
    const t = templates.find((x) => x.key === key)!;
    const s = subtypeOf(t.defaultSubtype)!;
    const id = uid();
    accounts.push({ id, templateKey: key, name, accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: opening, creditLimitCents: null, gainCategoryId: null, lossCategoryId: null, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: opening });
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

function versionsOf(categoryId: string, source: BudgetVersion[] = budgetVersions) {
  return source
    .filter((v) => v.categoryId === categoryId)
    .map((v) => ({ effectiveMonth: v.effectiveMonth, amountCents: v.amountCents }));
}

function ensureEnvelopes(month: string, source: BudgetVersion[] = budgetVersions) {
  const resolved = new Map<string, number | null>();
  for (const cat of categories) {
    resolved.set(cat.id, resolveAmount(versionsOf(cat.id, source), month));
  }
  for (const cat of categories) {
    if (cat.parentId == null) continue;
    const childAmount = resolved.get(cat.id) ?? null;
    const parentAmount = resolved.get(cat.parentId) ?? null;
    if (childAmount != null && parentAmount == null) {
      fail("Conflict", "Set a budget on the parent category first.");
    }
  }
  for (const parent of categories) {
    const parentAmount = resolved.get(parent.id) ?? null;
    if (parentAmount == null) continue;
    let childSum = 0;
    for (const child of categories) {
      if (child.parentId !== parent.id) continue;
      const amt = resolved.get(child.id);
      if (amt != null) childSum += amt;
    }
    if (childSum > parentAmount) {
      fail("Conflict", "Subcategory budgets add up to more than the parent.");
    }
  }
}

function setBudgets(items: BudgetWrite[]) {
  if (items.length === 0) return;
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.categoryId)) fail("ValidationError", "A category can only be listed once.");
    seen.add(item.categoryId);
    if (item.amountCents != null && item.amountCents < 0) {
      fail("ValidationError", "A budget can't be negative.");
    }
    const cat = categories.find((c) => c.id === item.categoryId) ?? fail("NotFound", "Category not found");
    if (item.amountCents != null) {
      if (cat.isSystem) fail("ValidationError", "The Adjustment category can't have a budget.");
      if (cat.kind !== "expense") fail("ValidationError", "Income categories can't have a budget.");
      if (cat.isArchived && resolveAmount(versionsOf(cat.id), localToday().slice(0, 7)) == null) {
        fail("Conflict", "Archived categories can't be given a new budget.");
      }
    }
  }
  const month = localToday().slice(0, 7);
  const next = budgetVersions.map((v) => ({ ...v }));
  for (const item of items) {
    const existing = next.find((v) => v.categoryId === item.categoryId && v.effectiveMonth === month);
    if (existing) existing.amountCents = item.amountCents;
    else next.push({ categoryId: item.categoryId, effectiveMonth: month, amountCents: item.amountCents });
  }
  ensureEnvelopes(month, next);
  budgetVersions.length = 0;
  budgetVersions.push(...next);
}

/** Per-category expense nets in [from, to), after reimbursement apportion and before parent rollup. */
function spendNets(from: string, to: string): Map<string, number> {
  const inRange = (t: Transaction) => t.transactionDate >= from && t.transactionDate < to;
  const nets = new Map<string, number>();
  const attrib: { cat: string; amt: number }[] = [];
  txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).forEach((t) => {
    const lines = t.splits.length
      ? t.splits.map((s) => ({ cat: s.categoryId, amt: s.amountCents }))
      : t.categoryId ? [{ cat: t.categoryId, amt: t.amountCents }] : [];
    const shares = apportion(allocatedOn(t.id), lines.map((l) => l.amt));
    lines.forEach((l, k) => attrib.push({ cat: l.cat, amt: l.amt - shares[k] }));
  });
  attrib.forEach(({ cat, amt }) => nets.set(cat, (nets.get(cat) ?? 0) + amt));
  return nets;
}

function planMonthRange(month: string): { from: string; to: string } {
  const parts = month.split("-");
  if (parts.length !== 2) fail("ValidationError", "Month must be in YYYY-MM format");
  const year = parseI32(parts[0]) ?? fail("ValidationError", "Invalid year");
  const mon = parseU32(parts[1]) ?? fail("ValidationError", "Invalid month");
  if (mon < 1 || mon > 12) fail("ValidationError", "Month must be 01-12");
  const from = `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}-01`;
  const to = mon === 12
    ? `${String(year + 1).padStart(4, "0")}-01-01`
    : `${String(year).padStart(4, "0")}-${String(mon + 1).padStart(2, "0")}-01`;
  return { from, to };
}

function parseI32(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return null;
  return n;
}

function parseU32(s: string): number | null {
  if (!/^\+?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 4294967295) return null;
  return n;
}

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function prepareGoal(input: GoalWrite, currentId: string | null): string {
  const name = String(input.name ?? "").trim();
  if (!name) fail("ValidationError", "Goal name cannot be empty");
  if (!(typeof input.targetCents === "number" && input.targetCents > 0)) {
    fail("ValidationError", "Target must be greater than zero.");
  }
  if (input.targetDate != null && !isRealDate(input.targetDate)) {
    fail("ValidationError", "Date must be a real YYYY-MM-DD.");
  }
  const acc = accounts.find((x) => x.id === input.accountId) ?? fail("NotFound", "Account not found");
  if (acc.isArchived) fail("Conflict", "The selected account is archived");
  if (!goalSubtype(acc.subtype)) {
    fail("Conflict", "Goals can only sit on cash, an e-wallet, savings, or a current account.");
  }
  const existing = goals.find((g) => g.accountId === input.accountId);
  if (existing && existing.id !== currentId) fail("Conflict", "This account already has a goal.");
  return name;
}

function toPlanGoal(row: GoalRecord): PlanGoal {
  const acc = accounts.find((x) => x.id === row.accountId) ?? fail("NotFound", "Account not found");
  const balanceCents = balanceOf(acc);
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    accountName: acc.name,
    balanceCents,
    targetCents: row.targetCents,
    targetDate: row.targetDate,
    monthlyCents: monthlyRequired(localToday(), row.targetDate, balanceCents, row.targetCents),
  };
}

function getPlan(month: string): Plan {
  const { from, to } = planMonthRange(month);
  const own = spendNets(from, to);
  const budgets: PlanBudget[] = [];
  for (const cat of categories) {
    const amountCents = resolveAmount(versionsOf(cat.id), month);
    if (amountCents == null) continue;
    let spentCents = own.get(cat.id) ?? 0;
    if (cat.parentId == null) {
      for (const child of categories) {
        if (child.parentId === cat.id) spentCents += own.get(child.id) ?? 0;
      }
    }
    budgets.push({
      categoryId: cat.id,
      parentId: cat.parentId,
      name: cat.name,
      emoji: cat.emoji,
      sortOrder: cat.sortOrder,
      isArchived: cat.isArchived,
      amountCents,
      spentCents,
    });
  }
  budgets.sort((x, y) => x.sortOrder - y.sortOrder || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const planGoals: PlanGoal[] = [];
  for (const acc of accounts) {
    if (acc.isArchived) continue;
    const row = goals.find((g) => g.accountId === acc.id);
    if (row) planGoals.push(toPlanGoal(row));
  }
  return { month, budgets, goals: planGoals };
}

function addIncomeOrExpense(kind: "income" | "expense", a: any): Transaction {
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
  return tx;
}

function addTransfer(a: any): Transaction {
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
  return tx;
}

function addPayment(a: any): Transaction {
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
  return tx;
}

function clock(): Date {
  return mockNow ?? new Date();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function stampOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function ymdOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function appFailure(err: unknown): { code: string; message: string } | null {
  if (!err || typeof err !== "object") return null;
  const row = err as { code?: unknown; message?: unknown };
  if (typeof row.code !== "string" || typeof row.message !== "string") return null;
  return { code: row.code, message: row.message };
}

function monthModeOf(mode: string | null): MonthMode {
  if (mode == null || mode === "each") return "each";
  if (mode === "onThe") return "onThe";
  return fail("ValidationError", "Month mode must be each or onThe.");
}

function ordinalOf(value: string | null): Ordinal {
  if (value == null || value === "first") return "first";
  if (value === "second" || value === "third" || value === "fourth" || value === "fifth" || value === "last") return value;
  return fail("ValidationError", "Ordinal must be first, second, third, fourth, fifth, or last.");
}

function endOf(write: ScheduleWrite): End {
  if (write.endMode === "never") return { mode: "never" };
  if (write.endMode === "after") return { mode: "after", count: write.endCount ?? 0 };
  if (write.endMode === "on") {
    const date = write.endDate ?? "";
    if (!isRealDate(date)) fail("ValidationError", "Date must be a real YYYY-MM-DD.");
    return { mode: "on", date };
  }
  return fail("ValidationError", "End must be never, after, or on.");
}

function ruleFrom(write: ScheduleWrite): Rule {
  if (!isRealDate(write.startDate)) fail("ValidationError", "Date must be a real YYYY-MM-DD.");
  if (write.frequency !== "daily" && write.frequency !== "weekly" && write.frequency !== "monthly" && write.frequency !== "yearly") {
    fail("ValidationError", "Frequency must be daily, weekly, monthly, or yearly.");
  }
  return {
    start: write.startDate,
    frequency: write.frequency,
    interval: write.interval,
    weekdays: [...write.weekdays],
    monthMode: monthModeOf(write.monthMode),
    monthDays: [...write.monthDays],
    ordinal: ordinalOf(write.ordinal),
    ordinalDay: write.ordinalDay == null || write.ordinalDay === "weekday" ? "weekday" : write.ordinalDay,
    months: [...write.months],
    dayOfMonth: write.dayOfMonth ?? 0,
    end: endOf(write),
  };
}

function ensureActive(id: string, role: "selected" | "source" | "destination"): Account {
  const account = accounts.find((row) => row.id === id) ?? fail("NotFound", "Account not found");
  if (account.isArchived) fail("Conflict", `The ${role} account is archived`);
  return account;
}

function validateCategory(categoryId: string, kind: string): void {
  const category = categories.find((row) => row.id === categoryId) ?? fail("NotFound", "Category not found");
  if (category.isSystem) fail("ValidationError", "That category can't be selected");
  if (category.kind !== kind) {
    fail("ValidationError", `Category kind '${category.kind}' does not match transaction kind '${kind}'`);
  }
}

function validatePosting(
  kind: string,
  amountCents: number,
  accountId: string,
  toAccountId: string | null,
  categoryId: string | null,
  time: string | null,
): void {
  if (amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
  if (kind === "income" || kind === "expense") {
    ensureActive(accountId, "selected");
  } else if (kind === "transfer") {
    const to = toAccountId ?? fail("ValidationError", "A destination account is required");
    if (accountId === to) fail("ValidationError", "Cannot transfer to the same account");
    ensureActive(accountId, "source");
    const dest = ensureActive(to, "destination");
    if (dest.subtype === "credit-card" || dest.subtype === "bnpl") {
      fail("ValidationError", "Pay a credit card or BNPL as a payment.");
    }
  } else if (kind === "payment") {
    const to = toAccountId ?? fail("ValidationError", "A destination account is required");
    if (accountId === to) fail("ValidationError", "Cannot pay the same account.");
    const source = ensureActive(accountId, "source");
    const dest = ensureActive(to, "destination");
    if (dest.subtype !== "credit-card" && dest.subtype !== "bnpl") {
      fail("ValidationError", "Payments can only pay a credit card or BNPL.");
    }
    if (!isPaymentSource(source.subtype)) {
      fail("ValidationError", "Payments can only come from cash, an e-wallet, savings, or a current account.");
    }
  } else {
    fail("ValidationError", "Kind must be income, expense, transfer, or payment.");
  }
  if (timeEnabled()) {
    const raw = (time ?? "").trim();
    if (!raw) fail("ValidationError", "A time is required");
    if (!isHHMM(raw)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
  }
  if (kind === "income" || kind === "expense") {
    validateCategory(categoryId ?? fail("ValidationError", "A category is required"), kind);
  }
}

function prepareSchedule(input: ScheduleWrite): ScheduleWrite {
  if (input.mode !== "auto" && input.mode !== "tap") fail("ValidationError", "Mode must be auto or tap.");
  const write: ScheduleWrite = {
    ...input,
    weekdays: [...input.weekdays],
    monthDays: [...input.monthDays],
    months: [...input.months],
  };
  if (timeEnabled()) {
    const raw = typeof write.time === "string" ? write.time.trim() : "";
    if (!raw) fail("ValidationError", "A time is required");
    if (!isHHMM(raw)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
    write.time = raw;
  } else {
    const raw = typeof write.time === "string" ? write.time.trim() : "";
    if (raw && !isHHMM(raw)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
    write.time = null;
  }
  const reason = validateRule(ruleFrom(write));
  if (reason) fail("ValidationError", reason);
  validatePosting(write.kind, write.amountCents, write.accountId, write.toAccountId, write.categoryId, write.time);
  return write;
}

/** The stored time, or 00:00 when times are on and it was saved while they were off. */
function effectiveTime(schedule: Schedule): string | null {
  if (!timeEnabled()) return null;
  return schedule.time ?? "00:00";
}

function scheduleTime(schedule: Schedule): string | null {
  return schedule.time && isHHMM(schedule.time) ? schedule.time : null;
}

function dueDates(schedule: Schedule, at: Date): string[] {
  let dates = datesThrough(ruleFrom(schedule), ymdOf(at));
  const time = scheduleTime(schedule);
  if (timeEnabled() && time && stampOf(at).slice(11) < time) {
    const today = ymdOf(at);
    dates = dates.filter((date) => date !== today);
  }
  const settled = new Set(occurrences.filter((row) => row.scheduleId === schedule.id).map((row) => row.occurrenceDate));
  return dates.filter((date) => !settled.has(date));
}

function isDue(schedule: Schedule, date: string, at: Date): boolean {
  const today = ymdOf(at);
  if (date > today) return false;
  if (date < today || !timeEnabled()) return true;
  const time = scheduleTime(schedule);
  if (!time) return true;
  return stampOf(at).slice(11) >= time;
}

function onSchedule(rule: Rule, date: string): boolean {
  return datesThrough(rule, date).includes(date);
}

function ensureOpen(schedule: Schedule, date: string, at: Date): void {
  if (!isRealDate(date)) fail("ValidationError", "Date must be a real YYYY-MM-DD.");
  if (occurrences.some((row) => row.scheduleId === schedule.id && row.occurrenceDate === date)) {
    fail("ValidationError", "That date was already posted or skipped.");
  }
  if (!onSchedule(ruleFrom(schedule), date)) fail("ValidationError", "That date is not on this schedule.");
  if (!isDue(schedule, date, at)) fail("ValidationError", "That date is not due.");
}

function postingBlock(schedule: Schedule): string | null {
  try {
    validatePosting(schedule.kind, schedule.amountCents, schedule.accountId, schedule.toAccountId, schedule.categoryId, effectiveTime(schedule));
    return null;
  } catch (err) {
    const parsed = appFailure(err);
    if (!parsed || parsed.code === "DatabaseError") throw err;
    return parsed.message;
  }
}

function blockText(schedule: Schedule): string | null {
  return postingBlock(schedule) ?? passFailures.get(schedule.id) ?? null;
}

function blockReasonFor(schedule: Schedule, at: Date): string | null {
  if (dueDates(schedule, at).length === 0) return null;
  return blockText(schedule);
}

function present(schedule: Schedule, at: Date): Schedule {
  return {
    ...schedule,
    weekdays: [...schedule.weekdays],
    monthDays: [...schedule.monthDays],
    months: [...schedule.months],
    blockReason: blockReasonFor(schedule, at),
  };
}

function findSchedule(id: string): Schedule {
  return schedules.find((row) => row.id === id) ?? fail("NotFound", "Schedule not found");
}

function labelFor(schedule: Schedule): string {
  const text = schedule.description?.trim() ?? "";
  if (text) return text;
  if (schedule.categoryId) {
    const category = categories.find((row) => row.id === schedule.categoryId);
    if (category) return category.name;
  }
  if (schedule.kind === "transfer") return "Transfer";
  if (schedule.kind === "payment") return "Payment";
  return schedule.kind;
}

function createPosted(schedule: Schedule, amountCents: number, date: string): Transaction {
  const time = effectiveTime(schedule);
  const description = schedule.description;
  if (schedule.kind === "income" || schedule.kind === "expense") {
    return addIncomeOrExpense(schedule.kind, {
      accountId: schedule.accountId,
      categoryId: schedule.categoryId,
      amountCents,
      description,
      date,
      time,
      excludedFromReporting: false,
      splits: null,
    });
  }
  const toAccountId = schedule.toAccountId ?? fail("ValidationError", "A destination account is required");
  const input = { fromAccountId: schedule.accountId, toAccountId, amountCents, description, date, time };
  if (schedule.kind === "transfer") return addTransfer(input);
  if (schedule.kind === "payment") return addPayment(input);
  return fail("ValidationError", "Kind must be income, expense, transfer, or payment.");
}

function runPass(): SchedulePass {
  const at = clock();
  const nowStamp = stampOf(at);
  const posted: Transaction[] = [];
  const wakes: string[] = [];
  for (const schedule of schedules.slice()) {
    const wake = nextDue(ruleFrom(schedule), nowStamp, timeEnabled() ? scheduleTime(schedule) : null);
    if (wake && wake > nowStamp) wakes.push(wake);
    if (schedule.mode !== "auto") continue;
    const due = dueDates(schedule, at);
    if (due.length === 0 || postingBlock(schedule) != null) continue;
    for (const date of due) {
      try {
        posted.push(settlePost(schedule, schedule.amountCents, date));
        passFailures.delete(schedule.id);
      } catch (err) {
        const failure = appFailure(err);
        if (failure?.code === "DatabaseError") throw err;
        if (failure) passFailures.set(schedule.id, failure.message);
        break;
      }
    }
  }
  posted.sort((a, b) => cmpText(a.transactionDate, b.transactionDate) || cmpText(a.id, b.id));
  const nextWakeAt = wakes.reduce<string | null>((min, wake) => (min == null || wake < min ? wake : min), null);
  return { posted, nextWakeAt };
}

function listScheduleRows(): Schedule[] {
  const at = clock();
  return schedules
    .slice()
    .sort((a, b) => cmpText(a.createdAt, b.createdAt) || cmpText(a.id, b.id))
    .map((row) => present(row, at));
}

function createSchedule(input: ScheduleWrite): Schedule {
  const write = prepareSchedule(input);
  const stamp = now();
  const row: Schedule = {
    ...write,
    weekdays: [...write.weekdays],
    monthDays: [...write.monthDays],
    months: [...write.months],
    id: uid(),
    createdAt: stamp,
    updatedAt: stamp,
    blockReason: null,
  };
  schedules.push(row);
  return present(row, clock());
}

function updateSchedule(id: string, input: ScheduleWrite): Schedule {
  const row = findSchedule(id);
  const write = prepareSchedule(input);
  Object.assign(row, write, {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: now(),
    weekdays: [...write.weekdays],
    monthDays: [...write.monthDays],
    months: [...write.months],
  });
  passFailures.delete(id);
  return present(row, clock());
}

function deleteSchedule(id: string): void {
  const index = schedules.findIndex((row) => row.id === id);
  if (index < 0) fail("NotFound", "Schedule not found");
  schedules.splice(index, 1);
  passFailures.delete(id);
  for (let i = occurrences.length - 1; i >= 0; i--) {
    if (occurrences[i].scheduleId === id) occurrences.splice(i, 1);
  }
}

function upcomingRows(): UpcomingOccurrence[] {
  const at = clock();
  const showTime = timeEnabled();
  const rows: UpcomingOccurrence[] = [];
  for (const schedule of schedules) {
    if (schedule.mode !== "tap") continue;
    const due = dueDates(schedule, at);
    if (due.length === 0) continue;
    const blockReason = blockText(schedule);
    const label = labelFor(schedule);
    const name = accounts.find((row) => row.id === schedule.accountId)?.name ?? "Missing account";
    const time = showTime ? effectiveTime(schedule) : null;
    for (const date of due) {
      rows.push({
        scheduleId: schedule.id,
        occurrenceDate: date,
        kind: schedule.kind,
        label,
        amountCents: schedule.amountCents,
        time,
        accountName: name,
        blockReason,
      });
    }
  }
  rows.sort((a, b) => cmpText(a.occurrenceDate, b.occurrenceDate) || cmpText(a.label, b.label) || cmpText(a.scheduleId, b.scheduleId));
  return rows;
}

function postOccurrence(scheduleId: string, date: string, amountCents: number): Transaction {
  const schedule = findSchedule(scheduleId);
  const at = clock();
  ensureOpen(schedule, date, at);
  return settlePost(schedule, amountCents, date);
}

function skipOccurrence(scheduleId: string, date: string): void {
  const schedule = findSchedule(scheduleId);
  ensureOpen(schedule, date, clock());
  occurrences.push({ scheduleId, occurrenceDate: date, status: "skipped", transactionId: null });
}

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
      const value = resolveValueCategories(s.key, { gainCategoryId: a.gainCategoryId ?? null, lossCategoryId: a.lossCategoryId ?? null }, null, null);
      const acc: Account = { id: uid(), templateKey: a.templateKey ?? null, name: String(a.name).trim(), accountType: s.type, group: s.group, subtype: s.key, openingBalanceCents: a.openingBalanceCents, creditLimitCents, gainCategoryId: value.gainCategoryId, lossCategoryId: value.lossCategoryId, currency: "MYR", isArchived: false, createdAt: now(), updatedAt: now(), balanceCents: a.openingBalanceCents };
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
      const resultingSubtype = nextSub ? nextSub.key : acc.subtype;
      if (!goalSubtype(resultingSubtype) && goals.some((g) => g.accountId === acc.id)) {
        fail("Conflict", "Delete this account's goal before changing its type.");
      }
      const sent = Object.prototype.hasOwnProperty.call(a.input, "creditLimitCents") ? a.input.creditLimitCents : null;
      const nextLimit = resolveCreditLimit(resultingSubtype, sent ?? null, acc.creditLimitCents);
      const rawCategories = Object.prototype.hasOwnProperty.call(a.input, "valueCategories") ? a.input.valueCategories : null;
      const incoming = rawCategories != null
        ? { gainCategoryId: rawCategories.gainCategoryId ?? null, lossCategoryId: rawCategories.lossCategoryId ?? null }
        : null;
      const value = resolveValueCategories(resultingSubtype, incoming, acc.gainCategoryId, acc.lossCategoryId);
      if (a.input.name != null) acc.name = String(a.input.name).trim();
      if (nextSub) {
        acc.subtype = nextSub.key;
        acc.accountType = nextSub.type;
        acc.group = nextSub.group;
      }
      acc.creditLimitCents = nextLimit;
      acc.gainCategoryId = value.gainCategoryId;
      acc.lossCategoryId = value.lossCategoryId;
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
    case "update_net_worth": {
      const acc = accounts.find((x) => x.id === a.accountId) ?? fail("NotFound", "Account not found");
      if (acc.isArchived) fail("Conflict", "Cannot update an archived account");
      if (!isValueSubtype(acc.subtype)) fail("ValidationError", "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.");
      if (a.balanceCents < 0) fail("ValidationError", "Balance must be zero or more.");
      const diff = a.balanceCents - balanceOf(acc);
      if (diff === 0) return hydrate(acc) as T;
      const kind = diff > 0 ? "income" : "expense";
      const saved = diff > 0 ? acc.gainCategoryId : acc.lossCategoryId;
      const passed = typeof a.categoryId === "string" ? a.categoryId.trim() : "";
      const catId = saved != null ? saved : passed || fail("ValidationError", "Pick a category for this update.");
      const cat = categories.find((c) => c.id === catId) ?? fail("NotFound", "Category not found");
      if (cat.isSystem) fail("ValidationError", "That category can't be selected.");
      if (cat.kind !== kind) fail("ValidationError", `Category kind '${cat.kind}' does not match transaction kind '${kind}'`);
      const transactionTime = resolveTime(a.time, null);
      txns.unshift({ id: uid(), kind, accountId: acc.id, toAccountId: null, categoryId: catId, amountCents: Math.abs(diff), description: "Value update", transactionDate: today(), transactionTime, createdAt: now(), updatedAt: now(), excludedFromReporting: false, splits: [], ...reimbDefaults() });
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
      for (const acc of accounts) {
        if (acc.gainCategoryId === c.id) acc.gainCategoryId = null;
        if (acc.lossCategoryId === c.id) acc.lossCategoryId = null;
      }
      categories.splice(categories.indexOf(c), 1);
      for (let k = budgetVersions.length - 1; k >= 0; k--) {
        if (budgetVersions[k].categoryId === c.id) budgetVersions.splice(k, 1);
      }
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
      const previousParent = cat.parentId;
      cat.parentId = pid;
      try {
        ensureEnvelopes(localToday().slice(0, 7));
      } catch {
        cat.parentId = previousParent;
        fail("Conflict", "This move would leave subcategory budgets that don't fit. Clear or lower them first.");
      }
      cat.updatedAt = now();
      return cat as T;
    }
    case "create_income_transaction":
    case "create_expense_transaction":
      return addIncomeOrExpense(command === "create_income_transaction" ? "income" : "expense", a) as T;
    case "create_transfer_transaction":
      return addTransfer(a) as T;
    case "create_payment_transaction":
      return addPayment(a) as T;
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
      for (const row of occurrences) {
        if (row.transactionId === removed.id) row.transactionId = null;
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
      const byCat = new Map<string, number>();
      spendNets(from, to).forEach((amt, cat) => {
        const pid = parentOf(cat);
        byCat.set(pid, (byCat.get(pid) ?? 0) + amt);
      });
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
    case "ocr_image": {
      const bytes = a.bytes as Uint8Array;
      if (!bytes || bytes.length === 0) fail("ocr_empty", "No text was found in that image.");
      return MOCK_OCR_TEXT as T;
    }
    case "extract_drafts": {
      if (!settings.get("ai_base_url") || !settings.get("ai_model")) {
        fail("ai_not_configured", "Set the AI base URL and model in Settings first.");
      }
      const active = accounts.filter((x) => !x.isArchived);
      const category = categories.find((c) => c.kind === "expense" && !c.isSystem && !c.isArchived && c.parentId == null);
      const needTime = timeEnabled();
      const rows: DraftFields[] = [
        {
          kind: "expense", date: today(), time: needTime ? "00:00" : null, amountCents: 1250,
          accountId: active[0]?.id ?? null, toAccountId: null, categoryId: category?.id ?? null,
          note: "Kopitiam Lim", hints: needTime ? ["time_assumed"] : [],
        },
      ];
      if (active.length > 1) {
        rows.push({
          kind: "transfer", date: today(), time: needTime ? "00:00" : null, amountCents: 5000,
          accountId: active[0].id, toAccountId: active[1].id, categoryId: null,
          note: "Top up", hints: ["low_confidence", ...(needTime ? ["time_assumed"] : [])],
        });
      }
      const created = rows.map((fields) => {
        const row: DraftRowMock = { id: uid(), sourceName: String(a.sourceName).trim() || "Pasted image", createdAt: now(), fields };
        drafts.push(row);
        return presentDraft(row);
      });
      return created as T;
    }
    case "list_import_drafts":
      return drafts.map(presentDraft) as T;
    case "update_import_draft": {
      const row = findDraft(a.id);
      const f: DraftFields = { ...a.fields };
      f.kind = String(f.kind).trim().toLowerCase() as DraftFields["kind"];
      if (!["expense", "income", "transfer"].includes(f.kind)) fail("ValidationError", "Kind must be expense, income or transfer");
      f.date = normalizeOptional(f.date, /^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
      if (f.date && !isRealDate(f.date)) fail("ValidationError", "Date must be YYYY-MM-DD");
      f.time = normalizeOptional(f.time, /^\d{2}:\d{2}$/, "Time must be in HH:MM 24-hour format");
      if (f.time && !isHHMM(f.time)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
      f.note = (f.note ?? "").trim() || null;
      // A category of the old kind can never be posted under the new one.
      if (row.fields.kind !== f.kind) f.categoryId = null;
      if (f.kind === "transfer") f.categoryId = null;
      else f.toAccountId = null;
      f.hints = [];
      row.fields = f;
      return presentDraft(row) as T;
    }
    case "discard_import_drafts": {
      const ids = [...new Set(a.ids as string[])];
      for (const id of ids) findDraft(id);
      for (const id of ids) {
        const i = drafts.findIndex((d) => d.id === id);
        if (i >= 0) drafts.splice(i, 1);
      }
      return undefined as T;
    }
    case "confirm_import_drafts": {
      let confirmed = 0;
      const failed: { id: string; message: string }[] = [];
      for (const id of a.ids as string[]) {
        try {
          const row = findDraft(id);
          if (draftProblems(row.fields).length > 0) fail("ValidationError", "Fix the highlighted fields first.");
          const f = row.fields;
          if (f.kind === "transfer") {
            // Moving money to a credit card or BNPL is posted as a payment.
            const dest = accounts.find((x) => x.id === f.toAccountId);
            const post = dest && isPaymentDestination(dest.subtype) ? addPayment : addTransfer;
            post({ fromAccountId: f.accountId, toAccountId: f.toAccountId, amountCents: f.amountCents, description: f.note, date: f.date, time: f.time });
          } else {
            addIncomeOrExpense(f.kind, { accountId: f.accountId, categoryId: f.categoryId, amountCents: f.amountCents, description: f.note, date: f.date, time: f.time, excludedFromReporting: false, splits: null });
          }
          drafts.splice(drafts.indexOf(row), 1);
          confirmed += 1;
        } catch (e) {
          failed.push({ id, message: (e as { message?: string })?.message ?? "Could not post this draft." });
        }
      }
      return { confirmed, failed } as T;
    }
    case "get_ai_settings":
      return aiSettings() as T;
    case "set_ai_settings": {
      const url = String(a.input.baseUrl).trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\//.test(url)) fail("ValidationError", "The base URL must start with http:// or https://");
      settings.set("ai_base_url", url);
      settings.set("ai_model", String(a.input.model).trim());
      if (a.input.apiKey != null) settings.set("ai_api_key", String(a.input.apiKey).trim());
      return aiSettings() as T;
    }
    case "test_ai_connection": {
      if (!settings.get("ai_base_url") || !settings.get("ai_model")) {
        fail("ai_not_configured", "Set the AI base URL and model in Settings first.");
      }
      return undefined as T;
    }
    case "get_setting":
      if (String(a.key).trim() === "ai_api_key") fail("ValidationError", "That setting is write-only.");
      return (settings.get(String(a.key)) ?? null) as T;
    case "set_setting": {
      if (!String(a.key).trim()) fail("ValidationError", "Key cannot be empty");
      settings.set(String(a.key), String(a.value));
      return undefined as T;
    }
    case "get_plan":
      return getPlan(String(a.month)) as T;
    case "set_budgets":
      setBudgets((a.items as BudgetWrite[] | undefined) ?? []);
      return undefined as T;
    case "create_goal": {
      const input = a.input as GoalWrite;
      const name = prepareGoal(input, null);
      const row: GoalRecord = {
        id: uid(),
        name,
        accountId: input.accountId,
        targetCents: input.targetCents,
        targetDate: input.targetDate ?? null,
      };
      goals.push(row);
      return toPlanGoal(row) as T;
    }
    case "update_goal": {
      const input = a.input as GoalWrite;
      const id = input.id ?? "";
      const row = goals.find((g) => g.id === id) ?? fail("NotFound", "Goal not found");
      const name = prepareGoal(input, id);
      row.name = name;
      row.accountId = input.accountId;
      row.targetCents = input.targetCents;
      row.targetDate = input.targetDate ?? null;
      return toPlanGoal(row) as T;
    }
    case "delete_goal": {
      const i = goals.findIndex((g) => g.id === a.id);
      if (i < 0) fail("NotFound", "Goal not found");
      goals.splice(i, 1);
      return undefined as T;
    }
    case "reset_app": {
      accounts.length = 0;
      txns.length = 0;
      allocs.length = 0;
      settings.clear();
      budgetVersions.length = 0;
      goals.length = 0;
      schedules.length = 0;
      occurrences.length = 0;
      drafts.length = 0;
      passFailures.clear();
      seedCategories();
      return undefined as T;
    }
    case "list_schedules":
      return listScheduleRows() as T;
    case "create_schedule":
      return createSchedule(a.input) as T;
    case "update_schedule":
      return updateSchedule(a.id, a.input) as T;
    case "delete_schedule":
      deleteSchedule(a.id);
      return undefined as T;
    case "list_upcoming":
      return upcomingRows() as T;
    case "post_occurrence":
      return postOccurrence(a.scheduleId, a.date, a.amountCents) as T;
    case "skip_occurrence":
      skipOccurrence(a.scheduleId, a.date);
      return undefined as T;
    case "run_schedule_pass":
      return runPass() as T;
    default:
      return fail("DatabaseError", `Unknown command: ${command}`) as T;
  }
}
