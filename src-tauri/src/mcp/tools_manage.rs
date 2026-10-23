//! MCP write tools for budgets, goals, schedules, accounts and categories.
//! Same rules as `tools`: no SQL, no business rules, no auditing.
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use super::resolve;
use super::tools::{cents, local_now, parse_args, schema_of, to_json, ToolDef};
use crate::error::{AppError, AppResult};
use crate::models::{BudgetWrite, GoalWrite, ScheduleWrite, UpdateAccountInput, UpdateCategoryInput, ValueCategories};
use crate::{schedules, service};

// ── Argument structs ────────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdArgs {
    /// Id or exact name.
    id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleIdArgs {
    /// Schedule id.
    id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BudgetArg {
    /// Expense category id or exact name.
    category_id: String,
    /// Monthly budget in integer cents (zero allowed); null clears the budget.
    #[schemars(with = "Option<i64>")]
    amount_cents: Option<Value>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetBudgetsArgs {
    items: Vec<BudgetArg>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoalArgs {
    /// Goal id; required for update_goal, not allowed for create_goal.
    id: Option<String>,
    name: String,
    /// Account the goal sits on: id or exact name.
    account_id: String,
    /// Positive integer cents.
    #[schemars(with = "i64")]
    target_cents: Value,
    /// YYYY-MM-DD.
    target_date: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleArgs {
    /// Schedule id; required for update_schedule, not allowed for create_schedule.
    id: Option<String>,
    /// "auto" posts by itself, "tap" waits for you to post or skip.
    mode: String,
    /// "income", "expense", "transfer" or "payment".
    kind: String,
    /// Positive integer cents.
    #[schemars(with = "i64")]
    amount_cents: Value,
    /// Account id or exact name.
    account_id: String,
    /// Destination account id or name (transfer and payment).
    to_account_id: Option<String>,
    /// Category id or exact name (income and expense).
    category_id: Option<String>,
    description: Option<String>,
    /// First date, YYYY-MM-DD.
    start_date: String,
    /// HH:MM (24h); required unless the app has times turned off.
    time: Option<String>,
    /// "daily", "weekly", "monthly" or "yearly".
    frequency: String,
    /// Repeat every N periods (default 1).
    interval: Option<i64>,
    /// Weekly: "mon".."sun".
    #[serde(default)]
    weekdays: Vec<String>,
    /// Monthly: "each" (default) or "onThe".
    month_mode: Option<String>,
    /// Monthly "each": days of the month.
    #[serde(default)]
    month_days: Vec<i64>,
    /// Monthly "onThe": first, second, third, fourth, fifth or last.
    ordinal: Option<String>,
    /// Monthly "onThe": "weekday", "weekend" or a day name.
    ordinal_day: Option<String>,
    /// Yearly: months 1-12.
    #[serde(default)]
    months: Vec<i64>,
    day_of_month: Option<i64>,
    /// "never" (default), "after" or "on".
    end_mode: Option<String>,
    /// End "after" this many occurrences.
    end_count: Option<i64>,
    /// End "on" this date, YYYY-MM-DD.
    end_date: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PostOccurrenceArgs {
    schedule_id: String,
    /// The occurrence date, YYYY-MM-DD.
    date: String,
    /// Positive integer cents actually paid or received.
    #[schemars(with = "i64")]
    amount_cents: Value,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkipOccurrenceArgs {
    schedule_id: String,
    /// The occurrence date, YYYY-MM-DD.
    date: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateAccountArgs {
    name: String,
    /// Account subtype, e.g. "cash", "savings", "credit-card".
    subtype: String,
    /// Integer cents (default 0).
    #[schemars(with = "Option<i64>")]
    opening_balance_cents: Option<Value>,
    template_key: Option<String>,
    /// Positive integer cents (credit cards).
    #[schemars(with = "Option<i64>")]
    credit_limit_cents: Option<Value>,
    /// Category id or name used for investment gains.
    gain_category_id: Option<String>,
    /// Category id or name used for investment losses.
    loss_category_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValueCategoriesArg {
    gain_category_id: Option<String>,
    loss_category_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAccountArgs {
    /// Account id or exact name.
    id: String,
    name: Option<String>,
    subtype: Option<String>,
    /// Integer cents.
    #[schemars(with = "Option<i64>")]
    opening_balance_cents: Option<Value>,
    /// Positive integer cents.
    #[schemars(with = "Option<i64>")]
    credit_limit_cents: Option<Value>,
    value_categories: Option<ValueCategoriesArg>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetAccountBalanceArgs {
    /// Account id or exact name.
    account_id: String,
    /// The real balance in integer cents; zero and negatives (owed) are allowed.
    #[schemars(with = "i64")]
    real_balance_cents: Value,
    /// Record the difference as income/expense instead of an adjustment (default false).
    record_as_income_expense: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateNetWorthArgs {
    /// Fixed deposit, investment, unit trust or crypto account: id or exact name.
    account_id: String,
    /// New value in integer cents; zero allowed.
    #[schemars(with = "i64")]
    balance_cents: Value,
    /// Gain or loss category id or name.
    category_id: Option<String>,
    /// HH:MM (24h).
    time: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateCategoryArgs {
    name: String,
    /// "income" or "expense".
    kind: String,
    emoji: String,
    color: Option<String>,
    /// Parent category id or exact name, to make a subcategory.
    parent_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateCategoryArgs {
    /// Category id or exact name.
    id: String,
    name: Option<String>,
    emoji: Option<String>,
    color: Option<String>,
    sort_order: Option<i64>,
}

// ── Registry ────────────────────────────────────────────────────────────────

macro_rules! wtool {
    ($name:expr, $desc:expr, $args:ty) => {
        ToolDef { name: $name, description: $desc, writes: true, schema: schema_of::<$args> }
    };
}

pub fn definitions() -> Vec<ToolDef> {
    vec![
        wtool!("set_budgets", "Set this month's budget for one or more expense categories. Amounts are integer cents; amountCents null clears a budget. Categories accept an id or exact name. Returns the month's plan.", SetBudgetsArgs),
        wtool!("create_goal", "Create a savings goal on an account (cash, e-wallet, savings or current). targetCents is integer cents; targetDate is YYYY-MM-DD.", GoalArgs),
        wtool!("update_goal", "Change a savings goal; send id plus the full set of fields.", GoalArgs),
        wtool!("delete_goal", "Delete a savings goal by id.", IdArgs),
        wtool!("create_schedule", "Create a recurring income, expense, transfer or payment. Amounts are integer cents; dates are YYYY-MM-DD.", ScheduleArgs),
        wtool!("update_schedule", "Replace a recurring schedule; send id plus the full set of fields.", ScheduleArgs),
        wtool!("delete_schedule", "Delete a recurring schedule by id.", ScheduleIdArgs),
        wtool!("post_occurrence", "Post a due occurrence of a tap-mode schedule as a real transaction. amountCents is integer cents; date is YYYY-MM-DD.", PostOccurrenceArgs),
        wtool!("skip_occurrence", "Skip a due occurrence of a schedule so it no longer shows as upcoming.", SkipOccurrenceArgs),
        wtool!("create_account", "Create an account. Amounts are integer cents.", CreateAccountArgs),
        wtool!("update_account", "Rename or retype an account, or change its opening balance or credit limit (integer cents). id accepts an id or exact name.", UpdateAccountArgs),
        wtool!("archive_account", "Archive an account by id or exact name.", IdArgs),
        wtool!("restore_account", "Restore an archived account by id or exact name.", IdArgs),
        wtool!("set_account_balance", "Reconcile an account to its real balance (integer cents, may be zero or negative). Adds an adjustment for the difference.", SetAccountBalanceArgs),
        wtool!("update_net_worth", "Record a new value for a fixed deposit, investment, unit trust or crypto account (integer cents).", UpdateNetWorthArgs),
        wtool!("create_category", "Create a category, or a subcategory when parentId is given (id or exact name).", CreateCategoryArgs),
        wtool!("update_category", "Rename or restyle a category. id accepts an id or exact name.", UpdateCategoryArgs),
        wtool!("archive_category", "Archive a category (and its subcategories) by id or exact name.", IdArgs),
        wtool!("restore_category", "Restore an archived category by id or exact name.", IdArgs),
    ]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Optional positive cents; absent or null is `None`.
fn opt_cents(v: Option<Value>, field: &str) -> AppResult<Option<i64>> {
    v.filter(|v| !v.is_null()).map(|v| cents(&v, field)).transpose()
}

/// Optional integer cents (zero and negatives allowed); absent or null is `None`.
fn opt_integer(v: Option<Value>, field: &str) -> AppResult<Option<i64>> {
    v.filter(|v| !v.is_null()).map(|v| resolve::integer_cents_arg(&v, field)).transpose()
}

fn opt_category(conn: &Connection, key: Option<&str>, kind: Option<&str>) -> AppResult<Option<String>> {
    key.map(|k| resolve::resolve_category(conn, k, kind)).transpose()
}

fn goal_write(conn: &Connection, a: GoalArgs) -> AppResult<GoalWrite> {
    Ok(GoalWrite {
        target_cents: cents(&a.target_cents, "targetCents")?,
        target_date: a.target_date.as_deref().map(resolve::parse_date).transpose()?,
        account_id: resolve::resolve_account(conn, &a.account_id)?,
        id: a.id,
        name: a.name,
    })
}

fn schedule_write(conn: &Connection, a: ScheduleArgs) -> AppResult<ScheduleWrite> {
    let amount_cents = cents(&a.amount_cents, "amountCents")?;
    let start_date = resolve::parse_date(&a.start_date)?;
    let end_date = a.end_date.as_deref().map(resolve::parse_date).transpose()?;
    let cat_kind = Some(a.kind.as_str()).filter(|k| matches!(*k, "income" | "expense"));
    Ok(ScheduleWrite {
        mode: a.mode,
        amount_cents,
        account_id: resolve::resolve_account(conn, &a.account_id)?,
        to_account_id: a.to_account_id.as_deref().map(|k| resolve::resolve_account(conn, k)).transpose()?,
        category_id: opt_category(conn, a.category_id.as_deref(), cat_kind)?,
        kind: a.kind,
        description: a.description,
        start_date,
        time: a.time,
        frequency: a.frequency,
        interval: a.interval.unwrap_or(1),
        weekdays: a.weekdays,
        month_mode: a.month_mode,
        month_days: a.month_days,
        ordinal: a.ordinal,
        ordinal_day: a.ordinal_day,
        months: a.months,
        day_of_month: a.day_of_month,
        end_mode: a.end_mode.unwrap_or_else(|| "never".into()),
        end_count: a.end_count,
        end_date,
    })
}

fn deleted(id: &str) -> Value {
    json!({"deleted": true, "id": id})
}

fn need_id(id: Option<String>, tool: &str) -> AppResult<String> {
    id.ok_or_else(|| AppError::Validation(format!("{tool} needs the id of the item to change")))
}

fn no_id(id: &Option<String>, tool: &str, update: &str) -> AppResult<()> {
    match id {
        Some(_) => Err(AppError::Validation(format!("{tool} takes no id; use {update} to change an existing one"))),
        None => Ok(()),
    }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// Run one of this module's tools. `None` means the name is not ours. The
/// caller applies `with_formatted` to the result.
pub fn call(conn: &Connection, name: &str, args: Value) -> Option<AppResult<Value>> {
    let known = definitions().iter().any(|d| d.name == name);
    known.then(|| run(conn, name, args))
}

fn run(conn: &Connection, name: &str, args: Value) -> AppResult<Value> {
    match name {
        "set_budgets" => {
            let a: SetBudgetsArgs = parse_args(name, args)?;
            let items = a
                .items
                .into_iter()
                .map(|i| {
                    Ok(BudgetWrite {
                        category_id: resolve::resolve_category(conn, &i.category_id, Some("expense"))?,
                        amount_cents: opt_integer(i.amount_cents, "amountCents")?,
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;
            service::set_budgets(conn, &items)?;
            to_json(service::get_plan(conn, &crate::today()[..7])?)
        }
        "create_goal" => {
            let a: GoalArgs = parse_args(name, args)?;
            no_id(&a.id, name, "update_goal")?;
            to_json(service::create_goal(conn, goal_write(conn, a)?)?)
        }
        "update_goal" => {
            let a: GoalArgs = parse_args(name, args)?;
            need_id(a.id.clone(), name)?;
            to_json(service::update_goal(conn, goal_write(conn, a)?)?)
        }
        "delete_goal" => {
            let a: IdArgs = parse_args(name, args)?;
            service::delete_goal(conn, &a.id)?;
            Ok(deleted(&a.id))
        }
        "create_schedule" => {
            let a: ScheduleArgs = parse_args(name, args)?;
            no_id(&a.id, name, "update_schedule")?;
            to_json(schedules::create_schedule(conn, schedule_write(conn, a)?, local_now())?)
        }
        "update_schedule" => {
            let mut a: ScheduleArgs = parse_args(name, args)?;
            let id = need_id(a.id.take(), name)?;
            to_json(schedules::update_schedule(conn, &id, schedule_write(conn, a)?, local_now())?)
        }
        "delete_schedule" => {
            let a: ScheduleIdArgs = parse_args(name, args)?;
            schedules::delete_schedule(conn, &a.id)?;
            Ok(deleted(&a.id))
        }
        "post_occurrence" => {
            let a: PostOccurrenceArgs = parse_args(name, args)?;
            let amount = cents(&a.amount_cents, "amountCents")?;
            let date = resolve::parse_date(&a.date)?;
            to_json(schedules::post_occurrence(conn, &a.schedule_id, &date, amount, local_now())?)
        }
        "skip_occurrence" => {
            let a: SkipOccurrenceArgs = parse_args(name, args)?;
            let date = resolve::parse_date(&a.date)?;
            schedules::skip_occurrence(conn, &a.schedule_id, &date, local_now())?;
            Ok(json!({"skipped": true, "scheduleId": a.schedule_id, "date": date}))
        }
        "create_account" => {
            let a: CreateAccountArgs = parse_args(name, args)?;
            let opening = opt_integer(a.opening_balance_cents, "openingBalanceCents")?.unwrap_or(0);
            let limit = opt_cents(a.credit_limit_cents, "creditLimitCents")?;
            let gain = opt_category(conn, a.gain_category_id.as_deref(), None)?;
            let loss = opt_category(conn, a.loss_category_id.as_deref(), None)?;
            to_json(service::create_account(conn, &a.name, &a.subtype, opening, a.template_key.as_deref(), limit, gain.as_deref(), loss.as_deref())?)
        }
        "update_account" => {
            let a: UpdateAccountArgs = parse_args(name, args)?;
            let opening = opt_integer(a.opening_balance_cents, "openingBalanceCents")?;
            let limit = opt_cents(a.credit_limit_cents, "creditLimitCents")?;
            let value_categories = a
                .value_categories
                .map(|v| {
                    Ok::<_, AppError>(ValueCategories {
                        gain_category_id: opt_category(conn, v.gain_category_id.as_deref(), None)?,
                        loss_category_id: opt_category(conn, v.loss_category_id.as_deref(), None)?,
                    })
                })
                .transpose()?;
            let input = UpdateAccountInput {
                id: resolve::resolve_account(conn, &a.id)?,
                name: a.name,
                subtype: a.subtype,
                opening_balance_cents: opening,
                credit_limit_cents: limit,
                value_categories,
            };
            to_json(service::update_account(conn, input)?)
        }
        "archive_account" => {
            let a: IdArgs = parse_args(name, args)?;
            to_json(service::archive_account(conn, &resolve::resolve_account(conn, &a.id)?)?)
        }
        "restore_account" => {
            let a: IdArgs = parse_args(name, args)?;
            to_json(service::restore_account(conn, &resolve::resolve_archived_account(conn, &a.id)?)?)
        }
        "set_account_balance" => {
            let a: SetAccountBalanceArgs = parse_args(name, args)?;
            let real = resolve::integer_cents_arg(&a.real_balance_cents, "realBalanceCents")?;
            let id = resolve::resolve_account(conn, &a.account_id)?;
            to_json(service::set_account_balance(conn, &id, real, a.record_as_income_expense.unwrap_or(false))?)
        }
        "update_net_worth" => {
            let a: UpdateNetWorthArgs = parse_args(name, args)?;
            let balance = resolve::integer_cents_arg(&a.balance_cents, "balanceCents")?;
            let id = resolve::resolve_account(conn, &a.account_id)?;
            let category = opt_category(conn, a.category_id.as_deref(), None)?;
            to_json(service::update_net_worth(conn, &id, balance, category.as_deref(), a.time.as_deref())?)
        }
        "create_category" => {
            let a: CreateCategoryArgs = parse_args(name, args)?;
            let kind = Some(a.kind.as_str()).filter(|k| matches!(*k, "income" | "expense"));
            let parent = opt_category(conn, a.parent_id.as_deref(), kind)?;
            to_json(service::create_category(conn, &a.name, &a.kind, &a.emoji, a.color.as_deref(), parent.as_deref())?)
        }
        "update_category" => {
            let a: UpdateCategoryArgs = parse_args(name, args)?;
            let input = UpdateCategoryInput {
                id: resolve::resolve_category(conn, &a.id, None)?,
                name: a.name,
                emoji: a.emoji,
                color: a.color,
                sort_order: a.sort_order,
            };
            to_json(service::update_category(conn, input)?)
        }
        "archive_category" => {
            let a: IdArgs = parse_args(name, args)?;
            to_json(service::archive_category(conn, &resolve::resolve_category(conn, &a.id, None)?)?)
        }
        "restore_category" => {
            let a: IdArgs = parse_args(name, args)?;
            to_json(service::restore_category(conn, &resolve::resolve_archived_category(conn, &a.id)?)?)
        }
        other => Err(AppError::NotFound(format!("Unknown tool \"{other}\""))),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tools::{call, definitions};
    use crate::db::open_in_memory;
    use crate::error::{AppError, AppResult};
    use crate::models::TransactionFilters;
    use crate::service;
    use rusqlite::Connection;
    use serde_json::{json, Value};

    fn setup() -> Connection {
        let c = open_in_memory().unwrap();
        service::create_account(&c, "Maybank", "cash", 100_000, None, None, None, None).unwrap();
        service::create_category(&c, "Lunch Runs", "expense", "x", None, None).unwrap();
        c
    }

    fn days_ago(n: i64) -> String {
        (chrono::Local::now().date_naive() - chrono::Duration::days(n)).format("%Y-%m-%d").to_string()
    }

    fn validation(r: AppResult<Value>) -> String {
        match r {
            Err(AppError::Validation(m)) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn plan_budget(c: &Connection, cat: &str) -> Option<Value> {
        let plan = call(c, "get_plan", json!({"month": crate::today()[..7].to_string()})).unwrap();
        plan["budgets"].as_array().unwrap().iter().find(|b| b["categoryId"] == cat).cloned()
    }

    #[test]
    fn set_budgets_then_get_plan_shows_them() {
        let c = setup();
        let cat = service::list_categories(&c, Some("expense"), false).unwrap().into_iter().find(|x| x.name == "Lunch Runs").unwrap().id;
        call(&c, "set_budgets", json!({"items": [{"categoryId": "lunch runs", "amountCents": 30_000}]})).unwrap();
        let b = plan_budget(&c, &cat).unwrap();
        assert_eq!(b["amountCents"], 30_000);
        assert_eq!(b["amountFormatted"], "RM 300.00");
        let r = validation(call(&c, "set_budgets", json!({"items": [{"categoryId": "lunch runs", "amountCents": 1.5}]})));
        assert!(r.contains("integer cents"), "{r}");
        assert_eq!(plan_budget(&c, &cat).unwrap()["amountCents"], 30_000);
        // null clears
        call(&c, "set_budgets", json!({"items": [{"categoryId": "Lunch Runs", "amountCents": null}]})).unwrap();
        assert!(plan_budget(&c, &cat).map_or(true, |b| b["amountCents"] == 0));
    }

    #[test]
    fn goal_create_update_delete_roundtrip() {
        let c = setup();
        let g = call(&c, "create_goal", json!({"name": "Trip", "accountId": "maybank", "targetCents": 500_000, "targetDate": "2030-12-31"})).unwrap();
        assert_eq!(g["targetCents"], 500_000);
        assert_eq!(g["targetFormatted"], "RM 5,000.00");
        let id = g["id"].as_str().unwrap().to_string();
        let u = call(&c, "update_goal", json!({"id": id, "name": "Big Trip", "accountId": "Maybank", "targetCents": 600_000})).unwrap();
        assert_eq!(u["name"], "Big Trip");
        assert_eq!(u["targetCents"], 600_000);
        let month = crate::today()[..7].to_string();
        let plan = call(&c, "get_plan", json!({"month": month})).unwrap();
        assert_eq!(plan["goals"].as_array().unwrap().len(), 1);
        assert_eq!(call(&c, "delete_goal", json!({"id": id})).unwrap(), json!({"deleted": true, "id": id}));
        let plan = call(&c, "get_plan", json!({"month": month})).unwrap();
        assert!(plan["goals"].as_array().unwrap().is_empty());
        let m = validation(call(&c, "create_goal", json!({"name": "X", "accountId": "Maybank", "targetCents": 0})));
        assert!(m.contains("integer cents"), "{m}");
        validation(call(&c, "update_goal", json!({"name": "X", "accountId": "Maybank", "targetCents": 100})));
    }

    fn daily_tap(start: &str) -> Value {
        json!({"mode": "tap", "kind": "expense", "amountCents": 500, "accountId": "Maybank", "categoryId": "lunch runs",
               "description": "Coffee", "startDate": start, "time": "00:00", "frequency": "daily"})
    }

    #[test]
    fn schedule_create_then_list_upcoming() {
        let c = setup();
        let s = call(&c, "create_schedule", daily_tap(&days_ago(2))).unwrap();
        assert_eq!(s["amountCents"], 500);
        assert_eq!(s["amountFormatted"], "RM 5.00");
        assert_eq!(s["interval"], 1);
        let up = call(&c, "list_upcoming", json!({})).unwrap();
        let rows = up.as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r["scheduleId"] == s["id"]));
        assert_eq!(call(&c, "list_schedules", json!({})).unwrap().as_array().unwrap().len(), 1);
        // update then delete
        let mut upd = daily_tap(&days_ago(2));
        upd["id"] = s["id"].clone();
        upd["amountCents"] = json!(900);
        assert_eq!(call(&c, "update_schedule", upd).unwrap()["amountCents"], 900);
        let sid = s["id"].as_str().unwrap();
        assert_eq!(call(&c, "delete_schedule", json!({"id": sid})).unwrap(), json!({"deleted": true, "id": sid}));
        assert!(call(&c, "list_upcoming", json!({})).unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn skip_occurrence_removes_it_from_upcoming() {
        let c = setup();
        let start = days_ago(2);
        let s = call(&c, "create_schedule", daily_tap(&start)).unwrap();
        let sid = s["id"].as_str().unwrap();
        call(&c, "skip_occurrence", json!({"scheduleId": sid, "date": start})).unwrap();
        let rows = call(&c, "list_upcoming", json!({})).unwrap();
        let dates: Vec<_> = rows.as_array().unwrap().iter().map(|r| r["occurrenceDate"].as_str().unwrap().to_string()).collect();
        assert_eq!(dates.len(), 2);
        assert!(!dates.contains(&start));
        // post one for real
        let t = call(&c, "post_occurrence", json!({"scheduleId": sid, "date": days_ago(1), "amountCents": 450})).unwrap();
        assert_eq!(t["amountCents"], 450);
        assert_eq!(call(&c, "list_upcoming", json!({})).unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn float_amount_writes_nothing_for_schedule_tools() {
        let c = setup();
        let s = call(&c, "create_schedule", daily_tap(&days_ago(1))).unwrap();
        let sid = s["id"].as_str().unwrap();
        let tx_before = service::list_transactions(&c, TransactionFilters::default()).unwrap().len();
        for bad in [json!(12.5), json!(0), json!(-5), json!("100")] {
            let m = validation(call(&c, "post_occurrence", json!({"scheduleId": sid, "date": days_ago(1), "amountCents": bad})));
            assert!(m.contains("integer cents"), "{m}");
        }
        let mut bad = daily_tap(&days_ago(1));
        bad["amountCents"] = json!(1.5);
        assert!(validation(call(&c, "create_schedule", bad)).contains("integer cents"));
        assert_eq!(service::list_transactions(&c, TransactionFilters::default()).unwrap().len(), tx_before);
        assert_eq!(call(&c, "list_upcoming", json!({})).unwrap().as_array().unwrap().len(), 2);
        assert_eq!(call(&c, "list_schedules", json!({})).unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn archive_account_by_name() {
        let c = setup();
        let v = call(&c, "archive_account", json!({"id": "maybank"})).unwrap();
        assert_eq!(v["isArchived"], true);
        assert_eq!(v["name"], "Maybank");
        let r = call(&c, "restore_account", json!({"id": "MAYBANK"})).unwrap();
        assert_eq!(r["isArchived"], false);
    }

    #[test]
    fn create_category_under_parent_by_name() {
        let c = setup();
        let parent = call(&c, "create_category", json!({"name": "Eating Out", "kind": "expense", "emoji": "x"})).unwrap();
        let child = call(&c, "create_category", json!({"name": "Cafe", "kind": "expense", "emoji": "x", "parentId": "eating out"})).unwrap();
        assert_eq!(child["parentId"], parent["id"]);
        let u = call(&c, "update_category", json!({"id": "cafe", "name": "Espresso Bar"})).unwrap();
        assert_eq!(u["name"], "Espresso Bar");
        let a = call(&c, "archive_category", json!({"id": "espresso bar"})).unwrap();
        assert_eq!(a["isArchived"], true);
        assert_eq!(call(&c, "restore_category", json!({"id": "Espresso Bar"})).unwrap()["isArchived"], false);
    }

    #[test]
    fn account_create_update_and_balance_tools() {
        let c = setup();
        let a = call(&c, "create_account", json!({"name": "Visa", "subtype": "credit-card", "openingBalanceCents": 0, "creditLimitCents": 500_000})).unwrap();
        assert_eq!(a["creditLimitCents"], 500_000);
        let u = call(&c, "update_account", json!({"id": "visa", "name": "Visa Gold"})).unwrap();
        assert_eq!(u["name"], "Visa Gold");
        let b = call(&c, "set_account_balance", json!({"accountId": "maybank", "realBalanceCents": 0, "recordAsIncomeExpense": false})).unwrap();
        assert_eq!(b["balanceCents"], 0);
        let b = call(&c, "set_account_balance", json!({"accountId": "maybank", "realBalanceCents": -2500})).unwrap();
        assert_eq!(b["balanceCents"], -2500);
        let m = validation(call(&c, "set_account_balance", json!({"accountId": "maybank", "realBalanceCents": 10.5})));
        assert!(m.contains("integer cents"), "{m}");
        let m = validation(call(&c, "update_net_worth", json!({"accountId": "maybank", "balanceCents": "5"})));
        assert!(m.contains("integer cents"), "{m}");
        let m = validation(call(&c, "create_account", json!({"name": "Z", "subtype": "cash", "openingBalanceCents": 1.5})));
        assert!(m.contains("integer cents"), "{m}");
    }

    #[test]
    fn total_tool_count_is_between_28_and_40() {
        let n = definitions().len();
        assert!((28..=40).contains(&n), "{n}");
    }

    #[test]
    fn every_manage_tool_is_a_write_with_object_schema() {
        let defs = definitions();
        for n in [
            "set_budgets", "create_goal", "update_goal", "delete_goal", "create_schedule", "update_schedule", "delete_schedule",
            "post_occurrence", "skip_occurrence", "create_account", "update_account", "archive_account", "restore_account",
            "set_account_balance", "update_net_worth", "create_category", "update_category", "archive_category", "restore_category",
        ] {
            let d = defs.iter().find(|d| d.name == n).unwrap_or_else(|| panic!("missing {n}"));
            assert!(d.writes, "{n}");
            assert_eq!((d.schema)()["type"], "object", "{n}");
            assert!(!d.description.is_empty(), "{n}");
        }
    }
}
