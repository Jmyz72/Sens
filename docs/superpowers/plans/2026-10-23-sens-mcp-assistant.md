# MCP assistant ("AI CFO") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed an MCP server in the Sens desktop app so an agent on the user's tailnet can read and manage the whole ledger, reached through `tailscale serve`.

**Architecture:** A new `src-tauri/src/mcp/` module. A pure tool layer (`tools::call(conn, name, args) -> AppResult<Value>`) sits on `service.rs` and knows nothing about HTTP. A thin `rmcp` Streamable HTTP server behind a bearer-token middleware exposes it on `127.0.0.1`. Audit rows and a rate limiter wrap write tools. The server shares the app's DB connection and emits a `data-changed` event after writes.

**Tech Stack:** Rust (rusqlite, rmcp 3.7, axum 0.8, tokio, sha2, schemars, Tauri v2), React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-sens-mcp-assistant-design.md`

## Global Constraints

- Money is integer MYR cents in and out; read results add a formatted `"RM 12.34"` string beside each cents field.
- Server binds `127.0.0.1` only; off by default; port setting default `8765`.
- Auth: `Authorization: Bearer <token>`, SHA-256 hash stored, constant-time compare, loopback peer required, else `401`.
- Never exposed: `reset_app`, `get_setting`/`set_setting`, AI-provider commands, photo import (`ocr_image`, `extract_drafts`, draft commands).
- Audit: migration **018**, table `mcp_audit_log(id, at, tailscale_user, tool, args_json, ok, error_code)`, one row per write tool call, none for reads. Rate limit 60 write calls per minute, error code `rate_limited`.
- Errors are `AppError {code, message}`; the token and request headers never appear in logs or errors.
- The backend generates UUIDs and timestamps; tools never accept them for creation.
- New Tauri commands (`get_mcp_status`, `set_mcp_enabled`, `rotate_mcp_token`, `list_mcp_audit`) are mirrored as stubs in `src/client/mock.ts`.
- Business rules stay in `service.rs`; SQL stays in `repo.rs`. The `mcp/` module contains neither.
- Rust is not on PATH: prefix cargo with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Update `CHANGELOG.md` `[Unreleased]` and `ROADMAP.md` in the same change.

## Review Focus

1. Two accounts or categories share a name (or differ only by case): the tool errors `ValidationError` naming both, and never picks one. A name matching only an archived row errors `Conflict`.
2. An amount that is a float, zero, negative or a string (the agent passes `12.5` meaning RM 12.50): rejected with a message that says amounts are integer cents. Nothing is written.
3. A malformed date (`"23/10/2026"`, `"2026-13-40"`): `ValidationError`, nothing written.
4. Bearer header oddities: missing, wrong scheme, wrong case in `bearer`, trailing space, empty token, and **no token configured yet**. All return `401`; an unset token never means open.
5. The app's DB lock is poisoned or the port is already in use: a tool call returns a `DatabaseError`, and enabling reports the bind failure in status. Neither panics the app.

---

## File Structure

- `src-tauri/src/mcp/mod.rs`: module wiring, `McpHandle` (start/stop), settings keys.
- `src-tauri/src/mcp/resolve.rs`: name-or-UUID resolution, `fmt_myr`, date/amount arg validation.
- `src-tauri/src/mcp/audit.rs`: audit write/list, rate limiter.
- `src-tauri/src/mcp/tools.rs`: tool registry, arg structs, `call`.
- `src-tauri/src/mcp/auth.rs`: token hash/generate/verify, axum middleware.
- `src-tauri/src/mcp/server.rs`: rmcp handler + axum router + serve loop.
- Modify: `db/migrations.rs`, `repo.rs` (audit SQL), `service.rs` (audit service fns), `commands.rs`, `lib.rs`, `Cargo.toml`.
- Frontend: `src/types.ts`, `src/client/index.ts`, `src/client/mock.ts`, `src/screens/Settings.tsx`, `src/components/Sidebar.tsx` (agent dot), `src/lib/dataChanged.ts` (new).

---

### Task 1: Audit table, audit service, rate limiter

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append `(18, MIGRATION_018)`), `src-tauri/src/repo.rs`, `src-tauri/src/models.rs`, `src-tauri/Cargo.toml`
- Create: `src-tauri/src/mcp/mod.rs`, `src-tauri/src/mcp/audit.rs`
- Test: `#[cfg(test)]` module in `audit.rs`

