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
import { PROVIDER_GROUPS } from "../lib/providers";
import { postingsFor } from "../lib/kinds";

const fail = (code: string, message: string): never => {
  throw { code, message };
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ── taxonomy ──
const SUBTYPE_ROWS: [string, string, AccountTypeName, AccountGroup][] = [
  ["cash","Cash","fund","own"],["ewallet","E-wallet","fund","own"],
  ["savings","Savings account","fund","own"],["current","Current / Checking","fund","own"],
  ["fixed-deposit","Fixed deposit","financial","own"],["investment","Investment / Brokerage","financial","own"],
  ["unit-trust","Unit trust / ASNB","financial","own"],["crypto","Crypto","financial","own"],
  ["lent","Lent to someone (IOU)","receivable","own"],["borrowed","Borrowed from someone","payable","owe"],
  ["credit-card","Credit card","credit","owe"],["bnpl","BNPL","credit","owe"],
  ["personal-loan","Personal loan","credit","owe"],["mortgage","Mortgage","credit","owe"],
  ["car-loan","Car / Hire-purchase loan","credit","owe"],["other-debt","Other debt","credit","owe"],
];
const SUBTYPES: AccountSubtype[] = SUBTYPE_ROWS.map(([key, label, type, group], i) => ({
  key, label, type, group, sortOrder: i, isActive: true,
}));
const subtypeOf = (key: string) => SUBTYPES.find((s) => s.key === key);

// ── seed templates (mirrors src/lib/providers.ts → Rust seed) ──
const templates: AccountTemplate[] = [];
PROVIDER_GROUPS.forEach(({ group, defaultSubtype, providers }) =>
  providers.forEach(([key, name]) =>
    templates.push({
      key, name, groupName: group, defaultSubtype,
      iconAsset: key, brandColor: null, sortOrder: templates.length, isActive: true,
    }),
  ),
);

// Mirrors src-tauri/src/db/seed.rs CATEGORIES (append-only; no renames/removals
// across versions). Saving/investing, loans/debt, reimbursements and credit-card
// payments are deliberately NOT categories — dedicated features handle them.
const CAT_SEED: [string, Category["kind"], string, string][] = [
  ["Salary", "income", "💰", "#46d39a"], ["Bonus", "income", "🎉", "#3fcf8e"], ["Freelance", "income", "💻", "#5aa66d"], ["Business", "income", "🏪", "#4bd699"], ["Rental Income", "income", "🏘️", "#5bddaa"], ["Government & Aid", "income", "🏛️", "#37c886"], ["Cashback & Rewards", "income", "🪙", "#66b079"], ["Gift", "income", "🎁", "#56b3c4"], ["Other Income", "income", "➕", "#7bbf8f"],
  ["Food", "expense", "🍔", "#e0a13c"], ["Groceries", "expense", "🛒", "#5aa66d"], ["Transport", "expense", "🚗", "#8b7bd8"], ["Bills", "expense", "🧾", "#56b3c4"], ["Family & Dependents", "expense", "👪", "#e08a5c"], ["Kids", "expense", "🧸", "#f0a868"], ["Insurance & Protection", "expense", "🛡️", "#e96680"], ["Health", "expense", "🏥", "#f0708c"], ["Personal Care", "expense", "💈", "#d98fb0"], ["Shopping", "expense", "🛍️", "#d9728f"], ["Home & Living", "expense", "🏡", "#c98a6a"], ["Entertainment", "expense", "🎬", "#a78bfa"], ["Education", "expense", "📚", "#5b8def"], ["Travel", "expense", "✈️", "#33c9d6"], ["Donations & Religious", "expense", "🙏", "#b39bd8"], ["Government & Fees", "expense", "🏛️", "#7a93c4"], ["Pets", "expense", "🐾", "#9ab06a"], ["Fees & Charges", "expense", "💳", "#9aa4b2"], ["Other Expense", "expense", "💸", "#9aa4b2"],
  ["Transfer", "transfer", "🔄", "#9aa4b2"],
];
const SUB_SEED: [string, Category["kind"], string, string, string][] = [
  ["Food", "expense", "Dining out", "🍽️", "#e0a13c"], ["Food", "expense", "Mamak/Kopitiam", "🍜", "#dba24a"], ["Food", "expense", "Coffee", "☕", "#c08a4a"], ["Food", "expense", "Bubble tea/Drinks", "🧋", "#e0b060"], ["Food", "expense", "Delivery/Takeaway", "🛵", "#d99a3c"], ["Food", "expense", "Snacks", "🍪", "#e3b15c"],
  ["Groceries", "expense", "Supermarket", "🛒", "#5aa66d"], ["Groceries", "expense", "Wet market", "🐟", "#6cb47d"], ["Groceries", "expense", "Convenience store", "🏪", "#4f9862"],
  ["Transport", "expense", "Fuel", "⛽", "#8b7bd8"], ["Transport", "expense", "TnG/Toll reload", "🛣️", "#9a8be0"], ["Transport", "expense", "Parking & Tolls", "🅿️", "#9a8be0"], ["Transport", "expense", "Ride-hailing", "🚕", "#7d6dd0"], ["Transport", "expense", "Public transit", "🚇", "#a89bea"], ["Transport", "expense", "Car maintenance", "🔧", "#6f5fc0"],
  ["Bills", "expense", "Rent", "🏠", "#56b3c4"], ["Bills", "expense", "Electricity", "💡", "#5fbecf"], ["Bills", "expense", "Water", "🚿", "#4aa6b8"], ["Bills", "expense", "Internet", "📶", "#63c5d6"], ["Bills", "expense", "Mobile", "📱", "#52aebf"], ["Bills", "expense", "Astro/TV", "📡", "#4f9fb0"], ["Bills", "expense", "Subscriptions", "📺", "#48a2b4"],
  ["Family & Dependents", "expense", "Parents' allowance", "👴", "#e08a5c"], ["Family & Dependents", "expense", "Childcare/Nursery", "👶", "#e6976c"], ["Family & Dependents", "expense", "School fees", "🏫", "#da7f50"], ["Family & Dependents", "expense", "Maid/Helper", "🧹", "#eba074"], ["Family & Dependents", "expense", "Pocket money", "💵", "#d97848"],
  ["Kids", "expense", "Diapers/Milk", "🍼", "#f0a868"], ["Kids", "expense", "Toys", "🧸", "#f3b67e"], ["Kids", "expense", "Activities/Classes", "⚽", "#ed9a54"], ["Kids", "expense", "School supplies", "✏️", "#f5be8c"],
  ["Insurance & Protection", "expense", "Life/Medical", "🏥", "#e96680"], ["Insurance & Protection", "expense", "Car (Takaful)", "🚗", "#ee7891"], ["Insurance & Protection", "expense", "Home", "🏠", "#e35a76"], ["Insurance & Protection", "expense", "Travel", "✈️", "#f0859b"],
  ["Health", "expense", "Pharmacy", "💊", "#f0708c"], ["Health", "expense", "Clinic/Doctor", "🩺", "#f37e98"], ["Health", "expense", "Dental", "🦷", "#ee6a87"], ["Health", "expense", "Optical", "👓", "#f58aa2"], ["Health", "expense", "Mental health", "🧠", "#f0738e"], ["Health", "expense", "Fitness", "🏋️", "#f58aa2"],
  ["Personal Care", "expense", "Haircut/Salon", "💇", "#d98fb0"], ["Personal Care", "expense", "Skincare/Cosmetics", "💄", "#e09cbb"], ["Personal Care", "expense", "Spa/Grooming", "💆", "#d385a8"], ["Personal Care", "expense", "Laundry", "🧺", "#e6a8c4"],
  ["Shopping", "expense", "Clothing", "👗", "#d9728f"], ["Shopping", "expense", "Electronics", "🔌", "#e07f9a"], ["Shopping", "expense", "Home", "🛋️", "#cf6685"], ["Shopping", "expense", "Gifts", "🎁", "#e58aa3"],
  ["Home & Living", "expense", "Furniture", "🛋️", "#c98a6a"], ["Home & Living", "expense", "Appliances", "🔌", "#d1977a"], ["Home & Living", "expense", "Repairs/Maintenance", "🔧", "#c08160"], ["Home & Living", "expense", "Cleaning supplies", "🧼", "#d9a288"], ["Home & Living", "expense", "Renovation", "🛠️", "#b87a58"],
  ["Entertainment", "expense", "Movies", "🎬", "#a78bfa"], ["Entertainment", "expense", "Games", "🎮", "#b39bfb"], ["Entertainment", "expense", "Events", "🎟️", "#9b7df9"], ["Entertainment", "expense", "Hobbies", "🎨", "#bfa9fc"],
  ["Education", "expense", "Courses", "🎓", "#5b8def"], ["Education", "expense", "Books", "📖", "#6b97f1"], ["Education", "expense", "Tuition", "🧑", "#4f83ed"],
  ["Travel", "expense", "Flights", "✈️", "#33c9d6"], ["Travel", "expense", "Accommodation", "🏨", "#45d0dc"], ["Travel", "expense", "Activities", "🏝️", "#28bdca"],
  ["Donations & Religious", "expense", "Zakat", "🕌", "#b39bd8"], ["Donations & Religious", "expense", "Tithe/Offering", "⛪", "#bda8e0"], ["Donations & Religious", "expense", "Sedekah/Charity", "🤲", "#a78ed0"], ["Donations & Religious", "expense", "Temple/Church", "🛕", "#c7b3e8"],
  ["Government & Fees", "expense", "Road tax", "🚗", "#7a93c4"], ["Government & Fees", "expense", "Saman/Summons", "🚨", "#8aa0cc"], ["Government & Fees", "expense", "JPJ/Immigration", "🛂", "#6f88bc"], ["Government & Fees", "expense", "Passport/Visa", "📘", "#97aad4"],
  ["Pets", "expense", "Food", "🦴", "#9ab06a"], ["Pets", "expense", "Vet", "🐶", "#a8bb7c"], ["Pets", "expense", "Grooming", "✂️", "#8da55e"], ["Pets", "expense", "Supplies", "🐾", "#b3c48e"],
  ["Fees & Charges", "expense", "Bank charges", "🏦", "#9aa4b2"], ["Fees & Charges", "expense", "ATM/transfer fees", "🏧", "#a6afbc"], ["Fees & Charges", "expense", "Late fees", "⏰", "#8e99a8"], ["Fees & Charges", "expense", "Service charge", "🧾", "#b2bac6"],
  ["Salary", "income", "Base pay", "💵", "#46d39a"], ["Salary", "income", "Overtime", "⏰", "#52d8a2"], ["Salary", "income", "Allowances", "🧾", "#3fcf8e"], ["Salary", "income", "Commission", "📊", "#5bddaa"],
  ["Bonus", "income", "Annual bonus", "🎊", "#3fcf8e"], ["Bonus", "income", "Performance", "⭐", "#52d8a2"], ["Bonus", "income", "Festive/THR", "🧧", "#5bddaa"],
  ["Freelance", "income", "Projects", "💻", "#5aa66d"], ["Freelance", "income", "Consulting", "💼", "#66b079"],
  ["Business", "income", "Sales", "💵", "#4bd699"], ["Business", "income", "Side hustle", "🛠️", "#5bddaa"], ["Business", "income", "Online/Dropship", "📦", "#3fcf8e"],
  ["Rental Income", "income", "Property rent", "🏠", "#5bddaa"], ["Rental Income", "income", "Room rent", "🛏️", "#66e0b4"], ["Rental Income", "income", "Asset rent", "🚗", "#4fd6a4"],
  ["Government & Aid", "income", "STR/BR1M", "🤲", "#37c886"], ["Government & Aid", "income", "Tax refund (LHDN)", "🧾", "#46d39a"], ["Government & Aid", "income", "Subsidies", "🎫", "#2fbf71"],
  ["Cashback & Rewards", "income", "Card cashback", "💳", "#66b079"], ["Cashback & Rewards", "income", "e-Wallet rewards", "📲", "#73bb8a"], ["Cashback & Rewards", "income", "Points redeemed", "🎁", "#5aa66d"],
  ["Gift", "income", "Cash gift", "💵", "#56b3c4"], ["Gift", "income", "Angpow/Duit raya", "🧧", "#63c0cf"],
  ["Transfer", "transfer", "Own accounts", "🔄", "#9aa4b2"], ["Transfer", "transfer", "Savings transfer", "💰", "#a6afbc"],
];

const categories: Category[] = [];

function seedCategories() {
  categories.length = 0;
  CAT_SEED.forEach(([name, kind, emoji, color], i) => {
    categories.push({ id: uid(), name, kind, emoji, color, parentId: null, sortOrder: i, isArchived: false, createdAt: now(), updatedAt: now() });
  });
  const subSortByParent: Record<string, number> = {};
  SUB_SEED.forEach(([parentName, kind, childName, emoji, color]) => {
    const parent = categories.find((c) => c.name === parentName && c.kind === kind && c.parentId == null);
    if (parent) {
      const sort = subSortByParent[parent.id] ?? 0;
      subSortByParent[parent.id] = sort + 1;
      categories.push({ id: uid(), name: childName, kind, emoji, color, parentId: parent.id, sortOrder: sort, isArchived: false, createdAt: now(), updatedAt: now() });
    }
  });
}
seedCategories();

const accounts: Account[] = [];
const txns: Transaction[] = [];
const settings = new Map<string, string>();

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
    txns.push({ id: uid(), kind: "opening", accountId: id, toAccountId: null, categoryId: null, amountCents: opening, description: "Opening balance", transactionDate: "2026-01-01", createdAt: now(), updatedAt: now(), excludedFromReporting: false });
  };
  mk("maybank", "Maybank Savings", 842000);
  mk("tng-ewallet", "Touch 'n Go", 12750);
  mk("stashaway", "StashAway", 1860000);
  const cat = (n: string) => categories.find((c) => c.name === n)!.id;
  const add = (kind: Transaction["kind"], acc: number, amt: number, catName: string | null, desc: string, date: string, to?: number) =>
    txns.push({ id: uid(), kind, accountId: accounts[acc].id, toAccountId: to != null ? accounts[to].id : null, categoryId: catName ? cat(catName) : null, amountCents: amt, description: desc, transactionDate: date, createdAt: now(), updatedAt: now(), excludedFromReporting: false });
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
      txns.push({ id: uid(), kind: "opening", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: a.openingBalanceCents, description: "Opening balance", transactionDate: today(), createdAt: now(), updatedAt: now(), excludedFromReporting: false });
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
      if (!hasActivity(acc.id)) {
        const op = txns.find((t) => t.kind === "opening" && t.accountId === acc.id);
        if (op) op.amountCents = a.realBalanceCents;
      } else {
        const diff = a.realBalanceCents - balanceOf(acc);
        if (diff !== 0) txns.unshift({ id: uid(), kind: "adjustment", accountId: acc.id, toAccountId: null, categoryId: null, amountCents: diff, description: "Balance adjustment", transactionDate: today(), createdAt: now(), updatedAt: now(), excludedFromReporting: false });
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
      const cat: Category = { id: uid(), name, kind, emoji: a.emoji, color: a.color ?? null, parentId: a.parentId ?? null, sortOrder: 100, isArchived: false, createdAt: now(), updatedAt: now() };
      categories.push(cat);
      return cat as T;
    }
    case "archive_category":
    case "restore_category": {
      const c = categories.find((x) => x.id === a.id) ?? fail("NotFound", "Category not found");
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
      if (categories.some((x) => x.parentId === c.id)) fail("Conflict", "Remove or move its subcategories first");
      if (txns.some((t) => t.categoryId === c.id)) fail("Conflict", "In use by transactions — archive it instead");
      categories.splice(categories.indexOf(c), 1);
      return undefined as T;
    }
    case "reorder_categories": {
      (a.ids as string[]).forEach((id, i) => {
        const c = categories.find((x) => x.id === id);
        if (c) { c.sortOrder = i; c.updatedAt = now(); }
      });
      return undefined as T;
    }
    case "set_categories_archived": {
      const archiving = a.archived === true;
      (a.ids as string[]).forEach((id) => {
        const c = categories.find((x) => x.id === id);
        if (!c) return;
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
      const pid: string | null = a.parentId ?? null;
      if (pid != null) {
        if (pid === cat.id) fail("ValidationError", "A category cannot be its own parent");
        const parent = categories.find((x) => x.id === pid) ?? fail("NotFound", "Category not found");
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
      const tx: Transaction = { id: uid(), kind, accountId: a.accountId, toAccountId: null, categoryId: a.categoryId, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now(), excludedFromReporting: !!a.excludedFromReporting };
      txns.unshift(tx);
      return tx as T;
    }
    case "create_transfer_transaction": {
      if (a.amountCents <= 0) fail("ValidationError", "Amount must be greater than zero");
      if (a.fromAccountId === a.toAccountId) fail("ValidationError", "Cannot transfer to the same account");
      const tx: Transaction = { id: uid(), kind: "transfer", accountId: a.fromAccountId, toAccountId: a.toAccountId, categoryId: null, amountCents: a.amountCents, description: a.description, transactionDate: a.date, createdAt: now(), updatedAt: now(), excludedFromReporting: false };
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
      if (txns[i].kind === "opening" || a.input.kind === "opening") fail("ValidationError", "The opening balance can't be edited here; change it from the account's opening balance field");
      if (txns[i].kind === "adjustment" || a.input.kind === "adjustment") fail("ValidationError", "Adjustments cannot be edited; delete it and reconcile again");
      const excluded = (a.input.kind === "income" || a.input.kind === "expense") && !!a.input.excludedFromReporting;
      txns[i] = { ...txns[i], ...a.input, excludedFromReporting: excluded, updatedAt: now() };
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
      const byCat = new Map<string, number>();
      txns.filter((t) => t.kind === "expense" && !t.excludedFromReporting && inRange(t)).forEach((t) => {
        const pid = parentOf(t.categoryId!);
        byCat.set(pid, (byCat.get(pid) ?? 0) + t.amountCents);
      });
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
