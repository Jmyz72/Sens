// Shared frontend types mirroring the Rust command request/response shapes.
// All money is integer MYR cents. Field names are camelCase to match the
// backend's serde(rename_all = "camelCase").

export type TransactionKind = "income" | "expense" | "transfer" | "adjustment" | "opening" | "payment" | "reimbursement";
export type CategoryKind = "income" | "expense" | "transfer";
export type AccountGroup = "own" | "owe";
export type AccountTypeName = "fund" | "financial" | "receivable" | "payable" | "credit";

export interface AccountSubtype {
  key: string;
  label: string;
  type: AccountTypeName;
  group: AccountGroup;
  sortOrder: number;
  isActive: boolean;
}

export interface AccountTemplate {
  key: string;
  name: string;
  groupName: string;
  defaultSubtype: string;
  iconAsset: string;
  brandColor: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface Account {
  id: string;
  templateKey: string | null;
  name: string;
  accountType: AccountTypeName;
  group: AccountGroup;
  subtype: string;
  openingBalanceCents: number;
  creditLimitCents: number | null;
  currency: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  balanceCents: number;
}

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  emoji: string;
  color: string | null;
  parentId: string | null;
  sortOrder: number;
  isArchived: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TxnSplit {
  categoryId: string;
  amountCents: number;
}

export interface TxnAllocation {
  expenseId: string;
  amountCents: number;
}

export interface AwaitingReimbursement {
  count: number;
  totalCents: number;
}

export interface Transaction {
  id: string;
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  amountCents: number;
  description: string | null;
  transactionDate: string;
  transactionTime: string | null;
  excludedFromReporting: boolean;
  splits: TxnSplit[];
  /** Expenses only: the amount expected back, or null. */
  expectedReimbursementCents: number | null;
  /** Expenses only: sum of this expense's allocations. */
  reimbursedCents: number;
  /** Reimbursements only: the expenses this row repays. */
  allocations: TxnAllocation[];
  createdAt: string;
  updatedAt: string;
}

export interface TransactionFilters {
  accountId?: string;
  categoryId?: string;
  kind?: TransactionKind;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateTransactionInput {
  id: string;
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  amountCents: number;
  description: string | null;
  transactionDate: string;
  transactionTime: string | null;
  excludedFromReporting: boolean;
  splits?: TxnSplit[] | null;
}

export interface CategoryBreakdown {
  categoryId: string;
  categoryName: string;
  emoji: string;
  color: string | null;
  totalCents: number;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  accountType: AccountTypeName;
  group: AccountGroup;
  balanceCents: number;
}

export interface DashboardSummary {
  month: string;
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  incomeCents: number;
  expenseCents: number;
  netCashflowCents: number;
  spendingBreakdown: CategoryBreakdown[];
  accountBalances: AccountBalance[];
  recentTransactions: Transaction[];
}

export interface BudgetWrite {
  categoryId: string;
  amountCents: number | null;
}

export interface GoalWrite {
  id?: string | null;
  name: string;
  accountId: string;
  targetCents: number;
  targetDate: string | null;
}

export interface PlanBudget {
  categoryId: string;
  parentId: string | null;
  name: string;
  emoji: string;
  sortOrder: number;
  isArchived: boolean;
  amountCents: number;
  spentCents: number;
}

export interface PlanGoal {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  balanceCents: number;
  targetCents: number;
  targetDate: string | null;
  monthlyCents: number | null;
}

export interface Plan {
  month: string;
  budgets: PlanBudget[];
  goals: PlanGoal[];
}

export interface AppError {
  code: "ValidationError" | "NotFound" | "Conflict" | "DatabaseError";
  message: string;
}
