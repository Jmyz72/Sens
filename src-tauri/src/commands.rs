//! Tauri command layer: the boundary between React and Rust. Commands are
//! action-oriented, hold no SQL or UI logic, lock the shared connection, and
//! delegate to the service layer.

use crate::error::AppResult;
use crate::mcp::{self, McpHandle};
use crate::models::*;
use crate::schedules;
use crate::service;
use crate::DbState;
use tauri::State;

fn local_now() -> chrono::NaiveDateTime {
    chrono::Local::now().naive_local()
}

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
    credit_limit_cents: Option<i64>,
    gain_category_id: Option<String>,
    loss_category_id: Option<String>,
) -> AppResult<Account> {
    with_conn!(state, c => service::create_account(&c, &name, &subtype, opening_balance_cents, template_key.as_deref(), credit_limit_cents, gain_category_id.as_deref(), loss_category_id.as_deref()))
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
pub fn set_account_balance(state: State<'_, DbState>, account_id: String, real_balance_cents: i64, record_as_income_expense: bool) -> AppResult<Account> {
    with_conn!(state, c => service::set_account_balance(&c, &account_id, real_balance_cents, record_as_income_expense))
}

#[tauri::command]
pub fn update_net_worth(
    state: State<'_, DbState>,
    account_id: String,
    balance_cents: i64,
    category_id: Option<String>,
    time: Option<String>,
) -> AppResult<Account> {
    with_conn!(state, c => service::update_net_worth(
        &c, &account_id, balance_cents, category_id.as_deref(), time.as_deref()
    ))
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
pub fn create_income_transaction(state: State<'_, DbState>, account_id: String, category_id: Option<String>, amount_cents: i64, description: Option<String>, date: String, time: Option<String>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_income(&c, &account_id, category_id.as_deref(), amount_cents, description.as_deref(), &date, time.as_deref(), excluded_from_reporting, splits))
}

#[tauri::command]
pub fn create_expense_transaction(state: State<'_, DbState>, account_id: String, category_id: Option<String>, amount_cents: i64, description: Option<String>, date: String, time: Option<String>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_expense(&c, &account_id, category_id.as_deref(), amount_cents, description.as_deref(), &date, time.as_deref(), excluded_from_reporting, splits))
}

#[tauri::command]
pub fn create_transfer_transaction(state: State<'_, DbState>, from_account_id: String, to_account_id: String, amount_cents: i64, description: Option<String>, date: String, time: Option<String>) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_transfer(&c, &from_account_id, &to_account_id, amount_cents, description.as_deref(), &date, time.as_deref()))
}

#[tauri::command]
pub fn create_payment_transaction(
    state: State<'_, DbState>,
    from_account_id: String,
    to_account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_payment(
        &c, &from_account_id, &to_account_id, amount_cents, description.as_deref(), &date, time.as_deref()
    ))
}

#[tauri::command]
pub fn create_reimbursement_transaction(
    state: State<'_, DbState>,
    account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::create_reimbursement(
        &c, &account_id, amount_cents, description.as_deref(), &date, time.as_deref(), allocations
    ))
}

#[tauri::command]
pub fn update_reimbursement_transaction(
    state: State<'_, DbState>,
    id: String,
    account_id: String,
    amount_cents: i64,
    description: Option<String>,
    date: String,
    time: Option<String>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::update_reimbursement(
        &c, &id, &account_id, amount_cents, description.as_deref(), &date, time.as_deref(), allocations
    ))
}

#[tauri::command]
pub fn set_expected_reimbursement(
    state: State<'_, DbState>,
    expense_id: String,
    expected_cents: Option<i64>,
) -> AppResult<Transaction> {
    with_conn!(state, c => service::set_expected_reimbursement(&c, &expense_id, expected_cents))
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

/// The generic settings commands must not reach the MCP keys (token hash,
/// enabled flag, port); the Assistant card commands own them.
fn reject_mcp_key(key: &str) -> AppResult<()> {
    if key.trim().starts_with("mcp_") {
        return Err(crate::error::AppError::Validation("That setting is managed by the Assistant card.".into()));
    }
    Ok(())
}

#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> AppResult<Option<String>> {
    reject_mcp_key(&key)?;
    with_conn!(state, c => service::get_setting(&c, &key))
}

