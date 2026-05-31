// Typed client layer. React calls these functions instead of invoking Tauri
// commands directly. Each wrapper maps 1:1 to a backend command. When running
// outside Tauri (plain `npm run dev` in a browser), calls are served by an
// in-memory mock so the UI is fully explorable without the desktop shell.

import type {
  Account,
  AccountBalance,
  AccountSubtype,
  AccountTemplate,
  Category,
  CategoryKind,
  DashboardSummary,
  Transaction,
  TransactionFilters,
  UpdateTransactionInput,
} from "../types";
import { dispatch } from "./invoke";

export const client = {
  // Accounts
  listAccountTemplates: () => dispatch<AccountTemplate[]>("list_account_templates"),
  listAccountSubtypes: () => dispatch<AccountSubtype[]>("list_account_subtypes"),
  createAccount: (name: string, subtype: string, openingBalanceCents: number, templateKey: string | null) =>
    dispatch<Account>("create_account", { name, subtype, openingBalanceCents, templateKey }),
  listAccounts: (includeArchived = false) =>
    dispatch<Account[]>("list_accounts", { includeArchived }),
  updateAccount: (input: { id: string; name?: string; subtype?: string; openingBalanceCents?: number }) =>
    dispatch<Account>("update_account", { input }),
  archiveAccount: (id: string) => dispatch<Account>("archive_account", { id }),
  restoreAccount: (id: string) => dispatch<Account>("restore_account", { id }),
  setAccountBalance: (accountId: string, realBalanceCents: number) =>
    dispatch<Account>("set_account_balance", { accountId, realBalanceCents }),

  // Categories
  listCategories: (kind?: CategoryKind, includeArchived = false) => dispatch<Category[]>("list_categories", { kind: kind ?? null, includeArchived }),
  createCategory: (name: string, kind: CategoryKind, emoji: string, color?: string, parentId?: string | null) =>
    dispatch<Category>("create_category", { name, kind, emoji, color: color ?? null, parentId: parentId ?? null }),
  updateCategory: (input: { id: string; name?: string; emoji?: string; color?: string; sortOrder?: number }) =>
    dispatch<Category>("update_category", { input }),
  archiveCategory: (id: string) => dispatch<Category>("archive_category", { id }),
  restoreCategory: (id: string) => dispatch<Category>("restore_category", { id }),
  deleteCategory: (id: string) => dispatch<void>("delete_category", { id }),
  reorderCategories: (ids: string[]) => dispatch<void>("reorder_categories", { ids }),
  setCategoryParent: (id: string, parentId: string | null) =>
    dispatch<Category>("set_category_parent", { id, parentId }),
  setCategoriesArchived: (ids: string[], archived: boolean) =>
    dispatch<void>("set_categories_archived", { ids, archived }),

  // Transactions
  createIncome: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string) =>
    dispatch<Transaction>("create_income_transaction", { accountId, categoryId, amountCents, description, date }),
  createExpense: (accountId: string, categoryId: string, amountCents: number, description: string | null, date: string) =>
    dispatch<Transaction>("create_expense_transaction", { accountId, categoryId, amountCents, description, date }),
  createTransfer: (fromAccountId: string, toAccountId: string, amountCents: number, description: string | null, date: string) =>
    dispatch<Transaction>("create_transfer_transaction", { fromAccountId, toAccountId, amountCents, description, date }),
  listTransactions: (filters?: TransactionFilters) =>
    dispatch<Transaction[]>("list_transactions", { filters: filters ?? null }),
  updateTransaction: (input: UpdateTransactionInput) => dispatch<Transaction>("update_transaction", { input }),
  deleteTransaction: (id: string) => dispatch<void>("delete_transaction", { id }),

  // Dashboard
  getDashboardSummary: (month: string) => dispatch<DashboardSummary>("get_dashboard_summary", { month }),
  getAccountBalances: () => dispatch<AccountBalance[]>("get_account_balances"),
  getAccountBalance: (accountId: string) => dispatch<number>("get_account_balance", { accountId }),

  // Settings
  getSetting: (key: string) => dispatch<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => dispatch<void>("set_setting", { key, value }),
  resetApp: () => dispatch<void>("reset_app"),
};
