//! Repository layer: owns all SQL and row→struct mapping. No business
//! decisions beyond database constraints (see the spec's Repository layer).

use crate::error::{AppError, AppResult};
use crate::models::*;
use rusqlite::{params, Connection, Row};

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
    now: &str,
) -> AppResult<Account> {
    conn.execute(
        "INSERT INTO accounts
           (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'MYR', 0, ?5, ?5)",
        params![id, template_key, name, subtype, now],
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

pub fn set_opening_amount(conn: &Connection, account_id: &str, amount_cents: i64, now: &str) -> AppResult<Account> {
    let n = conn.execute(
        "UPDATE transactions SET amount_cents = ?2, updated_at = ?3 WHERE account_id = ?1 AND kind = 'opening'",
        params![account_id, amount_cents, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Opening transaction not found".into()));
    }
    get_account(conn, account_id)
}

pub fn update_account_fields(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    subtype: Option<&str>,
    opening_balance_cents: Option<i64>,
    now: &str,
) -> AppResult<Account> {
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
    get_account(conn, id)
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
        "SELECT COUNT(*) FROM transactions WHERE category_id = ?1",
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
        excluded_from_reporting: r.get::<_, i64>("excluded_from_reporting")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
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
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting as i64, now],
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

pub fn get_transaction(conn: &Connection, id: &str) -> AppResult<Transaction> {
    conn.query_row("SELECT * FROM transactions WHERE id = ?1", [id], map_transaction)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Transaction not found".into()),
            other => other.into(),
        })
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
    excluded_from_reporting: bool,
    now: &str,
) -> AppResult<Transaction> {
    let n = conn
        .execute(
            "UPDATE transactions SET kind=?2, account_id=?3, to_account_id=?4, category_id=?5,
               amount_cents=?6, description=?7, transaction_date=?8, excluded_from_reporting=?9, updated_at=?10 WHERE id=?1",
            params![id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting as i64, now],
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
        sql.push_str(" AND category_id = ?");
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
    sql.push_str(" ORDER BY transaction_date DESC, created_at DESC");
    let limit = f.limit.unwrap_or(200).clamp(1, 1000);
    sql.push_str(&format!(" LIMIT {}", limit));
    if let Some(off) = f.offset {
        sql.push_str(&format!(" OFFSET {}", off.max(0)));
    }
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), map_transaction)?
        .collect::<Result<Vec<_>, _>>()?;
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

pub fn spending_breakdown(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CategoryBreakdown>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(c.parent_id, c.id) AS group_id, pc.name, pc.emoji, pc.color, SUM(t.amount_cents) AS total
         FROM transactions t
         JOIN categories c  ON c.id = t.category_id
         JOIN categories pc ON pc.id = COALESCE(c.parent_id, c.id)
         WHERE t.kind = 'expense' AND t.excluded_from_reporting = 0 AND t.transaction_date >= ?1 AND t.transaction_date < ?2
         GROUP BY group_id ORDER BY total DESC",
    )?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            Ok(CategoryBreakdown {
                category_id: r.get(0)?,
                category_name: r.get(1)?,
                emoji: r.get(2)?,
                color: r.get(3)?,
                total_cents: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
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
    let rows = stmt
        .query_map([limit], map_transaction)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
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
