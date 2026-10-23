//! MCP tool registry and read tools. A pure layer over `rusqlite::Connection`:
//! no transport, no auditing (the server layer wraps writes). No SQL or
//! business rules here; everything delegates to `service` / `schedules`.
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::resolve;
use crate::error::{AppError, AppResult};
use crate::models::TransactionFilters;
use crate::{schedules, service};

/// One entry in the tool registry.
// Fields are consumed by the server layer in later tasks.
#[allow(dead_code)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// True for tools that mutate data (audited and rate limited by the server).
    pub writes: bool,
    pub schema: fn() -> Value,
}

// ── Argument structs ────────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoArgs {}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OverviewArgs {
    /// Month as YYYY-MM; defaults to the current month.
    month: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListAccountsArgs {
    /// Include archived accounts (default false).
    include_archived: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListCategoriesArgs {
    /// Filter by kind: "income" or "expense".
    kind: Option<String>,
    /// Include archived categories (default false).
    include_archived: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListTransactionsArgs {
    /// Account id or exact name.
    account_id: Option<String>,
    /// Category id or exact name.
    category_id: Option<String>,
    /// Transaction kind, e.g. "expense", "income", "transfer".
    kind: Option<String>,
    /// Inclusive start date, YYYY-MM-DD.
    from_date: Option<String>,
    /// Inclusive end date, YYYY-MM-DD.
    to_date: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MonthArgs {
    /// Month as YYYY-MM.
    month: String,
}

// ── Registry ────────────────────────────────────────────────────────────────

fn schema_of<T: JsonSchema>() -> Value {
    let mut v = serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| json!({}));
    if let Some(o) = v.as_object_mut() {
        o.insert("type".into(), json!("object"));
    }
    v
}

macro_rules! tool {
    ($name:expr, $desc:expr, $args:ty) => {
        ToolDef { name: $name, description: $desc, writes: false, schema: schema_of::<$args> }
    };
}

static TOOLS: &[ToolDef] = &[
    tool!("get_financial_overview", "One-call snapshot for a month: net worth, account balances, income/expense totals, upcoming scheduled items, the monthly plan and amounts awaiting reimbursement. Money fields carry a Formatted sibling (RM 12.34).", OverviewArgs),
    tool!("list_accounts", "List accounts with signed balances in integer cents (liabilities are negative).", ListAccountsArgs),
    tool!("get_account_balances", "Current balance of every active account, in integer cents.", NoArgs),
    tool!("list_categories", "List categories, optionally filtered by kind (income or expense).", ListCategoriesArgs),
    tool!("list_transactions", "List transactions, newest first. accountId and categoryId accept an id or an exact name.", ListTransactionsArgs),
    tool!("get_dashboard_summary", "Income, expense and net-worth summary for a month (YYYY-MM).", MonthArgs),
    tool!("get_plan", "The monthly plan (budgets and progress) for a month (YYYY-MM).", MonthArgs),
    tool!("list_schedules", "List recurring schedules.", NoArgs),
    tool!("list_upcoming", "List upcoming scheduled occurrences.", NoArgs),
    tool!("get_awaiting_reimbursement", "Expenses still awaiting reimbursement and the outstanding total.", NoArgs),
];

pub fn definitions() -> Vec<ToolDef> {
    TOOLS
        .iter()
        .map(|t| ToolDef { name: t.name, description: t.description, writes: t.writes, schema: t.schema })
        .collect()
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn parse_args<T: DeserializeOwned>(name: &str, args: Value) -> AppResult<T> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args)
        .map_err(|e| AppError::Validation(format!("Invalid arguments for {name}: {e}")))
}

fn valid_month(m: &str) -> AppResult<String> {
    let b = m.as_bytes();
    let ok = b.len() == 7
        && b.iter().enumerate().all(|(i, c)| if i == 4 { *c == b'-' } else { c.is_ascii_digit() })
        && matches!(m[5..].parse::<u32>(), Ok(1..=12));
    if ok {
        Ok(m.to_string())
    } else {
        Err(AppError::Validation(format!("Invalid month \"{m}\": use YYYY-MM")))
    }
}

fn to_json<T: serde::Serialize>(v: T) -> AppResult<Value> {
    serde_json::to_value(v).map_err(|e| AppError::Database(format!("Failed to serialize result: {e}")))
}

fn local_now() -> chrono::NaiveDateTime {
    chrono::Local::now().naive_local()
}

/// Walk `value` recursively; beside every integer `xxxCents` key insert
/// `xxxFormatted` holding the `RM 12.34` string.
pub fn with_formatted(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            let extra: Vec<(String, String)> = map
                .iter()
                .filter_map(|(k, v)| {
                    let stem = k.strip_suffix("Cents")?;
                    Some((format!("{stem}Formatted"), resolve::fmt_myr(v.as_i64()?)))
                })
                .collect();
            for v in map.values_mut() {
                *v = with_formatted(v.take());
            }
            for (k, s) in extra {
                map.insert(k, Value::String(s));
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                *v = with_formatted(v.take());
            }
        }
        _ => {}
    }
    value
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// Run a tool by name. Unknown name is `NotFound`; bad args are `Validation`.
// Called by the server layer in later tasks.
#[allow(dead_code)]
pub fn call(conn: &Connection, name: &str, args: Value) -> AppResult<Value> {
    let result = match name {
        "get_financial_overview" => {
            let a: OverviewArgs = parse_args(name, args)?;
            let month = match a.month {
                Some(m) => valid_month(&m)?,
                None => crate::today()[..7].to_string(),
            };
            let summary = service::get_dashboard_summary(conn, &month)?;
            let net_worth = summary.net_worth_cents;
            json!({
                "month": month,
                "netWorthCents": net_worth,
                "summary": to_json(summary)?,
                "upcoming": to_json(schedules::list_upcoming(conn, local_now())?)?,
                "plan": to_json(service::get_plan(conn, &month)?)?,
                "awaitingReimbursement": to_json(service::get_awaiting_reimbursement(conn)?)?,
            })
        }
        "list_accounts" => {
            let a: ListAccountsArgs = parse_args(name, args)?;
            to_json(service::list_accounts(conn, a.include_archived.unwrap_or(false))?)?
        }
        "get_account_balances" => {
            let _: NoArgs = parse_args(name, args)?;
            to_json(service::get_account_balances(conn)?)?
        }
        "list_categories" => {
            let a: ListCategoriesArgs = parse_args(name, args)?;
            to_json(service::list_categories(conn, a.kind.as_deref(), a.include_archived.unwrap_or(false))?)?
        }
        "list_transactions" => {
            let a: ListTransactionsArgs = parse_args(name, args)?;
            let account_id = a.account_id.as_deref().map(|k| resolve::resolve_account(conn, k)).transpose()?;
            let cat_kind = a.kind.as_deref().filter(|k| matches!(*k, "income" | "expense"));
            let category_id = a.category_id.as_deref().map(|k| resolve::resolve_category(conn, k, cat_kind)).transpose()?;
            let filters = TransactionFilters {
                account_id,
                category_id,
                kind: a.kind,
                from_date: a.from_date.as_deref().map(resolve::parse_date).transpose()?,
                to_date: a.to_date.as_deref().map(resolve::parse_date).transpose()?,
                limit: a.limit,
                offset: a.offset,
            };
            to_json(service::list_transactions(conn, filters)?)?
        }
        "get_dashboard_summary" => {
            let a: MonthArgs = parse_args(name, args)?;
            to_json(service::get_dashboard_summary(conn, &valid_month(&a.month)?)?)?
        }
        "get_plan" => {
            let a: MonthArgs = parse_args(name, args)?;
            to_json(service::get_plan(conn, &valid_month(&a.month)?)?)?
        }
        "list_schedules" => {
            let _: NoArgs = parse_args(name, args)?;
            to_json(schedules::list_schedules(conn, local_now())?)?
        }
        "list_upcoming" => {
            let _: NoArgs = parse_args(name, args)?;
            to_json(schedules::list_upcoming(conn, local_now())?)?
        }
        "get_awaiting_reimbursement" => {
            let _: NoArgs = parse_args(name, args)?;
            to_json(service::get_awaiting_reimbursement(conn)?)?
        }
        other => return Err(AppError::NotFound(format!("Unknown tool \"{other}\""))),
    };
    Ok(with_formatted(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::service;
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::collections::HashSet;

    fn seeded() -> (Connection, String) {
        let c = open_in_memory().unwrap();
        let a = service::create_account(&c, "Maybank", "cash", 100_000, None, None, None, None).unwrap().id;
        service::create_account(&c, "Wallet", "cash", 5_000, None, None, None, None).unwrap();
        let cat = service::create_category(&c, "Lunch Runs", "expense", "x", None, None).unwrap().id;
        service::create_expense(&c, &a, Some(&cat), 1250, Some("Lunch"), &crate::today(), Some("00:00"), false, None).unwrap();
        (c, a)
    }

    #[test]
    fn definitions_have_unique_names_and_object_schemas() {
        let defs = definitions();
        let names: HashSet<_> = defs.iter().map(|d| d.name).collect();
        assert_eq!(names.len(), defs.len());
        assert_eq!(defs.len(), 10);
        for d in &defs {
            assert!(!d.writes, "{}", d.name);
            assert!(!d.description.is_empty());
            assert_eq!((d.schema)()["type"], "object", "{}", d.name);
        }
    }

    #[test]
    fn definitions_exclude_forbidden_tools() {
        for d in definitions() {
            assert!(!matches!(d.name, "reset_app" | "set_setting" | "get_setting"), "{}", d.name);
            for bad in ["ai_provider", "ocr", "draft"] {
                assert!(!d.name.contains(bad), "{}", d.name);
            }
        }
    }

    fn check_formatted(v: &Value) {
        match v {
            Value::Object(m) => {
                for (k, val) in m {
                    if let (Some(stem), true) = (k.strip_suffix("Cents"), val.is_i64()) {
                        let f = m.get(&format!("{stem}Formatted")).and_then(|f| f.as_str()).expect(k);
                        assert!(f.starts_with("RM ") || f.starts_with("-RM "), "{f}");
                    }
                    check_formatted(val);
                }
            }
            Value::Array(a) => a.iter().for_each(check_formatted),
            _ => {}
        }
    }

    #[test]
    fn overview_contains_net_worth_month_upcoming_and_plan() {
        let (c, _) = seeded();
        let v = call(&c, "get_financial_overview", json!({})).unwrap();
        for k in ["month", "netWorthCents", "netWorthFormatted", "summary", "upcoming", "plan", "awaitingReimbursement"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["month"], crate::today()[..7]);
        assert_eq!(v["netWorthCents"], 103_750);
        assert_eq!(v["netWorthFormatted"], "RM 1,037.50");
        assert!(v["summary"].to_string().contains("Formatted"));
        check_formatted(&v);
    }

    #[test]
    fn list_transactions_resolves_account_by_name() {
        let (c, a) = seeded();
        let v = call(&c, "list_transactions", json!({"accountId": "maybank", "kind": "expense"})).unwrap();
        let rows = v.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["accountId"], a.as_str());
        assert_eq!(rows[0]["amountCents"], 1250);
        assert_eq!(rows[0]["amountFormatted"], "RM 12.50");
    }

    #[test]
    fn unknown_tool_is_not_found() {
        let c = open_in_memory().unwrap();
        assert!(matches!(call(&c, "reset_app", json!({})), Err(AppError::NotFound(_))));
    }

    #[test]
    fn bad_args_are_validation_errors() {
        let c = open_in_memory().unwrap();
        assert!(matches!(call(&c, "list_accounts", json!({"bogus": 1})), Err(AppError::Validation(_))));
        assert!(matches!(call(&c, "get_plan", json!({"month": "2026-13"})), Err(AppError::Validation(_))));
        assert!(matches!(call(&c, "list_transactions", json!({"fromDate": "x"})), Err(AppError::Validation(_))));
    }
}
