//! Service layer: business rules and data correctness. Validates inputs,
//! enforces MYR-only and archived-account rules, validates subtypes against
//! the `account_subtypes` taxonomy, runs balance correction, and assembles
//! dashboard summaries.

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::{now, repo};
use rusqlite::Connection;

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn require_nonempty(label: &str, s: &str) -> AppResult<String> {
    let t = s.trim();
    if t.is_empty() {
        return Err(AppError::Validation(format!("{label} cannot be empty")));
    }
    Ok(t.to_string())
}

fn ensure_active_account(conn: &Connection, id: &str, role: &str) -> AppResult<()> {
    let a = repo::get_account(conn, id)?;
    if a.is_archived {
        return Err(AppError::Conflict(format!("The {role} account is archived")));
    }
    Ok(())
}

// ── Accounts ─────────────────────────────────────────────────────────────────

pub fn list_account_templates(conn: &Connection) -> AppResult<Vec<AccountTemplate>> {
    repo::list_templates(conn)
}

pub fn list_account_subtypes(conn: &Connection) -> AppResult<Vec<AccountSubtype>> {
    repo::list_account_subtypes(conn)
}

pub fn create_account(
    conn: &Connection,
    name: &str,
    subtype: &str,
    opening_balance_cents: i64,
    template_key: Option<&str>,
) -> AppResult<Account> {
    let name = require_nonempty("Account name", name)?;
    let subtype = require_nonempty("Subtype", subtype)?;
    if !repo::subtype_exists(conn, &subtype)? {
        return Err(AppError::Validation(format!("Invalid subtype: {subtype}")));
    }
    if let Some(key) = template_key {
        repo::get_template(conn, key)?; // existence (NotFound if bogus)
    }
    repo::insert_account(conn, &new_id(), template_key, &name, &subtype, opening_balance_cents, &now())
}

pub fn list_accounts(conn: &Connection, include_archived: bool) -> AppResult<Vec<Account>> {
    repo::list_accounts(conn, include_archived)
}

pub fn update_account(conn: &Connection, input: UpdateAccountInput) -> AppResult<Account> {
    repo::get_account(conn, &input.id)?; // existence
    let name = match &input.name {
        Some(n) => Some(require_nonempty("Account name", n)?),
        None => None,
    };
    if let Some(s) = &input.subtype {
        if !repo::subtype_exists(conn, s)? {
            return Err(AppError::Validation(format!("Invalid subtype: {s}")));
        }
    }
    repo::update_account_fields(
        conn,
        &input.id,
        name.as_deref(),
        input.subtype.as_deref(),
        input.opening_balance_cents,
        &now(),
    )
}

pub fn archive_account(conn: &Connection, id: &str) -> AppResult<Account> {
    repo::set_account_archived(conn, id, true, &now())
}

pub fn restore_account(conn: &Connection, id: &str) -> AppResult<Account> {
    repo::set_account_archived(conn, id, false, &now())
}

/// Reconcile an account to a real balance. With no transactions, edit the
/// opening balance; with transactions, insert a signed adjustment for the
/// difference dated today. No-op if already matching.
pub fn set_account_balance(conn: &Connection, account_id: &str, real_balance_cents: i64) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot reconcile an archived account".into()));
    }
    if !repo::account_has_transactions(conn, account_id)? {
        return repo::update_account_fields(conn, account_id, None, None, Some(real_balance_cents), &now());
    }
    let diff = real_balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let today = crate::today();
    repo::insert_transaction(
        conn,
        &new_id(),
        KIND_ADJUSTMENT,
        account_id,
        None,
        None,
        diff,
        Some("Balance adjustment"),
        &today,
        &now(),
    )?;
    repo::get_account(conn, account_id)
}

// ── Categories ───────────────────────────────────────────────────────────────

