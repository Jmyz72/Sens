//! OpenAI-compatible chat client and the prompt/reply contract for photo import.
//! No database access: callers pass the settings and names in.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Connection settings for an OpenAI-compatible `/chat/completions` endpoint.
#[derive(Debug, Clone)]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// Names the model may use. Built by `drafts.rs` from the database.
#[derive(Debug, Clone)]
pub struct PromptContext {
    pub accounts: Vec<String>,
    pub expense_categories: Vec<String>,
    pub income_categories: Vec<String>,
}

/// One transaction as the model returns it. Everything is optional: the model
/// is not trusted, and `drafts.rs` validates each field.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawDraft {
    pub date: Option<String>,
    pub time: Option<String>,
    pub amount: Option<Value>,
    pub currency: Option<String>,
    pub kind: Option<String>,
    pub account: Option<String>,
    pub to_account: Option<String>,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub note: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct RawReply {
    transactions: Vec<RawDraft>,
}

pub const MAX_OCR_CHARS: usize = 20_000;

const SYSTEM_PROMPT: &str = "You extract money transactions from OCR text of receipts, bank or e-wallet screenshots, and statements. The user's currency is Malaysian Ringgit (MYR).\n\
Reply with ONE JSON object and nothing else, shaped {\"transactions\":[...]}.\n\
Each transaction has: date (YYYY-MM-DD or null), time (HH:MM 24-hour or null), amount (positive decimal string such as \"12.50\", no currency symbol), currency (ISO code; \"MYR\" if unsure), kind (\"expense\", \"income\" or \"transfer\"), account (one of the user's accounts, or null), to_account (transfers only, otherwise null), category and subcategory (from the user's list for that kind, otherwise null), note (merchant or a short description, or null), confidence (0 to 1).\n\
Rules: one entry per distinct transaction. For a receipt use the grand total, never line items. Never invent data; use null when unsure. Copy account and category names exactly as listed. Spending is an expense, money received is an income, moving money between the user's own accounts is a transfer. Ignore balances, loyalty points and totals that are not transactions.";

fn bullet_list(items: &[String]) -> String {
    if items.is_empty() {
        "- (none)".to_string()
    } else {
        items.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n")
    }
}

pub fn build_messages(ocr_text: &str, ctx: &PromptContext, today: &str) -> Vec<Value> {
    let text: String = ocr_text.chars().take(MAX_OCR_CHARS).collect();
    let user = format!(
        "Today is {today}.\n\nAccounts:\n{}\n\nExpense categories:\n{}\n\nIncome categories:\n{}\n\nOCR text:\n\"\"\"\n{text}\n\"\"\"",
        bullet_list(&ctx.accounts),
        bullet_list(&ctx.expense_categories),
        bullet_list(&ctx.income_categories),
    );
    vec![
        json!({"role": "system", "content": SYSTEM_PROMPT}),
        json!({"role": "user", "content": user}),
    ]
}

/// The first `{` to the last `}`, so code fences and chatter around the JSON are ignored.
fn json_slice(text: &str) -> &str {
    match (text.find('{'), text.rfind('}')) {
        (Some(a), Some(b)) if b > a => &text[a..=b],
        _ => text.trim(),
    }
}

pub fn parse_reply(text: &str) -> AppResult<Vec<RawDraft>> {
    serde_json::from_str::<RawReply>(json_slice(text))
        .map(|r| r.transactions)
        .map_err(|e| AppError::Ai("ai_bad_response", format!("The AI reply was not the expected JSON: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> PromptContext {
        PromptContext {
            accounts: vec!["Maybank Savings".into(), "TNG eWallet".into()],
            expense_categories: vec!["Food (subcategories: Lunch, Dinner)".into()],
            income_categories: vec!["Salary".into()],
        }
    }

    #[test]
    fn prompt_lists_accounts_categories_date_and_ocr_text() {
        let msgs = build_messages("Total RM 12.50", &ctx(), "2026-10-17");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(user.contains("Today is 2026-10-17."));
        assert!(user.contains("- Maybank Savings"));
        assert!(user.contains("- Food (subcategories: Lunch, Dinner)"));
        assert!(user.contains("- Salary"));
        assert!(user.contains("Total RM 12.50"));
    }

    #[test]
    fn prompt_truncates_very_long_ocr_text() {
        let long = "x".repeat(MAX_OCR_CHARS + 500);
        let msgs = build_messages(&long, &ctx(), "2026-10-17");
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(!user.contains(&"x".repeat(MAX_OCR_CHARS + 1)));
    }

    #[test]
    fn parses_a_plain_reply() {
        let rows = parse_reply(r#"{"transactions":[{"date":"2026-10-15","amount":"12.50","kind":"expense","account":"TNG eWallet","category":"Food","subcategory":"Lunch","note":"Kopitiam","confidence":0.9}]}"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].account.as_deref(), Some("TNG eWallet"));
        assert_eq!(rows[0].confidence, Some(0.9));
    }

    #[test]
    fn parses_a_reply_wrapped_in_code_fences_and_prose() {
        let reply = "Here you go:\n```json\n{\"transactions\":[{\"amount\":12.5}]}\n```";
        let rows = parse_reply(reply).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].amount.is_some());
    }

    #[test]
    fn rejects_non_json_with_ai_bad_response() {
        match parse_reply("sorry, no transactions") {
            Err(AppError::Ai(code, _)) => assert_eq!(code, "ai_bad_response"),
            other => panic!("expected ai_bad_response, got {other:?}"),
        }
    }

    #[test]
    fn rejects_json_without_the_transactions_key() {
        assert!(parse_reply(r#"{"items":[]}"#).is_err());
    }
}