**Interfaces:**
- Produces: `models::McpAuditEntry { id: String, at: String, tailscale_user: Option<String>, tool: String, args_json: String, ok: bool, error_code: Option<String> }` (Serialize, camelCase)
- Produces: `audit::record(conn: &Connection, user: Option<&str>, tool: &str, args: &serde_json::Value, outcome: &AppResult<()>) -> AppResult<()>`
- Produces: `audit::list(conn: &Connection, limit: i64) -> AppResult<Vec<McpAuditEntry>>` (newest first)
- Produces: `audit::RateLimiter::new(max: usize, window: std::time::Duration)` with `fn check(&self, now: std::time::Instant) -> bool` (true = allowed; thread-safe via internal `Mutex`)

- [ ] **Step 1: Write failing tests** in `audit.rs`: `record_then_list_newest_first` (two records, list returns the later first, `ok`/`error_code` set from an `Err(AppError::Validation(..))` as `"ValidationError"`); `list_respects_limit`; `rate_limiter_allows_60_then_blocks_61st`; `rate_limiter_window_resets` (61st allowed once `now` is past the window).
- [ ] **Step 2:** Run `cd src-tauri && cargo test --lib mcp::audit` and expect a compile failure.
- [ ] **Step 3:** Add deps `sha2`, `rand`, `schemars`, `tokio` (features `net`, `rt`, `sync`, `macros`), `axum = "0.8"`, `rmcp = { version = "3.7", features = ["server", "transport-streamable-http-server"] }`. Check `cargo info rmcp` for the exact feature names and fix them to match. Add `MIGRATION_018` creating `mcp_audit_log` with an index on `at`. SQL goes in `repo.rs` (`insert_mcp_audit`, `list_mcp_audit`); `audit.rs` calls those. `mod.rs` just declares `pub mod audit;` for now and `lib.rs` declares `mod mcp;`.
- [ ] **Step 4:** Run `cargo test --lib mcp::audit`; expect PASS. Run `cargo test --lib` to confirm the migration runner test still passes.
- [ ] **Step 5: Commit** `feat(mcp): audit log table and rate limiter`

### Task 2: Argument resolution and money formatting

**Files:**
- Create: `src-tauri/src/mcp/resolve.rs`; add `pub mod resolve;` to `mod.rs`
- Test: module tests in `resolve.rs`

**Interfaces:**
- Produces: `resolve_account(conn: &Connection, key: &str) -> AppResult<String>` (returns the account id; UUID match first, then case-insensitive trimmed name among active accounts)
- Produces: `resolve_category(conn: &Connection, key: &str, kind: Option<&str>) -> AppResult<String>` (same rules; `kind` narrows by income/expense)
- Produces: `fmt_myr(cents: i64) -> String` (`"RM 12.34"`, negative `"-RM 12.34"`, thousands separators `"RM 1,234.50"`)
- Produces: `parse_date(s: &str) -> AppResult<String>` (strict `YYYY-MM-DD`, returns it unchanged)
- Produces: `cents_arg(v: &serde_json::Value, field: &str) -> AppResult<i64>` (JSON integer only, > 0; the error message contains "integer cents")

