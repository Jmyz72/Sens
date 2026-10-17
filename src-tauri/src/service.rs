//! Service layer: business rules and data correctness. Validates inputs,
//! enforces MYR-only and archived-account rules, validates subtypes against
//! the `account_subtypes` taxonomy, runs balance correction, and assembles
//! dashboard summaries.

use std::ops::Deref;

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::{now, repo};
use rusqlite::Connection;

/// One deferred transaction, or a savepoint when the caller already began one.
/// Standalone creates still commit on their own. A schedule post can wrap them
/// so the occurrence, the money, and the link roll back together.
struct WriteTxn<'a> {
    conn: &'a Connection,
    savepoint: bool,
    open: bool,
}

impl<'a> WriteTxn<'a> {
    fn begin(conn: &'a Connection) -> AppResult<Self> {
        if conn.is_autocommit() {
            conn.execute_batch("BEGIN DEFERRED")?;
            Ok(Self { conn, savepoint: false, open: true })
        } else {
            conn.execute_batch("SAVEPOINT sens_posting")?;
            Ok(Self { conn, savepoint: true, open: true })
        }
    }

    fn commit(mut self) -> AppResult<()> {
        if self.savepoint {
            self.conn.execute_batch("RELEASE sens_posting")?;
        } else {
            self.conn.execute_batch("COMMIT")?;
        }
        self.open = false;
        Ok(())
    }
}

