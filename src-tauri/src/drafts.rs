//! Photo-import drafts: turn an LLM reply into reviewable drafts, check them,
//! and post confirmed ones through the normal transaction path. Also holds the
//! AI connection settings. SQL stays in repo.rs.

use chrono::{NaiveDate, NaiveTime};
use rusqlite::Connection;
use serde_json::Value;

use crate::ai::{AiConfig, PromptContext, RawDraft};
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::{repo, service};

pub const KEY_BASE_URL: &str = "ai_base_url";
pub const KEY_MODEL: &str = "ai_model";
pub const KEY_API_KEY: &str = "ai_api_key";

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

fn parse_time(s: &str) -> Option<String> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok().map(|t| t.format("%H:%M").to_string())
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
}