- [ ] **Step 1: Write failing tests**, one per Review Focus 1–3 case: `ambiguous_account_name_errors_listing_both`, `case_insensitive_name_resolves`, `archived_only_name_is_conflict`, `unknown_name_is_not_found`, `uuid_passthrough`, `float_amount_rejected_mentions_cents` (`12.5`), `zero_negative_and_string_amount_rejected`, `bad_date_rejected` (`"23/10/2026"`, `"2026-13-40"`), `fmt_myr_cases` (0, 5, 1234, 123450, -250).
- [ ] **Step 2:** Run `cargo test --lib mcp::resolve`; expect FAIL (undefined).
- [ ] **Step 3:** Implement the five functions. Reuse `service::list_accounts(conn, true)` / `service::list_categories` for lookups instead of new SQL. Ambiguity counts only active rows. Errors: `Validation` for ambiguity, `NotFound` for none, `Conflict` when only archived rows match.
- [ ] **Step 4:** Run `cargo test --lib mcp::resolve`; expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): name resolution and arg validation`

### Task 3: Tool registry and read tools

**Files:**
- Create: `src-tauri/src/mcp/tools.rs`; add `pub mod tools;`
- Test: module tests in `tools.rs` using `crate::db::open_in_memory()`

**Interfaces:**
- Consumes: `resolve::*`, `audit::*` (Tasks 1–2)
- Produces: `tools::ToolDef { name: &'static str, description: &'static str, writes: bool, schema: fn() -> serde_json::Value }`
- Produces: `tools::definitions() -> Vec<ToolDef>`
- Produces: `tools::call(conn: &Connection, name: &str, args: serde_json::Value) -> AppResult<serde_json::Value>`; unknown name is `NotFound`. It does no auditing; the server layer (Task 5) wraps writes.
- Read tools by exact name: `get_financial_overview {month?}`, `list_accounts {includeArchived?}`, `get_account_balances`, `list_categories {kind?, includeArchived?}`, `list_transactions {accountId?, categoryId?, kind?, fromDate?, toDate?, limit?, offset?}` (account and category args accept names), `get_dashboard_summary {month}`, `get_plan {month}`, `list_schedules`, `list_upcoming`, `get_awaiting_reimbursement`.

- [ ] **Step 1: Write failing tests**: `definitions_have_unique_names_and_object_schemas`; `definitions_exclude_forbidden_tools` (none of `reset_app`, `set_setting`, `get_setting`, any name containing `ai_provider`, `ocr`, `draft`); `overview_contains_net_worth_month_upcoming_and_plan` (seed two accounts and a transaction, assert keys and a `"RM "` string beside each cents field); `list_transactions_resolves_account_by_name`; `unknown_tool_is_not_found`.
- [ ] **Step 2:** Run `cargo test --lib mcp::tools`; expect FAIL.
- [ ] **Step 3:** Implement the registry as a static table of `ToolDef` plus a `match name` in `call`. Arg structs derive `Deserialize` + `schemars::JsonSchema` with `#[serde(rename_all = "camelCase", deny_unknown_fields)]`; each `schema` fn is `schemars::schema_for!(Args)` converted to a `Value`. `get_financial_overview` reuses `service::get_dashboard_summary` (it already carries `netWorthCents` and `accountBalances`), `schedules::list_upcoming`, `service::get_plan`, `service::get_awaiting_reimbursement`; `month` defaults to `crate::today()[..7]`. Add the `"RM"` strings with a small `with_formatted(value)` helper that walks the result and, for every key ending in `Cents`, inserts a sibling key (`xxxCents` → `xxxFormatted`).
- [ ] **Step 4:** Run `cargo test --lib mcp::tools`; expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): tool registry and read tools`

### Task 4: Write tools: transactions

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`
- Test: module tests in `tools.rs`

**Interfaces:**
- Consumes: `service::create_income`, `create_expense`, `create_transfer`, `create_payment`, `create_reimbursement`, `update_transaction`, `delete_transaction`, `set_expected_reimbursement`
- Produces (all `writes: true`): `create_income`, `create_expense {accountId, categoryId?, amountCents, description?, date, time?, excludedFromReporting?, splits?}`; `create_transfer {fromAccountId, toAccountId, amountCents, description?, date, time?}`; `create_payment` (same shape as transfer); `create_reimbursement {accountId, amountCents, description?, date, time?, allocations}`; `update_transaction` (fields of `UpdateTransactionInput`); `delete_transaction {id}`; `set_expected_reimbursement {expenseId, expectedCents?}`. Every account and category arg accepts a UUID or a name.

- [ ] **Step 1: Write failing tests**: `create_expense_by_names_posts_and_changes_balance`; `float_amount_writes_nothing` (Review Focus 2: balance and transaction count unchanged); `bad_date_writes_nothing` (Review Focus 3); `delete_transaction_removes_it`; `create_transfer_same_account_is_validation_error`; `definitions_mark_all_create_update_delete_tools_as_writes`.
- [ ] **Step 2:** Run `cargo test --lib mcp::tools`; expect the new tests to FAIL.
- [ ] **Step 3:** Add the arms and arg structs. Validate with `cents_arg` and `parse_date` *before* calling the service. Pass `excluded_from_reporting` as `false` when absent, matching `commands.rs`.
- [ ] **Step 4:** Run `cargo test --lib mcp::tools`; expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): transaction write tools`

### Task 5: Write tools: budgets, goals, schedules, accounts, categories

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`
- Test: module tests in `tools.rs`

