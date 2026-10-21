//! Photo-import drafts: turn an LLM reply into reviewable drafts, check them,
//! and post confirmed ones through the normal transaction path. Also holds the
//! AI provider list. SQL stays in repo.rs.

use chrono::{NaiveDate, NaiveTime};
use rusqlite::Connection;
use serde_json::Value;

use crate::ai::{AiConfig, NamedConfig, PromptContext, RawDraft};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::{repo, service};


// ── Parsing helpers ──────────────────────────────────────────────────────────

/// Decimal MYR text or number → integer cents (half-up on the third decimal).
/// Signs, currency text and thousands commas are ignored. Zero or junk → None.
pub fn parse_amount_cents(v: &Value) -> Option<i64> {
    let text = match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let cleaned: String = text.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let (whole, frac) = match cleaned.split_once('.') {
        Some((w, f)) => (w, f),
        None => (cleaned.as_str(), ""),
    };
    if frac.contains('.') || (whole.is_empty() && frac.is_empty()) {
        return None;
    }
    let whole_n: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let digits: Vec<i64> = frac.chars().filter_map(|c| c.to_digit(10)).map(i64::from).collect();
    let d = |i: usize| digits.get(i).copied().unwrap_or(0);
    let mut cents = whole_n.checked_mul(100)?.checked_add(d(0) * 10 + d(1))?;
    if d(2) >= 5 {
        cents += 1;
    }
    (cents > 0).then_some(cents)
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Exact (normalised) name match first, then a unique prefix match. Ambiguous → None.
pub fn match_unique(items: &[(String, String)], query: &str) -> Option<String> {
    let q = norm(query);
    if q.is_empty() {
        return None;
    }
    let exact: Vec<&(String, String)> = items.iter().filter(|(_, n)| norm(n) == q).collect();
    if exact.len() == 1 {
        return Some(exact[0].0.clone());
    }
    if exact.len() > 1 {
        return None;
    }
    let prefix: Vec<&(String, String)> = items.iter().filter(|(_, n)| norm(n).starts_with(&q)).collect();
    (prefix.len() == 1).then(|| prefix[0].0.clone())
}

fn parse_date(s: &str) -> Option<String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok().map(|d| d.format("%Y-%m-%d").to_string())
}

/// `HH:MM` or `HH:MM:SS` (seconds dropped) → `HH:MM`.
fn parse_time(s: &str) -> Option<String> {
    let s = s.trim();
    NaiveTime::parse_from_str(s, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(s, "%H:%M:%S"))
        .ok()
        .map(|t| t.format("%H:%M").to_string())
}