impl Drop for WriteTxn<'_> {
    fn drop(&mut self) {
        if !self.open {
            return;
        }
        if self.savepoint {
            let _ = self.conn.execute_batch("ROLLBACK TO sens_posting");
            let _ = self.conn.execute_batch("RELEASE sens_posting");
        } else {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

impl Deref for WriteTxn<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// One balanced posting leg. Exactly one of `account_id` / `system_bucket` is set.
struct Leg {
    account_id: Option<String>,
    system_bucket: Option<&'static str>,
    amount_cents: i64,
}

/// The single canonical sign rule: turn a transaction header into balanced legs.
/// `amount_cents` is positive for income/expense/transfer/reimbursement and
/// already-signed for adjustment/opening. The legs always sum to zero.
fn postings_for(kind: &str, account_id: &str, to_account_id: Option<&str>, amount_cents: i64) -> Vec<Leg> {
    let real = |amt: i64| Leg { account_id: Some(account_id.to_string()), system_bucket: None, amount_cents: amt };
    let bucket = |b: &'static str, amt: i64| Leg { account_id: None, system_bucket: Some(b), amount_cents: amt };
    match kind {
        KIND_INCOME => vec![real(amount_cents), bucket("income", -amount_cents)],
        KIND_EXPENSE => vec![real(-amount_cents), bucket("expense", amount_cents)],
        // Money back for spending: the expense bucket shrinks as the account grows.
        KIND_REIMBURSEMENT => vec![real(amount_cents), bucket("expense", -amount_cents)],
        KIND_TRANSFER | KIND_PAYMENT => vec![
            real(-amount_cents),
            Leg { account_id: to_account_id.map(|s| s.to_string()), system_bucket: None, amount_cents },
        ],
        KIND_ADJUSTMENT | KIND_OPENING => vec![real(amount_cents), bucket("equity", -amount_cents)],
        _ => {
            // All real kinds are handled above; an unknown kind would yield an
            // unbalanced ledger entry. Surface it loudly in dev/tests.
            debug_assert!(false, "postings_for: unhandled transaction kind '{kind}'");
            vec![]
        }
    }
}

/// (Re)write the postings for a transaction from its header. Idempotent: clears
/// any existing postings first, so it is safe on both create and update paths.
fn materialize_postings(conn: &Connection, t: &Transaction) -> AppResult<()> {
    let legs = postings_for(&t.kind, &t.account_id, t.to_account_id.as_deref(), t.amount_cents);
    // Defence in depth: every known kind yields a balanced 2-leg entry. An empty
    // set means an unhandled kind reached here — fail loud (even in release)
    // rather than silently writing an unbalanced ledger.
    if legs.is_empty() {
        return Err(AppError::Validation(format!(
            "Cannot post transaction of kind '{}'",
            t.kind
        )));
    }
    repo::delete_postings_for(conn, &t.id)?;
    for leg in legs {
        repo::insert_posting(conn, &new_id(), &t.id, leg.account_id.as_deref(), leg.system_bucket, leg.amount_cents)?;
    }
    Ok(())
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

/// Reject mutating a protected (system) category.
fn ensure_not_system(conn: &Connection, id: &str) -> AppResult<()> {
    if repo::get_category(conn, id)?.is_system {
        return Err(AppError::Conflict("This is a system category and can't be changed".into()));
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

fn is_credit_limit_subtype(subtype: &str) -> bool {
    subtype == "credit-card" || subtype == "bnpl"
}

fn is_value_subtype(subtype: &str) -> bool {
    matches!(subtype, "fixed-deposit" | "investment" | "unit-trust" | "crypto")
}

fn validate_saved_value_category(conn: &Connection, id: &str, expected_kind: &str, wrong_kind_message: &str) -> AppResult<()> {
    let cat = repo::get_category(conn, id)?;
    if cat.is_system {
        return Err(AppError::Validation("That category can't be selected.".into()));
    }
    if cat.kind != expected_kind {
        return Err(AppError::Validation(wrong_kind_message.into()));
    }
    Ok(())
}

fn resolve_value_categories(
    conn: &Connection,
    subtype: &str,
    incoming: Option<&ValueCategories>,
    existing_gain: Option<String>,
    existing_loss: Option<String>,
) -> AppResult<(Option<String>, Option<String>)> {
    let qualifying = is_value_subtype(subtype);
    match incoming {
        Some(v) if !qualifying && (v.gain_category_id.is_some() || v.loss_category_id.is_some()) => {
            Err(AppError::Validation(
                "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto.".into(),
            ))
        }
        Some(_) if !qualifying => Ok((None, None)),
        Some(v) => {
            if let Some(id) = &v.gain_category_id {
                validate_saved_value_category(conn, id, "income", "Gain category must be an income category.")?;
            }
            if let Some(id) = &v.loss_category_id {
                validate_saved_value_category(conn, id, "expense", "Loss category must be an expense category.")?;
            }
            Ok((v.gain_category_id.clone(), v.loss_category_id.clone()))
        }
        None if !qualifying => Ok((None, None)),
        None => Ok((existing_gain, existing_loss)),
    }
}

fn resolve_credit_limit(subtype: &str, incoming: Option<i64>, existing: Option<i64>) -> AppResult<Option<i64>> {
    if is_credit_limit_subtype(subtype) {
        match incoming {
            Some(n) if n > 0 => Ok(Some(n)),
            Some(_) => Err(AppError::Validation("Credit limit must be greater than zero.".into())),
            None => match existing {
                Some(n) if n > 0 => Ok(Some(n)),
                _ => Err(AppError::Validation("Credit limit is required for this account.".into())),
            },
        }
    } else if incoming.is_some() {
        Err(AppError::Validation("Credit limit only applies to credit cards and BNPL.".into()))
    } else {
        Ok(None)
    }
}

pub fn create_account(
    conn: &Connection,
    name: &str,
    subtype: &str,
    opening_balance_cents: i64,
    template_key: Option<&str>,
    credit_limit_cents: Option<i64>,
    gain_category_id: Option<&str>,
    loss_category_id: Option<&str>,
) -> AppResult<Account> {
    let name = require_nonempty("Account name", name)?;
    let subtype = require_nonempty("Subtype", subtype)?;
    if !repo::subtype_exists(conn, &subtype)? {
        return Err(AppError::Validation(format!("Invalid subtype: {subtype}")));
    }
    if let Some(key) = template_key {
        repo::get_template(conn, key)?; // existence (NotFound if bogus)
    }
    let limit = resolve_credit_limit(&subtype, credit_limit_cents, None)?;
    let (gain_id, loss_id) = resolve_value_categories(
        conn,
        &subtype,
        Some(&ValueCategories {
            gain_category_id: gain_category_id.map(str::to_string),
            loss_category_id: loss_category_id.map(str::to_string),
        }),
        None,
        None,
    )?;
    let account_id = new_id();
    let tx = conn.unchecked_transaction()?;
    repo::insert_account(&tx, &account_id, template_key, &name, &subtype, limit, &now())?;
    repo::set_value_categories(&tx, &account_id, gain_id.as_deref(), loss_id.as_deref(), &now())?;
    let opening = repo::insert_transaction(
        &tx,
        &new_id(),
        KIND_OPENING,
        &account_id,
        None,
        None,
        opening_balance_cents,
        Some("Opening balance"),
        &crate::today(),
        None,
        false,
        &now(),
    )?;
    materialize_postings(&tx, &opening)?;
    tx.commit()?;
    repo::get_account(conn, &account_id)
}

pub fn list_accounts(conn: &Connection, include_archived: bool) -> AppResult<Vec<Account>> {
    repo::list_accounts(conn, include_archived)
}

pub fn get_account(conn: &Connection, id: &str) -> AppResult<Account> {
    repo::get_account(conn, id)
}

pub fn update_account(conn: &Connection, input: UpdateAccountInput) -> AppResult<Account> {
    let existing = repo::get_account(conn, &input.id)?; // existence
    let name = match &input.name {
        Some(n) => Some(require_nonempty("Account name", n)?),
        None => None,
    };
    if let Some(s) = &input.subtype {
        if !repo::subtype_exists(conn, s)? {
            return Err(AppError::Validation(format!("Invalid subtype: {s}")));
        }
    }
    let resulting_subtype = input.subtype.as_deref().unwrap_or(existing.subtype.as_str());
    if !goal_subtype(resulting_subtype) && repo::goal_for_account(conn, &input.id)?.is_some() {
        return Err(AppError::Conflict("Delete this account's goal before changing its type.".into()));
    }
    let limit = resolve_credit_limit(resulting_subtype, input.credit_limit_cents, existing.credit_limit_cents)?;
    let (gain_id, loss_id) = resolve_value_categories(
        conn,
        resulting_subtype,
        input.value_categories.as_ref(),
        existing.gain_category_id.clone(),
        existing.loss_category_id.clone(),
    )?;
    let tx = conn.unchecked_transaction()?;
    repo::update_account_fields(
        &tx,
        &input.id,
        name.as_deref(),
        input.subtype.as_deref(),
        input.opening_balance_cents,
        &now(),
    )?;
    repo::set_credit_limit(&tx, &input.id, limit, &now())?;
    repo::set_value_categories(&tx, &input.id, gain_id.as_deref(), loss_id.as_deref(), &now())?;
    if input.opening_balance_cents.is_some() {
        let opening = repo::get_opening_transaction(&tx, &input.id)?;
        materialize_postings(&tx, &opening)?;
    }
    tx.commit()?;
    repo::get_account(conn, &input.id)
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
pub fn set_account_balance(
    conn: &Connection,
    account_id: &str,
    real_balance_cents: i64,
    record_as_income_expense: bool,
) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot reconcile an archived account".into()));
    }
    if !repo::account_has_nonopening_activity(conn, account_id)? {
        // Only the opening row exists — edit it so the balance equals the target.
        // The income/expense flag has no meaning here (nothing to classify).
        let tx = conn.unchecked_transaction()?;
        repo::set_opening_amount(&tx, account_id, real_balance_cents, &now())?;
        let opening = repo::get_opening_transaction(&tx, account_id)?;
        materialize_postings(&tx, &opening)?;
        tx.commit()?;
        return repo::get_account(conn, account_id);
    }
    let diff = real_balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let today = crate::today();
    let tx = conn.unchecked_transaction()?;
    let txn = if record_as_income_expense {
        // Sign decides: surplus → income, shortfall → expense. Amount is the
        // positive magnitude; the posting engine applies the sign per kind.
        let kind = if diff > 0 { KIND_INCOME } else { KIND_EXPENSE };
        let cat_id = repo::get_system_category_id(&tx, kind)?;
        repo::insert_transaction(
            &tx,
            &new_id(),
            kind,
            account_id,
            None,
            Some(&cat_id),
            diff.abs(),
            Some("Balance adjustment"),
            &today,
            None,
            false,
            &now(),
        )?
    } else {
        repo::insert_transaction(
            &tx,
            &new_id(),
            KIND_ADJUSTMENT,
            account_id,
            None,
            None,
            diff,
            Some("Balance adjustment"),
            &today,
            None,
            false,
            &now(),
        )?
    };
    materialize_postings(&tx, &txn)?;
    tx.commit()?;
    repo::get_account(conn, account_id)
}

pub fn update_net_worth(
    conn: &Connection,
    account_id: &str,
    balance_cents: i64,
    category_id: Option<&str>,
    time: Option<&str>,
) -> AppResult<Account> {
    let acc = repo::get_account(conn, account_id)?;
    if acc.is_archived {
        return Err(AppError::Conflict("Cannot update an archived account".into()));
    }
    if !is_value_subtype(&acc.subtype) {
        return Err(AppError::Validation(
            "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.".into(),
        ));
    }
    if balance_cents < 0 {
        return Err(AppError::Validation("Balance must be zero or more.".into()));
    }
    let diff = balance_cents - acc.balance_cents;
    if diff == 0 {
        return Ok(acc);
    }
    let kind = if diff > 0 { KIND_INCOME } else { KIND_EXPENSE };
    let saved = if diff > 0 { acc.gain_category_id.clone() } else { acc.loss_category_id.clone() };
    let cat = match saved {
        Some(id) => id,
        None => category_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| AppError::Validation("Pick a category for this update.".into()))?,
    };
    if repo::get_category(conn, &cat)?.is_system {
        return Err(AppError::Validation("That category can't be selected.".into()));
    }
    validate_category_for(conn, &cat, kind)?;
    let time = resolve_time(conn, time, None)?;
    let today = crate::today();
    let tx = conn.unchecked_transaction()?;
    let txn = repo::insert_transaction(
        &tx, &new_id(), kind, account_id, None, Some(&cat), diff.abs(),
        Some("Value update"), &today, time.as_deref(), false, &now(),
    )?;
    materialize_postings(&tx, &txn)?;
    tx.commit()?;
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
    ensure_not_system(conn, &input.id)?;
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
    ensure_not_system(conn, id)?;
    let now = now();
    let updated = repo::set_category_archived(conn, id, true, &now)?;
    if cat.parent_id.is_none() {
        repo::set_children_archived(conn, id, true, &now)?;
    }
    Ok(updated)
}

pub fn restore_category(conn: &Connection, id: &str) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    ensure_not_system(conn, id)?;
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
    ensure_not_system(conn, id)?;
    if repo::count_children(conn, id)? > 0 {
        return Err(AppError::Conflict("Remove or move its subcategories first".into()));
    }
    if repo::count_transactions_for_category(conn, id)? > 0 {
        return Err(AppError::Conflict("In use by transactions — archive it instead".into()));
    }
    let tx = conn.unchecked_transaction()?;
    repo::clear_value_category(&tx, id, &now())?;
    repo::delete_category(&tx, id)?;
    tx.commit()?;
    Ok(())
}

/// Reparent a category: move a leaf to another top-level parent, promote a
/// subcategory to top-level (parent_id = None), or demote a childless top-level
/// into a subcategory. Kind never changes; the new parent must be top-level and
/// share the moved category's kind. The parent write and the current-month
/// envelope check commit together; a tree that no longer fits is left unchanged.
pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>) -> AppResult<Category> {
    let cat = repo::get_category(conn, id)?;
    ensure_not_system(conn, id)?;
    if let Some(pid) = parent_id {
        if pid == id {
            return Err(AppError::Validation("A category cannot be its own parent".into()));
        }
        let parent = repo::get_category(conn, pid)?; // NotFound if bogus
        if parent.is_system {
            return Err(AppError::Validation("That category can't be a parent".into()));
        }
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
    let tx = conn.unchecked_transaction()?;
    repo::set_category_parent(&tx, id, parent_id, &now())?;
    let today = crate::today();
    // Any envelope failure becomes the one move Conflict. The original text
    // (including "Set a budget on the parent category first.") must not leak.
    if ensure_envelopes(&tx, &today[..7]).is_err() {
        return Err(AppError::Conflict(
            "This move would leave subcategory budgets that don't fit. Clear or lower them first.".into(),
        ));
    }
    tx.commit()?;
    repo::get_category(conn, id)
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
    ensure_not_system(conn, &ids[0])?;
    for id in &ids[1..] {
        let cat = repo::get_category(conn, id)?;
        ensure_not_system(conn, id)?;
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
    if c.is_system {
        return Err(AppError::Validation("That category can't be selected".into()));
    }
    if c.kind != kind {
        return Err(AppError::Validation(format!(
            "Category kind '{}' does not match transaction kind '{}'",
            c.kind, kind
        )));
    }
    Ok(())
}

/// Validate split lines for an income/expense transaction: >= 2 lines, all
/// positive, summing to `total`, each category valid for `kind` and non-system.
fn validate_splits(conn: &Connection, kind: &str, splits: &[crate::models::SplitInput], total: i64) -> AppResult<()> {
    if splits.len() < 2 {
        return Err(AppError::Validation("A split needs at least two categories".into()));
    }
    let mut sum = 0i64;
    for s in splits {
        if s.amount_cents <= 0 {
            return Err(AppError::Validation("Each split amount must be positive".into()));
        }
        // validate_category_for already rejects system categories and kind mismatches.
        validate_category_for(conn, &s.category_id, kind)?;
        sum += s.amount_cents;
    }
    if sum != total {
        return Err(AppError::Validation("Split amounts must add up to the total".into()));
    }
    Ok(())
}

fn validate_positive(amount_cents: i64) -> AppResult<()> {
    if amount_cents <= 0 {
        return Err(AppError::Validation("Amount must be greater than zero".into()));
    }
    Ok(())
}

const SETTING_TIME_ENABLED: &str = "transaction_time_enabled";

pub(crate) fn time_enabled(conn: &Connection) -> AppResult<bool> {
    Ok(repo::get_setting(conn, SETTING_TIME_ENABLED)?.as_deref() != Some("0"))
}

fn validate_hhmm(s: &str) -> AppResult<()> {
    let bad = || AppError::Validation("Time must be in HH:MM 24-hour format".into());
    let (h, m) = s.split_once(':').ok_or_else(bad)?;
    if h.len() != 2 || m.len() != 2 {
        return Err(bad());
    }
    let h: u32 = h.parse().map_err(|_| bad())?;
    let m: u32 = m.parse().map_err(|_| bad())?;
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok(())
}

/// Resolve the time to persist. When the setting is on, a valid non-empty time
/// is required. When off, `fallback` is used (None on create, the existing value
/// on update) and any supplied time is ignored.
fn resolve_time(conn: &Connection, supplied: Option<&str>, fallback: Option<String>) -> AppResult<Option<String>> {
    if !time_enabled(conn)? {
        return Ok(fallback);
    }
    let t = supplied
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation("A time is required".into()))?;
    validate_hhmm(t)?;
    Ok(Some(t.to_string()))
}

pub fn create_income(conn: &Connection, account_id: &str, category_id: Option<&str>, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    create_income_expense(conn, KIND_INCOME, account_id, category_id, amount_cents, description, date, time, excluded_from_reporting, splits)
}

pub fn create_expense(conn: &Connection, account_id: &str, category_id: Option<&str>, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>, excluded_from_reporting: bool, splits: Option<Vec<crate::models::SplitInput>>) -> AppResult<Transaction> {
    create_income_expense(conn, KIND_EXPENSE, account_id, category_id, amount_cents, description, date, time, excluded_from_reporting, splits)
}

/// Shared create path for income/expense, with optional split lines.
///
/// The `transactions` CHECK requires `category_id IS NOT NULL` for income/expense,
/// so a SPLIT transaction stores its FIRST split line's category as the header.
/// "Is a split" is defined by the presence of split rows, not by a null category.
fn create_income_expense(
    conn: &Connection,
    kind: &'static str,
    account_id: &str,
    category_id: Option<&str>,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
    excluded_from_reporting: bool,
    splits: Option<Vec<crate::models::SplitInput>>,
) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, None)?;
    let tx = WriteTxn::begin(conn)?;

    let is_split = splits.as_ref().is_some_and(|s| !s.is_empty());
    let header_cat: String = if is_split {
        let s = splits.as_ref().unwrap();
        validate_splits(&tx, kind, s, amount_cents)?;
        s[0].category_id.clone()
    } else {
        let cat = category_id.ok_or_else(|| AppError::Validation("A category is required".into()))?;
        validate_category_for(&tx, cat, kind)?;
        cat.to_string()
    };

    let t = repo::insert_transaction(&tx, &new_id(), kind, account_id, None, Some(&header_cat), amount_cents, description, date, time.as_deref(), excluded_from_reporting, &now())?;
    if is_split {
        for (i, line) in splits.as_ref().unwrap().iter().enumerate() {
            repo::insert_split(&tx, &new_id(), &t.id, &line.category_id, line.amount_cents, i as i64, &now())?;
        }
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    // Re-read so the returned Transaction carries hydrated splits.
    repo::get_transaction(conn, &t.id)
}

pub fn create_transfer(conn: &Connection, from_account_id: &str, to_account_id: &str, amount_cents: i64, description: Option<&str>, date: &str, time: Option<&str>) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    if from_account_id == to_account_id {
        return Err(AppError::Validation("Cannot transfer to the same account".into()));
    }
    ensure_active_account(conn, from_account_id, "source")?;
    ensure_active_account(conn, to_account_id, "destination")?;
    let dest = repo::get_account(conn, to_account_id)?;
    if is_payment_destination(&dest.subtype) {
        return Err(AppError::Validation("Pay a credit card or BNPL as a payment.".into()));
    }
    let time = resolve_time(conn, time, None)?;
    let tx = WriteTxn::begin(conn)?;
    let t = repo::insert_transaction(&tx, &new_id(), KIND_TRANSFER, from_account_id, Some(to_account_id), None, amount_cents, description, date, time.as_deref(), false, &now())?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}

