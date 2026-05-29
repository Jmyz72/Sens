// Typed client layer. React calls these functions instead of invoking Tauri
// commands directly. Each wrapper maps 1:1 to a backend command. When running
// outside Tauri (plain `npm run dev` in a browser), calls are served by an
// in-memory mock so the UI is fully explorable without the desktop shell.

import type {
  Account,
  AccountBalance,
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
  createAccountFromTemplate: (templateKey: string, name: string, openingBalanceCents: number) =>
    dispatch<Account>("create_account_from_template", { templateKey, name, openingBalanceCents }),
  createCustomAccount: (name: string, accountType: string, subtype: string, openingBalanceCents: number) =>
    dispatch<Account>("create_custom_account", { name, accountType, subtype, openingBalanceCents }),
  listAccounts: (includeArchived = false) =>
    dispatch<Account[]>("list_accounts", { includeArchived }),
  updateAccount: (input: { id: string; name?: string; subtype?: string; openingBalanceCents?: number }) =>
    dispatch<Account>("update_account", { input }),
  archiveAccount: (id: string) => dispatch<Account>("archive_account", { id }),
  restoreAccount: (id: string) => dispatch<Account>("restore_account", { id }),
  setAccountBalance: (accountId: string, realBalanceCents: number) =>
    dispatch<Account>("set_account_balance", { accountId, realBalanceCents }),

  // Categories
  listCategories: (kind?: CategoryKind) => dispatch<Category[]>("list_categories", { kind: kind ?? null }),
  createCategory: (name: string, kind: CategoryKind, emoji: string, color?: string) =>
    dispatch<Category>("create_category", { name, kind, emoji, color: color ?? null }),
  archiveCategory: (id: string) => dispatch<Category>("archive_category", { id }),
  restoreCategory: (id: string) => dispatch<Category>("restore_category", { id }),

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
};