fn clean(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

// ── Lookups and resolution ───────────────────────────────────────────────────

pub struct Lookups {
    accounts: Vec<(String, String)>,
    categories: Vec<Category>,
}

pub fn lookups(conn: &Connection) -> AppResult<Lookups> {
    let accounts = service::list_accounts(conn, false)?
        .into_iter()
        .map(|a| (a.id, a.name))
        .collect();
    let categories = service::list_categories(conn, None, false)?;
    Ok(Lookups { accounts, categories })
}

fn category_lines(cats: &[Category], kind: &str) -> Vec<String> {
    let pool: Vec<&Category> = cats.iter().filter(|c| c.kind == kind && !c.is_system && !c.is_archived).collect();
    pool.iter()
        .filter(|c| c.parent_id.is_none())
        .map(|parent| {
            let kids: Vec<&str> = pool
                .iter()
                .filter(|c| c.parent_id.as_deref() == Some(parent.id.as_str()))
                .map(|c| c.name.as_str())
                .collect();
            if kids.is_empty() {
                parent.name.clone()
            } else {
                format!("{} (subcategories: {})", parent.name, kids.join(", "))
            }
        })
        .collect()
}

pub fn prompt_context(lk: &Lookups) -> PromptContext {
    PromptContext {
        accounts: lk.accounts.iter().map(|(_, n)| n.clone()).collect(),
        expense_categories: category_lines(&lk.categories, "expense"),
        income_categories: category_lines(&lk.categories, "income"),
    }
}

fn resolve_category(cats: &[Category], kind: &str, category: Option<&str>, subcategory: Option<&str>) -> Option<String> {
    let pool: Vec<&Category> = cats.iter().filter(|c| c.kind == kind && !c.is_system && !c.is_archived).collect();
    let pairs = |keep: &dyn Fn(&Category) -> bool| -> Vec<(String, String)> {
        pool.iter().filter(|c| keep(c)).map(|c| (c.id.clone(), c.name.clone())).collect()
    };
    if let (Some(cn), Some(sn)) = (category, subcategory) {
        if let Some(parent_id) = match_unique(&pairs(&|c| c.parent_id.is_none()), cn) {
            let under = pairs(&|c| c.parent_id.as_deref() == Some(parent_id.as_str()));
            if let Some(id) = match_unique(&under, sn) {
                return Some(id);
            }
        }
    }
    if let Some(cn) = category {
        if let Some(id) = match_unique(&pairs(&|c| c.parent_id.is_none()), cn) {
            return Some(id);
        }
    }
    for name in [subcategory, category].into_iter().flatten() {
        if let Some(id) = match_unique(&pairs(&|_| true), name) {
            return Some(id);
        }
    }
    None
}

/// Turn one model row into a draft. Never fails: whatever cannot be resolved
/// stays empty and is reported through `hints` and (later) `problems`.
pub fn fields_from_raw(raw: &RawDraft, lk: &Lookups, today: &str, time_required: bool) -> DraftFields {
    let mut hints: Vec<String> = Vec::new();
    let mut hint = |h: &str| hints.push(h.to_string());

    let kind = match raw.kind.as_deref().map(|k| k.trim().to_lowercase()).as_deref() {
        Some("expense") => "expense",
        Some("income") => "income",
        Some("transfer") => "transfer",
        _ => {
            hint("kind_assumed");
            "expense"
        }
    };

    let date = match raw.date.as_deref().and_then(parse_date) {
        Some(d) => {
            if d.as_str() > today {
                hint("future_date");
            }
            d
        }
        None => {
            hint("date_assumed");
            today.to_string()
        }
    };

    let time = match raw.time.as_deref().and_then(parse_time) {
        Some(t) => Some(t),
        None if time_required => {
            hint("time_assumed");
            Some("00:00".to_string())
        }
        None => None,
    };

    let account_name = clean(raw.account.as_deref());
    let account_id = account_name.and_then(|n| match_unique(&lk.accounts, n));
    if account_name.is_some() && account_id.is_none() {
        hint("unmatched_account");
    }

    let (to_account_id, category_id) = if kind == "transfer" {
        let name = clean(raw.to_account.as_deref());
        let id = name.and_then(|n| match_unique(&lk.accounts, n));
        if name.is_some() && id.is_none() {
            hint("unmatched_account");
        }
        (id, None)
    } else {
        let cat = clean(raw.category.as_deref());
        let sub = clean(raw.subcategory.as_deref());
        let id = resolve_category(&lk.categories, kind, cat, sub);
        if (cat.is_some() || sub.is_some()) && id.is_none() {
            hint("unmatched_category");
        }
        (None, id)
    };

    if let Some(code) = clean(raw.currency.as_deref()) {
        if !["myr", "rm"].contains(&code.to_lowercase().as_str()) {
            hint("non_myr");
        }
    }
    if raw.confidence.unwrap_or(0.7) < 0.6 {
        hint("low_confidence");
    }

    DraftFields {
        kind: kind.to_string(),
        date: Some(date),
        time,
        amount_cents: raw.amount.as_ref().and_then(parse_amount_cents),
        account_id,
        to_account_id,
        category_id,
        note: clean(raw.note.as_deref()).map(str::to_string),
        hints,
    }
}

/// Blocking problems for a draft; empty means it can be confirmed.
pub fn problems(f: &DraftFields, time_required: bool) -> Vec<String> {
    let mut p: Vec<&str> = Vec::new();
    if f.amount_cents.map_or(true, |a| a <= 0) {
        p.push("amount");
    }
    if f.date.is_none() {
        p.push("date");
    }
    if time_required && f.time.is_none() {
        p.push("time");
    }
    if f.account_id.is_none() {
        p.push("account");
    }
    match f.kind.as_str() {
        "transfer" => {
            if f.to_account_id.is_none() || f.to_account_id == f.account_id {
                p.push("to_account");
            }
        }
        "income" | "expense" => {
            if f.category_id.is_none() {
                p.push("category");
            }
        }
        _ => p.push("kind"),
    }
    p.into_iter().map(String::from).collect()
}

// ── Presenting drafts ────────────────────────────────────────────────────────

fn present(row: repo::DraftRow, time_required: bool) -> AppResult<ImportDraft> {
    let fields: DraftFields = serde_json::from_str(&row.payload)
        .map_err(|e| AppError::Database(format!("Bad draft payload: {e}")))?;
    let problems = problems(&fields, time_required);
    Ok(ImportDraft { id: row.id, source_name: row.source_name, created_at: row.created_at, fields, problems })
}

fn payload_of(fields: &DraftFields) -> AppResult<String> {
    serde_json::to_string(fields).map_err(|e| AppError::Database(e.to_string()))
}

/// Run `body` in one transaction (rolled back on error), the way schedules do.
fn in_transaction<T>(conn: &Connection, body: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    conn.execute_batch("BEGIN")?;
    match body() {
        Ok(v) => {
            conn.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

// ── AI providers ─────────────────────────────────────────────────────────────

fn to_provider(row: repo::AiProviderRow) -> AiProvider {
    AiProvider {
        has_key: row.api_key.is_some(),
        id: row.id,
        name: row.name,
        base_url: row.base_url,
        model: row.model,
        enabled: row.enabled,
        position: row.position,
    }
}

fn to_named(row: repo::AiProviderRow) -> NamedConfig {
    NamedConfig { name: row.name, cfg: AiConfig { base_url: row.base_url, model: row.model, api_key: row.api_key } }
}

/// Trimmed, non-empty name, base URL and model, with the base URL normalised.
fn clean_provider_fields(conn: &Connection, input: &AiProviderInput, except_id: Option<&str>) -> AppResult<(String, String, String)> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("Name cannot be empty".into()));
    }
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(AppError::Validation("The base URL must start with http:// or https://".into()));
    }
    let model = input.model.trim().to_string();
    if model.is_empty() {
        return Err(AppError::Validation("Model cannot be empty".into()));
    }
    let wanted = name.to_lowercase();
    let taken = repo::list_ai_providers(conn)?
        .iter()
        .any(|p| Some(p.id.as_str()) != except_id && p.name.trim().to_lowercase() == wanted);
    if taken {
        return Err(AppError::Validation("An AI provider with that name already exists.".into()));
    }
    Ok((name, base_url, model))
}

