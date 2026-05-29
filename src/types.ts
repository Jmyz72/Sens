// Shared frontend types mirroring the Rust command request/response shapes.
// All money is integer MYR cents. Field names are camelCase to match the
// backend's serde(rename_all = "camelCase").

export type TransactionKind = "income" | "expense" | "transfer" | "adjustment";
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
  sortOrder: number;
  isSystem: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface AppError {
  code: "ValidationError" | "NotFound" | "Conflict" | "DatabaseError";
  message: string;
}
