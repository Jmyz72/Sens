//! Repository layer: owns all SQL and row→struct mapping. No business
//! decisions beyond database constraints (see the spec's Repository layer).

use crate::error::{AppError, AppResult};
use crate::models::*;
use rusqlite::{params, Connection, Row};
use std::collections::HashMap;

/// SQL expression computing an account's current balance as the sum of its
/// postings. `{a}` is the accounts-table alias. One uniform rule for every kind
/// (replaces the former 6-term per-kind sum over `transactions`).
fn balance_expr(a: &str) -> String {
    format!("COALESCE((SELECT SUM(amount_cents) FROM postings WHERE account_id = {a}.id), 0)")
}

// ── Templates ────────────────────────────────────────────────────────────────

pub fn list_templates(conn: &Connection) -> AppResult<Vec<AccountTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active
         FROM account_templates WHERE is_active = 1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AccountTemplate {
                key: r.get(0)?,
                name: r.get(1)?,
                group_name: r.get(2)?,
                default_subtype: r.get(3)?,
                icon_asset: r.get(4)?,
                brand_color: r.get(5)?,
                sort_order: r.get(6)?,
                is_active: r.get::<_, i64>(7)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_template(conn: &Connection, key: &str) -> AppResult<AccountTemplate> {
    conn.query_row(
        "SELECT key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active
         FROM account_templates WHERE key = ?1",
        [key],
        |r| {
            Ok(AccountTemplate {
                key: r.get(0)?,
                name: r.get(1)?,
                group_name: r.get(2)?,
                default_subtype: r.get(3)?,
                icon_asset: r.get(4)?,
                brand_color: r.get(5)?,
                sort_order: r.get(6)?,
                is_active: r.get::<_, i64>(7)? != 0,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Account template not found".into()),
        other => other.into(),
    })
}

pub fn list_account_subtypes(conn: &Connection) -> AppResult<Vec<AccountSubtype>> {
    let mut stmt = conn.prepare(
        "SELECT key, label, type, account_group, sort_order, is_active
         FROM account_subtypes WHERE is_active = 1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AccountSubtype {
                key: r.get(0)?,
                label: r.get(1)?,
                type_: r.get(2)?,
                group: r.get(3)?,
                sort_order: r.get(4)?,
                is_active: r.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn subtype_exists(conn: &Connection, key: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM account_subtypes WHERE key = ?1)",
        [key],
        |r| r.get(0),
    )?)
}

// ── Accounts ─────────────────────────────────────────────────────────────────

fn map_account(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get("id")?,
        template_key: r.get("template_key")?,
        name: r.get("name")?,
        account_type: r.get("account_type")?, // aliased from s.type
        group: r.get("group")?,               // aliased from s.account_group
        subtype: r.get("subtype")?,
        opening_balance_cents: r.get("opening_balance_cents")?,
        credit_limit_cents: r.get("credit_limit_cents")?,
        gain_category_id: r.get("gain_category_id")?,
        loss_category_id: r.get("loss_category_id")?,
        currency: r.get("currency")?,
        is_archived: r.get::<_, i64>("is_archived")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        balance_cents: r.get("balance_cents")?,
    })
}

pub fn insert_account(
    conn: &Connection,
    id: &str,
    template_key: Option<&str>,
    name: &str,
    subtype: &str,
    credit_limit_cents: Option<i64>,
    now: &str,
) -> AppResult<Account> {
    conn.execute(
        "INSERT INTO accounts
           (id, template_key, name, subtype, currency, is_archived, credit_limit_cents, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'MYR', 0, ?5, ?6, ?6)",
        params![id, template_key, name, subtype, credit_limit_cents, now],
    )?;
    get_account(conn, id)
}

pub fn get_account(conn: &Connection, id: &str) -> AppResult<Account> {
    let sql = format!(
        "SELECT a.*, COALESCE(s.type, 'fund') AS account_type, COALESCE(s.account_group, 'own') AS \"group\", \
         COALESCE((SELECT amount_cents FROM transactions WHERE account_id = a.id AND kind = 'opening' LIMIT 1), 0) AS opening_balance_cents, \
         ({}) AS balance_cents \
         FROM accounts a LEFT JOIN account_subtypes s ON s.key = a.subtype WHERE a.id = ?1",
        balance_expr("a")
    );
    conn.query_row(&sql, [id], map_account)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Account not found".into()),
            other => other.into(),
        })
}

