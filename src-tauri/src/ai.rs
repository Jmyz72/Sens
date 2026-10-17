//! OpenAI-compatible chat client and the prompt/reply contract for photo import.
//! No database access: callers pass the settings and names in.

use std::time::Duration;

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
/// is not trusted, and `drafts.rs` validates each field. Each field is read
/// leniently so one badly typed value never rejects the whole reply.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawDraft {
    #[serde(default, deserialize_with = "lenient_string")]
    pub date: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub time: Option<String>,
    #[serde(default)]
    pub amount: Option<Value>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub currency: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub account: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub to_account: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub category: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub subcategory: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub note: Option<String>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub confidence: Option<f64>,
}

/// A string, number or bool becomes text; null, arrays and objects become None.
fn lenient_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

/// A number or a numeric string; anything else becomes None.
fn lenient_f64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    })
}

/// `transactions` must be present; `null` counts as an empty list.
#[derive(Debug, Deserialize)]
struct RawReply {
    transactions: Option<Vec<Value>>,
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
    serde_json::from_str::<Value>(json_slice(text))
        .and_then(|v| {
            // A missing key is invalid; `Option` alone would accept it.
            if v.get("transactions").is_none() {
                return Err(serde::de::Error::missing_field("transactions"));
            }
            serde_json::from_value::<RawReply>(v)
        })
        .map(|r| {
            r.transactions
                .unwrap_or_default()
                .into_iter()
                .filter(Value::is_object)
                .filter_map(|row| serde_json::from_value::<RawDraft>(row).ok())
                .collect()
        })
        .map_err(|e| AppError::Ai("ai_bad_response", format!("The AI reply was not the expected JSON: {e}")))
}

fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // reqwest is built with `rustls-no-provider`; install ring once. Ignore
        // the error if the updater already installed a provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn send_error(e: reqwest::Error) -> AppError {
    AppError::Ai("ai_unreachable", format!("Could not reach the AI provider: {}", e.without_url()))
}

fn short(text: &str) -> String {
    text.chars().take(200).collect()
}

fn content_from(body: &str) -> AppResult<String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AppError::Ai("ai_bad_response", "The AI provider did not return JSON.".into()))?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Ai("ai_bad_response", "The AI provider's reply had no message content.".into()))
}

/// One `/chat/completions` call. Asks for JSON mode first and, if the provider
/// rejects that with a 400, repeats once without it.
pub async fn chat_completion(cfg: &AiConfig, messages: &[Value]) -> AppResult<String> {
    ensure_crypto_provider();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Ai("ai_unreachable", e.to_string()))?;
    let mut json_mode = true;
    loop {
        let mut body = json!({"model": cfg.model, "messages": messages, "temperature": 0});
        if json_mode {
            body["response_format"] = json!({"type": "json_object"});
        }
        let mut req = client.post(&url).json(&body);
        if let Some(key) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await.map_err(send_error)?;
        let status = resp.status();
        let text = resp.text().await.map_err(send_error)?;
        if status.as_u16() == 400 && json_mode {
            json_mode = false;
            continue;
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AppError::Ai("ai_auth", "The AI provider rejected the API key.".into()));
        }
        if !status.is_success() {
            return Err(AppError::Ai(
                "ai_bad_response",
                format!("The AI provider returned {status}: {}", short(&text)),
            ));
        }
        return content_from(&text);
    }
}

/// Ask for transactions; if the reply is not valid, show the model the problem
/// and ask once more.
pub async fn extract(cfg: &AiConfig, mut messages: Vec<Value>) -> AppResult<Vec<RawDraft>> {
    let first = chat_completion(cfg, &messages).await?;
    match parse_reply(&first) {
        Ok(rows) => Ok(rows),
        Err(err) => {
            messages.push(json!({"role": "assistant", "content": first}));
            messages.push(json!({
                "role": "user",
                "content": format!("That reply was not valid: {err}. Reply again with only the JSON object described.")
            }));
            let second = chat_completion(cfg, &messages).await?;
            parse_reply(&second)
        }
    }
}