pub(crate) fn is_payment_destination(subtype: &str) -> bool {
    subtype == "credit-card" || subtype == "bnpl"
}

fn is_payment_source(subtype: &str) -> bool {
    matches!(subtype, "cash" | "ewallet" | "savings" | "current")
}

pub fn create_payment(
    conn: &Connection,
    from_account_id: &str,
    to_account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    if from_account_id == to_account_id {
        return Err(AppError::Validation("Cannot pay the same account.".into()));
    }
    ensure_active_account(conn, from_account_id, "source")?;
    ensure_active_account(conn, to_account_id, "destination")?;
    let source = repo::get_account(conn, from_account_id)?;
    let dest = repo::get_account(conn, to_account_id)?;
    if !is_payment_destination(&dest.subtype) {
        return Err(AppError::Validation("Payments can only pay a credit card or BNPL.".into()));
    }
    if !is_payment_source(&source.subtype) {
        return Err(AppError::Validation(
            "Payments can only come from cash, an e-wallet, savings, or a current account.".into(),
        ));
    }
    let time = resolve_time(conn, time, None)?;
    let tx = WriteTxn::begin(conn)?;
    let t = repo::insert_transaction(
        &tx, &new_id(), KIND_PAYMENT, from_account_id, Some(to_account_id), None,
        amount_cents, description, date, time.as_deref(), false, &now(),
    )?;
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    Ok(t)
}