#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> AppResult<()> {
    reject_mcp_key(&key)?;
    with_conn!(state, c => service::set_setting(&c, &key, &value))
}

#[tauri::command]
pub fn reset_app(app: tauri::AppHandle, mcp: State<'_, McpHandle>) -> AppResult<()> {
    // Also drops the MCP token and stops the server (settings are wiped).
    mcp.reset(&app).map(|_| ())
}

// ── MCP assistant ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_mcp_status(app: tauri::AppHandle, mcp: State<'_, McpHandle>) -> McpStatus {
    mcp.get_status(&app)
}

#[tauri::command]
pub fn set_mcp_enabled(
    app: tauri::AppHandle,
    mcp: State<'_, McpHandle>,
    enabled: bool,
    port: Option<u16>,
) -> AppResult<McpStatus> {
    mcp.set_enabled(&app, enabled, port)
}

/// Returns the plaintext token once; only its hash is stored.
#[tauri::command]
pub fn rotate_mcp_token(app: tauri::AppHandle, mcp: State<'_, McpHandle>) -> AppResult<String> {
    mcp.rotate(&app)
}

#[tauri::command]
pub fn list_mcp_audit(state: State<'_, DbState>, limit: Option<i64>) -> AppResult<Vec<McpAuditEntry>> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    with_conn!(state, c => mcp::audit::list(&c, limit))
}

// ── Schedules ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_schedule(state: State<'_, DbState>, input: ScheduleWrite) -> AppResult<Schedule> {
    with_conn!(state, c => schedules::create_schedule(&c, input, local_now()))
}

#[tauri::command]
pub fn update_schedule(state: State<'_, DbState>, id: String, input: ScheduleWrite) -> AppResult<Schedule> {
    with_conn!(state, c => schedules::update_schedule(&c, &id, input, local_now()))
}

#[tauri::command]
pub fn delete_schedule(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => schedules::delete_schedule(&c, &id))
}

#[tauri::command]
pub fn list_schedules(state: State<'_, DbState>) -> AppResult<Vec<Schedule>> {
    with_conn!(state, c => schedules::list_schedules(&c, local_now()))
}

#[tauri::command]
pub fn list_upcoming(state: State<'_, DbState>) -> AppResult<Vec<UpcomingOccurrence>> {
    with_conn!(state, c => schedules::list_upcoming(&c, local_now()))
}

#[tauri::command]
pub fn post_occurrence(
    state: State<'_, DbState>,
    schedule_id: String,
    date: String,
    amount_cents: i64,
) -> AppResult<Transaction> {
    with_conn!(state, c => schedules::post_occurrence(&c, &schedule_id, &date, amount_cents, local_now()))
}

#[tauri::command]
pub fn skip_occurrence(state: State<'_, DbState>, schedule_id: String, date: String) -> AppResult<()> {
    with_conn!(state, c => schedules::skip_occurrence(&c, &schedule_id, &date, local_now()))
}

#[tauri::command]
pub fn run_schedule_pass(state: State<'_, DbState>) -> AppResult<SchedulePass> {
    with_conn!(state, c => schedules::run_pass(&c, local_now()))
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

#[tauri::command]
pub fn get_awaiting_reimbursement(state: State<'_, DbState>) -> AppResult<AwaitingReimbursement> {
    with_conn!(state, c => service::get_awaiting_reimbursement(&c))
}

// ── Plan (budgets & goals) ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_plan(state: State<'_, DbState>, month: String) -> AppResult<Plan> {
    with_conn!(state, c => service::get_plan(&c, &month))
}

#[tauri::command]
pub fn set_budgets(state: State<'_, DbState>, items: Vec<BudgetWrite>) -> AppResult<()> {
    with_conn!(state, c => service::set_budgets(&c, &items))
}

#[tauri::command]
pub fn create_goal(state: State<'_, DbState>, input: GoalWrite) -> AppResult<PlanGoal> {
    with_conn!(state, c => service::create_goal(&c, input))
}

#[tauri::command]
pub fn update_goal(state: State<'_, DbState>, input: GoalWrite) -> AppResult<PlanGoal> {
    with_conn!(state, c => service::update_goal(&c, input))
}

#[tauri::command]
pub fn delete_goal(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => service::delete_goal(&c, &id))
}

// ── Photo import ─────────────────────────────────────────────────────────────

