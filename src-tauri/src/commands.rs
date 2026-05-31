//! Tauri command layer: the boundary between React and Rust. Commands are
//! action-oriented, hold no SQL or UI logic, lock the shared connection, and
//! delegate to the service layer.

use crate::error::AppResult;
use crate::models::*;
use crate::service;
use crate::DbState;
use tauri::State;

macro_rules! with_conn {
    ($state:expr, $conn:ident => $body:expr) => {{
        let $conn = $state
            .0
            .lock()
            .map_err(|_| crate::error::AppError::Database("Database lock poisoned".into()))?;
        $body
    }};
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_account_templates(state: State<'_, DbState>) -> AppResult<Vec<AccountTemplate>> {
    with_conn!(state, c => service::list_account_templates(&c))
}

#[tauri::command]
pub fn list_account_subtypes(state: State<'_, DbState>) -> AppResult<Vec<AccountSubtype>> {
    with_conn!(state, c => service::list_account_subtypes(&c))
}

#[tauri::command]
pub fn create_account(
    state: State<'_, DbState>,
    name: String,
    subtype: String,
    opening_balance_cents: i64,
    template_key: Option<String>,
) -> AppResult<Account> {
    with_conn!(state, c => service::create_account(&c, &name, &subtype, opening_balance_cents, template_key.as_deref()))
}

#[tauri::command]
pub fn list_accounts(state: State<'_, DbState>, include_archived: bool) -> AppResult<Vec<Account>> {
    with_conn!(state, c => service::list_accounts(&c, include_archived))
}

#[tauri::command]
pub fn update_account(state: State<'_, DbState>, input: UpdateAccountInput) -> AppResult<Account> {
    with_conn!(state, c => service::update_account(&c, input))
}

#[tauri::command]
pub fn archive_account(state: State<'_, DbState>, id: String) -> AppResult<Account> {
    with_conn!(state, c => service::archive_account(&c, &id))
}

#[tauri::command]
pub fn restore_account(state: State<'_, DbState>, id: String) -> AppResult<Account> {
    with_conn!(state, c => service::restore_account(&c, &id))
}

#[tauri::command]
pub fn set_account_balance(state: State<'_, DbState>, account_id: String, real_balance_cents: i64) -> AppResult<Account> {
    with_conn!(state, c => service::set_account_balance(&c, &account_id, real_balance_cents))
}

// ── Categories ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_categories(state: State<'_, DbState>, kind: Option<String>, include_archived: bool) -> AppResult<Vec<Category>> {
    with_conn!(state, c => service::list_categories(&c, kind.as_deref(), include_archived))
}

#[tauri::command]
pub fn create_category(state: State<'_, DbState>, name: String, kind: String, emoji: String, color: Option<String>, parent_id: Option<String>) -> AppResult<Category> {
    with_conn!(state, c => service::create_category(&c, &name, &kind, &emoji, color.as_deref(), parent_id.as_deref()))
}

#[tauri::command]
pub fn update_category(state: State<'_, DbState>, input: UpdateCategoryInput) -> AppResult<Category> {
    with_conn!(state, c => service::update_category(&c, input))
}

#[tauri::command]
pub fn archive_category(state: State<'_, DbState>, id: String) -> AppResult<Category> {
    with_conn!(state, c => service::archive_category(&c, &id))
}

#[tauri::command]
pub fn restore_category(state: State<'_, DbState>, id: String) -> AppResult<Category> {
    with_conn!(state, c => service::restore_category(&c, &id))
}

#[tauri::command]
pub fn delete_category(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => service::delete_category(&c, &id))
}

#[tauri::command]
pub fn reorder_categories(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<()> {
    with_conn!(state, c => service::reorder_categories(&c, &ids))
}

#[tauri::command]
pub fn set_category_parent(state: State<'_, DbState>, id: String, parent_id: Option<String>) -> AppResult<Category> {
    with_conn!(state, c => service::set_category_parent(&c, &id, parent_id.as_deref()))
}

#[tauri::command]
pub fn set_categories_archived(state: State<'_, DbState>, ids: Vec<String>, archived: bool) -> AppResult<()> {
    with_conn!(state, c => service::set_categories_archived(&c, &ids, archived))
}

// ── Transactions ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_income_transaction(state: State<'_, DbState>, account_id: String, category_id: String, amount_cents: i64, description: Option<String>, date: String, excluded_from_reporting: bool) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_income(&c, &account_id, &category_id, amount_cents, description.as_deref(), &date, excluded_from_reporting))
}

#[tauri::command]
pub fn create_expense_transaction(state: State<'_, DbState>, account_id: String, category_id: String, amount_cents: i64, description: Option<String>, date: String, excluded_from_reporting: bool) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_expense(&c, &account_id, &category_id, amount_cents, description.as_deref(), &date, excluded_from_reporting))
}

#[tauri::command]
pub fn create_transfer_transaction(state: State<'_, DbState>, from_account_id: String, to_account_id: String, amount_cents: i64, description: Option<String>, date: String) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_transfer(&c, &from_account_id, &to_account_id, amount_cents, description.as_deref(), &date))
}

#[tauri::command]
pub fn list_transactions(state: State<'_, DbState>, filters: Option<TransactionFilters>) -> AppResult<Vec<Transaction>> {
    with_conn!(state, c => service::list_transactions(&c, filters.unwrap_or_default()))
}

#[tauri::command]
pub fn update_transaction(state: State<'_, DbState>, input: UpdateTransactionInput) -> AppResult<Transaction> {
    with_conn!(state, c => service::update_transaction(&c, input))
}

#[tauri::command]
pub fn delete_transaction(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => service::delete_transaction(&c, &id))
}

// ── App Settings ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> AppResult<Option<String>> {
    with_conn!(state, c => service::get_setting(&c, &key))
}

#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> AppResult<()> {
    with_conn!(state, c => service::set_setting(&c, &key, &value))
}

#[tauri::command]
pub fn reset_app(state: State<'_, DbState>) -> AppResult<()> {
    with_conn!(state, c => service::reset_app(&c))
}

// ── Dashboard ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_dashboard_summary(state: State<'_, DbState>, month: String) -> AppResult<DashboardSummary> {
    with_conn!(state, c => service::get_dashboard_summary(&c, &month))
}

#[tauri::command]
pub fn get_account_balance(state: State<'_, DbState>, account_id: String) -> AppResult<i64> {
    with_conn!(state, c => service::get_account_balance(&c, &account_id))
}

#[tauri::command]
pub fn get_account_balances(state: State<'_, DbState>) -> AppResult<Vec<AccountBalance>> {
    with_conn!(state, c => service::get_account_balances(&c))
}
