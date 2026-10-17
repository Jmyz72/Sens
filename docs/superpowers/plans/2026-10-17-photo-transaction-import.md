# Photo Transaction Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Drafts** sidebar screen where the user uploads or pastes a photo, the OS reads the text, an OpenAI-compatible LLM turns it into transaction drafts, and the user reviews and confirms them before anything is saved.

**Architecture:** Rust does everything sensitive: `ocr.rs` (native OS OCR), `ai.rs` (OpenAI-compatible HTTP client, prompt, reply schema), `drafts.rs` (name resolution, validation, persistence in a new `import_drafts` table, confirm through the existing `service::create_*` path). Commands stay thin. The React `Drafts` screen drives the flow; `mock.ts` mirrors every command so browser dev works.

**Tech Stack:** Tauri v2 (Rust), `reqwest` 0.13 (rustls/ring), `objc2-vision` (macOS OCR), `windows` crate (`Windows.Media.Ocr`), SQLite, React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md`

**Repo rules that apply to every task** (from `AGENTS.md`):
- Rust is not on PATH. Prefix Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Money is integer MYR cents. The backend generates UUIDs and timestamps.
- Migrations are append-only. SQL lives only in `repo.rs`. Business rules live in Rust and are mirrored in `src/client/mock.ts`.
- Never hardcode colors; use `useTheme()` tokens. Color is never the only cue.
- Keep `CHANGELOG.md` and `ROADMAP.md` current (Task 13).
- The branch is `feat/photo-import-drafts` (the spec commits are already on it).

**Deviations from the spec (decided while planning):**
- Draft logic lives in a new `src-tauri/src/drafts.rs`, not `service.rs` (1,454 lines already; `schedules.rs` is the precedent for a service-layer module).
- The API key is stored in the `app_settings` table, not the OS keychain (no keychain crate is in the tree; adding one is not cheap). The UI says so. The key is write-only from the frontend.
- A receipt with no time gets `00:00` plus a `time_assumed` hint when "Record transaction times" is on, instead of blocking the row.

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/db/migrations.rs` (modify) | Migration 016: `import_drafts` table |
| `src-tauri/src/db/mod.rs` (modify) | Factory reset also clears `import_drafts` |
| `src-tauri/src/error.rs` (modify) | `AppError::Ai(code, message)` for OCR/AI failures |
| `src-tauri/src/models.rs` (modify) | `DraftFields`, `ImportDraft`, `ConfirmResult`, `AiSettings`, `AiSettingsInput` |
| `src-tauri/src/repo.rs` (modify) | Draft CRUD SQL |
| `src-tauri/src/ai.rs` (create) | Prompt builder, reply parsing, OpenAI-compatible client. No DB access |
| `src-tauri/src/drafts.rs` (create) | Amount parsing, name matching, raw→draft, problems, store/list/update/discard/confirm, AI settings |
| `src-tauri/src/ocr.rs` (create) | `recognize(bytes)` with per-OS backends |
| `src-tauri/src/service.rs` (modify) | Block the frontend from reading `ai_api_key` |
| `src-tauri/src/commands.rs`, `lib.rs` (modify) | New commands and registration |
| `src-tauri/Cargo.toml` (modify) | `reqwest`, `rustls`, `objc2*`, `windows` |
| `src/types.ts` (modify) | Draft and AI types |
| `src/client/invoke.ts`, `index.ts`, `mock.ts` (modify) | Raw-bytes dispatch, wrappers, mock backend |
| `src/nav.ts`, `src/App.tsx` (modify) | `drafts` screen, sidebar badge |
| `src/screens/Drafts.tsx` (create) | The whole feature UI |
| `src/screens/Settings.tsx` (modify) | "AI import" card |
| `src/__tests__/mock-drafts.test.ts` (create) | Mock behavior tests |

---