/// Receives the image as a raw IPC body (not a JSON number array) and returns
/// the recognised text. OCR is blocking, so it runs off the async threads.
#[tauri::command]
pub async fn ocr_image(request: tauri::ipc::Request<'_>) -> AppResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(crate::error::AppError::Validation("Expected raw image bytes".into()));
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize(&bytes))
        .await
        .map_err(|e| crate::error::AppError::Ai("ocr_unavailable", e.to_string()))?
}

/// Ask the model for transactions in `text` and store them as drafts. The
/// database lock is never held across the network call.
#[tauri::command]
pub async fn extract_drafts(state: State<'_, DbState>, source_name: String, text: String) -> AppResult<ExtractResult> {
    let (providers, ctx, today) = with_conn!(state, c => crate::drafts::prepare(&c))?;
    let messages = crate::ai::build_messages(&text, &ctx, &today);
    let out = crate::ai::extract_with_fallback(&providers, messages).await?;
    let drafts = with_conn!(state, c => crate::drafts::store_drafts(&c, &source_name, &out.rows, &crate::today()))?;
    Ok(ExtractResult { drafts, provider: out.provider, skipped: out.skipped })
}

#[tauri::command]
pub fn list_import_drafts(state: State<'_, DbState>) -> AppResult<Vec<ImportDraft>> {
    with_conn!(state, c => crate::drafts::list_drafts(&c))
}

#[tauri::command]
pub fn update_import_draft(state: State<'_, DbState>, id: String, fields: DraftFields) -> AppResult<ImportDraft> {
    with_conn!(state, c => crate::drafts::update_draft(&c, &id, fields))
}

#[tauri::command]
pub fn discard_import_drafts(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<()> {
    with_conn!(state, c => crate::drafts::discard_drafts(&c, &ids))
}

#[tauri::command]
pub fn confirm_import_drafts(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<ConfirmResult> {
    with_conn!(state, c => crate::drafts::confirm_drafts(&c, &ids))
}

#[tauri::command]
pub fn list_ai_providers(state: State<'_, DbState>) -> AppResult<Vec<AiProvider>> {
    with_conn!(state, c => crate::drafts::list_ai_providers(&c))
}

#[tauri::command]
pub fn create_ai_provider(state: State<'_, DbState>, input: AiProviderInput) -> AppResult<AiProvider> {
    with_conn!(state, c => crate::drafts::create_ai_provider(&c, input))
}

#[tauri::command]
pub fn update_ai_provider(state: State<'_, DbState>, id: String, input: AiProviderInput) -> AppResult<AiProvider> {
    with_conn!(state, c => crate::drafts::update_ai_provider(&c, &id, input))
}

#[tauri::command]
pub fn set_ai_provider_enabled(state: State<'_, DbState>, id: String, enabled: bool) -> AppResult<AiProvider> {
    with_conn!(state, c => crate::drafts::set_ai_provider_enabled(&c, &id, enabled))
}

#[tauri::command]
pub fn delete_ai_provider(state: State<'_, DbState>, id: String) -> AppResult<()> {
    with_conn!(state, c => crate::drafts::delete_ai_provider(&c, &id))
}

#[tauri::command]
pub fn reorder_ai_providers(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<()> {
    with_conn!(state, c => crate::drafts::reorder_ai_providers(&c, &ids))
}

/// Tests one provider, without fallback and whether or not it is enabled.
#[tauri::command]
pub async fn test_ai_provider(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let named = with_conn!(state, c => crate::drafts::provider_config(&c, &id))?;
    crate::ai::test_connection(&named.cfg).await
}

#[cfg(test)]
mod tests {
    use super::reject_mcp_key;
    use crate::error::AppError;

    #[test]
    fn generic_settings_commands_reject_mcp_keys() {
        // get_setting and set_setting both call reject_mcp_key first.
        for key in ["mcp_token_hash", "mcp_enabled", "mcp_port", " mcp_port"] {
            match reject_mcp_key(key) {
                Err(AppError::Validation(m)) => assert_eq!(m, "That setting is managed by the Assistant card."),
                other => panic!("{key}: expected Validation, got {other:?}"),
            }
        }
        assert!(reject_mcp_key("transaction_time_enabled").is_ok());
        assert!(reject_mcp_key("theme").is_ok());
    }
}