/// Validate a reimbursement's allocations against its amount and the expenses
/// they repay. `except_reimbursement_id` is the reimbursement being edited, so
/// its own existing links do not count as already used.
fn validate_allocations(
    conn: &Connection,
    amount_cents: i64,
    allocations: &[Allocation],
    except_reimbursement_id: Option<&str>,
) -> AppResult<()> {
    if allocations.is_empty() {
        return Err(AppError::Validation("Pick at least one expense to reimburse.".into()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut sum = 0i64;
    for a in allocations {
        if a.amount_cents <= 0 {
            return Err(AppError::Validation("Each allocation must be greater than zero.".into()));
        }
        if !seen.insert(a.expense_id.as_str()) {
            return Err(AppError::Validation("An expense can only be listed once.".into()));
        }
        let expense = match repo::get_transaction(conn, &a.expense_id) {
            Ok(t) => t,
            Err(AppError::NotFound(_)) => {
                return Err(AppError::Validation("Only expenses can be reimbursed.".into()))
            }
            Err(other) => return Err(other),
        };
        if !is_plain_expense(conn, &expense)? {
            return Err(AppError::Validation("Only expenses can be reimbursed.".into()));
        }
        let used = repo::allocated_total_for_expense(conn, &a.expense_id, except_reimbursement_id)?;
        // `a.amount_cents` is client-supplied, so compare without adding (no overflow).
        if a.amount_cents > expense.amount_cents.saturating_sub(used) {
            return Err(AppError::Validation("Allocation exceeds what's left on that expense.".into()));
        }
        sum = match sum.checked_add(a.amount_cents) {
            Some(v) => v,
            None => return Err(AppError::Validation("Allocations must add up to the reimbursement amount.".into())),
        };
    }
    if sum != amount_cents {
        return Err(AppError::Validation("Allocations must add up to the reimbursement amount.".into()));
    }
    Ok(())
}

/// An expense that is not a balance correction (those sit in a system category).
fn is_plain_expense(conn: &Connection, t: &Transaction) -> AppResult<bool> {
    if t.kind != KIND_EXPENSE {
        return Ok(false);
    }
    match t.category_id.as_deref() {
        Some(cid) => Ok(!repo::get_category(conn, cid)?.is_system),
        None => Ok(true),
    }
}

pub fn create_reimbursement(
    conn: &Connection,
    account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, None)?;
    let tx = conn.unchecked_transaction()?;
    validate_allocations(&tx, amount_cents, &allocations, None)?;
    let t = repo::insert_transaction(
        &tx, &new_id(), KIND_REIMBURSEMENT, account_id, None, None,
        amount_cents, description, date, time.as_deref(), false, &now(),
    )?;
    for a in &allocations {
        repo::insert_allocation(&tx, &new_id(), &t.id, &a.expense_id, a.amount_cents, &now())?;
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    repo::get_transaction(conn, &t.id)
}

pub fn update_reimbursement(
    conn: &Connection,
    id: &str,
    account_id: &str,
    amount_cents: i64,
    description: Option<&str>,
    date: &str,
    time: Option<&str>,
    allocations: Vec<Allocation>,
) -> AppResult<Transaction> {
    let existing = repo::get_transaction(conn, id)?;
    if existing.kind != KIND_REIMBURSEMENT {
        return Err(AppError::Validation("Only reimbursements can be edited here.".into()));
    }
    validate_positive(amount_cents)?;
    ensure_active_account(conn, account_id, "selected")?;
    let time = resolve_time(conn, time, existing.transaction_time.clone())?;
    let tx = conn.unchecked_transaction()?;
    validate_allocations(&tx, amount_cents, &allocations, Some(id))?;
    let t = repo::update_transaction_row(
        &tx, id, KIND_REIMBURSEMENT, account_id, None, None,
        amount_cents, description, date, time.as_deref(), false, None, &now(),
    )?;
    repo::delete_allocations_for(&tx, id)?;
    for a in &allocations {
        repo::insert_allocation(&tx, &new_id(), id, &a.expense_id, a.amount_cents, &now())?;
    }
    materialize_postings(&tx, &t)?;
    tx.commit()?;
    repo::get_transaction(conn, id)
}

pub fn set_expected_reimbursement(
    conn: &Connection,
    expense_id: &str,
    expected_cents: Option<i64>,
) -> AppResult<Transaction> {
    let expense = repo::get_transaction(conn, expense_id)?;
    if !is_plain_expense(conn, &expense)? {
        return Err(AppError::Validation("Only expenses can expect a reimbursement.".into()));
    }
    if let Some(n) = expected_cents {
        if n <= 0 || n > expense.amount_cents {
            return Err(AppError::Validation(
                "Expected reimbursement must be more than zero and no more than the expense amount.".into(),
            ));
        }
    }
    repo::set_expected_reimbursement(conn, expense_id, expected_cents, &now())?;
    repo::get_transaction(conn, expense_id)
}

pub fn get_awaiting_reimbursement(conn: &Connection) -> AppResult<AwaitingReimbursement> {
    repo::awaiting_reimbursement(conn)
}

pub fn list_transactions(conn: &Connection, filters: TransactionFilters) -> AppResult<Vec<Transaction>> {
    repo::list_transactions(conn, &filters)
}

pub fn update_transaction(conn: &Connection, input: UpdateTransactionInput) -> AppResult<Transaction> {
    let existing = repo::get_transaction(conn, &input.id)?;
    // Adjustments are not editable through the normal form and kind cannot be
    // changed into or out of 'adjustment'.
    if existing.kind == KIND_OPENING || input.kind == KIND_OPENING {
        return Err(AppError::Validation("The opening balance can't be edited here; change it from the account's opening balance field".into()));
    }
    if existing.kind == KIND_ADJUSTMENT || input.kind == KIND_ADJUSTMENT {
        return Err(AppError::Validation("Adjustments cannot be edited; delete it and reconcile again".into()));
    }
    if existing.kind == KIND_REIMBURSEMENT || input.kind == KIND_REIMBURSEMENT {
        return Err(AppError::Validation("Edit a reimbursement from its own form.".into()));
    }
    // Corrections booked as income/expense carry a protected (system) category.
    // They are structural like adjustments — edit by deleting and reconciling.
    if let Some(cid) = existing.category_id.as_deref() {
        if repo::get_category(conn, cid)?.is_system {
            return Err(AppError::Validation("Balance corrections can't be edited; delete it and reconcile again".into()));
        }
    }
    validate_positive(input.amount_cents)?;
    ensure_active_account(conn, &input.account_id, "selected")?;
    // A reimbursed expense stays an expense, and cannot drop below what is already repaid.
    if existing.reimbursed_cents > 0 {
        if input.kind != KIND_EXPENSE {
            return Err(AppError::Conflict(
                "This expense has been reimbursed. Edit or delete the reimbursement first.".into(),
            ));
        }
        if input.amount_cents < existing.reimbursed_cents {
            return Err(AppError::Validation(
                "Amount can't go below what's already been reimbursed.".into(),
            ));
        }
    }

    let (to_account_id, category_id) = match input.kind.as_str() {
        KIND_INCOME | KIND_EXPENSE => match &input.splits {
            Some(s) if !s.is_empty() => {
                validate_splits(conn, &input.kind, s, input.amount_cents)?;
                (None, Some(s[0].category_id.clone())) // header = first split (CHECK needs non-null)
            }
            _ => {
                let cat = input
                    .category_id
                    .as_deref()
                    .ok_or_else(|| AppError::Validation("A category is required".into()))?;
                validate_category_for(conn, cat, &input.kind)?;
                (None, Some(cat.to_string()))
            }
        },
        KIND_TRANSFER => {
            let to = input
                .to_account_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("A destination account is required for transfers".into()))?;
            if to == input.account_id {
                return Err(AppError::Validation("Cannot transfer to the same account".into()));
            }
            ensure_active_account(conn, to, "destination")?;
            let dest = repo::get_account(conn, to)?;
            if is_payment_destination(&dest.subtype) {
                return Err(AppError::Validation("Pay a credit card or BNPL as a payment.".into()));
            }
            (Some(to.to_string()), input.category_id.clone())
        }
        KIND_PAYMENT => {
            if input.splits.as_ref().is_some_and(|s| !s.is_empty()) {
                return Err(AppError::Validation("Payments can't be split.".into()));
            }
            let to = input.to_account_id.as_deref().ok_or_else(|| {
                AppError::Validation("A destination account is required for payments.".into())
            })?;
            if to == input.account_id {
                return Err(AppError::Validation("Cannot pay the same account.".into()));
            }
            ensure_active_account(conn, to, "destination")?;
            let source = repo::get_account(conn, &input.account_id)?;
            let dest = repo::get_account(conn, to)?;
            if !is_payment_destination(&dest.subtype) {
                return Err(AppError::Validation("Payments can only pay a credit card or BNPL.".into()));
            }
            if !is_payment_source(&source.subtype) {
                return Err(AppError::Validation(
                    "Payments can only come from cash, an e-wallet, savings, or a current account.".into(),
                ));
            }
            (Some(to.to_string()), None)
        }
        other => return Err(AppError::Validation(format!("Invalid transaction kind: {other}"))),
    };

    let excluded = matches!(input.kind.as_str(), KIND_INCOME | KIND_EXPENSE) && input.excluded_from_reporting;
    // The expectation survives an expense edit (clamped to the new amount) and is
    // cleared when the row stops being an expense, so the table CHECK still holds.
    let expected = match existing.expected_reimbursement_cents {
        Some(n) if input.kind == KIND_EXPENSE => Some(n.min(input.amount_cents)),
        _ => None,
    };

    let time = resolve_time(conn, input.transaction_time.as_deref(), existing.transaction_time.clone())?;

    let dbtx = conn.unchecked_transaction()?;
    let t = repo::update_transaction_row(
        &dbtx,
        &input.id,
        &input.kind,
        &input.account_id,
        to_account_id.as_deref(),
        category_id.as_deref(),
        input.amount_cents,
        input.description.as_deref(),
        &input.transaction_date,
        time.as_deref(),
        excluded,
        expected,
        &now(),
    )?;
    repo::delete_splits_for(&dbtx, &input.id)?;
    if let Some(s) = &input.splits {
        if !s.is_empty() {
            for (i, line) in s.iter().enumerate() {
                repo::insert_split(&dbtx, &new_id(), &input.id, &line.category_id, line.amount_cents, i as i64, &now())?;
            }
        }
    }
    materialize_postings(&dbtx, &t)?;
    dbtx.commit()?;
    repo::get_transaction(conn, &input.id)
}

pub fn delete_transaction(conn: &Connection, id: &str) -> AppResult<()> {
    let existing = repo::get_transaction(conn, id)?;
    if existing.kind == KIND_OPENING {
        return Err(AppError::Validation("The opening balance can't be deleted".into()));
    }
    if existing.reimbursed_cents > 0 {
        return Err(AppError::Conflict(
            "This expense has been reimbursed. Edit or delete the reimbursement first.".into(),
        ));
    }
    repo::delete_transaction(conn, id)
}

// ── App Settings ─────────────────────────────────────────────────────────────

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let key = require_nonempty("Key", key)?;
    if key == crate::drafts::KEY_API_KEY {
        return Err(AppError::Validation("That setting is write-only.".into()));
    }
    repo::get_setting(conn, &key)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    let key = require_nonempty("Key", key)?;
    repo::set_setting(conn, &key, value, &now())
}

/// Factory reset — wipe user data and restore seeded defaults.
pub fn reset_app(conn: &Connection) -> AppResult<()> {
    crate::db::reset_to_defaults(conn)
}

// ── Dashboard ────────────────────────────────────────────────────────────────

pub fn get_account_balance(conn: &Connection, account_id: &str) -> AppResult<i64> {
    Ok(repo::get_account(conn, account_id)?.balance_cents)
}

pub fn get_account_balances(conn: &Connection) -> AppResult<Vec<AccountBalance>> {
    repo::account_balances(conn)
}

/// Build the dashboard summary for a `YYYY-MM` month. Income/expense/cashflow and the spending breakdown exclude transfers, payments, reimbursements, and adjustments; expenses count net of their reimbursements.
pub fn get_dashboard_summary(conn: &Connection, month: &str) -> AppResult<DashboardSummary> {
    let (from, to) = month_range(month)?;
    let income = repo::sum_kind_in_range(conn, KIND_INCOME, &from, &to)?;
    let expense = repo::sum_expense_net_in_range(conn, &from, &to)?;
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

// ── Budgets ──────────────────────────────────────────────────────────────────

pub fn shift_month(month: &str, delta: i32) -> String {
    let year: i32 = month[..4].parse().unwrap_or(0);
    let mon: i32 = month[5..7].parse().unwrap_or(1);
    let idx = year * 12 + (mon - 1) + delta;
    let y = idx.div_euclid(12);
    let m = idx.rem_euclid(12) + 1;
    format!("{y:04}-{m:02}")
}

pub fn resolve_amount(versions: &[(String, Option<i64>)], month: &str) -> Option<i64> {
    versions
        .iter()
        .filter(|(effective, _)| effective.as_str() <= month)
        .max_by(|a, b| a.0.cmp(&b.0))
        .and_then(|(_, amount)| *amount)
}

pub fn set_budgets(conn: &Connection, items: &[BudgetWrite]) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if !seen.insert(item.category_id.clone()) {
            return Err(AppError::Validation("A category can only be listed once.".into()));
        }
        if let Some(amount) = item.amount_cents {
            if amount < 0 {
                return Err(AppError::Validation("A budget can't be negative.".into()));
            }
        }
        let cat = repo::get_category(conn, &item.category_id)?;
        if item.amount_cents.is_some() {
            if cat.is_system {
                return Err(AppError::Validation("The Adjustment category can't have a budget.".into()));
            }
            if cat.kind != "expense" {
                return Err(AppError::Validation("Income categories can't have a budget.".into()));
            }
            if cat.is_archived {
                let today = crate::today();
                let month = &today[..7];
                let versions = repo::list_budget_versions(conn)?;
                let mine: Vec<_> = versions.into_iter().filter(|v| v.0 == cat.id).map(|v| (v.1, v.2)).collect();
                if resolve_amount(&mine, month).is_none() {
                    return Err(AppError::Conflict("Archived categories can't be given a new budget.".into()));
                }
            }
        }
    }
    let today = crate::today();
    let month = &today[..7];
    let tx = conn.unchecked_transaction()?;
    for item in items {
        repo::upsert_budget(&tx, &new_id(), &item.category_id, month, item.amount_cents, &now())?;
    }
    ensure_envelopes(&tx, month)?;
    tx.commit()?;
    Ok(())
}