### Task 1: Migration 016 and factory reset

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (MIGRATIONS list at line 6, new const at the end)
- Modify: `src-tauri/src/db/mod.rs:189-199` (`reset_to_defaults`)
- Test: `src-tauri/src/lib.rs` (tests module, next to `migration_015_creates_schedule_tables`)

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src-tauri/src/lib.rs`, after `migration_015_creates_schedule_tables`:

```rust
    #[test]
    fn migration_016_creates_import_drafts_table() {
        let c = test_db();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='import_drafts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn factory_reset_leaves_import_drafts_empty() {
        let c = test_db();
        c.execute(
            "INSERT INTO import_drafts (id, source_name, payload, created_at, updated_at) VALUES ('d1', 'x.png', '{}', 't', 't')",
            [],
        )
        .unwrap();
        service::reset_app(&c).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM import_drafts", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH"; cd src-tauri && cargo test --lib import_drafts`
Expected: FAIL (`migration_016...` asserts 1 == 0; the reset test errors with "no such table: import_drafts").

- [ ] **Step 3: Add the migration**

In `migrations.rs`, change the list to include 16:

```rust
    (13, MIGRATION_013), (14, MIGRATION_014), (15, MIGRATION_015), (16, MIGRATION_016),
```

Append at the end of the file:

```rust
const MIGRATION_016: &str = r#"
CREATE TABLE import_drafts (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;
```

- [ ] **Step 4: Clear it on factory reset**

In `db/mod.rs` `reset_to_defaults`, add as the first delete (before `schedule_occurrences`):

```rust
        conn.execute("DELETE FROM import_drafts", [])?;
```

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass, including both new tests. If another test asserts a migration count or latest version, update it to 16.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db src-tauri/src/lib.rs
git commit -m "feat(import): add import_drafts table (migration 016)"
```

---

### Task 2: AppError::Ai, models, and draft repository

**Files:**
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/models.rs` (append)
- Modify: `src-tauri/src/repo.rs` (append before the "Error mapping helpers" section)

- [ ] **Step 1: Add the error variant**

In `error.rs` add to the enum (after `Database`):

```rust
    /// OCR or AI import failure. The code is stable so the UI can branch on it:
    /// `ocr_unavailable`, `ocr_empty`, `ai_not_configured`, `ai_unreachable`,
    /// `ai_auth`, `ai_bad_response`.
    #[error("{1}")]
    Ai(&'static str, String),
```

and in `fn code`:

```rust
            AppError::Ai(code, _) => code,
```

- [ ] **Step 2: Add the models**

Append to `models.rs`:

```rust
// ── Photo import ─────────────────────────────────────────────────────────────

/// One reviewable draft transaction. Stored as JSON in `import_drafts.payload`.
/// `hints` are non-blocking notes from import ("low_confidence", "date_assumed",
/// "time_assumed", "kind_assumed", "future_date", "non_myr", "unmatched_account",
/// "unmatched_category"); any user edit clears them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFields {
    pub kind: String,
    pub date: Option<String>,
    pub time: Option<String>,
    pub amount_cents: Option<i64>,
    pub account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDraft {
    pub id: String,
    pub source_name: String,
    pub created_at: String,
    pub fields: DraftFields,
    /// Blocking problems ("amount", "date", "time", "account", "to_account",
    /// "category", "kind"). The draft can be confirmed only when this is empty.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmFailure {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmResult {
    pub confirmed: usize,
    pub failed: Vec<ConfirmFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub base_url: String,
    pub model: String,
    /// The key itself is never sent to the frontend.
    pub has_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub base_url: String,
    pub model: String,
    /// `None` keeps the saved key; `Some("")` clears it.
    pub api_key: Option<String>,
}
```

- [ ] **Step 3: Add the repository functions**

Insert in `repo.rs` just before the `// ── Error mapping helpers` comment:

```rust
// ── Import drafts ────────────────────────────────────────────────────────────

pub struct DraftRow {
    pub id: String,
    pub source_name: String,
    pub payload: String,
    pub created_at: String,
}

fn draft_row(r: &Row) -> rusqlite::Result<DraftRow> {
    Ok(DraftRow {
        id: r.get(0)?,
        source_name: r.get(1)?,
        payload: r.get(2)?,
        created_at: r.get(3)?,
    })
}

pub fn insert_draft(conn: &Connection, id: &str, source_name: &str, payload: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO import_drafts (id, source_name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, source_name, payload, now],
    )?;
    Ok(())
}

pub fn list_drafts(conn: &Connection) -> AppResult<Vec<DraftRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_name, payload, created_at FROM import_drafts ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map([], draft_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_draft(conn: &Connection, id: &str) -> AppResult<DraftRow> {
    conn.query_row(
        "SELECT id, source_name, payload, created_at FROM import_drafts WHERE id = ?1",
        [id],
        draft_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("Draft not found".into()),
        other => other.into(),
    })
}

pub fn update_draft_payload(conn: &Connection, id: &str, payload: &str, now: &str) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE import_drafts SET payload = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, payload, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Draft not found".into()));
    }
    Ok(())
}

pub fn delete_draft(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM import_drafts WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound("Draft not found".into()));
    }
    Ok(())
}
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo test --lib --no-run`
Expected: compiles (warnings about unused new items are fine for now). If a non-exhaustive `match` on `AppError` elsewhere fails to compile, add an `AppError::Ai(..)` arm that behaves like `Validation`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/error.rs src-tauri/src/models.rs src-tauri/src/repo.rs
git commit -m "feat(import): AppError::Ai, draft models, draft repository"
```

---

### Task 3: `ai.rs` — prompt and reply contract (pure code)

**Files:**
- Create: `src-tauri/src/ai.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod ai;`)
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` `[dependencies]` add (the lock already has `reqwest` 0.13 via the updater, using ring-backed rustls):

```toml
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-no-provider"] }
rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }
```

Add `mod ai;` to `lib.rs` next to the other `mod` lines (alphabetical: before `mod apportion;`).

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/ai.rs` with only this test module first:

```rust
//! OpenAI-compatible chat client and the prompt/reply contract for photo import.
//! No database access: callers pass the settings and names in.

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
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib ai::`
Expected: FAIL to compile (`build_messages`, `PromptContext`, `parse_reply` not found).

- [ ] **Step 4: Implement**

Put this above the `#[cfg(test)]` module in `ai.rs`:

```rust
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
```

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib ai::`
Expected: 6 passed.

- [ ] **Step 6: Verify the lockfile still resolves with `--locked`**

Run: `cd src-tauri && cargo build --locked 2>&1 | tail -5`
Expected: it may fail with "lock file needs to be updated". If so run `cargo build` once (updates `Cargo.lock`), then re-run with `--locked` and expect success. Commit the `Cargo.lock` change.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ai.rs src-tauri/src/lib.rs
git commit -m "feat(import): prompt builder and reply parser"
```

---

### Task 4: `ai.rs` — OpenAI-compatible client

**Files:**
- Modify: `src-tauri/src/ai.rs`

- [ ] **Step 1: Add the failing network tests**

Append these inside the existing `mod tests` in `ai.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib ai::`
Expected: FAIL to compile (`chat_completion`, `extract` not found).

- [ ] **Step 3: Implement the client**

Add above the test module in `ai.rs` (and `use std::time::Duration;` at the top):

```rust
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
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib ai::`
Expected: 13 passed. If the 401 test hangs, the server thread is waiting for a second connection: confirm `serve` was given exactly one response for that test.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai.rs
git commit -m "feat(import): OpenAI-compatible chat client with JSON-mode fallback and one retry"
```

---

### Task 5: `drafts.rs` — parsing, matching, and raw→draft

**Files:**
- Create: `src-tauri/src/drafts.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod drafts;`)

- [ ] **Step 1: Write the failing tests**

Add `mod drafts;` to `lib.rs` (after `mod db;`). Create `src-tauri/src/drafts.rs`:

```rust
//! Photo-import drafts: turn an LLM reply into reviewable drafts, check them,
//! and post confirmed ones through the normal transaction path. Also holds the
//! AI connection settings. SQL stays in repo.rs.

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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib drafts::`
Expected: FAIL to compile (`parse_amount_cents`, `match_unique`, `lookups`, `fields_from_raw`, `problems` not found).

- [ ] **Step 3: Implement**

Put above the test module in `drafts.rs`:

```rust
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
```

Note: `let mut hint = |h: &str| hints.push(...)` borrows `hints` mutably for the closure's life; the final `DraftFields { hints, .. }` move happens after the last `hint(...)` call, so the borrow has ended. If the borrow checker objects, replace the closure with a plain `hints.push("x".to_string())` at each site.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib drafts::`
Expected: 9 passed. (The `AiConfig` import is unused until Task 6; a warning is fine.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/drafts.rs src-tauri/src/lib.rs
git commit -m "feat(import): amount parsing, name matching and draft resolution"
```

---

### Task 6: `drafts.rs` — persistence, confirm, and AI settings

**Files:**
- Modify: `src-tauri/src/drafts.rs`
- Modify: `src-tauri/src/service.rs:1119` (`get_setting`)

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `drafts.rs`:

```rust
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

    #[test]
    fn ai_settings_round_trip_and_never_expose_the_key() {
        let c = db();
        assert_eq!(get_ai_settings(&c).unwrap().has_key, false);
        let saved = set_ai_settings(
            &c,
            AiSettingsInput { base_url: " https://example.test/v1/ ".into(), model: " m ".into(), api_key: Some("k1".into()) },
        )
        .unwrap();
        assert_eq!(saved.base_url, "https://example.test/v1");
        assert_eq!(saved.model, "m");
        assert!(saved.has_key);

        // None keeps the key; Some("") clears it.
        let kept = set_ai_settings(&c, AiSettingsInput { base_url: saved.base_url.clone(), model: "m".into(), api_key: None }).unwrap();
        assert!(kept.has_key);
        assert_eq!(load_ai_config(&c).unwrap().api_key.as_deref(), Some("k1"));
        let cleared = set_ai_settings(&c, AiSettingsInput { base_url: saved.base_url, model: "m".into(), api_key: Some(String::new()) }).unwrap();
        assert!(!cleared.has_key);

        // The generic settings reader must not leak the key.
        assert!(service::get_setting(&c, KEY_API_KEY).is_err());
    }

    #[test]
    fn config_requires_a_base_url_and_model_and_a_http_scheme() {
        let c = db();
        match load_ai_config(&c) {
            Err(AppError::Ai(code, _)) => assert_eq!(code, "ai_not_configured"),
            other => panic!("expected ai_not_configured, got {other:?}"),
        }
        let err = set_ai_settings(&c, AiSettingsInput { base_url: "ftp://x".into(), model: "m".into(), api_key: None }).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib drafts::`
Expected: FAIL to compile (`store_drafts`, `list_drafts`, `update_draft`, `confirm_drafts`, `discard_drafts`, AI settings functions not found).

- [ ] **Step 3: Implement**

Append to `drafts.rs` above the test module:

```rust
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

// ── AI settings ──────────────────────────────────────────────────────────────

pub fn get_ai_settings(conn: &Connection) -> AppResult<AiSettings> {
    Ok(AiSettings {
        base_url: repo::get_setting(conn, KEY_BASE_URL)?.unwrap_or_default(),
        model: repo::get_setting(conn, KEY_MODEL)?.unwrap_or_default(),
        has_key: repo::get_setting(conn, KEY_API_KEY)?.is_some_and(|k| !k.is_empty()),
    })
}

pub fn set_ai_settings(conn: &Connection, input: AiSettingsInput) -> AppResult<AiSettings> {
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    if !base_url.is_empty() && !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(AppError::Validation("The base URL must start with http:// or https://".into()));
    }
    let now = crate::now();
    repo::set_setting(conn, KEY_BASE_URL, &base_url, &now)?;
    repo::set_setting(conn, KEY_MODEL, input.model.trim(), &now)?;
    if let Some(key) = input.api_key {
        repo::set_setting(conn, KEY_API_KEY, key.trim(), &now)?;
    }
    get_ai_settings(conn)
}

pub fn load_ai_config(conn: &Connection) -> AppResult<AiConfig> {
    let base_url = repo::get_setting(conn, KEY_BASE_URL)?.unwrap_or_default();
    let model = repo::get_setting(conn, KEY_MODEL)?.unwrap_or_default();
    if base_url.is_empty() || model.is_empty() {
        return Err(AppError::Ai("ai_not_configured", "Set the AI base URL and model in Settings first.".into()));
    }
    let api_key = repo::get_setting(conn, KEY_API_KEY)?.filter(|k| !k.is_empty());
    Ok(AiConfig { base_url, model, api_key })
}

/// Everything the async extract command needs, read under one short lock.
pub fn prepare(conn: &Connection) -> AppResult<(AiConfig, PromptContext, String)> {
    let cfg = load_ai_config(conn)?;
    let lk = lookups(conn)?;
    Ok((cfg, prompt_context(&lk), crate::today()))
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
                service::create_transfer(conn, account, to, amount, f.note.as_deref(), date, f.time.as_deref())?;
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
```

- [ ] **Step 4: Block the key from the generic reader**

In `service.rs`, replace `get_setting`:

```rust
pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let key = require_nonempty("Key", key)?;
    if key == crate::drafts::KEY_API_KEY {
        return Err(AppError::Validation("That setting is write-only.".into()));
    }
    repo::get_setting(conn, &key)
}
```

- [ ] **Step 5: Run the whole Rust suite**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass (the pre-existing tests plus ~35 new ones). If `service::archive_account` or `get_account_balance` signatures differ from what the tests assume, adjust the test calls (the production code does not use them).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/drafts.rs src-tauri/src/service.rs
git commit -m "feat(import): draft store, edit, confirm and AI settings"
```

---

### Task 7: `ocr.rs` — native OS text recognition

**Files:**
- Create: `src-tauri/src/ocr.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod ocr;`)
- Modify: `src-tauri/Cargo.toml`

The macOS backend below was compiled and run against a real image while planning (it returned `KOPITIAM LIM\nTotal RM 12.50`). The Windows backend is written against `windows` 0.61 and could not be compiled on macOS: Step 6 builds it on Windows.

- [ ] **Step 1: Add platform dependencies**

Append to `src-tauri/Cargo.toml` (after the existing `[target.'cfg(any(...))'.dependencies]` block):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-vision = "0.3"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = ["Foundation", "Foundation_Collections", "Graphics_Imaging", "Media_Ocr", "Storage_Streams"] }
```

Add `mod ocr;` to `lib.rs`.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/ocr.rs`:

```rust
//! Native OS text recognition. One backend per platform behind `recognize`.
//! Only the extracted text leaves this module; the image is never stored.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bytes_that_are_not_an_image() {
        assert!(recognize(&[0, 1, 2, 3]).is_err());
    }

    #[test]
    fn empty_text_is_reported_as_ocr_empty() {
        match finish(String::from("  \n ")) {
            Err(AppError::Ai(code, _)) => assert_eq!(code, "ocr_empty"),
            other => panic!("expected ocr_empty, got {other:?}"),
        }
        assert_eq!(finish(" hello \n".into()).unwrap(), "hello");
    }

    /// Manual smoke test: `SENS_OCR_SAMPLE=/path/to/receipt.png cargo test --lib -- --ignored recognizes_a_sample`
    #[test]
    #[ignore]
    fn recognizes_a_sample_image() {
        let path = std::env::var("SENS_OCR_SAMPLE").expect("set SENS_OCR_SAMPLE to an image path");
        let text = recognize(&std::fs::read(path).unwrap()).unwrap();
        println!("{text}");
        assert!(!text.is_empty());
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib ocr::`
Expected: FAIL to compile (`recognize`, `finish`, `AppError` not found).

- [ ] **Step 4: Implement**

Add above the test module:

```rust
use crate::error::{AppError, AppResult};

pub fn recognize(image: &[u8]) -> AppResult<String> {
    finish(platform::recognize(image)?)
}

fn finish(text: String) -> AppResult<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::Ai("ocr_empty", "No text was found in that image.".into()));
    }
    Ok(text)
}

fn unavailable(message: impl Into<String>) -> AppError {
    AppError::Ai("ocr_unavailable", message.into())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    pub fn recognize(image: &[u8]) -> AppResult<String> {
        let data = NSData::with_bytes(image);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let as_request: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
        let requests = NSArray::from_retained_slice(&[as_request]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| unavailable(format!("Could not read the image: {}", e.localizedDescription())))?;
        let mut lines = Vec::new();
        if let Some(results) = request.results() {
            for obs in results.iter() {
                let obs: Retained<VNRecognizedTextObservation> = unsafe { Retained::cast_unchecked(obs) };
                if let Some(best) = obs.topCandidates(1).iter().next() {
                    lines.push(best.string().to_string());
                }
            }
        }
        Ok(lines.join("\n"))
    }
}

#[cfg(windows)]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    fn run(image: &[u8]) -> windows::core::Result<String> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(image)?;
        writer.StoreAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines.join("\n"))
    }

    pub fn recognize(image: &[u8]) -> AppResult<String> {
        run(image).map_err(|e| unavailable(format!("Could not read the image: {e}")))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;

    pub fn recognize(_image: &[u8]) -> AppResult<String> {
        Err(unavailable("Text recognition is available on macOS and Windows only."))
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib ocr::`
Expected on macOS: 2 passed, 1 ignored. Then the manual smoke test with any receipt photo or screenshot:

```bash
cd src-tauri && SENS_OCR_SAMPLE=/path/to/receipt.png cargo test --lib -- --ignored recognizes_a_sample --nocapture
```
Expected: the receipt text is printed and the test passes.

Also run `cargo build --locked`; if `Cargo.lock` changed, commit it.

- [ ] **Step 6: Windows verification (manual, required before merge)**

On a Windows machine with Rust installed: `cd src-tauri && cargo test --lib ocr::` and the ignored smoke test above with a sample receipt. Expected: same results as macOS. If the `windows` calls do not compile, fix them against `windows` 0.61 docs (`BitmapDecoder`, `OcrEngine`) and keep the module's public `recognize(&[u8]) -> AppResult<String>` unchanged. CI is Ubuntu-only and cannot catch this; the release workflow builds Windows.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ocr.rs src-tauri/src/lib.rs
git commit -m "feat(import): native OS OCR (Apple Vision, Windows.Media.Ocr)"
```

---

### Task 8: Commands and registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (append)
- Modify: `src-tauri/src/lib.rs` (`generate_handler!` list)

- [ ] **Step 1: Add the commands**

Append to `commands.rs`:

```rust
// ── Photo import ─────────────────────────────────────────────────────────────

/// Receives the image as a raw IPC body (not a JSON number array) and returns
/// the recognised text. OCR is blocking, so it runs off the async threads.
#[tauri::command]
pub async fn ocr_image(request: tauri::ipc::Request<'_>) -> AppResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(crate::error::AppError::Validation("Expected raw image bytes".into()));
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize(&bytes))
        .await
        .map_err(|e| crate::error::AppError::Ai("ocr_unavailable", e.to_string()))?
}

/// Ask the model for transactions in `text` and store them as drafts. The
/// database lock is never held across the network call.
#[tauri::command]
pub async fn extract_drafts(state: State<'_, DbState>, source_name: String, text: String) -> AppResult<Vec<ImportDraft>> {
    let (cfg, ctx, today) = with_conn!(state, c => crate::drafts::prepare(&c))?;
    let messages = crate::ai::build_messages(&text, &ctx, &today);
    let raws = crate::ai::extract(&cfg, messages).await?;
    with_conn!(state, c => crate::drafts::store_drafts(&c, &source_name, &raws, &crate::today()))
}

#[tauri::command]
pub fn list_import_drafts(state: State<'_, DbState>) -> AppResult<Vec<ImportDraft>> {
    with_conn!(state, c => crate::drafts::list_drafts(&c))
}

#[tauri::command]
pub fn update_import_draft(state: State<'_, DbState>, id: String, fields: DraftFields) -> AppResult<ImportDraft> {
    with_conn!(state, c => crate::drafts::update_draft(&c, &id, fields))
}

#[tauri::command]
pub fn discard_import_drafts(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<()> {
    with_conn!(state, c => crate::drafts::discard_drafts(&c, &ids))
}

#[tauri::command]
pub fn confirm_import_drafts(state: State<'_, DbState>, ids: Vec<String>) -> AppResult<ConfirmResult> {
    with_conn!(state, c => crate::drafts::confirm_drafts(&c, &ids))
}

#[tauri::command]
pub fn get_ai_settings(state: State<'_, DbState>) -> AppResult<AiSettings> {
    with_conn!(state, c => crate::drafts::get_ai_settings(&c))
}

#[tauri::command]
pub fn set_ai_settings(state: State<'_, DbState>, input: AiSettingsInput) -> AppResult<AiSettings> {
    with_conn!(state, c => crate::drafts::set_ai_settings(&c, input))
}

/// Tests the saved settings (the Settings screen saves first).
#[tauri::command]
pub async fn test_ai_connection(state: State<'_, DbState>) -> AppResult<()> {
    let cfg = with_conn!(state, c => crate::drafts::load_ai_config(&c))?;
    crate::ai::test_connection(&cfg).await
}
```

- [ ] **Step 2: Register them**

In `lib.rs`, add to `tauri::generate_handler![...]` after `commands::run_schedule_pass,`:

```rust
            commands::ocr_image,
            commands::extract_drafts,
            commands::list_import_drafts,
            commands::update_import_draft,
            commands::discard_import_drafts,
            commands::confirm_import_drafts,
            commands::get_ai_settings,
            commands::set_ai_settings,
            commands::test_ai_connection,
```

- [ ] **Step 3: Build and test**

Run: `cd src-tauri && cargo build --locked && cargo test --lib --locked`
Expected: build succeeds; all tests pass.

If `extract_drafts` fails with "future cannot be sent between threads", the `with_conn!` guard is being kept alive across the `.await`. Fix by moving each `with_conn!` call into its own `let` statement as written above (do not inline them into one expression).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.lock
git commit -m "feat(import): Tauri commands for OCR, extraction, drafts and AI settings"
```

---

### Task 9: Frontend types, client, and mock

**Files:**
- Modify: `src/types.ts` (append)
- Modify: `src/client/invoke.ts`, `src/client/index.ts`, `src/client/mock.ts`
- Create: `src/__tests__/mock-drafts.test.ts`

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```ts
// ── Photo import ─────────────────────────────────────────────────────────────

export type DraftKind = "expense" | "income" | "transfer";

export interface DraftFields {
  kind: DraftKind;
  date: string | null;
  time: string | null;
  amountCents: number | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  /** Non-blocking notes from import; cleared by any edit. */
  hints: string[];
}

export interface ImportDraft {
  id: string;
  sourceName: string;
  createdAt: string;
  fields: DraftFields;
  /** Blocking problems: "amount" | "date" | "time" | "account" | "to_account" | "category" | "kind". */
  problems: string[];
}

export interface ConfirmResult {
  confirmed: number;
  failed: { id: string; message: string }[];
}

export interface AiSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface AiSettingsInput {
  baseUrl: string;
  model: string;
  /** null keeps the saved key; "" clears it. */
  apiKey: string | null;
}
```

- [ ] **Step 2: Write the failing mock tests**

Create `src/__tests__/mock-drafts.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../client";

beforeEach(async () => {
  await client.resetApp();
  await client.setSetting("transaction_time_enabled", "0");
});

async function configureAi() {
  await client.setAiSettings({ baseUrl: "http://localhost:11434/v1", model: "llava", apiKey: null });
}

describe("mock photo import", () => {
  it("reads text from raw image bytes", async () => {
    const text = await client.ocrImage(new Uint8Array([1, 2, 3]));
    expect(text).toContain("Total RM 12.50");
  });

  it("rejects empty image bytes", async () => {
    await expect(client.ocrImage(new Uint8Array())).rejects.toMatchObject({ code: "ocr_empty" });
  });

  it("refuses to extract until AI is configured", async () => {
    await expect(client.extractDrafts("a.png", "text")).rejects.toMatchObject({ code: "ai_not_configured" });
  });

  it("creates drafts, edits them, and confirms them into transactions", async () => {
    await client.createAccount("Maybank Savings", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("receipt.png", "text");
    expect(created).toHaveLength(1);
    expect(created[0].fields.kind).toBe("expense");
    expect(created[0].problems).toEqual([]);

    const edited = await client.updateImportDraft(created[0].id, { ...created[0].fields, note: "Edited note" });
    expect(edited.fields.hints).toEqual([]);

    const result = await client.confirmImportDrafts([created[0].id]);
    expect(result.confirmed).toBe(1);
    expect(await client.listImportDrafts()).toHaveLength(0);
    const txns = await client.listTransactions({});
    expect(txns.some((t) => t.description === "Edited note" && t.amountCents === 1250)).toBe(true);
  });

  it("keeps a draft with problems and reports it as failed", async () => {
    await configureAi();
    const created = await client.extractDrafts("receipt.png", "text"); // no accounts yet
    expect(created[0].problems).toContain("account");
    const result = await client.confirmImportDrafts([created[0].id]);
    expect(result.confirmed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(await client.listImportDrafts()).toHaveLength(1);
  });

  it("adds a transfer draft when there are two accounts", async () => {
    await client.createAccount("A", "savings", 0, null);
    await client.createAccount("B", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    expect(created.map((d) => d.fields.kind)).toEqual(["expense", "transfer"]);
    expect(created[1].fields.toAccountId).not.toBe(created[1].fields.accountId);
  });

  it("discards drafts", async () => {
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    await client.discardImportDrafts([created[0].id]);
    expect(await client.listImportDrafts()).toHaveLength(0);
  });

  it("flags a transfer to the same account", async () => {
    await client.createAccount("A", "savings", 0, null);
    await client.createAccount("B", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    const t = created[1];
    const same = await client.updateImportDraft(t.id, { ...t.fields, toAccountId: t.fields.accountId });
    expect(same.problems).toContain("to_account");
  });

  it("keeps the API key write-only", async () => {
    const saved = await client.setAiSettings({ baseUrl: "http://x.test/v1/", model: "m", apiKey: "secret" });
    expect(saved).toEqual({ baseUrl: "http://x.test/v1", model: "m", hasKey: true });
    await expect(client.getSetting("ai_api_key")).rejects.toMatchObject({ code: "ValidationError" });
    const kept = await client.setAiSettings({ baseUrl: "http://x.test/v1", model: "m", apiKey: null });
    expect(kept.hasKey).toBe(true);
    const cleared = await client.setAiSettings({ baseUrl: "http://x.test/v1", model: "m", apiKey: "" });
    expect(cleared.hasKey).toBe(false);
  });

  it("rejects a base URL without http(s)", async () => {
    await expect(client.setAiSettings({ baseUrl: "ftp://x", model: "m", apiKey: null })).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("clears drafts on factory reset", async () => {
    await configureAi();
    await client.extractDrafts("s.png", "text");
    await client.resetApp();
    expect(await client.listImportDrafts()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/__tests__/mock-drafts.test.ts`
Expected: FAIL (`client.ocrImage is not a function`).

- [ ] **Step 4: Add `dispatchRaw`**

Append to `src/client/invoke.ts`:

```ts
/** Sends raw bytes as the IPC body (no JSON number array), for large payloads such as images. */
export async function dispatchRaw<T>(command: string, bytes: Uint8Array): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, bytes);
  }
  return mockInvoke<T>(command, { bytes });
}
```

- [ ] **Step 5: Add the client wrappers**

In `src/client/index.ts`: add `AiSettings, AiSettingsInput, ConfirmResult, DraftFields, ImportDraft,` to the type import list, change the import to `import { dispatch, dispatchRaw } from "./invoke";`, and add inside `client` after the schedule wrappers:

```ts
  // Photo import
  ocrImage: (bytes: Uint8Array) => dispatchRaw<string>("ocr_image", bytes),
  extractDrafts: (sourceName: string, text: string) =>
    dispatch<ImportDraft[]>("extract_drafts", { sourceName, text }),
  listImportDrafts: () => dispatch<ImportDraft[]>("list_import_drafts"),
  updateImportDraft: (id: string, fields: DraftFields) =>
    dispatch<ImportDraft>("update_import_draft", { id, fields }),
  discardImportDrafts: (ids: string[]) => dispatch<void>("discard_import_drafts", { ids }),
  confirmImportDrafts: (ids: string[]) => dispatch<ConfirmResult>("confirm_import_drafts", { ids }),
  getAiSettings: () => dispatch<AiSettings>("get_ai_settings"),
  setAiSettings: (input: AiSettingsInput) => dispatch<AiSettings>("set_ai_settings", { input }),
  testAiConnection: () => dispatch<void>("test_ai_connection"),
```

- [ ] **Step 6: Add the mock backend**

In `src/client/mock.ts`:

1. Add `AiSettings, DraftFields, ImportDraft,` to the `../types` import list (keep it alphabetical).
2. Add this block after the `const occurrences: OccurrenceRow[] = [];` line (near line 268):

```ts
// ── Photo import (mirrors src-tauri/src/drafts.rs) ───────────────────────────

interface DraftRowMock {
  id: string;
  sourceName: string;
  createdAt: string;
  fields: DraftFields;
}
const drafts: DraftRowMock[] = [];
const MOCK_OCR_TEXT = "KOPITIAM LIM\n15/10/2026 13:42\nNasi lemak 8.00\nTeh ais 4.50\nTotal RM 12.50";

function draftProblems(f: DraftFields): string[] {
  const p: string[] = [];
  if (f.amountCents == null || f.amountCents <= 0) p.push("amount");
  if (!f.date) p.push("date");
  if (timeEnabled() && !f.time) p.push("time");
  if (!f.accountId) p.push("account");
  if (f.kind === "transfer") {
    if (!f.toAccountId || f.toAccountId === f.accountId) p.push("to_account");
  } else if (f.kind === "income" || f.kind === "expense") {
    if (!f.categoryId) p.push("category");
  } else {
    p.push("kind");
  }
  return p;
}

function presentDraft(d: DraftRowMock): ImportDraft {
  return { id: d.id, sourceName: d.sourceName, createdAt: d.createdAt, fields: { ...d.fields, hints: [...d.fields.hints] }, problems: draftProblems(d.fields) };
}

function findDraft(id: string): DraftRowMock {
  return drafts.find((d) => d.id === id) ?? fail("NotFound", "Draft not found");
}

function normalizeOptional(value: string | null | undefined, pattern: RegExp, message: string): string | null {
  const t = (value ?? "").trim();
  if (!t) return null;
  if (!pattern.test(t)) fail("ValidationError", message);
  return t;
}

function aiSettings(): AiSettings {
  return {
    baseUrl: settings.get("ai_base_url") ?? "",
    model: settings.get("ai_model") ?? "",
    hasKey: (settings.get("ai_api_key") ?? "") !== "",
  };
}
```

3. In the `switch (command)` of `mockInvokeInner`, add before `case "get_setting":` and then change `get_setting`:

```ts
    case "ocr_image": {
      const bytes = a.bytes as Uint8Array;
      if (!bytes || bytes.length === 0) fail("ocr_empty", "No text was found in that image.");
      return MOCK_OCR_TEXT as T;
    }
    case "extract_drafts": {
      if (!settings.get("ai_base_url") || !settings.get("ai_model")) {
        fail("ai_not_configured", "Set the AI base URL and model in Settings first.");
      }
      const active = accounts.filter((x) => !x.isArchived);
      const category = categories.find((c) => c.kind === "expense" && !c.isSystem && !c.isArchived && c.parentId == null);
      const needTime = timeEnabled();
      const rows: DraftFields[] = [
        {
          kind: "expense", date: today(), time: needTime ? "00:00" : null, amountCents: 1250,
          accountId: active[0]?.id ?? null, toAccountId: null, categoryId: category?.id ?? null,
          note: "Kopitiam Lim", hints: needTime ? ["time_assumed"] : [],
        },
      ];
      if (active.length > 1) {
        rows.push({
          kind: "transfer", date: today(), time: needTime ? "00:00" : null, amountCents: 5000,
          accountId: active[0].id, toAccountId: active[1].id, categoryId: null,
          note: "Top up", hints: ["low_confidence", ...(needTime ? ["time_assumed"] : [])],
        });
      }
      const created = rows.map((fields) => {
        const row: DraftRowMock = { id: uid(), sourceName: String(a.sourceName).trim() || "Pasted image", createdAt: now(), fields };
        drafts.push(row);
        return presentDraft(row);
      });
      return created as T;
    }
    case "list_import_drafts":
      return drafts.map(presentDraft) as T;
    case "update_import_draft": {
      const row = findDraft(a.id);
      const f: DraftFields = { ...a.fields };
      f.kind = String(f.kind).trim().toLowerCase() as DraftFields["kind"];
      if (!["expense", "income", "transfer"].includes(f.kind)) fail("ValidationError", "Kind must be expense, income or transfer");
      f.date = normalizeOptional(f.date, /^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
      f.time = normalizeOptional(f.time, /^\d{2}:\d{2}$/, "Time must be in HH:MM 24-hour format");
      if (f.time && !isHHMM(f.time)) fail("ValidationError", "Time must be in HH:MM 24-hour format");
      f.note = (f.note ?? "").trim() || null;
      if (f.kind === "transfer") f.categoryId = null;
      else f.toAccountId = null;
      f.hints = [];
      row.fields = f;
      return presentDraft(row) as T;
    }
    case "discard_import_drafts": {
      for (const id of a.ids as string[]) findDraft(id);
      for (const id of a.ids as string[]) drafts.splice(drafts.findIndex((d) => d.id === id), 1);
      return undefined as T;
    }
    case "confirm_import_drafts": {
      let confirmed = 0;
      const failed: { id: string; message: string }[] = [];
      for (const id of a.ids as string[]) {
        try {
          const row = findDraft(id);
          if (draftProblems(row.fields).length > 0) fail("ValidationError", "Fix the highlighted fields first.");
          const f = row.fields;
          if (f.kind === "transfer") {
            addTransfer({ fromAccountId: f.accountId, toAccountId: f.toAccountId, amountCents: f.amountCents, description: f.note, date: f.date, time: f.time });
          } else {
            addIncomeOrExpense(f.kind, { accountId: f.accountId, categoryId: f.categoryId, amountCents: f.amountCents, description: f.note, date: f.date, time: f.time, excludedFromReporting: false, splits: null });
          }
          drafts.splice(drafts.indexOf(row), 1);
          confirmed += 1;
        } catch (e) {
          failed.push({ id, message: (e as { message?: string })?.message ?? "Could not post this draft." });
        }
      }
      return { confirmed, failed } as T;
    }
    case "get_ai_settings":
      return aiSettings() as T;
    case "set_ai_settings": {
      const url = String(a.input.baseUrl).trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\//.test(url)) fail("ValidationError", "The base URL must start with http:// or https://");
      settings.set("ai_base_url", url);
      settings.set("ai_model", String(a.input.model).trim());
      if (a.input.apiKey != null) settings.set("ai_api_key", String(a.input.apiKey).trim());
      return aiSettings() as T;
    }
    case "test_ai_connection": {
      if (!settings.get("ai_base_url") || !settings.get("ai_model")) {
        fail("ai_not_configured", "Set the AI base URL and model in Settings first.");
      }
      return undefined as T;
    }
```

   and replace the existing `get_setting` case with:

```ts
    case "get_setting":
      if (String(a.key).trim() === "ai_api_key") fail("ValidationError", "That setting is write-only.");
      return (settings.get(String(a.key)) ?? null) as T;
```

4. In the `reset_app` case add `drafts.length = 0;` next to `occurrences.length = 0;`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run src/__tests__/mock-drafts.test.ts && npm run build`
Expected: 10 passed; build clean (strict TS, no unused). If `addIncomeOrExpense(f.kind, ...)` complains that `f.kind` is `"expense" | "income" | "transfer"`, narrow it with `f.kind === "income" ? "income" : "expense"`.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/client src/__tests__/mock-drafts.test.ts
git commit -m "feat(import): client wrappers and mock backend for photo import"
```

---

### Task 10: Sidebar entry and routing

**Files:**
- Modify: `src/nav.ts`
- Modify: `src/App.tsx`
- Create (stub for this task): `src/screens/Drafts.tsx`

- [ ] **Step 1: Add the nav entry**

In `src/nav.ts`:

```ts
export type ScreenId = "dashboard" | "plan" | "accounts" | "transactions" | "drafts" | "categories" | "settings";
```

Add to `NAV` after the `transactions` entry:

```ts
  { id: "drafts", label: "Drafts", icon: "sparkle", sub: "Review photo imports before they post" },
```

Change the Money section:

```ts
  { label: "Money", items: ["accounts", "transactions", "drafts", "categories"] },
```

- [ ] **Step 2: Create a minimal screen so routing compiles**

Create `src/screens/Drafts.tsx`:

```tsx
export function Drafts({ onCountChange }: { onCountChange: (n: number) => void }) {
  void onCountChange;
  return <div className="sens-screen">Drafts</div>;
}
```

- [ ] **Step 3: Route it and badge the sidebar**

In `src/App.tsx`:
- Add `import { Drafts } from "./screens/Drafts";` next to the other screen imports.
- Add state near the other `useState` calls: `const [draftCount, setDraftCount] = useState(0);`
- Load the count once at startup, after the `oweNoticeChecked` effect:

```tsx
  useEffect(() => {
    client.listImportDrafts().then((d) => setDraftCount(d.length)).catch(() => {});
  }, [version]);
```

- In `navCount` add: `if (id === "drafts") return draftCount > 0 ? draftCount : null;`
- In the screen switch add after the transactions block:

```tsx
            {active === "drafts" && <Drafts onCountChange={setDraftCount} />}
```

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: clean. Then `npm run dev` and open the printed URL: the sidebar's Money section shows **Drafts** after Transactions; clicking it shows the stub and the top bar subtitle "Review photo imports before they post".

- [ ] **Step 5: Commit**

```bash
git add src/nav.ts src/App.tsx src/screens/Drafts.tsx
git commit -m "feat(import): Drafts sidebar entry and routing"
```

---

### Task 11: Drafts screen

**Files:**
- Modify: `src/screens/Drafts.tsx` (replace the stub)

Behavior: a **Choose photo** button and a paste target feed `handleFile`. Pipeline states: idle → reading → extracting. Pending drafts render as editable rows with problem and hint markers (icon + text, never color alone). Confirm and Discard per row; Confirm all ready and Discard all in the header. Errors show as toasts; if extraction fails, the OCR text stays visible so nothing is lost.

- [ ] **Step 1: Write the screen**

Replace `src/screens/Drafts.tsx`:

```tsx
// Drafts: upload or paste a photo, let the AI propose transactions, review and edit
// them, then confirm. Nothing is saved as a transaction until a draft is confirmed.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, AiSettings, Category, DraftFields, ImportDraft } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Card, Empty, SectionTitle, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { client } from "../client";
import { useAppData } from "../store";
import { categoryPickerItems } from "../lib/categories";
import { fmtMoney, parseAmountToCents } from "../lib/format";
import { useTimeSetting } from "../lib/useTimeSetting";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PROBLEM_TEXT: Record<string, string> = {
  amount: "Enter an amount",
  date: "Enter a date",
  time: "Enter a time",
  account: "Choose an account",
  to_account: "Choose a different destination account",
  category: "Choose a category",
  kind: "Choose a kind",
};

const HINT_TEXT: Record<string, string> = {
  low_confidence: "The AI was unsure about this one",
  date_assumed: "No date found, so today was used",
  time_assumed: "No time found, so 00:00 was used",
  kind_assumed: "Kind was a guess",
  future_date: "This date is in the future",
  non_myr: "The amount may not be in MYR",
  unmatched_account: "Could not match an account",
  unmatched_category: "Could not match a category",
};

function messageOf(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : (error as { message?: string } | null)?.message) ?? fallback;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

type Busy = "idle" | "reading" | "extracting";

export function Drafts({ onCountChange }: { onCountChange: (n: number) => void }) {
  const t = useTheme();
  const { accounts, categories, reload } = useAppData();
  const { notify } = useToast();
  const [timeEnabled] = useTimeSetting();
  const [drafts, setDrafts] = useState<ImportDraft[] | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [lostText, setLostText] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = useCallback((next: ImportDraft[]) => {
    setDrafts(next);
    onCountChange(next.length);
  }, [onCountChange]);

  useEffect(() => {
    client.listImportDrafts().then(update).catch((e) => notify(messageOf(e, "Could not load drafts"), "error"));
    client.getAiSettings().then(setAi).catch(() => {});
  }, [update, notify]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("That file is not an image.", "error");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify("That image is larger than 20 MB.", "error");
      return;
    }
    setLostText(null);
    let text = "";
    try {
      setBusy("reading");
      text = await client.ocrImage(new Uint8Array(await file.arrayBuffer()));
      setBusy("extracting");
      const created = await client.extractDrafts(file.name || "Pasted image", text);
      setDrafts((prev) => {
        const next = [...(prev ?? []), ...created];
        onCountChange(next.length);
        return next;
      });
      notify(created.length === 0 ? "No transactions found in that image." : `${created.length} draft${created.length === 1 ? "" : "s"} ready to review.`, "info");
    } catch (error) {
      if (text) setLostText(text);
      notify(messageOf(error, "Could not read that image"), "error");
    } finally {
      setBusy("idle");
    }
  }, [notify, onCountChange]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handleFile]);

  const replace = (draft: ImportDraft) => update((drafts ?? []).map((d) => (d.id === draft.id ? draft : d)));

  const confirm = async (ids: string[]) => {
    try {
      const result = await client.confirmImportDrafts(ids);
      update(await client.listImportDrafts());
      if (result.confirmed > 0) {
        reload();
        notify(`${result.confirmed} transaction${result.confirmed === 1 ? "" : "s"} added.`, "info");
      }
      for (const failure of result.failed) notify(failure.message, "error");
    } catch (error) {
      notify(messageOf(error, "Could not confirm"), "error");
    }
  };

  const discard = async (ids: string[]) => {
    try {
      await client.discardImportDrafts(ids);
      update(await client.listImportDrafts());
    } catch (error) {
      notify(messageOf(error, "Could not discard"), "error");
    }
  };

  const ready = (drafts ?? []).filter((d) => d.problems.length === 0);
  const configured = !!ai && ai.baseUrl !== "" && ai.model !== "";
  const cloud = !!ai && ai.baseUrl !== "" && !isLocalUrl(ai.baseUrl);

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <SectionTitle sub="The text in the photo is read on this computer. Only that text, your account names and category names go to the AI provider you set in Settings.">
          Add from a photo
        </SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Btn icon="plus" disabled={busy !== "idle" || !configured} onClick={() => fileInput.current?.click()}>
            Choose photo
          </Btn>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleFile(file);
            }}
          />
          <span style={{ fontSize: 12.5, color: t.dim }}>
            {busy === "reading" && "Reading the text in your photo…"}
            {busy === "extracting" && "Asking the AI to find transactions…"}
            {busy === "idle" && "or paste a screenshot with Cmd/Ctrl+V"}
          </span>
        </div>
        {ai && !configured && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
            <Icon name="info" size={15} color={t.dim} />
            Set an AI base URL and model in Settings → AI import to use this.
          </div>
        )}
        {cloud && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
            <Icon name="info" size={15} color={t.dim} />
            Text from your photos is sent to {ai?.baseUrl}.
          </div>
        )}
      </Card>

      {lostText && (
        <Card>
          <SectionTitle sub="The AI step failed. You can copy this and add the transactions by hand.">Text read from the photo</SectionTitle>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, color: t.dim, fontFamily: t.mono, userSelect: "text" }}>{lostText}</pre>
        </Card>
      )}

      {drafts === null ? (
        <Card>
          <Skeleton height={44} radius={8} />
        </Card>
      ) : drafts.length === 0 ? (
        <Card>
          <Empty icon="sparkle" title="No drafts" hint="Upload a receipt or a bank screenshot and the transactions it finds will appear here." />
        </Card>
      ) : (
        <Card>
          <SectionTitle
            sub={`${drafts.length} pending · ${ready.length} ready`}
            right={
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="outline" size="sm" disabled={ready.length === 0} onClick={() => void confirm(ready.map((d) => d.id))}>
                  Confirm all ready
                </Btn>
                <Btn variant="danger" size="sm" onClick={() => void discard(drafts.map((d) => d.id))}>
                  Discard all
                </Btn>
              </div>
            }
          >
            Review drafts
          </SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts.map((d) => (
              <DraftRow
                key={d.id}
                draft={d}
                accounts={accounts}
                categories={categories}
                timeEnabled={timeEnabled}
                onSaved={replace}
                onConfirm={() => void confirm([d.id])}
                onDiscard={() => void discard([d.id])}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function DraftRow({
  draft, accounts, categories, timeEnabled, onSaved, onConfirm, onDiscard,
}: {
  draft: ImportDraft;
  accounts: Account[];
  categories: Category[];
  timeEnabled: boolean;
  onSaved: (d: ImportDraft) => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const t = useTheme();
  const { notify } = useToast();
  const [fields, setFields] = useState<DraftFields>(draft.fields);
  const [amountText, setAmountText] = useState(draft.fields.amountCents != null ? (draft.fields.amountCents / 100).toFixed(2) : "");
  const input = inputStyle(t);
  const activeAccounts = accounts.filter((a) => !a.isArchived);
  const kind = fields.kind;

  useEffect(() => {
    setFields(draft.fields);
    setAmountText(draft.fields.amountCents != null ? (draft.fields.amountCents / 100).toFixed(2) : "");
  }, [draft]);

  const save = async (next: DraftFields) => {
    try {
      onSaved(await client.updateImportDraft(draft.id, next));
    } catch (error) {
      notify(messageOf(error, "Could not save"), "error");
    }
  };

  // Edits are kept locally while typing and saved when a field loses focus or a select changes.
  const change = (patch: Partial<DraftFields>, saveNow = false) => {
    const next = { ...fields, ...patch };
    setFields(next);
    if (saveNow) void save(next);
  };

  const flagged = (problem: string) => draft.problems.includes(problem);
  const fieldStyle = (problem: string) => ({ ...input, ...(flagged(problem) ? { border: `1px solid ${t.negative}` } : {}) });

  return (
    <div style={{ border: `0.5px solid ${t.border}`, borderRadius: 12, padding: 14, background: t.panel2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
        <div style={{ fontSize: 12, color: t.faint }}>From {draft.sourceName}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" icon="check" disabled={draft.problems.length > 0} onClick={onConfirm}>Confirm</Btn>
          <Btn size="sm" variant="ghost" icon="trash" onClick={onDiscard}>Discard</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Kind</div>
          <select style={fieldStyle("kind")} value={kind} onChange={(e) => change({ kind: e.target.value as DraftFields["kind"] }, true)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </select>
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Date</div>
          <input style={fieldStyle("date")} type="date" value={fields.date ?? ""} onChange={(e) => change({ date: e.target.value || null })} onBlur={() => void save(fields)} />
        </label>
        {timeEnabled && (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Time</div>
            <input style={fieldStyle("time")} type="time" value={fields.time ?? ""} onChange={(e) => change({ time: e.target.value || null })} onBlur={() => void save(fields)} />
          </label>
        )}
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Amount (RM)</div>
          <input
            style={fieldStyle("amount")}
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            onBlur={() => {
              const cents = parseAmountToCents(amountText);
              const next = { ...fields, amountCents: cents };
              setFields(next);
              if (cents != null) setAmountText((cents / 100).toFixed(2));
              void save(next);
            }}
          />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>{kind === "transfer" ? "From account" : "Account"}</div>
          <select style={fieldStyle("account")} value={fields.accountId ?? ""} onChange={(e) => change({ accountId: e.target.value || null }, true)}>
            <option value="">Choose…</option>
            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {kind === "transfer" ? (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>To account</div>
            <select style={fieldStyle("to_account")} value={fields.toAccountId ?? ""} onChange={(e) => change({ toAccountId: e.target.value || null }, true)}>
              <option value="">Choose…</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        ) : (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Category</div>
            <select style={fieldStyle("category")} value={fields.categoryId ?? ""} onChange={(e) => change({ categoryId: e.target.value || null }, true)}>
              <option value="">Choose…</option>
              {categoryPickerItems(categories, kind).map((c) => (
                <option key={c.id} value={c.id}>{c.depth === 1 ? "   " : ""}{c.emoji} {c.label}</option>
              ))}
            </select>
          </label>
        )}
        <label style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Note</div>
          <input style={input} value={fields.note ?? ""} onChange={(e) => change({ note: e.target.value || null })} onBlur={() => void save(fields)} />
        </label>
      </div>

      {(draft.problems.length > 0 || draft.fields.hints.length > 0) && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {draft.problems.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: t.negative }}>
              <Icon name="alertCircle" size={14} color={t.negative} />
              Needs attention: {PROBLEM_TEXT[p] ?? p}
            </div>
          ))}
          {draft.fields.hints.map((h) => (
            <div key={h} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: t.dim }}>
              <Icon name="info" size={14} color={t.dim} />
              Check: {HINT_TEXT[h] ?? h}
            </div>
          ))}
        </div>
      )}

      {draft.problems.length === 0 && draft.fields.amountCents != null && (
        <div style={{ marginTop: 10, fontSize: 12, color: t.faint }}>
          Will add {kind === "transfer" ? "a transfer of" : kind === "income" ? "income of" : "an expense of"} {fmtMoney(draft.fields.amountCents)}.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean. If `tsc` reports a `Record<ScreenId, …>` somewhere that now lacks a `drafts` key, add the key there.

- [ ] **Step 3: Verify**

The screen needs an AI configuration to be usable, and the Settings card arrives in Task 12. Typecheck here (Step 2), commit (Step 4), and do the visual check at the end of Task 12 Step 3, which exercises Drafts and Settings together.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Drafts.tsx
git commit -m "feat(import): Drafts screen with upload, paste, review and confirm"
```

---

### Task 12: Settings → AI import

**Files:**
- Modify: `src/screens/Settings.tsx`

- [ ] **Step 1: Add the card**

In `Settings.tsx`, add `AiSettings` to a new type import: `import type { AiSettings } from "../types";`.

Add a component above `export function Settings` (it uses the file's existing `SettingRow`, `Card`, `SectionTitle`, `Btn`, `inputStyle`, `useTheme`, `useToast`, `client`):

```tsx
const AI_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: "Google AI Studio (Gemini)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
];

function AiImportCard() {
  const t = useTheme();
  const { notify } = useToast();
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const input = inputStyle(t);

  useEffect(() => {
    client.getAiSettings().then((s) => {
      setSaved(s);
      setBaseUrl(s.baseUrl);
      setModel(s.model);
    }).catch(() => {});
  }, []);

  const message = (error: unknown, fallback: string) =>
    (error instanceof Error ? error.message : (error as { message?: string } | null)?.message) ?? fallback;

  const save = async (): Promise<boolean> => {
    try {
      const next = await client.setAiSettings({ baseUrl, model, apiKey: apiKey === "" ? null : apiKey });
      setSaved(next);
      setBaseUrl(next.baseUrl);
      setApiKey("");
      return true;
    } catch (error) {
      notify(message(error, "Could not save"), "error");
      return false;
    }
  };

  const saveAndTest = async () => {
    setBusy(true);
    try {
      if (!(await save())) return;
      await client.testAiConnection();
      notify("Connected. The AI answered.", "info");
    } catch (error) {
      notify(message(error, "Connection failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    try {
      setSaved(await client.setAiSettings({ baseUrl, model, apiKey: "" }));
      setApiKey("");
    } catch (error) {
      notify(message(error, "Could not clear the key"), "error");
    }
  };

  return (
    <Card>
      <SectionTitle sub="Used by Drafts to turn the text in a photo into transactions. Any OpenAI-compatible chat endpoint works.">
        AI import
      </SectionTitle>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {AI_PRESETS.map((p) => (
          <Btn key={p.label} variant="outline" size="sm" onClick={() => { setBaseUrl(p.baseUrl); setModel(p.model); }}>
            {p.label}
          </Btn>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Base URL</div>
          <input style={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Model</div>
          <input style={input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model name" />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>API key {saved?.hasKey ? "(saved)" : "(optional for local)"}</div>
          <input
            style={input}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={saved?.hasKey ? "Leave blank to keep the saved key" : "Paste a key"}
          />
        </label>
      </div>
      <div style={{ fontSize: 12, color: t.faint, marginTop: 10 }}>
        The key is stored unencrypted in Sens's local database and is never shown again. Anything you send to a cloud provider leaves this computer.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Btn disabled={busy} onClick={() => void saveAndTest()}>{busy ? "Testing…" : "Save & test"}</Btn>
        <Btn variant="outline" disabled={busy} onClick={() => void save().then((ok) => ok && notify("Saved.", "info"))}>Save</Btn>
        {saved?.hasKey && <Btn variant="danger" disabled={busy} onClick={() => void clearKey()}>Remove key</Btn>}
      </div>
    </Card>
  );
}
```

Render it in `Settings` between the Transactions card and the About card:

```tsx
      <AiImportCard />
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Verify in the browser (mock backend)**

Run `npm run dev` and open **Settings**. Click the **Ollama (local)** preset, then **Save & test**. Expect a toast "Connected. The AI answered." (the mock accepts any configured URL). Enter a key, save, reload the page state by navigating away and back: the label reads "API key (saved)" and the field is empty. Click **Remove key**: the label returns to "(optional for local)". Enter `ftp://x` as the base URL and Save: expect the toast "The base URL must start with http:// or https://".

Then check Drafts end to end: create two accounts, open **Drafts**, click **Choose photo** and pick any image. Expect a draft expense (RM 12.50, "Kopitiam Lim") and a draft transfer carrying the note "The AI was unsure about this one". Edit the amount and tab away. Confirm one: the sidebar badge drops from 2 to 1 and the transaction appears on Transactions. Press Cmd/Ctrl+V with an image on the clipboard and expect a new pair of drafts. Also check the narrow-window layout (the row grid should wrap) and light and dark themes.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Settings.tsx
git commit -m "feat(import): AI import settings card"
```

---

### Task 13: Docs, full verification, desktop smoke test

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `AGENTS.md`
- Modify: `docs/architecture/backend.md`, `docs/architecture/frontend.md`
- Modify: `docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md`

- [ ] **Step 1: Update docs**

- `CHANGELOG.md` under `[Unreleased]` → `### Added`: add an entry:
  `- **Drafts (photo import).** A new Drafts screen reads a receipt or bank screenshot with your computer's built-in text recognition, asks an AI model you configure (any OpenAI-compatible endpoint: Gemini, Ollama, OpenAI…) to find the transactions, and shows them for review. Edit anything, then confirm; nothing posts until you do. Only the recognised text, your account names and category names are sent to the AI. Set it up in Settings → AI import.`
  Remove the Documentation line that says "Specified photo transaction import…" only if you also list the plan; otherwise keep it and add `Planned photo transaction import (docs/superpowers/plans/2026-10-17-photo-transaction-import.md).`
- `ROADMAP.md`: tick `- [x] Import transactions from a photo …`, set its spec link, and refresh the **Last shipped / Next up** block only if a release is cut (otherwise leave it).
- `docs/architecture/backend.md`: document the new commands (`ocr_image` raw body, `extract_drafts`, draft CRUD, AI settings), the `import_drafts` table and migration 016, `AppError::Ai` codes, the `reqwest`/OS-OCR dependencies, the write-only `ai_api_key`, and the mock mirrors.
- `docs/architecture/frontend.md`: document the Drafts screen, sidebar badge, and Settings → AI import.
- `AGENTS.md`: in the test-locations line add `src-tauri/src/ai.rs`, `drafts.rs` and `ocr.rs` to the Rust test locations. Also add the Drafts screen and the write-only `ai_api_key` setting to the architecture notes if a hard rule changed (it did not, so no new rule is needed).
- Spec: in "Components → Rust", change the `service.rs` bullet to say draft logic lives in `drafts.rs`, and change the key-storage sentence to "stored in the settings table; write-only from the frontend".

- [ ] **Step 2: Run the full gate**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run build
npm test
cd src-tauri && cargo test --lib --locked && cargo build --locked
```
Expected: every command exits 0. `npm run gen:seed-catalog` is not needed (no seed changes); confirm with `git status` that `src/generated/seed-catalog.json` is unchanged.

- [ ] **Step 3: Desktop smoke test (real OCR, real LLM)**

Run `export PATH="$HOME/.cargo/bin:$PATH"; npm run tauri dev`.
1. Settings → AI import → pick **Google AI Studio (Gemini)**, paste a key, **Save & test**: expect "Connected".
2. Create two accounts and an expense category if the database has none.
3. Drafts → **Choose photo** with a real receipt photo: expect "Reading the text…", "Asking the AI…", then draft rows with the right merchant and total.
4. Copy a screenshot to the clipboard and press Cmd+V on the Drafts screen: expect new drafts.
5. Confirm one draft: the sidebar badge drops by 1 and the transaction shows on Transactions with the right account balance. Quit and reopen the app with drafts left over: they are still listed.
6. Turn the network off and import again: expect a toast "Could not reach the AI provider…" and the "Text read from the photo" card showing the OCR text.
7. Enter a wrong API key: expect "The AI provider rejected the API key."

If any step fails, fix it with a test that reproduces the failure first.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: photo import changelog, roadmap, architecture notes"
```

- [ ] **Step 5: Open the PR**

Use the `superpowers:finishing-a-development-branch` skill. The PR must list the unverified items: Windows OCR (Task 7 Step 6) and the Gemini/Ollama manual checks (Task 13 Step 3) if they were not run.
