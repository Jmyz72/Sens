//! Save a schedule, then post its due dates or hold them for a tap.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::Connection;

use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::recurrence::{self, End, Freq, MonthMode, Ordinal, OrdinalDay, Rule};
use crate::{repo, service};

pub fn create_schedule(conn: &Connection, input: ScheduleWrite, now: NaiveDateTime) -> AppResult<Schedule> {
    let write = prepare(conn, &input)?;
    let id = uuid::Uuid::new_v4().to_string();
    repo::insert_schedule(conn, &id, &write, &crate::now())?;
    load(conn, &id, now)
}

pub fn update_schedule(conn: &Connection, id: &str, input: ScheduleWrite, now: NaiveDateTime) -> AppResult<Schedule> {
    let write = prepare(conn, &input)?;
    repo::update_schedule(conn, id, &write, &crate::now())?;
    load(conn, id, now)
}

pub fn delete_schedule(conn: &Connection, id: &str) -> AppResult<()> {
    repo::delete_schedule(conn, id)
}

pub fn list_schedules(conn: &Connection, now: NaiveDateTime) -> AppResult<Vec<Schedule>> {
    let times_on = service::time_enabled(conn)?;
    let mut rows = repo::list_schedules(conn)?;
    for row in &mut rows {
        row.block_reason = block_reason(conn, row, now, times_on)?;
    }
    Ok(rows)
}

pub fn list_upcoming(conn: &Connection, now: NaiveDateTime) -> AppResult<Vec<UpcomingOccurrence>> {
    let times_on = service::time_enabled(conn)?;
    let schedules = repo::list_schedules(conn)?;
    let mut rows = Vec::new();
    for schedule in &schedules {
        if schedule.mode != "tap" {
            continue;
        }
        let rule = rule_from(schedule)?;
        let due = due_dates(conn, schedule, &rule, now, times_on)?;
        if due.is_empty() {
            continue;
        }
        let reason = posting_block(conn, schedule)?;
        let label = label_for(conn, schedule);
        let account_name = repo::get_account(conn, &schedule.account_id)
            .map(|account| account.name)
            .unwrap_or_default();
        let time = if times_on { schedule.time.clone() } else { None };
        for date in due {
            rows.push(UpcomingOccurrence {
                schedule_id: schedule.id.clone(),
                occurrence_date: ymd(date),
                kind: schedule.kind.clone(),
                label: label.clone(),
                amount_cents: schedule.amount_cents,
                time: time.clone(),
                account_name: account_name.clone(),
                block_reason: reason.clone(),
            });
        }
    }
    rows.sort_by(|a, b| {
        a.occurrence_date
            .cmp(&b.occurrence_date)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.schedule_id.cmp(&b.schedule_id))
    });
    Ok(rows)
}

pub fn post_occurrence(
    conn: &Connection,
    schedule_id: &str,
    date: &str,
    amount_cents: i64,
    now: NaiveDateTime,
) -> AppResult<Transaction> {
    let schedule = repo::get_schedule(conn, schedule_id)?;
    let times_on = service::time_enabled(conn)?;
    ensure_open(conn, &schedule, date, now, times_on)?;
    let tx = create_posted(conn, &schedule, amount_cents, date, times_on)?;
    repo::insert_occurrence(conn, schedule_id, date, "posted", Some(&tx.id))?;
    Ok(tx)
}

pub fn skip_occurrence(conn: &Connection, schedule_id: &str, date: &str, now: NaiveDateTime) -> AppResult<()> {
    let schedule = repo::get_schedule(conn, schedule_id)?;
    let times_on = service::time_enabled(conn)?;
    ensure_open(conn, &schedule, date, now, times_on)?;
    repo::insert_occurrence(conn, schedule_id, date, "skipped", None)?;
    Ok(())
}

pub fn run_pass(conn: &Connection, now: NaiveDateTime) -> AppResult<SchedulePass> {
    let times_on = service::time_enabled(conn)?;
    let schedules = repo::list_schedules(conn)?;
    let mut posted = Vec::new();
    let mut wakes = Vec::new();
    for schedule in &schedules {
        let rule = rule_from(schedule)?;
        if let Some(wake) = recurrence::next_due(&rule, now, due_clock(schedule, times_on)) {
            if wake > now {
                wakes.push(wake);
            }
        }
        if schedule.mode != "auto" {
            continue;
        }
        let due = due_dates(conn, schedule, &rule, now, times_on)?;
        if due.is_empty() || posting_block(conn, schedule)?.is_some() {
            continue;
        }
        for date in due {
            let ymd = ymd(date);
            match create_posted(conn, schedule, schedule.amount_cents, &ymd, times_on) {
                Ok(tx) => {
                    repo::insert_occurrence(conn, &schedule.id, &ymd, "posted", Some(&tx.id))?;
                    posted.push(tx);
                }
                Err(AppError::Database(message)) => return Err(AppError::Database(message)),
                Err(_) => break,
            }
        }
    }
    posted.sort_by(|a, b| a.transaction_date.cmp(&b.transaction_date).then(a.id.cmp(&b.id)));
    let next_wake_at = wakes.into_iter().min().map(|wake| wake.format("%Y-%m-%dT%H:%M").to_string());
    Ok(SchedulePass { posted, next_wake_at })
}