/// Used by Settings → Test connection.
pub async fn test_connection(cfg: &AiConfig) -> AppResult<()> {
    let messages = vec![json!({"role": "user", "content": "Reply with the JSON object {\"ok\": true} and nothing else."})];
    chat_completion(cfg, &messages).await.map(|_| ())
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

    #[test]
    fn tolerates_badly_typed_fields_in_a_row() {
        let rows = parse_reply(
            r#"{"transactions":[{"date":20261015,"time":["13:00"],"amount":12.5,"currency":null,"kind":"expense","account":{"name":"x"},"note":1234,"category":true,"confidence":"0.8"}]}"#,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.date.as_deref(), Some("20261015"));
        assert_eq!(r.time, None);
        assert_eq!(r.account, None);
        assert_eq!(r.currency, None);
        assert_eq!(r.note.as_deref(), Some("1234"));
        assert_eq!(r.category.as_deref(), Some("true"));
        assert_eq!(r.kind.as_deref(), Some("expense"));
        assert_eq!(r.confidence, Some(0.8));
        assert!(r.amount.is_some());
    }

    #[test]
    fn a_non_numeric_confidence_becomes_none() {
        let rows = parse_reply(r#"{"transactions":[{"amount":"1","confidence":"high"},{"amount":"2","confidence":[1]}]}"#).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].confidence, None);
        assert_eq!(rows[1].confidence, None);
    }

    #[test]
    fn null_transactions_is_an_empty_list() {
        assert!(parse_reply(r#"{"transactions":null}"#).unwrap().is_empty());
    }

    #[test]
    fn rows_that_are_not_objects_are_skipped() {
        let rows = parse_reply(r#"{"transactions":["junk",42,null,{"amount":"3"}]}"#).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].amount.is_some());
    }

    // A tiny scripted HTTP server: answers each connection with the next canned
    // response and returns the raw requests it saw.
    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n")
    }

    fn serve(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in responses {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = find_header_end(&buf) {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if buf.len() >= pos + 4 + len {
                            break;
                        }
                    }
                }
                seen.push(String::from_utf8_lossy(&buf).to_string());
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(resp.as_bytes()).unwrap();
            }
            seen
        });
        (url, handle)
    }

    fn chat_ok(content: &str) -> (u16, String) {
        (200, json!({"choices": [{"message": {"content": content}}]}).to_string())
    }

    fn cfg(url: &str) -> AiConfig {
        AiConfig { base_url: url.to_string(), model: "m".into(), api_key: Some("secret".into()) }
    }

    fn code_of(e: &AppError) -> &'static str {
        match e {
            AppError::Ai(c, _) => c,
            _ => "other",
        }
    }

    fn msgs() -> Vec<Value> {
        vec![json!({"role": "user", "content": "hi"})]
    }

    #[test]
    fn chat_completion_returns_content_and_sends_key_and_json_mode() {
        let (url, server) = serve(vec![chat_ok("{\"transactions\":[]}")]);
        let out = tauri::async_runtime::block_on(chat_completion(&cfg(&url), &msgs())).unwrap();
        assert_eq!(out, "{\"transactions\":[]}");
        let req = server.join().unwrap().remove(0).to_lowercase();
        assert!(req.contains("post /chat/completions"));
        assert!(req.contains("bearer secret"));
        assert!(req.contains("response_format"));
    }

    #[test]
    fn chat_completion_retries_without_json_mode_after_a_400() {
        let (url, server) = serve(vec![(400, "{}".into()), chat_ok("ok")]);
        let out = tauri::async_runtime::block_on(chat_completion(&cfg(&url), &msgs())).unwrap();
        assert_eq!(out, "ok");
        let seen = server.join().unwrap();
        assert!(seen[0].contains("response_format"));
        assert!(!seen[1].contains("response_format"));
    }

    #[test]
    fn chat_completion_maps_401_to_ai_auth() {
        let (url, _server) = serve(vec![(401, "{}".into())]);
        let err = tauri::async_runtime::block_on(chat_completion(&cfg(&url), &msgs())).unwrap_err();
        assert_eq!(code_of(&err), "ai_auth");
    }

    #[test]
    fn chat_completion_maps_connection_failure_to_ai_unreachable() {
        let err = tauri::async_runtime::block_on(chat_completion(&cfg("http://127.0.0.1:9"), &msgs())).unwrap_err();
        assert_eq!(code_of(&err), "ai_unreachable");
    }

    #[test]
    fn chat_completion_rejects_a_reply_without_content() {
        let (url, _server) = serve(vec![(200, "{\"choices\":[]}".into())]);
        let err = tauri::async_runtime::block_on(chat_completion(&cfg(&url), &msgs())).unwrap_err();
        assert_eq!(code_of(&err), "ai_bad_response");
    }

    #[test]
    fn extract_retries_once_when_the_first_reply_is_not_json() {
        let good = "{\"transactions\":[{\"amount\":\"3.00\",\"kind\":\"expense\"}]}";
        let (url, server) = serve(vec![chat_ok("not json"), chat_ok(good)]);
        let rows = tauri::async_runtime::block_on(extract(&cfg(&url), msgs())).unwrap();
        assert_eq!(rows.len(), 1);
        let seen = server.join().unwrap();
        assert!(seen[1].contains("not valid"));
    }

    #[test]
    fn extract_gives_up_after_the_second_bad_reply() {
        let (url, _server) = serve(vec![chat_ok("nope"), chat_ok("still nope")]);
        let err = tauri::async_runtime::block_on(extract(&cfg(&url), msgs())).unwrap_err();
        assert_eq!(code_of(&err), "ai_bad_response");
    }
}