/// The current month's resolved tree must be a valid envelope: a subcategory
/// amount requires a parent amount, and the slices cannot sum past the parent.
fn ensure_envelopes(conn: &Connection, month: &str) -> AppResult<()> {
    let categories = repo::list_categories(conn, None, true)?;
    let versions = repo::list_budget_versions(conn)?;
    let mut resolved: std::collections::HashMap<String, Option<i64>> = std::collections::HashMap::new();
    for cat in &categories {
        let mine: Vec<_> = versions
            .iter()
            .filter(|v| v.0 == cat.id)
            .map(|v| (v.1.clone(), v.2))
            .collect();
        resolved.insert(cat.id.clone(), resolve_amount(&mine, month));
    }

    for cat in &categories {
        let Some(parent_id) = cat.parent_id.as_deref() else {
            continue;
        };
        let child_amount = resolved.get(&cat.id).copied().flatten();
        let parent_amount = resolved.get(parent_id).copied().flatten();
        if child_amount.is_some() && parent_amount.is_none() {
            return Err(AppError::Conflict("Set a budget on the parent category first.".into()));
        }
    }

    for parent in &categories {
        let Some(parent_amount) = resolved.get(&parent.id).copied().flatten() else {
            continue;
        };
        let child_sum: i64 = categories
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(parent.id.as_str()))
            .filter_map(|c| resolved.get(&c.id).copied().flatten())
            .sum();
        if child_sum > parent_amount {
            return Err(AppError::Conflict("Subcategory budgets add up to more than the parent.".into()));
        }
    }
    Ok(())
}

