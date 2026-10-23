//! Argument resolution and validation for MCP tools: names to ids, strict
//! money and date parsing, and MYR formatting. No SQL or business rules here.
use rusqlite::Connection;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::service;

/// Shared lookup: exact id first, then trimmed case-insensitive name.
/// Ambiguity counts only active rows; an archived-only match is a conflict.
fn resolve_by_name(what: &str, key: &str, rows: &[(String, String, bool)]) -> AppResult<String> {
    let key = key.trim();
    if let Some((id, _, _)) = rows.iter().find(|(id, _, _)| id == key) {
        return Ok(id.clone());
    }
    let wanted = key.to_lowercase();
    let matches: Vec<&(String, String, bool)> =
        rows.iter().filter(|(_, name, _)| name.trim().to_lowercase() == wanted).collect();
    let active: Vec<&&(String, String, bool)> = matches.iter().filter(|(_, _, arch)| !arch).collect();
    match (active.len(), matches.len()) {
        (1, _) => Ok(active[0].0.clone()),
        (0, 0) => Err(AppError::NotFound(format!("No {what} named \"{key}\""))),
        (0, _) => Err(AppError::Conflict(format!("{what} \"{key}\" is archived"))),
        _ => {
            let list = active
                .iter()
                .map(|(id, name, _)| format!("\"{}\" ({id})", name.trim()))
                .collect::<Vec<_>>()
                .join(", ");
            Err(AppError::Validation(format!(
                "Ambiguous {what} \"{key}\" matches {} entries: {list}. Pass the id instead.",
                active.len()
            )))
        }
    }
}

/// Resolve an account id or name to an account id.
pub fn resolve_account(conn: &Connection, key: &str) -> AppResult<String> {
    let rows: Vec<_> = service::list_accounts(conn, true)?
        .into_iter()
        .map(|a| (a.id, a.name, a.is_archived))
        .collect();
    resolve_by_name("account", key, &rows)
}

/// Resolve a category id or name to a category id; `kind` narrows by
/// income/expense.
pub fn resolve_category(conn: &Connection, key: &str, kind: Option<&str>) -> AppResult<String> {
    let rows: Vec<_> = service::list_categories(conn, kind, true)?
        .into_iter()
        .map(|c| (c.id, c.name, c.is_archived))
        .collect();
    resolve_by_name("category", key, &rows)
}

/// Resolve an archived account (for restore): an id, or a name that matches
/// an archived account.
pub fn resolve_archived_account(conn: &Connection, key: &str) -> AppResult<String> {
    let rows: Vec<_> = service::list_accounts(conn, true)?
        .into_iter()
        .map(|a| (a.id, a.name, a.is_archived))
        .collect();
    resolve_archived("account", key, rows)
}

/// Resolve an archived category (for restore): an id, or a name that matches
/// an archived category.
pub fn resolve_archived_category(conn: &Connection, key: &str) -> AppResult<String> {
    let rows: Vec<_> = service::list_categories(conn, None, true)?
        .into_iter()
        .map(|c| (c.id, c.name, c.is_archived))
        .collect();
    resolve_archived("category", key, rows)
}

fn resolve_archived(what: &str, key: &str, rows: Vec<(String, String, bool)>) -> AppResult<String> {
    if let Some((id, _, _)) = rows.iter().find(|(id, _, _)| id == key.trim()) {
        return Ok(id.clone());
    }
    // Only archived rows can match by name; treat them as the active set.
    let archived: Vec<_> = rows.into_iter().filter(|r| r.2).map(|(i, n, _)| (i, n, false)).collect();
    resolve_by_name(&format!("archived {what}"), key, &archived)
}

/// Format integer MYR cents as `RM 1,234.50` (negative: `-RM 12.34`).
pub fn fmt_myr(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    let whole = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let sign = if cents < 0 { "-" } else { "" };
    format!("{sign}RM {grouped}.{:02}", abs % 100)
}

/// Strict `YYYY-MM-DD`; returns the input unchanged.
pub fn parse_date(s: &str) -> AppResult<String> {
    let b = s.as_bytes();
    let shaped = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if shaped && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() {
        Ok(s.to_string())
    } else {
        Err(AppError::Validation(format!("Invalid date \"{s}\": use YYYY-MM-DD")))
    }
}

/// A positive JSON integer amount in cents; floats, strings, zero and
/// negatives are rejected.
pub fn cents_arg(v: &Value, field: &str) -> AppResult<i64> {
    match v.as_i64() {
        Some(n) if n > 0 => Ok(n),
        _ => Err(AppError::Validation(format!(
            "{field} must be a positive integer cents value (e.g. 1250 for RM 12.50), got {v}"
        ))),
    }
}