fn load(conn: &Connection, id: &str, now: NaiveDateTime) -> AppResult<Schedule> {
    let mut schedule = repo::get_schedule(conn, id)?;
    let times_on = service::time_enabled(conn)?;
    schedule.block_reason = block_reason(conn, &schedule, now, times_on)?;
    Ok(schedule)
}

fn block_reason(conn: &Connection, schedule: &Schedule, now: NaiveDateTime, times_on: bool) -> AppResult<Option<String>> {
    let rule = rule_from(schedule)?;
    if due_dates(conn, schedule, &rule, now, times_on)?.is_empty() {
        return Ok(None);
    }
    posting_block(conn, schedule)
}

fn posting_block(conn: &Connection, schedule: &Schedule) -> AppResult<Option<String>> {
    match validate_posting(
        conn,
        &schedule.kind,
        schedule.amount_cents,
        &schedule.account_id,
        schedule.to_account_id.as_deref(),
        schedule.category_id.as_deref(),
        schedule.time.as_deref(),
    ) {
        Ok(()) => Ok(None),
        Err(AppError::Database(message)) => Err(AppError::Database(message)),
        Err(other) => Ok(Some(other.to_string())),
    }
}

fn prepare(conn: &Connection, input: &ScheduleWrite) -> AppResult<ScheduleWrite> {
    if input.mode != "auto" && input.mode != "tap" {
        return Err(AppError::Validation("Mode must be auto or tap.".into()));
    }
    let mut write = input.clone();
    if service::time_enabled(conn)? {
        let raw = write
            .time
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Validation("A time is required".into()))?;
        if parse_hhmm(raw).is_none() {
            return Err(AppError::Validation("Time must be in HH:MM 24-hour format".into()));
        }
        write.time = Some(raw.to_string());
    } else {
        write.time = None;
    }
    let rule = rule_from_parts(
        &write.start_date,
        &write.frequency,
        write.interval,
        &write.weekdays,
        write.month_mode.as_deref(),
        &write.month_days,
        write.ordinal.as_deref(),
        write.ordinal_day.as_deref(),
        &write.months,
        write.day_of_month,
        &write.end_mode,
        write.end_count,
        write.end_date.as_deref(),
    )?;
    recurrence::validate_rule(&rule).map_err(AppError::Validation)?;
    validate_posting(
        conn,
        &write.kind,
        write.amount_cents,
        &write.account_id,
        write.to_account_id.as_deref(),
        write.category_id.as_deref(),
        write.time.as_deref(),
    )?;
    Ok(write)
}

fn validate_posting(
    conn: &Connection,
    kind: &str,
    amount_cents: i64,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: Option<&str>,
    time: Option<&str>,
) -> AppResult<()> {
    if amount_cents <= 0 {
        return Err(AppError::Validation("Amount must be greater than zero".into()));
    }
    match kind {
        KIND_INCOME | KIND_EXPENSE => ensure_active(conn, account_id, "selected")?,
        KIND_TRANSFER => {
            let to = to_account_id.ok_or_else(|| AppError::Validation("A destination account is required".into()))?;
            if account_id == to {
                return Err(AppError::Validation("Cannot transfer to the same account".into()));
            }
            ensure_active(conn, account_id, "source")?;
            ensure_active(conn, to, "destination")?;
            let dest = repo::get_account(conn, to)?;
            if dest.subtype == "credit-card" || dest.subtype == "bnpl" {
                return Err(AppError::Validation("Pay a credit card or BNPL as a payment.".into()));
            }
        }
        KIND_PAYMENT => {
            let to = to_account_id.ok_or_else(|| AppError::Validation("A destination account is required".into()))?;
            if account_id == to {
                return Err(AppError::Validation("Cannot pay the same account.".into()));
            }
            ensure_active(conn, account_id, "source")?;
            ensure_active(conn, to, "destination")?;
            let source = repo::get_account(conn, account_id)?;
            let dest = repo::get_account(conn, to)?;
            if dest.subtype != "credit-card" && dest.subtype != "bnpl" {
                return Err(AppError::Validation("Payments can only pay a credit card or BNPL.".into()));
            }
            if !matches!(source.subtype.as_str(), "cash" | "ewallet" | "savings" | "current") {
                return Err(AppError::Validation(
                    "Payments can only come from cash, an e-wallet, savings, or a current account.".into(),
                ));
            }
        }
        _ => return Err(AppError::Validation("Kind must be income, expense, transfer, or payment.".into())),
    }
    if service::time_enabled(conn)? {
        let raw = time
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Validation("A time is required".into()))?;
        if parse_hhmm(raw).is_none() {
            return Err(AppError::Validation("Time must be in HH:MM 24-hour format".into()));
        }
    }
    if kind == KIND_INCOME || kind == KIND_EXPENSE {
        let category_id = category_id.ok_or_else(|| AppError::Validation("A category is required".into()))?;
        validate_category(conn, category_id, kind)?;
    }
    Ok(())
}