/// Budgets for one `YYYY-MM` month. Spent uses the dashboard's category nets:
/// a child is its own net, a parent is its own net plus its children's. Goals
/// are every goal whose account is not archived.
pub fn get_plan(conn: &Connection, month: &str) -> AppResult<Plan> {
    let (from, to) = month_range(month)?;
    let own: std::collections::HashMap<String, i64> =
        repo::category_spend_nets(conn, &from, &to)?.into_iter().collect();
    let categories = repo::list_categories(conn, None, true)?;
    let versions = repo::list_budget_versions(conn)?;

    let mut budgets = Vec::new();
    for cat in &categories {
        let mine: Vec<(String, Option<i64>)> = versions
            .iter()
            .filter(|v| v.0 == cat.id)
            .map(|v| (v.1.clone(), v.2))
            .collect();
        let Some(amount_cents) = resolve_amount(&mine, month) else {
            continue;
        };
        let spent_cents = if cat.parent_id.is_none() {
            let mut spent = own.get(&cat.id).copied().unwrap_or(0);
            for child in &categories {
                if child.parent_id.as_deref() == Some(cat.id.as_str()) {
                    spent += own.get(&child.id).copied().unwrap_or(0);
                }
            }
            spent
        } else {
            own.get(&cat.id).copied().unwrap_or(0)
        };
        budgets.push(PlanBudget {
            category_id: cat.id.clone(),
            parent_id: cat.parent_id.clone(),
            name: cat.name.clone(),
            emoji: cat.emoji.clone(),
            sort_order: cat.sort_order,
            is_archived: cat.is_archived,
            amount_cents,
            spent_cents,
        });
    }
    budgets.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.name.cmp(&b.name)));
    let mut goals = Vec::new();
    for account in repo::list_accounts(conn, true)? {
        if account.is_archived {
            continue;
        }
        if let Some(row) = repo::goal_for_account(conn, &account.id)? {
            goals.push(plan_goal(&account, &row));
        }
    }
    Ok(Plan {
        month: month.to_string(),
        budgets,
        goals,
    })
}