pub fn list_accounts(conn: &Connection, include_archived: bool) -> AppResult<Vec<Account>> {
    let sql = format!(
        "SELECT a.*, COALESCE(s.type, 'fund') AS account_type, COALESCE(s.account_group, 'own') AS \"group\", \
         COALESCE((SELECT amount_cents FROM transactions WHERE account_id = a.id AND kind = 'opening' LIMIT 1), 0) AS opening_balance_cents, \
         ({}) AS balance_cents \
         FROM accounts a LEFT JOIN account_subtypes s ON s.key = a.subtype {} ORDER BY a.created_at",
        balance_expr("a"),
        if include_archived { "" } else { "WHERE a.is_archived = 0" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_account)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn account_has_nonopening_activity(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM transactions WHERE kind <> 'opening' AND (account_id = ?1 OR to_account_id = ?1))",
        [id],
        |r| r.get(0),
    )?)
}

pub fn set_opening_amount(conn: &Connection, account_id: &str, amount_cents: i64, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE transactions SET amount_cents = ?2, updated_at = ?3 WHERE account_id = ?1 AND kind = 'opening'",
        params![account_id, amount_cents, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Opening transaction not found".into()));
    }
    Ok(())
}

pub fn update_account_fields(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    subtype: Option<&str>,
    opening_balance_cents: Option<i64>,
    now: &str,
) -> AppResult<()> {
    if let Some(n) = name {
        conn.execute("UPDATE accounts SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, n, now])?;
    }
    if let Some(s) = subtype {
        conn.execute("UPDATE accounts SET subtype = ?2, updated_at = ?3 WHERE id = ?1", params![id, s, now])?;
    }
    if let Some(o) = opening_balance_cents {
        conn.execute(
            "UPDATE transactions SET amount_cents = ?2, updated_at = ?3 WHERE id = (SELECT id FROM transactions WHERE account_id = ?1 AND kind = 'opening' LIMIT 1)",
            params![id, o, now],
        )?;
    }
    Ok(())
}

pub fn set_credit_limit(conn: &Connection, id: &str, credit_limit_cents: Option<i64>, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET credit_limit_cents = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, credit_limit_cents, now],
    )?;
    Ok(())
}

pub fn set_value_categories(
    conn: &Connection,
    id: &str,
    gain_category_id: Option<&str>,
    loss_category_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET gain_category_id = ?2, loss_category_id = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, gain_category_id, loss_category_id, now],
    )?;
    Ok(())
}

pub fn clear_value_category(conn: &Connection, category_id: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE accounts SET gain_category_id = NULL, updated_at = ?2 WHERE gain_category_id = ?1",
        params![category_id, now],
    )?;
    conn.execute(
        "UPDATE accounts SET loss_category_id = NULL, updated_at = ?2 WHERE loss_category_id = ?1",
        params![category_id, now],
    )?;
    Ok(())
}

pub fn set_account_archived(conn: &Connection, id: &str, archived: bool, now: &str) -> AppResult<Account> {
    let n = conn.execute(
        "UPDATE accounts SET is_archived = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, archived as i64, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Account not found".into()));
    }
    get_account(conn, id)
}

// ── Categories ───────────────────────────────────────────────────────────────

fn map_category(r: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: r.get("id")?,
        name: r.get("name")?,
        kind: r.get("kind")?,
        emoji: r.get("emoji")?,
        color: r.get("color")?,
        parent_id: r.get("parent_id")?,
        sort_order: r.get("sort_order")?,
        is_archived: r.get::<_, i64>("is_archived")? != 0,
        is_system: r.get::<_, i64>("is_system")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn list_categories(conn: &Connection, kind: Option<&str>, include_archived: bool) -> AppResult<Vec<Category>> {
    let archived_filter = if include_archived { "" } else { "AND is_archived = 0" };
    let (sql, has_kind) = match kind {
        Some(_) => (
            format!("SELECT * FROM categories WHERE kind = ?1 {} ORDER BY sort_order, name", archived_filter),
            true,
        ),
        None => (
            format!("SELECT * FROM categories WHERE 1=1 {} ORDER BY sort_order, name", archived_filter),
            false,
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = if has_kind {
        stmt.query_map([kind.unwrap()], map_category)?.collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], map_category)?.collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

pub fn get_category(conn: &Connection, id: &str) -> AppResult<Category> {
    conn.query_row("SELECT * FROM categories WHERE id = ?1", [id], map_category)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Category not found".into()),
            other => other.into(),
        })
}

/// The protected "Adjustment" category id for a kind ('income' | 'expense').
/// Guaranteed to exist by the seed; NotFound surfaces a corrupt install loudly.
pub fn get_system_category_id(conn: &Connection, kind: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT id FROM categories WHERE is_system = 1 AND kind = ?1 AND parent_id IS NULL ORDER BY created_at ASC LIMIT 1",
        [kind],
        |r| r.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("System category missing".into()),
        other => other.into(),
    })
}