**Interfaces:**
- Consumes: `service::set_budgets`, `create_goal`, `update_goal`, `delete_goal`, `create_account`, `update_account`, `archive_account`, `restore_account`, `set_account_balance`, `update_net_worth`, `create_category`, `update_category`, `archive_category`, `restore_category`; `schedules::create_schedule`, `update_schedule`, `delete_schedule`, `post_occurrence`, `skip_occurrence` (these take `now: NaiveDateTime`; use `chrono::Local::now().naive_local()` as `commands.rs` does)
- Produces (all `writes: true`): `set_budgets {items}`, `create_goal`, `update_goal`, `delete_goal {id}`, `create_schedule`, `update_schedule {id, ...}`, `delete_schedule {id}`, `post_occurrence {scheduleId, date, amountCents}`, `skip_occurrence {scheduleId, date}`, `create_account`, `update_account`, `archive_account {id}`, `restore_account {id}`, `set_account_balance {accountId, realBalanceCents, recordAsIncomeExpense}`, `update_net_worth {accountId, balanceCents, categoryId?, time?}`, `create_category`, `update_category`, `archive_category {id}`, `restore_category {id}`. Input bodies reuse `BudgetWrite`, `GoalWrite`, `ScheduleWrite` shapes.

- [ ] **Step 1: Write failing tests**: `set_budgets_then_get_plan_shows_them`; `goal_create_update_delete_roundtrip`; `schedule_create_then_list_upcoming`; `skip_occurrence_removes_it_from_upcoming`; `archive_account_by_name`; `create_category_under_parent_by_name`; `total_tool_count_is_between_28_and_34` (guards the spec's "about 30").
- [ ] **Step 2:** Run `cargo test --lib mcp::tools`; expect new tests FAIL.
- [ ] **Step 3:** Add arms. Amounts in `BudgetWrite`, `GoalWrite` and `ScheduleWrite` are already cents; reject non-integers via serde (`deny_unknown_fields` + integer types) and translate the serde message into one mentioning "integer cents".
- [ ] **Step 4:** Run `cargo test --lib mcp::tools`; expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): budget, goal, schedule, account and category write tools`

### Task 6: Token auth and middleware

**Files:**
- Create: `src-tauri/src/mcp/auth.rs`; add `pub mod auth;`
- Test: module tests in `auth.rs` (axum `tower::ServiceExt::oneshot`)

**Interfaces:**
- Produces: `auth::generate_token() -> String` (32 random bytes, hex), `auth::hash_token(t: &str) -> String` (hex SHA-256), `auth::verify(token: &str, stored_hash: &str) -> bool` (constant-time; empty `stored_hash` is always false)
- Produces: `auth::require_token(State<AuthState>, ConnectInfo<SocketAddr>, Request, Next) -> Response`, where `AuthState { token_hash: Arc<RwLock<String>> }`. On success it inserts `CallerIdentity(Option<String>)` (from `Tailscale-User-Login`) into request extensions.

- [ ] **Step 1: Write failing tests**: one test per Review Focus 4 case (`missing_header`, `wrong_scheme`, `lowercase_bearer_is_accepted_but_wrong_token_is_not`, `trailing_space_token_rejected`, `empty_token`, `no_token_configured_rejects_everything`); `valid_token_passes_and_exposes_identity`; `non_loopback_peer_rejected`; `rotated_old_token_rejected` (swap the hash in `AuthState`, old token now 401).
- [ ] **Step 2:** Run `cargo test --lib mcp::auth`; expect FAIL.
- [ ] **Step 3:** Implement. The scheme match is case-insensitive per RFC 7235; the token compare is exact. Responses carry no body detail beyond `401`.
- [ ] **Step 4:** Run `cargo test --lib mcp::auth`; expect PASS.
- [ ] **Step 5: Commit** `feat(mcp): bearer token auth middleware`

### Task 7: rmcp server, audit wrapper, end-to-end test

**Files:**
- Create: `src-tauri/src/mcp/server.rs`; add `pub mod server;`
- Modify: `src-tauri/src/lib.rs` (`DbState` becomes `pub struct DbState(pub Arc<Mutex<rusqlite::Connection>>)`; `with_conn!` keeps working through deref; update the one constructor in `setup` and any test that builds one)
- Test: `#[cfg(test)]` in `server.rs`; one end-to-end test using an rmcp client over Streamable HTTP

