//! Domain types shared across repository, service, and command layers.
//!
//! All money is integer MYR cents. Structs serialize to camelCase for the
//! TypeScript client.

use serde::{Deserialize, Serialize};

/// Transaction kind. `transfer`, `payment`, `reimbursement`, and `adjustment` are
/// excluded from income / expense / cashflow aggregates (see the dashboard rules
/// in the spec). A reimbursement instead reduces the expenses it repays.
pub const KIND_INCOME: &str = "income";
pub const KIND_EXPENSE: &str = "expense";
pub const KIND_TRANSFER: &str = "transfer";
pub const KIND_ADJUSTMENT: &str = "adjustment";
pub const KIND_OPENING: &str = "opening";
pub const KIND_PAYMENT: &str = "payment";
pub const KIND_REIMBURSEMENT: &str = "reimbursement";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSubtype {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub group: String,
    pub sort_order: i64,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTemplate {
    pub key: String,
    pub name: String,
    pub group_name: String,
    pub default_subtype: String,
    pub icon_asset: String,
    pub brand_color: Option<String>,
    pub sort_order: i64,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub template_key: Option<String>,
    pub name: String,
    pub account_type: String, // derived type: fund|financial|receivable|payable|credit
    pub group: String,        // derived: own|owe
    pub subtype: String,
    pub opening_balance_cents: i64,
    pub credit_limit_cents: Option<i64>,
    pub gain_category_id: Option<String>,
    pub loss_category_id: Option<String>,
    pub currency: String,
    pub is_archived: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Computed: opening balance + signed transaction history.
    pub balance_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub emoji: String,
    pub color: Option<String>,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub is_archived: bool,
    pub is_system: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnSplit {
    pub category_id: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    pub category_id: String,
    pub amount_cents: i64,
}

/// One link between a reimbursement and an expense it repays. Used both as a
/// command input and as the serialized shape on `Transaction.allocations`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub expense_id: String,
    pub amount_cents: i64,
}

/// Dashboard tile: expenses whose expected reimbursement is not yet received.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingReimbursement {
    pub count: i64,
    pub total_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub kind: String,
    pub account_id: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub amount_cents: i64,
    pub description: Option<String>,
    pub transaction_date: String,
    pub transaction_time: Option<String>,
    pub excluded_from_reporting: bool,
    #[serde(default)]
    pub splits: Vec<TxnSplit>,
    /// Expenses only: the amount the user expects to get back. NULL when none.
    pub expected_reimbursement_cents: Option<i64>,
    /// Expenses only: sum of this expense's allocations.
    pub reimbursed_cents: i64,
    /// Reimbursements only: the expenses this row repays.
    pub allocations: Vec<Allocation>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Command inputs ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCategories {
    pub gain_category_id: Option<String>,
    pub loss_category_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccountInput {
    pub id: String,
    pub name: Option<String>,
    pub subtype: Option<String>,
    pub opening_balance_cents: Option<i64>,
    #[serde(default)]
    pub credit_limit_cents: Option<i64>,
    #[serde(default)]
    pub value_categories: Option<ValueCategories>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryInput {
    pub id: String,
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub color: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionFilters {
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub kind: Option<String>,
    pub from_date: Option<String>,
    pub to_date: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTransactionInput {
    pub id: String,
    pub kind: String,
    pub account_id: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub amount_cents: i64,
    pub description: Option<String>,
    pub transaction_date: String,
    pub transaction_time: Option<String>,
    #[serde(default)]
    pub excluded_from_reporting: bool,
    #[serde(default)]
    pub splits: Option<Vec<SplitInput>>,
}

// ── Plan (budgets & goals) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetWrite {
    pub category_id: String,
    pub amount_cents: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalWrite {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub account_id: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBudget {
    pub category_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub emoji: String,
    pub sort_order: i64,
    pub is_archived: bool,
    pub amount_cents: i64,
    pub spent_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGoal {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub account_name: String,
    pub balance_cents: i64,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub monthly_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub month: String,
    pub budgets: Vec<PlanBudget>,
    pub goals: Vec<PlanGoal>,
}

// ── Dashboard ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryBreakdown {
    pub category_id: String,
    pub category_name: String,
    pub emoji: String,
    pub color: Option<String>,
    pub total_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub account_id: String,
    pub name: String,
    pub account_type: String,
    pub group: String,
    pub balance_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub month: String,
    pub net_worth_cents: i64,
    pub assets_cents: i64,
    pub liabilities_cents: i64,
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cashflow_cents: i64,
    pub spending_breakdown: Vec<CategoryBreakdown>,
    pub account_balances: Vec<AccountBalance>,
    pub recent_transactions: Vec<Transaction>,
}