pub fn insert_category(
    conn: &Connection,
    id: &str,
    name: &str,
    kind: &str,
    emoji: &str,
    color: Option<&str>,
    parent_id: Option<&str>,
    now: &str,
) -> AppResult<Category> {
    conn.execute(
        "INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 100, 0, ?7, ?7)",
        params![id, name, kind, emoji, color, parent_id, now],
    )
    .map_err(map_unique)?;
    get_category(conn, id)
}

pub fn update_category_fields(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    emoji: Option<&str>,
    color: Option<&str>,
    sort_order: Option<i64>,
    now: &str,
) -> AppResult<Category> {
    if let Some(v) = name {
        conn.execute("UPDATE categories SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, v, now]).map_err(map_unique)?;
    }
    if let Some(v) = emoji {
        conn.execute("UPDATE categories SET emoji = ?2, updated_at = ?3 WHERE id = ?1", params![id, v, now])?;
    }
    if let Some(v) = color {
        conn.execute("UPDATE categories SET color = ?2, updated_at = ?3 WHERE id = ?1", params![id, v, now])?;
    }
    if let Some(v) = sort_order {
        conn.execute("UPDATE categories SET sort_order = ?2, updated_at = ?3 WHERE id = ?1", params![id, v, now])?;
    }
    get_category(conn, id)
}

pub fn set_category_archived(conn: &Connection, id: &str, archived: bool, now: &str) -> AppResult<Category> {
    let n = conn.execute(
        "UPDATE categories SET is_archived = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, archived as i64, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Category not found".into()));
    }
    get_category(conn, id)
}

/// Archive or restore all subcategories of a top-level category in one statement.
pub fn set_children_archived(conn: &Connection, parent_id: &str, archived: bool, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE categories SET is_archived = ?2, updated_at = ?3 WHERE parent_id = ?1",
        params![parent_id, archived as i64, now],
    )?;
    Ok(())
}

pub fn count_children(conn: &Connection, parent_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM categories WHERE parent_id = ?1",
        [parent_id],
        |r| r.get(0),
    )?)
}

pub fn count_transactions_for_category(conn: &Connection, category_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) FROM transactions WHERE category_id = ?1)
              + (SELECT COUNT(*) FROM transaction_splits WHERE category_id = ?1)",
        [category_id],
        |r| r.get(0),
    )?)
}

pub fn delete_category(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Category not found".into()));
    }
    Ok(())
}

pub fn reorder_categories(conn: &Connection, ids: &[String], now: &str) -> AppResult<()> {
    for (i, id) in ids.iter().enumerate() {
        let n = conn.execute(
            "UPDATE categories SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, i as i64, now],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("Category not found".into()));
        }
    }
    Ok(())
}

pub fn set_category_parent(conn: &Connection, id: &str, parent_id: Option<&str>, now: &str) -> AppResult<Category> {
    let n = conn
        .execute(
            "UPDATE categories SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, parent_id, now],
        )
        .map_err(map_unique)?;
    if n == 0 {
        return Err(AppError::NotFound("Category not found".into()));
    }
    get_category(conn, id)
}

// ── Transactions ─────────────────────────────────────────────────────────────

fn map_transaction(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get("id")?,
        kind: r.get("kind")?,
        account_id: r.get("account_id")?,
        to_account_id: r.get("to_account_id")?,
        category_id: r.get("category_id")?,
        amount_cents: r.get("amount_cents")?,
        description: r.get("description")?,
        transaction_date: r.get("transaction_date")?,
        transaction_time: r.get("transaction_time")?,
        excluded_from_reporting: r.get::<_, i64>("excluded_from_reporting")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        splits: Vec::new(),
        expected_reimbursement_cents: r.get("expected_reimbursement_cents")?,
        reimbursed_cents: 0,
        allocations: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
pub fn insert_transaction(
    conn: &Connection,
    id: &str,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: Option<&str>,
    amount_cents: i64,
    description: Option<&str>,
    transaction_date: &str,
    transaction_time: Option<&str>,
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting as i64, now],
    )
    .map_err(map_check)?;
    get_transaction(conn, id)
}