/// Any JSON integer amount in cents (zero and negatives allowed, for balances
/// that may be zero or owed); floats and strings are rejected.
pub fn integer_cents_arg(v: &Value, field: &str) -> AppResult<i64> {
    v.as_i64().ok_or_else(|| {
        AppError::Validation(format!("{field} must be an integer cents value (e.g. 1250 for RM 12.50), got {v}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use serde_json::json;

    fn acct(c: &Connection, name: &str) -> String {
        service::create_account(c, name, "cash", 0, None, None, None, None).unwrap().id
    }

    #[test]
    fn ambiguous_account_name_errors_listing_both() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Wallet");
        let b = acct(&c, "wallet ");
        match resolve_account(&c, "WALLET") {
            Err(AppError::Validation(m)) => {
                assert!(m.contains(&a) && m.contains(&b), "{m}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn case_insensitive_name_resolves() {
        let c = open_in_memory().unwrap();
        let id = acct(&c, "Maybank Savings");
        assert_eq!(resolve_account(&c, "  maybank SAVINGS ").unwrap(), id);
    }

    #[test]
    fn archived_only_name_is_conflict() {
        let c = open_in_memory().unwrap();
        let id = acct(&c, "Old");
        service::archive_account(&c, &id).unwrap();
        assert!(matches!(resolve_account(&c, "old"), Err(AppError::Conflict(_))));
    }

    #[test]
    fn unknown_name_is_not_found() {
        let c = open_in_memory().unwrap();
        assert!(matches!(resolve_account(&c, "nope"), Err(AppError::NotFound(_))));
        assert!(matches!(resolve_category(&c, "nope", None), Err(AppError::NotFound(_))));
    }

    #[test]
    fn uuid_passthrough() {
        let c = open_in_memory().unwrap();
        let id = acct(&c, "Wallet");
        assert_eq!(resolve_account(&c, &id).unwrap(), id);
        let cat = service::create_category(&c, "Snacks", "expense", "🍿", None, None).unwrap();
        assert_eq!(resolve_category(&c, &cat.id, None).unwrap(), cat.id);
    }

    #[test]
    fn category_kind_narrows() {
        let c = open_in_memory().unwrap();
        // "Gift" is seeded as an income category; add an expense twin.
        let e = service::create_category(&c, "Gift", "expense", "\u{1F381}", None, None).unwrap();
        assert!(matches!(resolve_category(&c, "gift", None), Err(AppError::Validation(_))));
        assert_eq!(resolve_category(&c, "gift", Some("expense")).unwrap(), e.id);
        let i = resolve_category(&c, "gift", Some("income")).unwrap();
        assert_ne!(e.id, i);
    }

    #[test]
    fn float_amount_rejected_mentions_cents() {
        match cents_arg(&json!(12.5), "amount") {
            Err(AppError::Validation(m)) => assert!(m.contains("integer cents"), "{m}"),
            other => panic!("expected Validation, got {other:?}"),
        }
        assert_eq!(cents_arg(&json!(1250), "amount").unwrap(), 1250);
    }

    #[test]
    fn zero_negative_and_string_amount_rejected() {
        for v in [json!(0), json!(-5), json!("12")] {
            match cents_arg(&v, "amount") {
                Err(AppError::Validation(m)) => assert!(m.contains("integer cents"), "{m}"),
                other => panic!("expected Validation for {v}, got {other:?}"),
            }
        }
    }

    #[test]
    fn bad_date_rejected() {
        assert!(matches!(parse_date("23/10/2026"), Err(AppError::Validation(_))));
        assert!(matches!(parse_date("2026-13-40"), Err(AppError::Validation(_))));
        assert_eq!(parse_date("2026-10-23").unwrap(), "2026-10-23");
    }

    #[test]
    fn fmt_myr_cases() {
        assert_eq!(fmt_myr(0), "RM 0.00");
        assert_eq!(fmt_myr(5), "RM 0.05");
        assert_eq!(fmt_myr(1234), "RM 12.34");
        assert_eq!(fmt_myr(123450), "RM 1,234.50");
        assert_eq!(fmt_myr(-250), "-RM 2.50");
    }

    #[test]
    fn integer_cents_allows_zero_and_negative_only_for_integers() {
        assert_eq!(integer_cents_arg(&json!(0), "x").unwrap(), 0);
        assert_eq!(integer_cents_arg(&json!(-250), "x").unwrap(), -250);
        for bad in [json!(1.5), json!("5"), json!(null)] {
            match integer_cents_arg(&bad, "x") {
                Err(AppError::Validation(m)) => assert!(m.contains("integer cents"), "{m}"),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn archived_resolvers_find_only_archived_by_name() {
        let c = open_in_memory().unwrap();
        let old = acct(&c, "Old");
        let live = acct(&c, "Live");
        service::archive_account(&c, &old).unwrap();
        assert_eq!(resolve_archived_account(&c, "old").unwrap(), old);
        assert_eq!(resolve_archived_account(&c, &live).unwrap(), live);
        assert!(matches!(resolve_archived_account(&c, "live"), Err(AppError::NotFound(_))));
        let cat = service::create_category(&c, "Snacks", "expense", "x", None, None).unwrap();
        service::archive_category(&c, &cat.id).unwrap();
        assert_eq!(resolve_archived_category(&c, "SNACKS").unwrap(), cat.id);
    }
}