pub fn list_categories(conn: &Connection, kind: Option<&str>, include_archived: bool) -> AppResult<Vec<Category>> {
    if let Some(k) = kind {
        validate_category_kind(k)?;
    }
    repo::list_categories(conn, kind, include_archived)
}

fn validate_category_kind(kind: &str) -> AppResult<()> {
    match kind {
        KIND_INCOME | KIND_EXPENSE | KIND_TRANSFER => Ok(()),
        _ => Err(AppError::Validation(format!("Invalid category kind: {kind}"))),
    }
}

pub fn create_category(
    conn: &Connection,
    name: &str,
    kind: &str,
    emoji: &str,
    color: Option<&str>,
    parent_id: Option<&str>,
) -> AppResult<Category> {
    let name = require_nonempty("Category name", name)?;
    let emoji = require_nonempty("Emoji", emoji)?;
    // A subcategory inherits its parent's kind; a top-level category validates its own.
    let effective_kind = match parent_id {
        Some(pid) => {
            let parent = repo::get_category(conn, pid)?; // NotFound if bogus
            if parent.parent_id.is_some() {
                return Err(AppError::Validation(
                    "Subcategories can only be nested one level deep".into(),
                ));
            }
            parent.kind
        }
        None => {
            validate_category_kind(kind)?;
            kind.to_string()
        }
    };
    repo::insert_category(conn, &new_id(), &name, &effective_kind, &emoji, color, parent_id, &now())
}

pub fn update_category(conn: &Connection, input: UpdateCategoryInput) -> AppResult<Category> {
    repo::get_category(conn, &input.id)?;
    let name = match &input.name {
        Some(n) => Some(require_nonempty("Category name", n)?),
        None => None,
    };
    repo::update_category_fields(
        conn,
        &input.id,
        name.as_deref(),
        input.emoji.as_deref(),
        input.color.as_deref(),
        input.sort_order,
        &now(),
    )
}

pub fn archive_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    let now = now();
    let updated = repo::set_category_archived(conn, id, true, &now)?;
    if cat.parent_id.is_none() {
        repo::set_children_archived(conn, id, true, &now)?;
    }
    Ok(updated)
}

pub fn restore_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    let now = now();
    let updated = repo::set_category_archived(conn, id, false, &now)?;
    if cat.parent_id.is_none() {
        // v1 simplification: restoring a top-level category un-archives ALL of its
        // children, including any that were archived independently before the parent
        // was. We do not track *why* a child was archived (see the subcategories spec's
        // "Scope Trims"). Acceptable until per-child restore is needed.
        repo::set_children_archived(conn, id, false, &now)?;
    }
    Ok(updated)
}

pub fn delete_category(conn: &Connection, id: &str) -> AppResult<()> {
    repo::get_category(conn, id)?; // NotFound if missing
    if repo::count_children(conn, id)? > 0 {
        return Err(AppError::Conflict("Remove or move its subcategories first".into()));
    }
    if repo::count_transactions_for_category(conn, id)? > 0 {
        return Err(AppError::Conflict("In use by transactions — archive it instead".into()));
    }
    repo::delete_category(conn, id)
}

/// Reparent a category: move a leaf to another top-level parent, promote a
/// subcategory to top-level (parent_id = None), or demote a childless top-level
/// into a subcategory. Kind never changes; the new parent must be top-level and
/// share the moved category's kind.
pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    if let Some(pid) = parent_id {
        if pid == id {
            return Err(AppError::Validation("A category cannot be its own parent".into()));
        }
        let parent = repo::get_category(conn, pid)?; // NotFound if bogus
        if parent.parent_id.is_some() {
            return Err(AppError::Validation("The new parent must be a top-level category".into()));
        }
        if parent.kind != cat.kind {
            return Err(AppError::Validation("Cannot move a category to a different kind".into()));
        }
        // Demoting/moving a top-level that still has children would create a third level.
        if cat.parent_id.is_none() && repo::count_children(conn, id)? > 0 {
            return Err(AppError::Validation("Empty this category's subcategories before making it a subcategory".into()));
        }
    }
    repo::set_category_parent(conn, id, parent_id, &now())
}