fn ensure_active(conn: &Connection, id: &str, role: &str) -> AppResult<()> {
    let account = repo::get_account(conn, id)?;
    if account.is_archived {
        return Err(AppError::Conflict(format!("The {role} account is archived")));
    }
    Ok(())
}

fn validate_category(conn: &Connection, category_id: &str, kind: &str) -> AppResult<()> {
    let category = repo::get_category(conn, category_id)?;
    if category.is_system {
        return Err(AppError::Validation("That category can't be selected".into()));
    }
    if category.kind != kind {
        return Err(AppError::Validation(format!(
            "Category kind '{}' does not match transaction kind '{}'",
            category.kind, kind
        )));
    }
    Ok(())
}

fn ensure_open(conn: &Connection, schedule: &Schedule, date: &str, now: NaiveDateTime, times_on: bool) -> AppResult<()> {
    let rule = rule_from(schedule)?;
    let parsed = parse_date(date)?;
    if repo::occurrence_status(conn, &schedule.id, date)?.is_some() {
        return Err(AppError::Validation("That date was already posted or skipped.".into()));
    }
    if !on_schedule(&rule, parsed) {
        return Err(AppError::Validation("That date is not on this schedule.".into()));
    }
    if !is_due(schedule, parsed, now, times_on) {
        return Err(AppError::Validation("That date is not due.".into()));
    }
    Ok(())
}

fn on_schedule(rule: &Rule, date: NaiveDate) -> bool {
    recurrence::dates_through(rule, date).contains(&date)
}

fn is_due(schedule: &Schedule, date: NaiveDate, now: NaiveDateTime, times_on: bool) -> bool {
    if date > now.date() {
        return false;
    }
    if date < now.date() || !times_on {
        return true;
    }
    match schedule.time.as_deref().and_then(parse_hhmm) {
        Some(time) => now.time() >= time,
        None => true,
    }
}

fn due_dates(
    conn: &Connection,
    schedule: &Schedule,
    rule: &Rule,
    now: NaiveDateTime,
    times_on: bool,
) -> AppResult<Vec<NaiveDate>> {
    let mut dates = recurrence::dates_through(rule, now.date());
    if times_on {
        if let Some(time) = schedule.time.as_deref().and_then(parse_hhmm) {
            if now.time() < time {
                let today = now.date();
                dates.retain(|date| *date != today);
            }
        }
    }
    let settled = repo::list_occurrences(conn, &schedule.id)?;
    dates.retain(|date| !settled.iter().any(|row| row.occurrence_date == ymd(*date)));
    Ok(dates)
}

fn due_clock(schedule: &Schedule, times_on: bool) -> NaiveTime {
    if !times_on {
        return NaiveTime::MIN;
    }
    schedule.time.as_deref().and_then(parse_hhmm).unwrap_or(NaiveTime::MIN)
}