pub fn insert_posting(
    conn: &Connection,
    id: &str,
    transaction_id: &str,
    account_id: Option<&str>,
    system_bucket: Option<&str>,
    amount_cents: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, transaction_id, account_id, system_bucket, amount_cents],
    )
    .map_err(map_check)?;
    Ok(())
}

pub fn delete_postings_for(conn: &Connection, transaction_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM postings WHERE transaction_id = ?1", [transaction_id])?;
    Ok(())
}

// ── Transaction splits ───────────────────────────────────────────────────────

pub fn insert_split(
    conn: &Connection,
    id: &str,
    transaction_id: &str,
    category_id: &str,
    amount_cents: i64,
    sort_order: i64,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, transaction_id, category_id, amount_cents, sort_order, now],
    )
    .map_err(map_check)?;
    Ok(())
}

pub fn list_splits_for(conn: &Connection, transaction_id: &str) -> AppResult<Vec<TxnSplit>> {
    let mut stmt = conn.prepare(
        "SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt
        .query_map([transaction_id], |r| {
            Ok(TxnSplit {
                category_id: r.get(0)?,
                amount_cents: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_splits_for(conn: &Connection, transaction_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM transaction_splits WHERE transaction_id = ?1", [transaction_id])?;
    Ok(())
}

/// Fill the derived collections on a row: split lines, an expense's reimbursed
/// total, and a reimbursement's allocations.
fn hydrate(conn: &Connection, t: &mut Transaction) -> AppResult<()> {
    t.splits = list_splits_for(conn, &t.id)?;
    t.reimbursed_cents = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM reimbursement_allocations WHERE expense_id = ?1",
        [&t.id],
        |r| r.get(0),
    )?;
    t.allocations = list_allocations_for(conn, &t.id)?;
    Ok(())
}

// ── Reimbursement allocations ────────────────────────────────────────────────

pub fn insert_allocation(
    conn: &Connection,
    id: &str,
    reimbursement_id: &str,
    expense_id: &str,
    amount_cents: i64,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, reimbursement_id, expense_id, amount_cents, now],
    )
    .map_err(map_check)?;
    Ok(())
}

pub fn list_allocations_for(conn: &Connection, reimbursement_id: &str) -> AppResult<Vec<Allocation>> {
    let mut stmt = conn.prepare(
        "SELECT expense_id, amount_cents FROM reimbursement_allocations WHERE reimbursement_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt
        .query_map([reimbursement_id], |r| {
            Ok(Allocation { expense_id: r.get(0)?, amount_cents: r.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_allocations_for(conn: &Connection, reimbursement_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM reimbursement_allocations WHERE reimbursement_id = ?1", [reimbursement_id])?;
    Ok(())
}

/// Total already allocated to an expense, optionally ignoring one reimbursement
/// (the one being edited, so its own links don't count as used).
pub fn allocated_total_for_expense(
    conn: &Connection,
    expense_id: &str,
    except_reimbursement_id: Option<&str>,
) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM reimbursement_allocations
         WHERE expense_id = ?1 AND (?2 IS NULL OR reimbursement_id <> ?2)",
        params![expense_id, except_reimbursement_id],
        |r| r.get(0),
    )?)
}

pub fn set_expected_reimbursement(
    conn: &Connection,
    expense_id: &str,
    expected: Option<i64>,
    now: &str,
) -> AppResult<()> {
    let n = conn
        .execute(
            "UPDATE transactions SET expected_reimbursement_cents = ?2, updated_at = ?3 WHERE id = ?1",
            params![expense_id, expected, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    Ok(())
}

pub fn get_transaction(conn: &Connection, id: &str) -> AppResult<Transaction> {
    let mut t = conn
        .query_row("SELECT * FROM transactions WHERE id = ?1", [id], map_transaction)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Transaction not found".into()),
            other => other.into(),
        })?;
    hydrate(conn, &mut t)?;
    Ok(t)
}

pub fn get_opening_transaction(conn: &Connection, account_id: &str) -> AppResult<Transaction> {
    conn.query_row(
        "SELECT * FROM transactions WHERE account_id = ?1 AND kind = 'opening' LIMIT 1",
        [account_id],
        map_transaction,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Opening transaction not found".into()),
        other => other.into(),
    })
}

#[allow(clippy::too_many_arguments)]
pub fn update_transaction_row(
    conn: &Connection,
    id: &str,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: Option<&str>,
    amount_cents: i64,
    description: Option<&str>,
    transaction_date: &str,
    transaction_time: Option<&str>,
    excluded_from_reporting: bool,
    expected_reimbursement_cents: Option<i64>,
    now: &str,
) -> AppResult<Transaction> {
    let n = conn
        .execute(
            "UPDATE transactions SET kind=?2, account_id=?3, to_account_id=?4, category_id=?5,
               amount_cents=?6, description=?7, transaction_date=?8, transaction_time=?9, excluded_from_reporting=?10,
               expected_reimbursement_cents=?11, updated_at=?12 WHERE id=?1",
            params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, transaction_time, excluded_from_reporting as i64, expected_reimbursement_cents, now],
        )
        .map_err(map_check)?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    get_transaction(conn, id)
}

pub fn delete_transaction(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM transactions WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Transaction not found".into()));
    }
    Ok(())
}

pub fn list_transactions(conn: &Connection, f: &TransactionFilters) -> AppResult<Vec<Transaction>> {
    let mut sql = String::from("SELECT * FROM transactions WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(v) = &f.account_id {
        sql.push_str(" AND (account_id = ? OR to_account_id = ?)");
        args.push(Box::new(v.clone()));
        args.push(Box::new(v.clone()));
    }
    if let Some(v) = &f.category_id {
        sql.push_str(" AND (category_id = ? OR id IN (SELECT transaction_id FROM transaction_splits WHERE category_id = ?))");
        args.push(Box::new(v.clone()));
        args.push(Box::new(v.clone()));
    }
    if let Some(v) = &f.kind {
        sql.push_str(" AND kind = ?");
        args.push(Box::new(v.clone()));
    }
    if let Some(v) = &f.from_date {
        sql.push_str(" AND transaction_date >= ?");
        args.push(Box::new(v.clone()));
    }
    if let Some(v) = &f.to_date {
        sql.push_str(" AND transaction_date < ?");
        args.push(Box::new(v.clone()));
    }
    sql.push_str(" ORDER BY transaction_date DESC, transaction_time DESC NULLS LAST, created_at DESC");
    let limit = f.limit.unwrap_or(200).clamp(1, 1000);
    sql.push_str(&format!(" LIMIT {}", limit));
    if let Some(off) = f.offset {
        sql.push_str(&format!(" OFFSET {}", off.max(0)));
    }
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt
        .query_map(refs.as_slice(), map_transaction)?
        .collect::<Result<Vec<_>, _>>()?;
    for t in rows.iter_mut() {
        hydrate(conn, t)?;
    }
    Ok(rows)
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/// Sum of a transaction kind within a half-open month range [from, to).
pub fn sum_kind_in_range(conn: &Connection, kind: &str, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
         WHERE kind = ?1 AND excluded_from_reporting = 0 AND transaction_date >= ?2 AND transaction_date < ?3",
        params![kind, from, to],
        |r| r.get(0),
    )?)
}

/// Net expense total in a half-open range: each non-excluded expense counts at
/// its amount minus what has been reimbursed, in the expense's own month.
pub fn sum_expense_net_in_range(conn: &Connection, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(t.amount_cents - COALESCE(
                  (SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0)), 0)
         FROM transactions t
         WHERE t.kind = 'expense' AND t.excluded_from_reporting = 0
           AND t.transaction_date >= ?1 AND t.transaction_date < ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}

/// Expenses whose expectation is not yet received: count and outstanding total.
pub fn awaiting_reimbursement(conn: &Connection) -> AppResult<AwaitingReimbursement> {
    let (count, total_cents) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(outstanding), 0) FROM (
           SELECT MAX(t.expected_reimbursement_cents - COALESCE(
                    (SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0), 0) AS outstanding
           FROM transactions t
           WHERE t.kind = 'expense' AND t.expected_reimbursement_cents IS NOT NULL
         ) WHERE outstanding > 0",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    Ok(AwaitingReimbursement { count, total_cents })
}

/// Per-category expense nets in a half-open range, after reimbursement apportion
/// and before parent rollup. A category appears only when it has a line; a fully
/// offset line is kept as zero.
pub fn category_spend_nets(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<(String, i64)>> {
    // One row per attributed line (a plain expense is one line; a split expense is
    // one line per split), carrying the expense's total allocated amount.
    let mut stmt = conn.prepare(
        "SELECT expense_id, cat, amt, alloc FROM (
           SELECT t.id AS expense_id, t.category_id AS cat, t.amount_cents AS amt, 0 AS ord, 0 AS rid,
                  COALESCE((SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0) AS alloc
           FROM transactions t
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
             AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
           UNION ALL
           SELECT t.id, s.category_id, s.amount_cents, s.sort_order, s.rowid,
                  COALESCE((SELECT SUM(a.amount_cents) FROM reimbursement_allocations a WHERE a.expense_id = t.id), 0)
           FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
           WHERE t.kind='expense' AND t.excluded_from_reporting=0
             AND t.transaction_date >= ?1 AND t.transaction_date < ?2
         ) ORDER BY expense_id, ord, rid",
    )?;
    let lines: Vec<(String, String, i64, i64)> = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    // Offset each expense's lines by its allocations, then total per category.
    let mut by_category: HashMap<String, i64> = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j < lines.len() && lines[j].0 == lines[i].0 {
            j += 1;
        }
        let amounts: Vec<i64> = lines[i..j].iter().map(|l| l.2).collect();
        let shares = crate::apportion::apportion(lines[i].3, &amounts);
        for (k, line) in lines[i..j].iter().enumerate() {
            *by_category.entry(line.1.clone()).or_insert(0) += line.2 - shares[k];
        }
        i = j;
    }
    Ok(by_category.into_iter().collect())
}

pub fn spending_breakdown(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CategoryBreakdown>> {
    // Roll subcategories into their parent, then attach display fields.
    let mut by_group: HashMap<String, i64> = HashMap::new();
    for (cat_id, net) in category_spend_nets(conn, from, to)? {
        let cat = get_category(conn, &cat_id)?;
        *by_group.entry(cat.parent_id.unwrap_or(cat.id)).or_insert(0) += net;
    }
    let mut out = Vec::new();
    for (group_id, total_cents) in by_group {
        if total_cents <= 0 {
            continue;
        }
        let g = get_category(conn, &group_id)?;
        out.push(CategoryBreakdown {
            category_id: group_id,
            category_name: g.name,
            emoji: g.emoji,
            color: g.color,
            total_cents,
        });
    }
    out.sort_by(|a, b| {
        b.total_cents
            .cmp(&a.total_cents)
            .then_with(|| a.category_name.cmp(&b.category_name))
    });
    Ok(out)
}

pub fn account_balances(conn: &Connection) -> AppResult<Vec<AccountBalance>> {
    let sql = format!(
        "SELECT a.id, a.name, COALESCE(s.type, 'fund') AS account_type, COALESCE(s.account_group, 'own') AS \"group\", ({}) AS balance_cents \
         FROM accounts a LEFT JOIN account_subtypes s ON s.key = a.subtype \
         WHERE a.is_archived = 0 ORDER BY a.created_at",
        balance_expr("a")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AccountBalance {
                account_id: r.get(0)?,
                name: r.get(1)?,
                account_type: r.get(2)?,
                group: r.get(3)?,
                balance_cents: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn recent_transactions(conn: &Connection, limit: i64) -> AppResult<Vec<Transaction>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM transactions ORDER BY transaction_date DESC, created_at DESC LIMIT ?1",
    )?;
    let mut rows = stmt
        .query_map([limit], map_transaction)?
        .collect::<Result<Vec<_>, _>>()?;
    for t in rows.iter_mut() {
        hydrate(conn, t)?;
    }
    Ok(rows)
}

// ── Budgets & goals ──────────────────────────────────────────────────────────

pub fn upsert_budget(
    conn: &Connection,
    id: &str,
    category_id: &str,
    effective_month: &str,
    amount_cents: Option<i64>,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents",
        params![id, category_id, effective_month, amount_cents, now],
    )?;
    Ok(())
}

pub fn list_budget_versions(conn: &Connection) -> AppResult<Vec<(String, String, Option<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT category_id, effective_month, amount_cents FROM category_budgets ORDER BY effective_month, category_id",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone)]
pub struct GoalRow {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn map_goal(r: &Row) -> rusqlite::Result<GoalRow> {
    Ok(GoalRow {
        id: r.get("id")?,
        name: r.get("name")?,
        account_id: r.get("account_id")?,
        target_cents: r.get("target_cents")?,
        target_date: r.get("target_date")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn insert_goal(
    conn: &Connection,
    id: &str,
    name: &str,
    account_id: &str,
    target_cents: i64,
    target_date: Option<&str>,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, name, account_id, target_cents, target_date, now],
    )?;
    Ok(())
}

pub fn update_goal(
    conn: &Connection,
    id: &str,
    name: &str,
    account_id: &str,
    target_cents: i64,
    target_date: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE savings_goals SET name = ?2, account_id = ?3, target_cents = ?4, target_date = ?5, updated_at = ?6 WHERE id = ?1",
        params![id, name, account_id, target_cents, target_date, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Goal not found".into()));
    }
    Ok(())
}

pub fn delete_goal(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM savings_goals WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_goal(conn: &Connection, id: &str) -> AppResult<GoalRow> {
    conn.query_row("SELECT * FROM savings_goals WHERE id = ?1", [id], map_goal).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Goal not found".into()),
        other => other.into(),
    })
}

pub fn goal_for_account(conn: &Connection, account_id: &str) -> AppResult<Option<GoalRow>> {
    let result = conn.query_row(
        "SELECT * FROM savings_goals WHERE account_id = ?1",
        [account_id],
        map_goal,
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ── Schedules ────────────────────────────────────────────────────────────────

fn join_strings(items: &[String]) -> String {
    items.join(",")
}

fn split_strings(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',').map(str::to_string).collect()
    }
}

fn join_ints(items: &[i64]) -> String {
    items
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn split_ints(raw: &str) -> Vec<i64> {
    if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(',')
            .filter_map(|part| part.parse().ok())
            .collect()
    }
}

fn map_schedule(r: &Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get("id")?,
        mode: r.get("mode")?,
        kind: r.get("kind")?,
        amount_cents: r.get("amount_cents")?,
        account_id: r.get("account_id")?,
        to_account_id: r.get("to_account_id")?,
        category_id: r.get("category_id")?,
        description: r.get("description")?,
        start_date: r.get("start_date")?,
        time: r.get("time")?,
        frequency: r.get("frequency")?,
        interval: r.get("interval")?,
        weekdays: split_strings(&r.get::<_, String>("weekdays")?),
        month_mode: r.get("month_mode")?,
        month_days: split_ints(&r.get::<_, String>("month_days")?),
        ordinal: r.get("ordinal")?,
        ordinal_day: r.get("ordinal_day")?,
        months: split_ints(&r.get::<_, String>("months")?),
        day_of_month: r.get("day_of_month")?,
        end_mode: r.get("end_mode")?,
        end_count: r.get("end_count")?,
        end_date: r.get("end_date")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        block_reason: None,
    })
}

const SCHEDULE_COLS: &str = "id, mode, kind, amount_cents, account_id, to_account_id, category_id, description, \
    start_date, time, frequency, interval, weekdays, month_mode, month_days, ordinal, ordinal_day, months, \
    day_of_month, end_mode, end_count, end_date, created_at, updated_at";

pub fn insert_schedule(
    conn: &Connection,
    id: &str,
    write: &ScheduleWrite,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO schedules (id, mode, kind, amount_cents, account_id, to_account_id, category_id, description,
         start_date, time, frequency, interval, weekdays, month_mode, month_days, ordinal, ordinal_day, months,
         day_of_month, end_mode, end_count, end_date, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23)",
        params![
            id,
            write.mode,
            write.kind,
            write.amount_cents,
            write.account_id,
            write.to_account_id,
            write.category_id,
            write.description,
            write.start_date,
            write.time,
            write.frequency,
            write.interval,
            join_strings(&write.weekdays),
            write.month_mode,
            join_ints(&write.month_days),
            write.ordinal,
            write.ordinal_day,
            join_ints(&write.months),
            write.day_of_month,
            write.end_mode,
            write.end_count,
            write.end_date,
            now,
        ],
    )?;
    Ok(())
}

pub fn update_schedule(
    conn: &Connection,
    id: &str,
    write: &ScheduleWrite,
    now: &str,
) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE schedules SET mode = ?2, kind = ?3, amount_cents = ?4, account_id = ?5, to_account_id = ?6,
         category_id = ?7, description = ?8, start_date = ?9, time = ?10, frequency = ?11, interval = ?12,
         weekdays = ?13, month_mode = ?14, month_days = ?15, ordinal = ?16, ordinal_day = ?17, months = ?18,
         day_of_month = ?19, end_mode = ?20, end_count = ?21, end_date = ?22, updated_at = ?23
         WHERE id = ?1",
        params![
            id,
            write.mode,
            write.kind,
            write.amount_cents,
            write.account_id,
            write.to_account_id,
            write.category_id,
            write.description,
            write.start_date,
            write.time,
            write.frequency,
            write.interval,
            join_strings(&write.weekdays),
            write.month_mode,
            join_ints(&write.month_days),
            write.ordinal,
            write.ordinal_day,
            join_ints(&write.months),
            write.day_of_month,
            write.end_mode,
            write.end_count,
            write.end_date,
            now,
        ],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Schedule not found".into()));
    }
    Ok(())
}