pub fn monthly_required(today: &str, target_date: Option<&str>, balance_cents: i64, target_cents: i64) -> Option<i64> {
    let date = target_date?;
    let gap = target_cents - balance_cents;
    if gap <= 0 || date < today {
        return None;
    }
    let months = months_left(&today[..7], &date[..7]);
    Some((gap + i64::from(months) - 1) / i64::from(months))
}

fn months_left(today_month: &str, target_month: &str) -> i32 {
    let idx = |ym: &str| -> i32 {
        let y: i32 = ym[..4].parse().unwrap_or(0);
        let m: i32 = ym[5..7].parse().unwrap_or(1);
        y * 12 + (m - 1)
    };
    let d = idx(target_month) - idx(today_month);
    if d <= 0 { 1 } else { d }
}

fn goal_subtype(subtype: &str) -> bool {
    matches!(subtype, "cash" | "ewallet" | "savings" | "current")
}

fn plan_goal(account: &Account, row: &repo::GoalRow) -> PlanGoal {
    PlanGoal {
        id: row.id.clone(),
        name: row.name.clone(),
        account_id: row.account_id.clone(),
        account_name: account.name.clone(),
        balance_cents: account.balance_cents,
        target_cents: row.target_cents,
        target_date: row.target_date.clone(),
        monthly_cents: monthly_required(
            &crate::today(),
            row.target_date.as_deref(),
            account.balance_cents,
            row.target_cents,
        ),
    }
}

