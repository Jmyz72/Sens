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
use crate::models::{Allocation, SplitInput, TransactionFilters, UpdateTransactionInput};
use crate::{schedules, service};

/// One entry in the tool registry.
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
    /// Rows to return: default 200, at most 1000.
    limit: Option<i64>,
    /// Rows to skip, for paging (default 0).
    offset: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MonthArgs {
    /// Month as YYYY-MM.
    month: String,
}

// Write-tool amounts arrive as raw JSON so `resolve::cents_arg` can reject
// floats, strings, zero and negatives with a message that says "integer cents".
// The schema still advertises them as integers.

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SplitArg {
    /// Category id or exact name.
    category_id: String,
    /// Positive integer cents.
    #[schemars(with = "i64")]
    amount_cents: Value,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AllocationArg {
    /// Id of the expense this reimbursement repays.
    expense_id: String,
    /// Positive integer cents.
    #[schemars(with = "i64")]
    amount_cents: Value,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateEntryArgs {
    /// Account id or exact name.
    account_id: String,
    /// Category id or exact name.
    category_id: Option<String>,
    /// Positive integer cents (1250 = RM 12.50).
    #[schemars(with = "i64")]
    amount_cents: Value,
    description: Option<String>,
    /// YYYY-MM-DD.
    date: String,
    /// HH:MM (24h); required unless the app has times turned off.
    time: Option<String>,
    /// Leave out of reports and the plan (default false).
    excluded_from_reporting: Option<bool>,
    /// Split across categories; amounts must add up to amountCents.
    splits: Option<Vec<SplitArg>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateMoveArgs {
    /// Source account id or exact name.
    from_account_id: String,
    /// Destination account id or exact name.
    to_account_id: String,
    /// Positive integer cents (1250 = RM 12.50).
    #[schemars(with = "i64")]
    amount_cents: Value,
    description: Option<String>,
    /// YYYY-MM-DD.
    date: String,
    /// HH:MM (24h); required unless the app has times turned off.
    time: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateReimbursementArgs {
    /// Account that receives the money: id or exact name.
    account_id: String,
    /// Positive integer cents (1250 = RM 12.50).
    #[schemars(with = "i64")]
    amount_cents: Value,
    description: Option<String>,
    /// YYYY-MM-DD.
    date: String,
    /// HH:MM (24h); required unless the app has times turned off.
    time: Option<String>,
    /// Which expenses this repays; amounts must add up to amountCents.
    allocations: Vec<AllocationArg>,
}

/// Patch args: an omitted field keeps the current value. Fields typed
/// `Option<Option<_>>` (via `patch`) also tell an explicit `null` (clear) apart.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateTransactionArgs {
    /// Transaction id.
    id: String,
    /// "income", "expense", "transfer" or "payment".
    kind: Option<String>,
    /// Account id or exact name.
    account_id: Option<String>,
    /// Destination account id or name (transfers and payments).
    #[serde(default, deserialize_with = "patch")]
    #[schemars(with = "Option<String>")]
    to_account_id: Option<Option<String>>,
    /// Category id or exact name.
    #[serde(default, deserialize_with = "patch")]
    #[schemars(with = "Option<String>")]
    category_id: Option<Option<String>>,
    /// Positive integer cents (1250 = RM 12.50).
    #[schemars(with = "Option<i64>")]
    amount_cents: Option<Value>,
    /// null clears it.
    #[serde(default, deserialize_with = "patch")]
    #[schemars(with = "Option<String>")]
    description: Option<Option<String>>,
    /// YYYY-MM-DD.
    transaction_date: Option<String>,
    /// HH:MM (24h).
    #[serde(default, deserialize_with = "patch")]
    #[schemars(with = "Option<String>")]
    transaction_time: Option<Option<String>>,
    /// Leave out of reports and the plan.
    excluded_from_reporting: Option<bool>,
    /// Omit to keep the current split lines; [] or null removes the split.
    #[serde(default, deserialize_with = "patch")]
    #[schemars(with = "Option<Vec<SplitArg>>")]
    splits: Option<Option<Vec<SplitArg>>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedReimbursementArgs {
    /// Expense transaction id.
    expense_id: String,
    /// Positive integer cents expected back; omit or null to clear.
    #[schemars(with = "Option<i64>")]
    expected_cents: Option<Value>,
}

// ── Registry ────────────────────────────────────────────────────────────────

pub(super) fn schema_of<T: JsonSchema>() -> Value {
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

macro_rules! wtool {
    ($name:expr, $desc:expr, $args:ty) => {
        ToolDef { name: $name, description: $desc, writes: true, schema: schema_of::<$args> }
    };
}

static TOOLS: &[ToolDef] = &[
    tool!("get_financial_overview", "One-call snapshot for a month: net worth, account balances, income/expense totals, upcoming scheduled items, the monthly plan and amounts awaiting reimbursement. Money fields carry a Formatted sibling (RM 12.34).", OverviewArgs),
    tool!("list_accounts", "List accounts with signed balances in integer cents (liabilities are negative).", ListAccountsArgs),
    tool!("get_account_balances", "Current balance of every active account, in integer cents.", NoArgs),
    tool!("list_categories", "List categories, optionally filtered by kind (income or expense).", ListCategoriesArgs),
    tool!("list_transactions", "List transactions, newest first. accountId and categoryId accept an id or an exact name. limit defaults to 200 and is capped at 1000; page with offset.", ListTransactionsArgs),
    tool!("get_dashboard_summary", "Income, expense and net-worth summary for a month (YYYY-MM).", MonthArgs),
    tool!("get_plan", "The monthly plan (budgets and progress) for a month (YYYY-MM).", MonthArgs),
    tool!("list_schedules", "List recurring schedules.", NoArgs),
    tool!("list_upcoming", "List upcoming scheduled occurrences.", NoArgs),
    tool!("get_awaiting_reimbursement", "Expenses still awaiting reimbursement and the outstanding total.", NoArgs),
    wtool!("create_income", "Record income into an account. Amounts are integer cents; account and category accept an id or exact name; date is YYYY-MM-DD.", CreateEntryArgs),
    wtool!("create_expense", "Record an expense from an account, optionally split across categories. Amounts are integer cents; account and category accept an id or exact name; date is YYYY-MM-DD.", CreateEntryArgs),
    wtool!("create_transfer", "Move money between two of your accounts (not to a credit card or BNPL; use create_payment). Amounts are integer cents.", CreateMoveArgs),
    wtool!("create_payment", "Pay off a credit card or BNPL account from another account. Amounts are integer cents.", CreateMoveArgs),
    wtool!("create_reimbursement", "Record money received that repays one or more expenses. allocations lists the expenses repaid; amounts are integer cents.", CreateReimbursementArgs),
    wtool!("update_transaction", "Change an existing income, expense, transfer or payment. Patch: send id plus only the fields to change; an omitted field keeps its current value and null clears an optional one (such as description). splits: omit to keep the current split lines; [] or null removes the split and uses categoryId (or the current header category). A split transaction's amountCents can only change together with new splits that add up to it. When changing kind, also send the fields the new kind needs. Reimbursements, adjustments and opening balances can't be edited here.", UpdateTransactionArgs),
    wtool!("delete_transaction", "Permanently delete a transaction by id.", IdArgs),
    wtool!("set_expected_reimbursement", "Mark an expense as expecting a reimbursement of expectedCents (integer cents), or clear it by omitting expectedCents.", ExpectedReimbursementArgs),
];

pub fn definitions() -> Vec<ToolDef> {
    TOOLS
        .iter()
        .map(|t| ToolDef { name: t.name, description: t.description, writes: t.writes, schema: t.schema })
        .chain(super::tools_manage::definitions())
        .collect()
}

// ── Helpers ─────────────────────────────────────────────────────────────────

pub(super) fn parse_args<T: DeserializeOwned>(name: &str, args: Value) -> AppResult<T> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args)
        .map_err(|e| AppError::Validation(format!("Invalid arguments for {name}: {}", plain_words(&e.to_string()))))
}

/// Swap Rust type names in a serde message for plain words.
fn plain_words(msg: &str) -> String {
    let mut out = String::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        out.push_str(match word.as_str() {
            "i64" | "u64" | "i32" | "u32" | "usize" => "an integer",
            "f64" | "f32" => "a number",
            "bool" => "a true/false value",
            "String" => "text",
            w => w,
        });
        word.clear();
    };
    for ch in msg.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            word.push(ch);
        } else {
            flush(&mut word, &mut out);
            out.push(ch);
        }
    }
    flush(&mut word, &mut out);
    out
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

pub(super) fn to_json<T: serde::Serialize>(v: T) -> AppResult<Value> {
    serde_json::to_value(v).map_err(|e| AppError::Database(format!("Failed to serialize result: {e}")))
}

pub(super) fn local_now() -> chrono::NaiveDateTime {
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

/// `deserialize_with` for patch fields: present (even `null`) becomes `Some`,
/// so with `#[serde(default)]` an omitted field stays `None`.
pub(super) fn patch<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Optional positive cents from a raw JSON amount; absent or null is `None`.
pub(super) fn opt_cents(v: Option<&Value>, field: &str) -> AppResult<Option<i64>> {
    v.filter(|v| !v.is_null()).map(|v| cents(v, field)).transpose()
}

/// Validated positive cents from a raw JSON amount.
pub(super) fn cents(v: &Value, field: &str) -> AppResult<i64> {
    resolve::cents_arg(v, field)
}

fn resolve_splits(conn: &Connection, splits: Option<Vec<SplitArg>>, kind: Option<&str>) -> AppResult<Option<Vec<SplitInput>>> {
    splits
        .map(|v| {
            v.into_iter()
                .map(|s| {
                    Ok(SplitInput {
                        amount_cents: cents(&s.amount_cents, "splits.amountCents")?,
                        category_id: resolve::resolve_category(conn, &s.category_id, kind)?,
                    })
                })
                .collect()
        })
        .transpose()
}

fn create_entry(conn: &Connection, name: &str, kind: &'static str, args: Value) -> AppResult<Value> {
    let a: CreateEntryArgs = parse_args(name, args)?;
    let amount = cents(&a.amount_cents, "amountCents")?;
    let date = resolve::parse_date(&a.date)?;
    let account_id = resolve::resolve_account(conn, &a.account_id)?;
    let category_id = a.category_id.as_deref().map(|k| resolve::resolve_category(conn, k, Some(kind))).transpose()?;
    let splits = resolve_splits(conn, a.splits, Some(kind))?;
    let (desc, time, excl) = (a.description.as_deref(), a.time.as_deref(), a.excluded_from_reporting.unwrap_or(false));
    let t = if kind == "income" {
        service::create_income(conn, &account_id, category_id.as_deref(), amount, desc, &date, time, excl, splits)?
    } else {
        service::create_expense(conn, &account_id, category_id.as_deref(), amount, desc, &date, time, excl, splits)?
    };
    to_json(t)
}

fn create_move(conn: &Connection, name: &str, payment: bool, args: Value) -> AppResult<Value> {
    let a: CreateMoveArgs = parse_args(name, args)?;
    let amount = cents(&a.amount_cents, "amountCents")?;
    let date = resolve::parse_date(&a.date)?;
    let from = resolve::resolve_account(conn, &a.from_account_id)?;
    let to = resolve::resolve_account(conn, &a.to_account_id)?;
    let (desc, time) = (a.description.as_deref(), a.time.as_deref());
    let t = if payment {
        service::create_payment(conn, &from, &to, amount, desc, &date, time)?
    } else {
        service::create_transfer(conn, &from, &to, amount, desc, &date, time)?
    };
    to_json(t)
}

/// Patch update: omitted fields keep the stored value, then the full set goes
/// through `service::update_transaction` so every service rule still runs.
fn update_transaction(conn: &Connection, name: &str, args: Value) -> AppResult<Value> {
    let a: UpdateTransactionArgs = parse_args(name, args)?;
    // Raw amount and date checks come before any read or write.
    let amount = opt_cents(a.amount_cents.as_ref(), "amountCents")?;
    let date = a.transaction_date.as_deref().map(resolve::parse_date).transpose()?;
    let cur = service::get_transaction(conn, &a.id)?;
    let kind = a.kind.unwrap_or_else(|| cur.kind.clone());
    // Kind-specific fields carry over only while the kind stays the same.
    let same_kind = kind == cur.kind;
    let cat_kind = Some(kind.as_str()).filter(|k| matches!(*k, "income" | "expense"));
    let account_id = match a.account_id {
        Some(k) => resolve::resolve_account(conn, &k)?,
        None => cur.account_id.clone(),
    };
    let to_account_id = match a.to_account_id {
        Some(Some(k)) => Some(resolve::resolve_account(conn, &k)?),
        Some(None) => None,
        None => cur.to_account_id.clone().filter(|_| same_kind),
    };
    let category_id = match a.category_id {
        Some(Some(k)) => Some(resolve::resolve_category(conn, &k, cat_kind)?),
        Some(None) => None,
        None => cur.category_id.clone().filter(|_| same_kind),
    };
    let splits = match a.splits {
        Some(v) => resolve_splits(conn, v, cat_kind)?,
        None if same_kind && cat_kind.is_some() && !cur.splits.is_empty() => Some(
            cur.splits
                .iter()
                .map(|s| SplitInput { category_id: s.category_id.clone(), amount_cents: s.amount_cents })
                .collect(),
        ),
        None => None,
    };
    let input = UpdateTransactionInput {
        id: a.id,
        kind,
        account_id,
        to_account_id,
        category_id,
        amount_cents: amount.unwrap_or(cur.amount_cents),
        description: a.description.unwrap_or(cur.description),
        transaction_date: date.unwrap_or(cur.transaction_date),
        transaction_time: a.transaction_time.unwrap_or(cur.transaction_time),
        excluded_from_reporting: a.excluded_from_reporting.unwrap_or(cur.excluded_from_reporting),
        splits,
    };
    to_json(service::update_transaction(conn, input)?)
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// Run a tool by name. Unknown name is `NotFound`; bad args are `Validation`.
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
                // The repo filter is exclusive; the tool contract is inclusive.
                to_date: a
                    .to_date
                    .as_deref()
                    .map(|d| {
                        let d = resolve::parse_date(d)?;
                        let next = chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d")
                            .ok()
                            .and_then(|x| x.checked_add_signed(chrono::Duration::days(1)))
                            .ok_or_else(|| AppError::Validation(format!("Invalid date \"{d}\"")))?;
                        Ok::<String, AppError>(next.format("%Y-%m-%d").to_string())
                    })
                    .transpose()?,
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
        "create_income" => create_entry(conn, name, "income", args)?,
        "create_expense" => create_entry(conn, name, "expense", args)?,
        "create_transfer" => create_move(conn, name, false, args)?,
        "create_payment" => create_move(conn, name, true, args)?,
        "create_reimbursement" => {
            let a: CreateReimbursementArgs = parse_args(name, args)?;
            let amount = cents(&a.amount_cents, "amountCents")?;
            let date = resolve::parse_date(&a.date)?;
            let account_id = resolve::resolve_account(conn, &a.account_id)?;
            let allocations = a
                .allocations
                .into_iter()
                .map(|x| Ok(Allocation { expense_id: x.expense_id, amount_cents: cents(&x.amount_cents, "allocations.amountCents")? }))
                .collect::<AppResult<Vec<_>>>()?;
            to_json(service::create_reimbursement(conn, &account_id, amount, a.description.as_deref(), &date, a.time.as_deref(), allocations)?)?
        }
        "update_transaction" => update_transaction(conn, name, args)?,
        "delete_transaction" => {
            let a: IdArgs = parse_args(name, args)?;
            service::delete_transaction(conn, &a.id)?;
            json!({"deleted": true, "id": a.id})
        }
        "set_expected_reimbursement" => {
            let a: ExpectedReimbursementArgs = parse_args(name, args)?;
            let expected = a.expected_cents.filter(|v| !v.is_null()).map(|v| cents(&v, "expectedCents")).transpose()?;
            to_json(service::set_expected_reimbursement(conn, &a.expense_id, expected)?)?
        }
        other => match super::tools_manage::call(conn, other, args) {
            Some(r) => r?,
            None => return Err(AppError::NotFound(format!("Unknown tool \"{other}\""))),
        },
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
        for d in &defs {
            let is_write = ["create_", "update_", "delete_", "set_", "archive_", "restore_", "post_", "skip_"]
                .iter()
                .any(|p| d.name.starts_with(p));
            assert_eq!(d.writes, is_write, "{}", d.name);
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

    #[test]
    fn list_transactions_to_date_is_inclusive() {
        let c = open_in_memory().unwrap();
        let a = service::create_account(&c, "Maybank", "cash", 0, None, None, None, None).unwrap().id;
        let cat = service::create_category(&c, "Lunch Runs", "expense", "x", None, None).unwrap().id;
        for d in ["2026-10-30", "2026-10-31"] {
            service::create_expense(&c, &a, Some(&cat), 100, None, d, Some("00:00"), false, None).unwrap();
        }
        let n = |args: Value| call(&c, "list_transactions", args).unwrap().as_array().unwrap().len();
        assert_eq!(n(json!({"kind": "expense", "toDate": "2026-10-31"})), 2);
        assert_eq!(n(json!({"kind": "expense", "toDate": "2026-10-30"})), 1);
        let from = call(&c, "list_transactions", json!({"kind": "expense", "fromDate": "2026-10-31"})).unwrap();
        let rows = from.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["transactionDate"], "2026-10-31");
    }

    #[test]
    fn bad_arg_messages_are_plain_language() {
        let c = open_in_memory().unwrap();
        let msg = |r: AppResult<Value>| match r {
            Err(AppError::Validation(m)) => m,
            other => panic!("expected Validation, got {other:?}"),
        };
        let m = msg(call(&c, "list_accounts", json!({"bogus": 1})));
        assert!(m.contains("bogus") && m.contains("list_accounts"), "{m}");
        let m = msg(call(&c, "list_transactions", json!({"limit": "ten"})));
        assert!(m.contains("integer"), "{m}");
        for bad in ["i64", "u64", "usize"] {
            assert!(!m.contains(bad), "{m}");
        }
    }

    #[test]
    fn all_read_tools_run_on_empty_db() {
        let c = open_in_memory().unwrap();
        for d in definitions() {
            if d.writes {
                continue;
            }
            let args = if matches!(d.name, "get_dashboard_summary" | "get_plan") {
                json!({"month": "2026-10"})
            } else {
                json!({})
            };
            call(&c, d.name, args).unwrap_or_else(|e| panic!("{}: {e:?}", d.name));
        }
    }

    fn count_and_balance(c: &Connection, acct: &str) -> (usize, i64) {
        let n = service::list_transactions(c, TransactionFilters::default()).unwrap().len();
        let b = service::get_account_balances(c).unwrap().into_iter().find(|b| b.account_id == acct).unwrap().balance_cents;
        (n, b)
    }

    #[test]
    fn create_expense_by_names_posts_and_changes_balance() {
        let (c, a) = seeded();
        let before = count_and_balance(&c, &a);
        let v = call(&c, "create_expense", json!({"accountId": "maybank", "categoryId": "lunch runs", "amountCents": 800, "description": "Nasi", "date": "2026-10-23", "time": "12:00"})).unwrap();
        assert_eq!(v["amountCents"], 800);
        assert_eq!(v["amountFormatted"], "RM 8.00");
        assert_eq!(v["accountId"], a.as_str());
        let after = count_and_balance(&c, &a);
        assert_eq!(after.0, before.0 + 1);
        assert_eq!(after.1, before.1 - 800);
    }

    #[test]
    fn create_income_by_names_posts() {
        let (c, a) = seeded();
        let cat = service::create_category(&c, "Side Gig", "income", "x", None, None).unwrap().id;
        let before = count_and_balance(&c, &a);
        let v = call(&c, "create_income", json!({"accountId": "Maybank", "categoryId": "side gig", "amountCents": 5000, "date": "2026-10-23", "time": "12:00"})).unwrap();
        assert_eq!(v["categoryId"], cat.as_str());
        assert_eq!(v["kind"], "income");
        assert_eq!(count_and_balance(&c, &a).1, before.1 + 5000);
    }

    #[test]
    fn float_amount_writes_nothing() {
        let (c, a) = seeded();
        let before = count_and_balance(&c, &a);
        for bad in [json!(12.5), json!(0), json!(-5), json!("100")] {
            let r = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": bad, "date": "2026-10-23", "time": "12:00"}));
            match r {
                Err(AppError::Validation(m)) => assert!(m.contains("integer cents"), "{m}"),
                other => panic!("expected Validation, got {other:?}"),
            }
        }
        assert_eq!(count_and_balance(&c, &a), before);
    }

    #[test]
    fn bad_date_writes_nothing() {
        let (c, a) = seeded();
        let before = count_and_balance(&c, &a);
        for bad in ["23/10/2026", "2026-13-40"] {
            let r = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": 100, "date": bad, "time": "12:00"}));
            assert!(matches!(r, Err(AppError::Validation(_))), "{bad}");
        }
        assert_eq!(count_and_balance(&c, &a), before);
    }

    #[test]
    fn delete_transaction_removes_it() {
        let (c, a) = seeded();
        let v = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": 300, "date": "2026-10-23", "time": "12:00"})).unwrap();
        let id = v["id"].as_str().unwrap().to_string();
        let before = count_and_balance(&c, &a);
        let d = call(&c, "delete_transaction", json!({"id": id})).unwrap();
        assert_eq!(d, json!({"deleted": true, "id": id}));
        let after = count_and_balance(&c, &a);
        assert_eq!(after.0, before.0 - 1);
        assert_eq!(after.1, before.1 + 300);
    }

    #[test]
    fn create_transfer_same_account_is_validation_error() {
        let (c, a) = seeded();
        let before = count_and_balance(&c, &a);
        let r = call(&c, "create_transfer", json!({"fromAccountId": "Maybank", "toAccountId": "maybank", "amountCents": 100, "date": "2026-10-23", "time": "12:00"}));
        assert!(matches!(r, Err(AppError::Validation(_))), "{r:?}");
        assert_eq!(count_and_balance(&c, &a), before);
    }

    #[test]
    fn create_payment_to_credit_card_reduces_liability() {
        let (c, a) = seeded();
        let card = service::create_account(&c, "Visa", "credit-card", 0, None, Some(500_000), None, None).unwrap().id;
        let cat = service::list_categories(&c, Some("expense"), false).unwrap()[0].id.clone();
        service::create_expense(&c, &card, Some(&cat), 4000, None, "2026-10-22", Some("00:00"), false, None).unwrap();
        let before = count_and_balance(&c, &card).1;
        let v = call(&c, "create_payment", json!({"fromAccountId": "Maybank", "toAccountId": "Visa", "amountCents": 1500, "date": "2026-10-23", "time": "12:00"})).unwrap();
        assert_eq!(v["kind"], "payment");
        assert_eq!(count_and_balance(&c, &card).1, before + 1500);
        assert_eq!(count_and_balance(&c, &a).1, 100_000 - 1250 - 1500);
    }

    #[test]
    fn update_transaction_changes_description() {
        let (c, a) = seeded();
        let v = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": 300, "description": "Old", "date": "2026-10-23", "time": "12:00"})).unwrap();
        let id = v["id"].as_str().unwrap();
        let u = call(&c, "update_transaction", json!({
            "id": id, "kind": "expense", "accountId": "Maybank", "categoryId": "Lunch Runs",
            "amountCents": 300, "description": "New", "transactionDate": "2026-10-23", "transactionTime": "12:00"
        })).unwrap();
        assert_eq!(u["description"], "New");
        assert_eq!(u["id"], id);
        assert_eq!(u["accountId"], a.as_str());
    }

    /// A split expense (200 + 100) that is excluded from reporting.
    fn split_expense(c: &Connection) -> Value {
        service::create_category(c, "Groceries Run", "expense", "x", None, None).unwrap();
        call(c, "create_expense", json!({
            "accountId": "Maybank", "amountCents": 300, "description": "Old", "date": "2026-10-23", "time": "12:00",
            "excludedFromReporting": true,
            "splits": [{"categoryId": "Lunch Runs", "amountCents": 200}, {"categoryId": "Groceries Run", "amountCents": 100}]
        })).unwrap()
    }

    #[test]
    fn update_transaction_keeps_excluded_flag_and_splits_when_omitted() {
        let (c, a) = seeded();
        let t = split_expense(&c);
        let id = t["id"].as_str().unwrap();
        let u = call(&c, "update_transaction", json!({"id": id, "description": "New"})).unwrap();
        assert_eq!(u["description"], "New");
        assert_eq!(u["excludedFromReporting"], true);
        assert_eq!(u["splits"], t["splits"]);
        assert_eq!(u["amountCents"], 300);
        assert_eq!(u["kind"], "expense");
        assert_eq!(u["accountId"], a.as_str());
        assert_eq!(u["transactionDate"], "2026-10-23");
        assert_eq!(u["transactionTime"], "12:00");
    }

    #[test]
    fn update_transaction_null_clears_description() {
        let (c, _) = seeded();
        let t = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": 300, "description": "Old", "date": "2026-10-23", "time": "12:00"})).unwrap();
        let id = t["id"].as_str().unwrap();
        // Omitted keeps it.
        let u = call(&c, "update_transaction", json!({"id": id, "amountCents": 450})).unwrap();
        assert_eq!(u["description"], "Old");
        assert_eq!(u["amountCents"], 450);
        // Explicit null clears it.
        let u = call(&c, "update_transaction", json!({"id": id, "description": null})).unwrap();
        assert!(u["description"].is_null(), "{u}");
        assert_eq!(u["amountCents"], 450);
    }

    #[test]
    fn update_transaction_one_field_on_split_keeps_splits_and_total() {
        let (c, a) = seeded();
        let t = split_expense(&c);
        let id = t["id"].as_str().unwrap();
        let before = count_and_balance(&c, &a);
        let u = call(&c, "update_transaction", json!({"id": id, "transactionDate": "2026-10-20"})).unwrap();
        assert_eq!(u["transactionDate"], "2026-10-20");
        assert_eq!(u["splits"], t["splits"]);
        assert_eq!(u["amountCents"], 300);
        // Echoing back the header categoryId (as list_transactions shows it) keeps the split.
        let u = call(&c, "update_transaction", json!({"id": id, "categoryId": t["categoryId"].clone()})).unwrap();
        assert_eq!(u["splits"].as_array().unwrap().len(), 2);
        assert_eq!(count_and_balance(&c, &a), before);
        // An explicit empty list removes the split and uses categoryId.
        let u = call(&c, "update_transaction", json!({"id": id, "splits": [], "categoryId": "Lunch Runs"})).unwrap();
        assert!(u["splits"].as_array().unwrap().is_empty());
        assert_eq!(u["amountCents"], 300);
    }

    #[test]
    fn update_transaction_validates_amount_and_date_before_writing() {
        let (c, _) = seeded();
        let t = call(&c, "create_expense", json!({"accountId": "Maybank", "categoryId": "Lunch Runs", "amountCents": 300, "date": "2026-10-23", "time": "12:00"})).unwrap();
        let id = t["id"].as_str().unwrap();
        for bad in [json!({"id": id, "amountCents": 1.5}), json!({"id": id, "transactionDate": "23/10/2026"})] {
            assert!(matches!(call(&c, "update_transaction", bad), Err(AppError::Validation(_))));
        }
        let rows = service::list_transactions(&c, TransactionFilters::default()).unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!((row.amount_cents, row.transaction_date.as_str()), (300, "2026-10-23"));
        assert!(matches!(call(&c, "update_transaction", json!({"id": "nope", "description": "x"})), Err(AppError::NotFound(_))));
    }

    #[test]
    fn patch_update_schemas_require_only_id() {
        let defs = definitions();
        for n in ["update_transaction", "update_schedule", "update_goal"] {
            let d = defs.iter().find(|d| d.name == n).unwrap();
            let schema = (d.schema)();
            assert_eq!(schema["required"], json!(["id"]), "{n}: {schema}");
            assert!(d.description.contains("omitted field keeps"), "{n}");
        }
    }

    #[test]
    fn definitions_mark_all_create_update_delete_tools_as_writes() {
        let defs = definitions();
        for n in ["create_income", "create_expense", "create_transfer", "create_payment", "create_reimbursement", "update_transaction", "delete_transaction", "set_expected_reimbursement"] {
            let d = defs.iter().find(|d| d.name == n).unwrap_or_else(|| panic!("missing {n}"));
            assert!(d.writes, "{n}");
            assert_eq!((d.schema)()["type"], "object");
        }
        for d in defs.iter().filter(|d| d.name.starts_with("create_") || d.name.starts_with("update_") || d.name.starts_with("delete_")) {
            assert!(d.writes, "{}", d.name);
        }
    }
}