/// Bulk archive or restore. Reuses the per-id archive/restore so the top-level
/// child cascade is applied to each. Wrapped in one transaction so a failure
/// partway leaves nothing half-applied (all-or-nothing).
pub fn set_categories_archived(conn: &Connection, ids: &[String], archived: bool) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        if archived {
            archive_category(&tx, id)?;
        } else {
            restore_category(&tx, id)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Assign sort_order = index to each id. Caller (frontend) supplies one full
/// sibling group (same parent + kind); we validate they are genuine siblings,
/// then apply every update in a single transaction (all-or-nothing).
pub fn reorder_categories(conn: &Connection, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let first = repo::get_category(conn, &ids[0])?;
    for id in &ids[1..] {
        let cat = repo::get_category(conn, id)?;
        if cat.kind != first.kind || cat.parent_id != first.parent_id {
            return Err(AppError::Validation("Can only reorder categories within one group".into()));
        }
    }
    let tx = conn.unchecked_transaction()?;
    repo::reorder_categories(&tx, ids, &now())?;
    tx.commit()?;
    Ok(())
}

// ── Transactions ─────────────────────────────────────────────────────────────

/// Validate that a category exists and matches the required kind.
fn validate_category_for(conn: &Connection, category_id: &str, kind: &str) -> AppResult<()> {
    let c = repo::get_category(conn, category_id)?;
    if c.kind != kind {
        return Err(AppError::Validation(format!(
            "Category kind '{}' does not match transaction kind '{}'",
            c.kind, kind
        )));
    }
    Ok(())
}

fn validate_positive(amount_cents: i64) -> AppResult<()> {
    if amount_cents <= 0 {
        return Err(AppError::Validation("Amount must be greater than zero".into()));
    }
    Ok(())
}

pub fn create_income(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_INCOME)?;
    repo::insert_transaction(conn, &new_id(), KIND_INCOME, account_id, None, Some(category_id), amount_cents, description, date, &now())
}

pub fn create_expense(conn: &Connection, account_id: &str, category_id: &str, amount_cents: i64, description: Option<&str>, date: &str) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    validate_category_for(conn, category_id, KIND_EXPENSE)?;
    repo::insert_transaction(conn, &new_id(), KIND_EXPENSE, account_id, None, Some(category_id), amount_cents, description, date, &now())
}

pub fn create_transfer(conn: &Connection, from_account_id: &str, to_account_id: &str, amount_cents: i64, description: Option<&str>, date: &str) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    if from_account_id == to_account_id {
        return Err(AppError::Validation("Cannot transfer to the same account".into()));
    }
    ensure_active_account(conn, from_account_id, "source")?;
    ensure_active_account(conn, to_account_id, "destination")?;
    repo::insert_transaction(conn, &new_id(), KIND_TRANSFER, from_account_id, Some(to_account_id), None, amount_cents, description, date, &now())
}

pub fn list_transactions(conn: &Connection, filters: TransactionFilters) -> AppResult<Vec<Transaction>> {
    repo::list_transactions(conn, &filters)
}