**Interfaces:**
- Consumes: `tools::{definitions, call}`, `audit::{record, RateLimiter}`, `auth::{AuthState, require_token, CallerIdentity}`
- Produces: `server::ServerConfig { port: u16, db: Arc<Mutex<Connection>>, token_hash: Arc<RwLock<String>>, on_write: Arc<dyn Fn() + Send + Sync> }`
- Produces: `server::start(cfg: ServerConfig) -> AppResult<RunningServer>` where `RunningServer { pub port: u16, shutdown: tokio::sync::oneshot::Sender<()> }` with `fn stop(self)`. `port: 0` binds an ephemeral port and reports the real one. A bind failure is `AppError::Conflict("Port N is in use")`.
- Behavior: the MCP handler lists `tools::definitions()`. For a `writes` tool it checks the rate limiter, runs `tools::call`, writes an audit row with the caller identity, and on success calls `on_write`. A rate-limited call returns an MCP tool error with code `rate_limited`, and is audited. Tool errors become MCP tool results with `isError: true` and the `AppError {code, message}` JSON as text. A poisoned DB lock yields `DatabaseError` (Review Focus 5).

- [ ] **Step 1: Write failing tests**: `e2e_list_tools_and_create_expense` (start on port 0 with an in-memory DB and a known token; an rmcp client sends the bearer token, calls `tools/list` and asserts at least 28 tools, calls `create_expense`, and asserts the balance via `get_account_balances`, one audit row, and `on_write` called once); `e2e_no_token_is_401`; `e2e_61st_write_in_a_minute_is_rate_limited_and_audited`; `port_in_use_returns_conflict` (bind the same port twice); `poisoned_lock_returns_database_error_not_panic`.
- [ ] **Step 2:** Run `cargo test --lib mcp::server`; expect FAIL.
- [ ] **Step 3:** Implement with `rmcp`'s streamable-HTTP service mounted at `/mcp` on an axum router layered with `require_token`, served with `into_make_service_with_connect_info::<SocketAddr>()`. Run blocking DB work on the lock inside `tokio::task::spawn_blocking`. Consult the pinned rmcp version's docs for the handler trait; keep all rmcp types inside this file.
- [ ] **Step 4:** Run `cargo test --lib`; expect PASS across the whole crate.
- [ ] **Step 5: Commit** `feat(mcp): streamable HTTP server with audit and rate limit`