fn create_posted(
    conn: &Connection,
    schedule: &Schedule,
    amount_cents: i64,
    date: &str,
    times_on: bool,
) -> AppResult<Transaction> {
    let time = if times_on { schedule.time.as_deref() } else { None };
    let description = schedule.description.as_deref();
    match schedule.kind.as_str() {
        KIND_INCOME => service::create_income(
            conn,
            &schedule.account_id,
            schedule.category_id.as_deref(),
            amount_cents,
            description,
            date,
            time,
            false,
            None,
        ),
        KIND_EXPENSE => service::create_expense(
            conn,
            &schedule.account_id,
            schedule.category_id.as_deref(),
            amount_cents,
            description,
            date,
            time,
            false,
            None,
        ),
        KIND_TRANSFER => {
            let to = schedule
                .to_account_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("A destination account is required".into()))?;
            service::create_transfer(conn, &schedule.account_id, to, amount_cents, description, date, time)
        }
        KIND_PAYMENT => {
            let to = schedule
                .to_account_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("A destination account is required".into()))?;
            service::create_payment(conn, &schedule.account_id, to, amount_cents, description, date, time)
        }
        _ => Err(AppError::Validation("Kind must be income, expense, transfer, or payment.".into())),
    }
}

fn label_for(conn: &Connection, schedule: &Schedule) -> String {
    if let Some(text) = schedule.description.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        return text.to_string();
    }
    if let Some(id) = schedule.category_id.as_deref() {
        if let Ok(category) = repo::get_category(conn, id) {
            return category.name;
        }
    }
    match schedule.kind.as_str() {
        KIND_TRANSFER => "Transfer".to_string(),
        KIND_PAYMENT => "Payment".to_string(),
        other => other.to_string(),
    }
}

fn rule_from(schedule: &Schedule) -> AppResult<Rule> {
    rule_from_parts(
        &schedule.start_date,
        &schedule.frequency,
        schedule.interval,
        &schedule.weekdays,
        schedule.month_mode.as_deref(),
        &schedule.month_days,
        schedule.ordinal.as_deref(),
        schedule.ordinal_day.as_deref(),
        &schedule.months,
        schedule.day_of_month,
        &schedule.end_mode,
        schedule.end_count,
        schedule.end_date.as_deref(),
    )
}

fn rule_from_parts(
    start_date: &str,
    frequency: &str,
    interval: i64,
    weekdays: &[String],
    month_mode: Option<&str>,
    month_days: &[i64],
    ordinal: Option<&str>,
    ordinal_day: Option<&str>,
    months: &[i64],
    day_of_month: Option<i64>,
    end_mode: &str,
    end_count: Option<i64>,
    end_date: Option<&str>,
) -> AppResult<Rule> {
    let start = parse_date(start_date)?;
    let frequency = match frequency {
        "daily" => Freq::Daily,
        "weekly" => Freq::Weekly,
        "monthly" => Freq::Monthly,
        "yearly" => Freq::Yearly,
        _ => return Err(AppError::Validation("Frequency must be daily, weekly, monthly, or yearly.".into())),
    };
    let month_mode = match month_mode {
        None | Some("each") => MonthMode::Each,
        Some("onThe") => MonthMode::OnThe,
        Some(_) => return Err(AppError::Validation("Month mode must be each or onThe.".into())),
    };
    let ordinal = match ordinal {
        None | Some("first") => Ordinal::First,
        Some("second") => Ordinal::Second,
        Some("third") => Ordinal::Third,
        Some("fourth") => Ordinal::Fourth,
        Some("fifth") => Ordinal::Fifth,
        Some("last") => Ordinal::Last,
        Some(_) => {
            return Err(AppError::Validation(
                "Ordinal must be first, second, third, fourth, fifth, or last.".into(),
            ))
        }
    };
    let ordinal_day = match ordinal_day {
        None | Some("weekday") => OrdinalDay::Weekday,
        Some("weekend") => OrdinalDay::Weekend,
        Some(day) => OrdinalDay::WeekdayName(day.to_string()),
    };
    let end = match end_mode {
        "never" => End::Never,
        "after" => End::After(i32::try_from(end_count.unwrap_or(0)).unwrap_or(i32::MAX)),
        "on" => End::On(parse_date(end_date.unwrap_or(""))?),
        _ => return Err(AppError::Validation("End must be never, after, or on.".into())),
    };
    Ok(Rule {
        start,
        frequency,
        interval: i32::try_from(interval).unwrap_or(0),
        weekdays: weekdays.to_vec(),
        month_mode,
        month_days: month_days.iter().map(|day| i32::try_from(*day).unwrap_or(0)).collect(),
        ordinal,
        ordinal_day,
        months: months.iter().map(|month| i32::try_from(*month).unwrap_or(0)).collect(),
        day_of_month: day_of_month.map(|day| i32::try_from(day).unwrap_or(0)).unwrap_or(0),
        end,
    })
}

fn parse_date(value: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| AppError::Validation("Date must be a real YYYY-MM-DD.".into()))
}

fn parse_hhmm(value: &str) -> Option<NaiveTime> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

fn ymd(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}