fn clean_key(key: &str) -> Option<String> {
    let k = key.trim();
    (!k.is_empty()).then(|| k.to_string())
}

pub fn list_ai_providers(conn: &Connection) -> AppResult<Vec<AiProvider>> {
    Ok(repo::list_ai_providers(conn)?.into_iter().map(to_provider).collect())
}

pub fn create_ai_provider(conn: &Connection, input: AiProviderInput) -> AppResult<AiProvider> {
    let (name, base_url, model) = clean_provider_fields(conn, &input, None)?;
    let row = repo::AiProviderRow {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        base_url,
        model,
        api_key: input.api_key.as_deref().and_then(clean_key),
        enabled: true,
        position: repo::list_ai_providers(conn)?.len() as i64,
    };
    repo::insert_ai_provider(conn, &row, &crate::now())?;
    Ok(to_provider(repo::get_ai_provider(conn, &row.id)?))
}

pub fn update_ai_provider(conn: &Connection, id: &str, input: AiProviderInput) -> AppResult<AiProvider> {
    let mut row = repo::get_ai_provider(conn, id)?;
    let (name, base_url, model) = clean_provider_fields(conn, &input, Some(id))?;
    row.name = name;
    row.base_url = base_url;
    row.model = model;
    if let Some(key) = input.api_key.as_deref() {
        row.api_key = clean_key(key);
    }
    repo::update_ai_provider(conn, &row, &crate::now())?;
    Ok(to_provider(repo::get_ai_provider(conn, id)?))
}

pub fn set_ai_provider_enabled(conn: &Connection, id: &str, enabled: bool) -> AppResult<AiProvider> {
    let mut row = repo::get_ai_provider(conn, id)?;
    row.enabled = enabled;
    repo::update_ai_provider(conn, &row, &crate::now())?;
    Ok(to_provider(repo::get_ai_provider(conn, id)?))
}

pub fn delete_ai_provider(conn: &Connection, id: &str) -> AppResult<()> {
    repo::get_ai_provider(conn, id)?;
    in_transaction(conn, || {
        repo::delete_ai_provider(conn, id)?;
        let rest: Vec<String> = repo::list_ai_providers(conn)?.into_iter().map(|p| p.id).collect();
        repo::set_ai_provider_positions(conn, &rest, &crate::now())
    })
}

pub fn reorder_ai_providers(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let mut stored: Vec<String> = repo::list_ai_providers(conn)?.into_iter().map(|p| p.id).collect();
    let mut given = ids.to_vec();
    stored.sort();
    given.sort();
    if stored != given {
        return Err(AppError::Validation("The order must list every AI provider exactly once.".into()));
    }
    in_transaction(conn, || repo::set_ai_provider_positions(conn, ids, &crate::now()))
}

/// One provider's settings, whether or not it is enabled (used by Test).
pub fn provider_config(conn: &Connection, id: &str) -> AppResult<NamedConfig> {
    Ok(to_named(repo::get_ai_provider(conn, id)?))
}

/// The enabled providers in the order Drafts tries them.
pub fn enabled_provider_configs(conn: &Connection) -> AppResult<Vec<NamedConfig>> {
    Ok(repo::list_ai_providers(conn)?.into_iter().filter(|p| p.enabled).map(to_named).collect())
}

/// Everything the async extract command needs, read under one short lock.
pub fn prepare(conn: &Connection) -> AppResult<(Vec<NamedConfig>, PromptContext, String)> {
    let providers = enabled_provider_configs(conn)?;
    if providers.is_empty() {
        return Err(AppError::Ai("ai_not_configured", "Add an AI provider in Settings first.".into()));
    }
    let lk = lookups(conn)?;
    Ok((providers, prompt_context(&lk), crate::today()))
}

// ── Draft lifecycle ──────────────────────────────────────────────────────────