### Task 8: Lifecycle, settings commands, Tauri wiring

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/models.rs`
- Test: module tests in `mod.rs`

**Interfaces:**
- Consumes: `server::{start, ServerConfig, RunningServer}`, `auth::{generate_token, hash_token}`
- Produces: settings keys `mcp_enabled` (`"0"`/`"1"`, default off), `mcp_port` (default `"8765"`), `mcp_token_hash`
- Produces: `models::McpStatus { enabled: bool, port: u16, running: bool, has_token: bool, error: Option<String> }` (camelCase)
- Produces: `McpHandle` (Tauri managed state; `Mutex<Option<RunningServer>>` plus the shared `token_hash` and last error) with `fn apply(&self, app: &tauri::AppHandle) -> McpStatus` that starts or stops the server to match the settings
- Produces: Tauri commands `get_mcp_status() -> McpStatus`, `set_mcp_enabled(enabled: bool, port: Option<u16>) -> McpStatus`, `rotate_mcp_token() -> String` (the plaintext token, once; also swaps the live hash), `list_mcp_audit(limit: Option<i64>) -> Vec<McpAuditEntry>` (default 50)
- `on_write` emits the Tauri event `data-changed` via `app.emit`.

- [ ] **Step 1: Write failing tests**: `rotate_token_stores_hash_not_plaintext`; `enable_without_token_is_validation_error` ("generate a token first"); `status_reports_bind_failure_in_error_and_running_false`; `enable_then_disable_stops_server`; `invalid_port_rejected` (0 and above 65535 rejected for the setting).
- [ ] **Step 2:** Run `cargo test --lib mcp::`; expect FAIL.
- [ ] **Step 3:** Implement. In `setup`, after `app.manage(DbState(..))`, manage an `McpHandle` and call `apply` once so an enabled setting survives restarts. Register the four commands in `generate_handler!`. `hash_token` output is the only thing written to settings.
- [ ] **Step 4:** Run `cargo test --lib` and `cd src-tauri && cargo build`; expect both clean.
- [ ] **Step 5: Commit** `feat(mcp): settings commands and app lifecycle`

### Task 9: Frontend client, mock stubs, Settings card, live refresh

**Files:**
- Modify: `src/types.ts`, `src/client/index.ts`, `src/client/mock.ts`, `src/screens/Settings.tsx`, `src/components/Sidebar.tsx`
- Create: `src/lib/dataChanged.ts`
- Test: `src/__tests__/mock-mcp.test.ts`

**Interfaces:**
- Produces TS types `McpStatus`, `McpAuditEntry` matching Task 8/1 (camelCase)
- Produces client fns `getMcpStatus()`, `setMcpEnabled(enabled: boolean, port?: number)`, `rotateMcpToken(): Promise<string>`, `listMcpAudit(limit?: number)`
- Produces `onDataChanged(cb: () => void): () => void` in `dataChanged.ts` (returns an unsubscribe; a no-op in the browser mock, which never emits)

- [ ] **Step 1: Write failing tests** in `mock-mcp.test.ts`: `status_defaults_off_without_token`; `rotate_returns_token_and_sets_hasToken`; `enable_without_token_throws_ValidationError`; `list_audit_is_empty_array`; `resetApp_clears_mcp_state`.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/mock-mcp.test.ts`; expect FAIL.
- [ ] **Step 3:** Add the mock cases (in-memory state, random token, no server) and the client wrappers. In `Settings.tsx` add an `AssistantCard` after `AiImportCard`: the on/off `Toggle`, a port field, "Generate / rotate token" (token shown once in a copyable box with a warning), the copyable `tailscale serve --bg --https=443 http://127.0.0.1:<port>` command, the status line including `error`, and the last 50 audit rows. Colors come from `useTheme()` tokens, never hardcoded. `Sidebar.tsx` shows an "Agent active" dot with a text label when `running` (not color alone). Screens that load data subscribe via `onDataChanged` and refetch; start with Transactions, Dashboard, Accounts, Plan.
- [ ] **Step 4:** Run `npm run build` and `npm test`; expect clean and PASS.
- [ ] **Step 5: Commit** `feat(mcp): settings card, mock stubs and live refresh`

### Task 10: Docs and manual verification

**Files:**
- Create: `docs/architecture/mcp.md`
- Modify: `docs/architecture/backend.md`, `AGENTS.md` (add a row to "Before you change X" and a hard rule: MCP tools call `service.rs` and never expose `reset_app`/settings/AI providers), `CHANGELOG.md`, `ROADMAP.md`, the spec's status line (`Implemented (unreleased)`)

- [ ] **Step 1:** Write `mcp.md` (architecture, tool list, auth, audit, Tailscale setup, the manual-test recipe) and add the 018 and command rows to `backend.md`.
- [ ] **Step 2:** Add a `[Unreleased]` → Added entry to `CHANGELOG.md` and a ROADMAP item (shipped checklist plus refreshed "Last shipped / Next up" block).
- [ ] **Step 3:** Run the full gate: `npm run build`, `npm test`, `cd src-tauri && cargo test --lib --locked`, `cargo build --locked`. All must be clean.
- [ ] **Step 4:** Manual check: run `npm run tauri dev`, enable in Settings, rotate the token, run the shown `tailscale serve` command, then from the cloud machine run `claude mcp add --transport http sens https://<machine>.<tailnet>.ts.net/mcp --header "Authorization: Bearer <token>"`. Ask for the overview, log one expense, and confirm the row appears live in the UI and in the audit list. Report anything that could not be verified.
- [ ] **Step 5: Commit** `docs(mcp): architecture notes, changelog and roadmap`