/// Shared checks for create and update. `current_id` is the goal being edited,
/// so that goal may keep its account. Any other account must be free.
fn prepare_goal(conn: &Connection, input: &GoalWrite, current_id: Option<&str>) -> AppResult<String> {
    let name = require_nonempty("Goal name", &input.name)?;
    if input.target_cents <= 0 {
        return Err(AppError::Validation("Target must be greater than zero.".into()));
    }
    if let Some(date) = &input.target_date {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("Date must be a real YYYY-MM-DD.".into()))?;
    }
    ensure_active_account(conn, &input.account_id, "selected")?;
    let account = repo::get_account(conn, &input.account_id)?;
    if !goal_subtype(&account.subtype) {
        return Err(AppError::Conflict(
            "Goals can only sit on cash, an e-wallet, savings, or a current account.".into(),
        ));
    }
    if let Some(existing) = repo::goal_for_account(conn, &input.account_id)? {
        if current_id != Some(existing.id.as_str()) {
            return Err(AppError::Conflict("This account already has a goal.".into()));
        }
    }
    Ok(name)
}

pub fn create_goal(conn: &Connection, input: GoalWrite) -> AppResult<PlanGoal> {
    let name = prepare_goal(conn, &input, None)?;
    let id = new_id();
    repo::insert_goal(
        conn,
        &id,
        &name,
        &input.account_id,
        input.target_cents,
        input.target_date.as_deref(),
        &now(),
    )?;
    let account = repo::get_account(conn, &input.account_id)?;
    let row = repo::get_goal(conn, &id)?;
    Ok(plan_goal(&account, &row))
}

pub fn update_goal(conn: &Connection, input: GoalWrite) -> AppResult<PlanGoal> {
    let id = input.id.clone().unwrap_or_default();
    repo::get_goal(conn, &id)?;
    let name = prepare_goal(conn, &input, Some(&id))?;
    repo::update_goal(
        conn,
        &id,
        &name,
        &input.account_id,
        input.target_cents,
        input.target_date.as_deref(),
        &now(),
    )?;
    let account = repo::get_account(conn, &input.account_id)?;
    let row = repo::get_goal(conn, &id)?;
    Ok(plan_goal(&account, &row))
}

pub fn delete_goal(conn: &Connection, id: &str) -> AppResult<()> {
    repo::get_goal(conn, id)?;
    repo::delete_goal(conn, id)
}