pub fn store_drafts(conn: &Connection, source_name: &str, raws: &[RawDraft], today: &str) -> AppResult<Vec<ImportDraft>> {
    let lk = lookups(conn)?;
    let time_required = service::time_enabled(conn)?;
    let source = {
        let s = source_name.trim();
        if s.is_empty() { "Pasted image" } else { s }
    };
    in_transaction(conn, || {
        let mut out = Vec::with_capacity(raws.len());
        for raw in raws {
            let fields = fields_from_raw(raw, &lk, today, time_required);
            let id = uuid::Uuid::new_v4().to_string();
            repo::insert_draft(conn, &id, source, &payload_of(&fields)?, &crate::now())?;
            out.push(present(repo::get_draft(conn, &id)?, time_required)?);
        }
        Ok(out)
    })
}

pub fn list_drafts(conn: &Connection) -> AppResult<Vec<ImportDraft>> {
    let time_required = service::time_enabled(conn)?;
    repo::list_drafts(conn)?.into_iter().map(|r| present(r, time_required)).collect()
}

fn normalize_date(s: Option<&str>) -> AppResult<Option<String>> {
    match clean(s) {
        None => Ok(None),
        Some(d) => parse_date(d).map(Some).ok_or_else(|| AppError::Validation("Date must be YYYY-MM-DD".into())),
    }
}

fn normalize_time(s: Option<&str>) -> AppResult<Option<String>> {
    match clean(s) {
        None => Ok(None),
        Some(t) => parse_time(t).map(Some).ok_or_else(|| AppError::Validation("Time must be in HH:MM 24-hour format".into())),
    }
}

/// Save the user's edits. Any edit counts as review, so hints are cleared.
pub fn update_draft(conn: &Connection, id: &str, mut fields: DraftFields) -> AppResult<ImportDraft> {
    fields.kind = fields.kind.trim().to_lowercase();
    if !["expense", "income", "transfer"].contains(&fields.kind.as_str()) {
        return Err(AppError::Validation("Kind must be expense, income or transfer".into()));
    }
    fields.date = normalize_date(fields.date.as_deref())?;
    fields.time = normalize_time(fields.time.as_deref())?;
    fields.note = clean(fields.note.as_deref()).map(str::to_string);
    let stored: DraftFields = serde_json::from_str(&repo::get_draft(conn, id)?.payload)
        .map_err(|e| AppError::Database(format!("Bad draft payload: {e}")))?;
    if stored.kind != fields.kind {
        // A category of the old kind can never be posted under the new one.
        fields.category_id = None;
    }
    if fields.kind == "transfer" {
        fields.category_id = None;
    } else {
        fields.to_account_id = None;
    }
    fields.hints.clear();
    repo::update_draft_payload(conn, id, &payload_of(&fields)?, &crate::now())?;
    present(repo::get_draft(conn, id)?, service::time_enabled(conn)?)
}

pub fn discard_drafts(conn: &Connection, ids: &[String]) -> AppResult<()> {
    in_transaction(conn, || {
        for id in ids {
            repo::delete_draft(conn, id)?;
        }
        Ok(())
    })
}

fn confirm_one(conn: &Connection, id: &str, time_required: bool) -> AppResult<()> {
    let draft = present(repo::get_draft(conn, id)?, time_required)?;
    if !draft.problems.is_empty() {
        return Err(AppError::Validation("Fix the highlighted fields first.".into()));
    }
    let f = draft.fields;
    let missing = || AppError::Validation("Fix the highlighted fields first.".into());
    let amount = f.amount_cents.ok_or_else(missing)?;
    let date = f.date.as_deref().ok_or_else(missing)?;
    let account = f.account_id.as_deref().ok_or_else(missing)?;
    in_transaction(conn, || {
        match f.kind.as_str() {
            "expense" => {
                service::create_expense(conn, account, f.category_id.as_deref(), amount, f.note.as_deref(), date, f.time.as_deref(), false, None)?;
            }
            "income" => {
                service::create_income(conn, account, f.category_id.as_deref(), amount, f.note.as_deref(), date, f.time.as_deref(), false, None)?;
            }
            _ => {
                let to = f.to_account_id.as_deref().ok_or_else(missing)?;
                // Moving money to a credit card or BNPL is posted as a payment.
                if service::is_payment_destination(&repo::get_account(conn, to)?.subtype) {
                    service::create_payment(conn, account, to, amount, f.note.as_deref(), date, f.time.as_deref())?;
                } else {
                    service::create_transfer(conn, account, to, amount, f.note.as_deref(), date, f.time.as_deref())?;
                }
            }
        }
        repo::delete_draft(conn, id)
    })
}