pub fn update_transaction(conn: &Connection, input: UpdateTransactionInput) -> AppResult<Transaction> {
    let existing = repo::get_transaction(conn, &input.id)?;
    // Adjustments are not editable through the normal form and kind cannot be
    // changed into or out of 'adjustment'.
    if existing.kind == KIND_ADJUSTMENT || input.kind == KIND_ADJUSTMENT {
        return Err(AppError::Validation("Adjustments cannot be edited; delete it and reconcile again".into()));
    }
    validate_positive(input.amount_cents)?;
    ensure_active_account(conn, &input.account_id, "selected")?;

    let (to_account_id, category_id) = match input.kind.as_str() {
        KIND_INCOME | KIND_EXPENSE => {
            let cat = input
                .category_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("A category is required".into()))?;
            validate_category_for(conn, cat, &input.kind)?;
            (None, Some(cat.to_string()))
        }
        KIND_TRANSFER => {
            let to = input
                .to_account_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("A destination account is required for transfers".into()))?;
            if to == input.account_id {
                return Err(AppError::Validation("Cannot transfer to the same account".into()));
            }
            ensure_active_account(conn, to, "destination")?;
            (Some(to.to_string()), input.category_id.clone())
        }
        other => return Err(AppError::Validation(format!("Invalid transaction kind: {other}"))),
    };

    repo::update_transaction_row(
        conn,
        &input.id,
        &input.kind,
        &input.account_id,
        to_account_id.as_deref(),
        category_id.as_deref(),
        input.amount_cents,
        input.description.as_deref(),
        &input.transaction_date,
        &now(),
    )
}

pub fn delete_transaction(conn: &Connection, id: &str) -> AppResult<()> {
    repo::delete_transaction(conn, id)
}

// ── App Settings ─────────────────────────────────────────────────────────────

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let key = require_nonempty("Key", key)?;
    repo::get_setting(conn, &key)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    let key = require_nonempty("Key", key)?;
    repo::set_setting(conn, &key, value, &now())
}

// ── Dashboard ────────────────────────────────────────────────────────────────

pub fn get_account_balance(conn: &Connection, account_id: &str) -> AppResult<i64> {
    Ok(repo::get_account(conn, account_id)?.balance_cents)
}

pub fn get_account_balances(conn: &Connection) -> AppResult<Vec<AccountBalance>> {
    repo::account_balances(conn)
}

/// Build the dashboard summary for a `YYYY-MM` month. Income/expense/cashflow
/// and the spending breakdown exclude transfers and adjustments.
pub fn get_dashboard_summary(conn: &Connection, month: &str) -> AppResult<DashboardSummary> {
    let (from, to) = month_range(month)?;
    let income = repo::sum_kind_in_range(conn, KIND_INCOME, &from, &to)?;
    let expense = repo::sum_kind_in_range(conn, KIND_EXPENSE, &from, &to)?;
    let balances = repo::account_balances(conn)?;
    let assets_cents: i64 = balances.iter().filter(|b| b.group == "own").map(|b| b.balance_cents).sum();
    let liabilities_cents: i64 = balances.iter().filter(|b| b.group == "owe").map(|b| b.balance_cents).sum();
    let net_worth_cents = assets_cents + liabilities_cents;
    Ok(DashboardSummary {
        month: month.to_string(),
        net_worth_cents,
        assets_cents,
        liabilities_cents,
        income_cents: income,
        expense_cents: expense,
        net_cashflow_cents: income - expense,
        spending_breakdown: repo::spending_breakdown(conn, &from, &to)?,
        account_balances: balances,
        recent_transactions: repo::recent_transactions(conn, 8)?,
    })
}

/// Convert `YYYY-MM` to a half-open `[first-of-month, first-of-next-month)` range.
fn month_range(month: &str) -> AppResult<(String, String)> {
    let parts: Vec<&str> = month.split('-').collect();
    if parts.len() != 2 {
        return Err(AppError::Validation("Month must be in YYYY-MM format".into()));
    }
    let year: i32 = parts[0].parse().map_err(|_| AppError::Validation("Invalid year".into()))?;
    let mon: u32 = parts[1].parse().map_err(|_| AppError::Validation("Invalid month".into()))?;
    if !(1..=12).contains(&mon) {
        return Err(AppError::Validation("Month must be 01-12".into()));
    }
    let from = format!("{year:04}-{mon:02}-01");
    let (ny, nm) = if mon == 12 { (year + 1, 1) } else { (year, mon + 1) };
    let to = format!("{ny:04}-{nm:02}-01");
    Ok((from, to))
}