pub fn delete_schedule(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM schedules WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Schedule not found".into()));
    }
    Ok(())
}

pub fn list_schedules(conn: &Connection) -> AppResult<Vec<Schedule>> {
    let sql = format!("SELECT {SCHEDULE_COLS} FROM schedules ORDER BY created_at, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], map_schedule)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_schedule(conn: &Connection, id: &str) -> AppResult<Schedule> {
    let sql = format!("SELECT {SCHEDULE_COLS} FROM schedules WHERE id = ?1");
    conn.query_row(&sql, [id], map_schedule)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Schedule not found".into()),
            other => other.into(),
        })
}

#[derive(Debug, Clone)]
pub struct ScheduleOccurrenceRow {
    pub occurrence_date: String,
    pub status: String,
    pub transaction_id: Option<String>,
}

pub fn list_occurrences(conn: &Connection, schedule_id: &str) -> AppResult<Vec<ScheduleOccurrenceRow>> {
    let mut stmt = conn.prepare(
        "SELECT occurrence_date, status, transaction_id FROM schedule_occurrences
         WHERE schedule_id = ?1 ORDER BY occurrence_date",
    )?;
    let rows = stmt
        .query_map([schedule_id], |r| {
            Ok(ScheduleOccurrenceRow {
                occurrence_date: r.get(0)?,
                status: r.get(1)?,
                transaction_id: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn insert_occurrence(
    conn: &Connection,
    schedule_id: &str,
    occurrence_date: &str,
    status: &str,
    transaction_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO schedule_occurrences (schedule_id, occurrence_date, status, transaction_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![schedule_id, occurrence_date, status, transaction_id],
    )?;
    Ok(())
}

pub fn set_occurrence_transaction(
    conn: &Connection,
    schedule_id: &str,
    occurrence_date: &str,
    transaction_id: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE schedule_occurrences SET transaction_id = ?3
         WHERE schedule_id = ?1 AND occurrence_date = ?2",
        params![schedule_id, occurrence_date, transaction_id],
    )?;
    Ok(())
}

pub fn delete_occurrence(conn: &Connection, schedule_id: &str, occurrence_date: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM schedule_occurrences WHERE schedule_id = ?1 AND occurrence_date = ?2",
        params![schedule_id, occurrence_date],
    )?;
    Ok(())
}

pub fn occurrence_status(
    conn: &Connection,
    schedule_id: &str,
    occurrence_date: &str,
) -> AppResult<Option<ScheduleOccurrenceRow>> {
    let result = conn.query_row(
        "SELECT occurrence_date, status, transaction_id FROM schedule_occurrences
         WHERE schedule_id = ?1 AND occurrence_date = ?2",
        params![schedule_id, occurrence_date],
        |r| {
            Ok(ScheduleOccurrenceRow {
                occurrence_date: r.get(0)?,
                status: r.get(1)?,
                transaction_id: r.get(2)?,
            })
        },
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ── App Settings ─────────────────────────────────────────────────────────────

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let result = conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )?;
    Ok(())
}

// ── Error mapping helpers ─────────────────────────────────────────────────────

/// Map a SQLite UNIQUE violation to a friendly Conflict.
fn map_unique(e: rusqlite::Error) -> AppError {
    let msg = e.to_string();
    if msg.contains("UNIQUE") {
        AppError::Conflict("A category with this name already exists at this level".into())
    } else {
        e.into()
    }
}

/// Map a SQLite CHECK violation (malformed transaction shape) to Validation.
fn map_check(e: rusqlite::Error) -> AppError {
    let msg = e.to_string();
    if msg.contains("CHECK") {
        AppError::Validation("Transaction fields are invalid for its kind".into())
    } else {
        e.into()
    }
}