/// Post each draft independently. One failure never blocks the others; failed
/// drafts stay in the list with the reason.
pub fn confirm_drafts(conn: &Connection, ids: &[String]) -> AppResult<ConfirmResult> {
    let time_required = service::time_enabled(conn)?;
    let mut confirmed = 0;
    let mut failed = Vec::new();
    for id in ids {
        match confirm_one(conn, id, time_required) {
            Ok(()) => confirmed += 1,
            Err(e) => failed.push(ConfirmFailure { id: id.clone(), message: e.to_string() }),
        }
    }
    Ok(ConfirmResult { confirmed, failed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::RawDraft;
    use serde_json::json;

    fn db() -> Connection {
        let c = crate::db::open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn raw(j: &str) -> RawDraft {
        serde_json::from_str(j).unwrap()
    }

    fn account(c: &Connection, name: &str) -> Account {
        service::create_account(c, name, "savings", 0, None, None, None, None).unwrap()
    }

    #[test]
    fn parses_amounts_to_cents() {
        assert_eq!(parse_amount_cents(&json!("12.50")), Some(1250));
        assert_eq!(parse_amount_cents(&json!("1,234.5")), Some(123_450));
        assert_eq!(parse_amount_cents(&json!("RM 12.5")), Some(1250));
        assert_eq!(parse_amount_cents(&json!(12.5)), Some(1250));
        assert_eq!(parse_amount_cents(&json!(8)), Some(800));
        assert_eq!(parse_amount_cents(&json!("-8.00")), Some(800));
        assert_eq!(parse_amount_cents(&json!("12.345")), Some(1235));
        assert_eq!(parse_amount_cents(&json!("0")), None);
        assert_eq!(parse_amount_cents(&json!("abc")), None);
        assert_eq!(parse_amount_cents(&json!("1.2.3")), None);
        assert_eq!(parse_amount_cents(&json!(null)), None);
    }

    #[test]
    fn matches_names_exactly_then_by_unique_prefix() {
        let items = vec![
            ("a".to_string(), "Maybank Savings".to_string()),
            ("b".to_string(), "Maybank Current".to_string()),
            ("c".to_string(), "TNG eWallet".to_string()),
        ];
        assert_eq!(match_unique(&items, "  tng   EWALLET "), Some("c".into()));
        assert_eq!(match_unique(&items, "maybank savings"), Some("a".into()));
        assert_eq!(match_unique(&items, "tng"), Some("c".into()));
        assert_eq!(match_unique(&items, "maybank"), None); // ambiguous
        assert_eq!(match_unique(&items, "cimb"), None);
        assert_eq!(match_unique(&items, ""), None);
    }

    #[test]
    fn resolves_account_and_subcategory_names() {
        let c = db();
        let a = account(&c, "Maybank Savings");
        let parent = service::create_category(&c, "Zebra Meals", "expense", "🍜", None, None).unwrap();
        let child = service::create_category(&c, "Zebra Lunch", "expense", "🥗", None, Some(&parent.id)).unwrap();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(
            &raw(r#"{"date":"2026-10-15","amount":"12.50","kind":"expense","account":"maybank savings","category":"Zebra Meals","subcategory":"Zebra Lunch","note":" Kopitiam ","confidence":0.9}"#),
            &lk,
            "2026-10-17",
            false,
        );
        assert_eq!(f.account_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(f.category_id.as_deref(), Some(child.id.as_str()));
        assert_eq!(f.amount_cents, Some(1250));
        assert_eq!(f.note.as_deref(), Some("Kopitiam"));
        assert_eq!(f.date.as_deref(), Some("2026-10-15"));
        assert!(f.hints.is_empty());
        assert!(problems(&f, false).is_empty());
    }

    #[test]
    fn falls_back_to_the_parent_when_the_subcategory_is_unknown() {
        let c = db();
        account(&c, "Wallet");
        let parent = service::create_category(&c, "Zebra Meals", "expense", "🍜", None, None).unwrap();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(
            &raw(r#"{"amount":"5","kind":"expense","account":"Wallet","category":"Zebra Meals","subcategory":"Nonexistent"}"#),
            &lk,
            "2026-10-17",
            false,
        );
        assert_eq!(f.category_id.as_deref(), Some(parent.id.as_str()));
    }

    #[test]
    fn flags_unknown_names_missing_date_future_date_and_low_confidence() {
        let c = db();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(
            &raw(r#"{"amount":"9","kind":"expense","account":"Nope","category":"Nothing","confidence":0.3}"#),
            &lk,
            "2026-10-17",
            false,
        );
        for hint in ["unmatched_account", "unmatched_category", "date_assumed", "low_confidence"] {
            assert!(f.hints.contains(&hint.to_string()), "missing hint {hint}: {:?}", f.hints);
        }
        assert_eq!(f.date.as_deref(), Some("2026-10-17"));
        assert_eq!(problems(&f, false), vec!["account".to_string(), "category".to_string()]);

        let future = fields_from_raw(&raw(r#"{"date":"2027-01-01","amount":"1","kind":"income"}"#), &lk, "2026-10-17", false);
        assert!(future.hints.contains(&"future_date".to_string()));
    }

    #[test]
    fn defaults_unknown_kind_to_expense_and_flags_foreign_currency() {
        let c = db();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(&raw(r#"{"amount":"4","kind":"refund","currency":"SGD"}"#), &lk, "2026-10-17", false);
        assert_eq!(f.kind, "expense");
        assert!(f.hints.contains(&"kind_assumed".to_string()));
        assert!(f.hints.contains(&"non_myr".to_string()));
        let myr = fields_from_raw(&raw(r#"{"amount":"4","kind":"expense","currency":"rm"}"#), &lk, "2026-10-17", false);
        assert!(!myr.hints.contains(&"non_myr".to_string()));
    }

    #[test]
    fn transfers_resolve_both_accounts_and_ignore_categories() {
        let c = db();
        let a = account(&c, "Maybank Savings");
        let b = account(&c, "TNG eWallet");
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(
            &raw(r#"{"amount":"50","kind":"transfer","account":"Maybank Savings","to_account":"TNG eWallet","category":"Food"}"#),
            &lk,
            "2026-10-17",
            false,
        );
        assert_eq!(f.account_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(f.to_account_id.as_deref(), Some(b.id.as_str()));
        assert_eq!(f.category_id, None);
        assert!(problems(&f, false).is_empty());
    }

    #[test]
    fn a_transfer_to_the_same_account_is_a_problem() {
        let c = db();
        let a = account(&c, "Maybank Savings");
        let f = DraftFields {
            kind: "transfer".into(),
            date: Some("2026-10-17".into()),
            time: None,
            amount_cents: Some(100),
            account_id: Some(a.id.clone()),
            to_account_id: Some(a.id.clone()),
            category_id: None,
            note: None,
            hints: vec![],
        };
        assert_eq!(problems(&f, false), vec!["to_account".to_string()]);
    }

    #[test]
    fn time_is_assumed_when_times_are_on_and_the_receipt_has_none() {
        let c = db();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(&raw(r#"{"amount":"4","kind":"expense"}"#), &lk, "2026-10-17", true);
        assert_eq!(f.time.as_deref(), Some("00:00"));
        assert!(f.hints.contains(&"time_assumed".to_string()));
        let kept = fields_from_raw(&raw(r#"{"amount":"4","kind":"expense","time":"9:05"}"#), &lk, "2026-10-17", true);
        assert_eq!(kept.time.as_deref(), Some("09:05"));
        assert!(!kept.hints.contains(&"time_assumed".to_string()));
    }

    fn expense_raw(account: &str, amount: &str) -> RawDraft {
        raw(&format!(
            r#"{{"date":"2026-10-15","amount":"{amount}","kind":"expense","account":"{account}","category":"Zebra Meals","note":"Kopitiam"}}"#
        ))
    }

    fn setup_with_category() -> (Connection, Account) {
        let c = db();
        let a = account(&c, "Maybank Savings");
        service::create_category(&c, "Zebra Meals", "expense", "🍜", None, None).unwrap();
        (c, a)
    }

    #[test]
    fn store_then_list_returns_drafts_in_order_with_problems() {
        let (c, _a) = setup_with_category();
        let stored = store_drafts(
            &c,
            "receipt.png",
            &[expense_raw("Maybank Savings", "12.50"), expense_raw("Maybank Savings", "0")],
            "2026-10-17",
        )
        .unwrap();
        assert_eq!(stored.len(), 2);
        let listed = list_drafts(&c).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].source_name, "receipt.png");
        assert!(listed[0].problems.is_empty());
        assert_eq!(listed[1].problems, vec!["amount".to_string()]);
    }

    #[test]
    fn updating_a_draft_clears_hints_and_recomputes_problems() {
        let (c, a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[raw(r#"{"amount":"5","kind":"expense","account":"Nope","confidence":0.2}"#)], "2026-10-17").unwrap();
        let d = &stored[0];
        assert!(!d.fields.hints.is_empty());
        assert!(d.problems.contains(&"account".to_string()));

        let mut f = d.fields.clone();
        f.account_id = Some(a.id.clone());
        f.category_id = Some(service::list_categories(&c, Some("expense"), false).unwrap()[0].id.clone());
        let updated = update_draft(&c, &d.id, f).unwrap();
        assert!(updated.fields.hints.is_empty());
        assert!(updated.problems.is_empty());
    }

    #[test]
    fn updating_rejects_a_bad_kind_date_or_time() {
        let (c, _a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[expense_raw("Maybank Savings", "5")], "2026-10-17").unwrap();
        let base = stored[0].fields.clone();

        let mut bad_kind = base.clone();
        bad_kind.kind = "refund".into();
        assert!(update_draft(&c, &stored[0].id, bad_kind).is_err());

        let mut bad_date = base.clone();
        bad_date.date = Some("15/10/2026".into());
        assert!(update_draft(&c, &stored[0].id, bad_date).is_err());

        let mut bad_time = base;
        bad_time.time = Some("25:99".into());
        assert!(update_draft(&c, &stored[0].id, bad_time).is_err());
    }

    #[test]
    fn confirm_posts_ready_drafts_and_keeps_failed_ones() {
        let (c, a) = setup_with_category();
        let stored = store_drafts(
            &c,
            "x.png",
            &[expense_raw("Maybank Savings", "12.50"), expense_raw("Maybank Savings", "0")],
            "2026-10-17",
        )
        .unwrap();
        let ids: Vec<String> = stored.iter().map(|d| d.id.clone()).collect();
        let res = confirm_drafts(&c, &ids).unwrap();
        assert_eq!(res.confirmed, 1);
        assert_eq!(res.failed.len(), 1);
        assert_eq!(res.failed[0].id, ids[1]);
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), -1250);
        assert_eq!(list_drafts(&c).unwrap().len(), 1);
    }

    #[test]
    fn confirm_posts_a_transfer() {
        let c = db();
        let a = account(&c, "Maybank Savings");
        let b = account(&c, "TNG eWallet");
        let stored = store_drafts(
            &c,
            "x.png",
            &[raw(r#"{"date":"2026-10-15","amount":"50","kind":"transfer","account":"Maybank Savings","to_account":"TNG eWallet"}"#)],
            "2026-10-17",
        )
        .unwrap();
        let res = confirm_drafts(&c, &[stored[0].id.clone()]).unwrap();
        assert_eq!(res.confirmed, 1);
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), -5000);
        assert_eq!(service::get_account_balance(&c, &b.id).unwrap(), 5000);
    }

    #[test]
    fn changing_the_kind_drops_a_category_of_the_old_kind() {
        let (c, a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[expense_raw("Maybank Savings", "5")], "2026-10-17").unwrap();
        let d = &stored[0];
        assert!(d.fields.category_id.is_some());
        assert_eq!(d.fields.account_id.as_deref(), Some(a.id.as_str()));
        let mut f = d.fields.clone();
        f.kind = "income".into();
        let updated = update_draft(&c, &d.id, f).unwrap();
        assert_eq!(updated.fields.category_id, None);
        assert!(updated.problems.contains(&"category".to_string()));
    }

    #[test]
    fn keeping_the_kind_keeps_the_category() {
        let (c, _a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[expense_raw("Maybank Savings", "5")], "2026-10-17").unwrap();
        let mut f = stored[0].fields.clone();
        f.note = Some("Edited".into());
        let updated = update_draft(&c, &stored[0].id, f).unwrap();
        assert_eq!(updated.fields.category_id, stored[0].fields.category_id);
        assert!(updated.problems.is_empty());
    }

    #[test]
    fn a_transfer_to_a_credit_card_is_confirmed_as_a_payment() {
        let c = db();
        let a = account(&c, "Maybank Savings");
        let card = service::create_account(&c, "Visa Card", "credit-card", -20_000, None, Some(1_000_000), None, None).unwrap();
        let stored = store_drafts(
            &c,
            "x.png",
            &[raw(r#"{"date":"2026-10-15","amount":"50","kind":"transfer","account":"Maybank Savings","to_account":"Visa Card"}"#)],
            "2026-10-17",
        )
        .unwrap();
        assert!(stored[0].problems.is_empty());
        let res = confirm_drafts(&c, &[stored[0].id.clone()]).unwrap();
        assert_eq!(res.failed.len(), 0, "{:?}", res.failed.first().map(|f| &f.message));
        assert_eq!(res.confirmed, 1);
        assert!(list_drafts(&c).unwrap().is_empty());
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), -5000);
        assert_eq!(service::get_account_balance(&c, &card.id).unwrap(), -15_000);
    }

    #[test]
    fn parse_time_accepts_seconds_and_normalises_to_hh_mm() {
        assert_eq!(parse_time("13:42:00").as_deref(), Some("13:42"));
        assert_eq!(parse_time("9:05").as_deref(), Some("09:05"));
        assert_eq!(parse_time("25:00:00"), None);
        let c = db();
        let lk = lookups(&c).unwrap();
        let f = fields_from_raw(&raw(r#"{"amount":"4","kind":"expense","time":"13:42:00"}"#), &lk, "2026-10-17", true);
        assert_eq!(f.time.as_deref(), Some("13:42"));
        assert!(!f.hints.contains(&"time_assumed".to_string()));
    }

    #[test]
    fn a_draft_that_fails_in_the_service_stays_and_reports_why() {
        let (c, a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[expense_raw("Maybank Savings", "5")], "2026-10-17").unwrap();
        service::archive_account(&c, &a.id).unwrap();
        let res = confirm_drafts(&c, &[stored[0].id.clone()]).unwrap();
        assert_eq!(res.confirmed, 0);
        assert_eq!(res.failed.len(), 1);
        assert_eq!(list_drafts(&c).unwrap().len(), 1);
    }

    #[test]
    fn discard_removes_drafts_without_posting() {
        let (c, a) = setup_with_category();
        let stored = store_drafts(&c, "x.png", &[expense_raw("Maybank Savings", "5")], "2026-10-17").unwrap();
        discard_drafts(&c, &[stored[0].id.clone()]).unwrap();
        assert!(list_drafts(&c).unwrap().is_empty());
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), 0);
    }

    fn input(name: &str, key: Option<&str>) -> AiProviderInput {
        AiProviderInput { name: name.into(), base_url: " https://x.test/v1/ ".into(), model: " m ".into(), api_key: key.map(Into::into) }
    }

    #[test]
    fn providers_round_trip_in_order_and_never_expose_the_key() {
        let c = db();
        let a = create_ai_provider(&c, input(" Gemini ", Some("k1"))).unwrap();
        let b = create_ai_provider(&c, input("Ollama", Some(""))).unwrap();
        assert_eq!(
            (a.name.as_str(), a.base_url.as_str(), a.model.as_str(), a.has_key, a.enabled, a.position),
            ("Gemini", "https://x.test/v1", "m", true, true, 0)
        );
        assert_eq!((b.has_key, b.position), (false, 1));
        assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Gemini", "Ollama"]);
        let json = serde_json::to_string(&list_ai_providers(&c).unwrap()).unwrap();
        assert!(!json.contains("k1"));
    }

    #[test]
    fn update_keeps_the_key_on_null_and_clears_it_on_empty() {
        let c = db();
        let a = create_ai_provider(&c, input("Gemini", Some("k1"))).unwrap();
        assert!(update_ai_provider(&c, &a.id, input("Gemini 2", None)).unwrap().has_key);
        assert_eq!(provider_config(&c, &a.id).unwrap().cfg.api_key.as_deref(), Some("k1"));
        assert!(!update_ai_provider(&c, &a.id, input("Gemini 2", Some(""))).unwrap().has_key);
        assert_eq!(provider_config(&c, &a.id).unwrap().cfg.api_key, None);
    }

    #[test]
    fn names_are_unique_ignoring_case_and_spaces() {
        let c = db();
        let a = create_ai_provider(&c, input("Gemini", None)).unwrap();
        assert!(matches!(create_ai_provider(&c, input(" gemini ", None)), Err(AppError::Validation(m)) if m == "An AI provider with that name already exists."));
        let b = create_ai_provider(&c, input("OpenAI", None)).unwrap();
        assert!(update_ai_provider(&c, &b.id, input("GEMINI", None)).is_err());
        assert!(update_ai_provider(&c, &a.id, input("gemini", None)).is_ok(), "renaming itself is fine");
    }

    #[test]
    fn provider_validation_messages() {
        let c = db();
        let bad = |n: &str, u: &str, m: &str| {
            create_ai_provider(&c, AiProviderInput { name: n.into(), base_url: u.into(), model: m.into(), api_key: None })
                .unwrap_err()
                .to_string()
        };
        assert_eq!(bad(" ", "https://x", "m"), "Name cannot be empty");
        assert_eq!(bad("A", "ftp://x", "m"), "The base URL must start with http:// or https://");
        assert_eq!(bad("A", "https://x", " "), "Model cannot be empty");
        assert!(matches!(update_ai_provider(&c, "nope", input("A", None)), Err(AppError::NotFound(_))));
        assert!(matches!(set_ai_provider_enabled(&c, "nope", false), Err(AppError::NotFound(_))));
        assert!(matches!(delete_ai_provider(&c, "nope"), Err(AppError::NotFound(_))));
        assert!(matches!(provider_config(&c, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn delete_closes_the_gap_and_reorder_needs_every_id_once() {
        let c = db();
        let ids: Vec<String> = ["A", "B", "C"].iter().map(|n| create_ai_provider(&c, input(n, None)).unwrap().id).collect();
        delete_ai_provider(&c, &ids[1]).unwrap();
        assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.position).collect::<Vec<_>>(), [0, 1]);
        reorder_ai_providers(&c, &[ids[2].clone(), ids[0].clone()]).unwrap();
        assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["C", "A"]);
        let msg = "The order must list every AI provider exactly once.";
        for bad in [
            vec![ids[2].clone()],
            vec![ids[2].clone(), ids[2].clone()],
            vec![ids[2].clone(), ids[0].clone(), "x".into()],
            vec![ids[2].clone(), "x".into()],
        ] {
            assert_eq!(reorder_ai_providers(&c, &bad).unwrap_err().to_string(), msg);
        }
    }

    #[test]
    fn enabled_configs_skip_disabled_providers_and_keep_order() {
        let c = db();
        let a = create_ai_provider(&c, input("A", None)).unwrap();
        create_ai_provider(&c, input("B", None)).unwrap();
        let off = set_ai_provider_enabled(&c, &a.id, false).unwrap();
        assert_eq!((off.enabled, off.position), (false, 0));
        assert_eq!(enabled_provider_configs(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["B"]);
        assert_eq!(provider_config(&c, &a.id).unwrap().name, "A", "Test ignores the switch");
    }

    #[test]
    fn prepare_needs_an_enabled_provider() {
        let c = db();
        let ai_err = |r: AppResult<()>| match r {
            Err(AppError::Ai(code, m)) => (code, m),
            other => panic!("expected an Ai error, got {other:?}"),
        };
        assert_eq!(ai_err(prepare(&c).map(|_| ())), ("ai_not_configured", "Add an AI provider in Settings first.".to_string()));
        let a = create_ai_provider(&c, input("A", None)).unwrap();
        set_ai_provider_enabled(&c, &a.id, false).unwrap();
        assert_eq!(ai_err(prepare(&c).map(|_| ())).0, "ai_not_configured");
        set_ai_provider_enabled(&c, &a.id, true).unwrap();
        assert_eq!(prepare(&c).unwrap().0[0].name, "A");
    }
}
