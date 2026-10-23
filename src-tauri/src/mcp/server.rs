//! Embedded MCP server: rmcp Streamable HTTP at `/mcp` behind bearer auth.
//!
//! All rmcp types stay inside this file. Tools come dynamically from
//! `tools::definitions()`; write tools are rate limited and audited here.
//! The token and request headers are never logged.
use std::collections::HashSet;
use std::net::SocketAddr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use rusqlite::Connection;
use serde_json::{Map, Value};

use super::audit::{self, RateLimiter};
use super::auth::{require_token, AuthState, CallerIdentity};
use super::tools;
use crate::error::{AppError, AppResult};

/// Write calls allowed per window, shared by every session of one server.
const WRITE_LIMIT: usize = 60;
const WRITE_WINDOW: Duration = Duration::from_secs(60);
/// Longest caller identity stored in the audit log.
const MAX_IDENTITY_CHARS: usize = 256;
/// Audit identity for callers without a `Tailscale-User-Login` header.
const TAGGED_DEVICE: &str = "tagged device";

/// What the server needs from the app.
pub struct ServerConfig {
    pub port: u16,
    pub db: Arc<Mutex<Connection>>,
    pub token_hash: Arc<RwLock<String>>,
    pub on_write: Arc<dyn Fn() + Send + Sync>,
}

/// A started server. `stop` (or dropping it) shuts it down.
pub struct RunningServer {
    #[allow(dead_code)] // read by the app lifecycle in Task 8
    pub port: u16,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

// Narrow allow: the app lifecycle (Task 8) calls `start`/`stop`; until then
// only tests do, and the non-test build would flag the whole MCP chain.
#[allow(dead_code)]
impl RunningServer {
    pub fn stop(self) {
        let _ = self.shutdown.send(());
    }
}

fn start_failed(e: std::io::Error) -> AppError {
    AppError::Database(format!("Could not start the MCP server: {e}"))
}

/// Binds `127.0.0.1:port` (0 = ephemeral) synchronously, then serves on the
/// current tokio runtime if there is one, otherwise on Tauri's runtime.
#[allow(dead_code)] // called by the app lifecycle in Task 8 (see RunningServer)
pub fn start(cfg: ServerConfig) -> AppResult<RunningServer> {
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", cfg.port)).map_err(|e| bind_error(cfg.port, e))?;
    std_listener.set_nonblocking(true).map_err(start_failed)?;
    let port = std_listener.local_addr().map_err(start_failed)?.port();

    let defs = tools::definitions();
    let shared = Arc::new(Shared {
        db: cfg.db,
        on_write: cfg.on_write,
        limiter: RateLimiter::new(WRITE_LIMIT, WRITE_WINDOW),
        write_tools: defs
            .iter()
            .filter(|d| d.writes)
            .map(|d| d.name)
            .chain(test_write_tools())
            .collect(),
        tools: defs
            .iter()
            .map(|d| {
                let schema = match (d.schema)() {
                    Value::Object(m) => m,
                    _ => Map::new(),
                };
                Tool::new(d.name, d.description, schema)
            })
            .collect(),
    });

    // rmcp's own Host allow-list is off because it only knows loopback names,
    // and Tailscale Serve forwards the tailnet hostname as `Host`.
    // `require_allowed_host` replaces it. The loopback-peer check in
    // `require_token` is NOT a DNS-rebinding defense: rebinding requests and
    // all Tailscale Serve traffic arrive from loopback. The bearer token is the
    // real control; the Host layer is defense in depth.
    let http_config = StreamableHttpServerConfig::default().disable_allowed_hosts();
    let sessions_ct = http_config.cancellation_token.clone();
    let factory_shared = shared.clone();
    let mcp = StreamableHttpService::new(
        move || Ok(SensHandler { shared: factory_shared.clone() }),
        Arc::new(LocalSessionManager::default()),
        http_config,
    );
    // The last layer added runs first: auth, then Host, then rmcp. So an
    // unauthenticated caller only ever sees 401.
    let app = Router::new()
        .nest_service("/mcp", mcp)
        .layer(from_fn(require_allowed_host))
        .layer(from_fn_with_state(AuthState { token_hash: cfg.token_hash }, require_token));

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let serve = async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("mcp server: listener setup failed: {e}");
                return;
            }
        };
        let shutdown = async move {
            let _ = rx.await;
            // End open sessions (SSE streams) so graceful shutdown can finish.
            sessions_ct.cancel();
        };
        let result = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(shutdown)
            .await;
        if let Err(e) = result {
            eprintln!("mcp server stopped with an error: {e}");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(serve);
        }
        Err(_) => {
            tauri::async_runtime::spawn(serve);
        }
    }
    Ok(RunningServer { port, shutdown: tx })
}

/// State shared by every MCP session of one running server.
struct Shared {
    db: Arc<Mutex<Connection>>,
    on_write: Arc<dyn Fn() + Send + Sync>,
    limiter: RateLimiter,
    tools: Vec<Tool>,
    write_tools: HashSet<&'static str>,
}

impl Shared {
    /// Runs one tool call (blocking). Writes are rate limited and audited.
    fn run(&self, name: &str, args: Value, user: &str) -> AppResult<Value> {
        let writes = self.write_tools.contains(name);
        if writes && !self.limiter.check(Instant::now()) {
            let message =
                format!("Too many write calls: at most {WRITE_LIMIT} per minute. Try again shortly.");
            if let Ok(conn) = self.db.lock() {
                audit_call(&conn, user, name, &args, &Err(AppError::RateLimited(message.clone())));
            }
            return Err(AppError::RateLimited(message));
        }
        let conn = self
            .db
            .lock()
            .map_err(|_| AppError::Database("Database lock poisoned".into()))?;
        let audit_args = writes.then(|| args.clone());
        let (result, panicked) = match catch_unwind(AssertUnwindSafe(|| dispatch(&conn, name, args))) {
            Ok(r) => (r, false),
            Err(_) => (Err(AppError::Database("Internal error while running the tool".into())), true),
        };
        if let Some(args) = audit_args {
            let outcome = match &result {
                Ok(_) => Ok(()),
                Err(e) => Err(copy_error(e)),
            };
            audit_call(&conn, user, name, &args, &outcome);
        }
        // Dropping the guard rolls back any transaction the tool left open.
        drop(conn);
        if panicked {
            // Never leave the desktop UI's shared connection poisoned.
            self.db.clear_poison();
        }
        if writes && result.is_ok() {
            (self.on_write)();
        }
        result
    }
}

/// Runs one tool. Tests add a tool that panics, to exercise panic safety.
fn dispatch(conn: &Connection, name: &str, args: Value) -> AppResult<Value> {
    #[cfg(test)]
    if name == TEST_PANIC_TOOL {
        panic!("test tool panicked");
    }
    tools::call(conn, name, args)
}

/// Test-only tool that panics; registered as a write so its audit path is covered.
#[cfg(test)]
const TEST_PANIC_TOOL: &str = "__test_panic";

fn test_write_tools() -> impl Iterator<Item = &'static str> {
    #[cfg(test)]
    return std::iter::once(TEST_PANIC_TOOL);
    #[cfg(not(test))]
    std::iter::empty()
}

/// `AddrInUse` is the user-fixable conflict; anything else is reported as-is.
fn bind_error(port: u16, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        AppError::Conflict(format!("Port {port} is in use"))
    } else {
        AppError::Database(format!("Could not listen on 127.0.0.1:{port}: {e}"))
    }
}

/// True for `localhost`, `127.0.0.1`, `[::1]` or a `*.ts.net` name, each with
/// an optional numeric `:port`, case-insensitive.
fn host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let host = host.to_ascii_lowercase();
    if let Some(rest) = host.strip_prefix('[') {
        // Bracketed IPv6: only [::1], then nothing or `:port`.
        let Some((inner, after)) = rest.split_once(']') else { return false };
        return inner == "::1"
            && (after.is_empty() || after.strip_prefix(':').is_some_and(valid_port));
    }
    let (name, port) = match host.split_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host.as_str(), None),
    };
    if !port.is_none_or(valid_port) {
        return false;
    }
    match name {
        "localhost" | "127.0.0.1" => true,
        n => n
            .strip_suffix(".ts.net")
            .is_some_and(|label| !label.is_empty() && !label.starts_with('.') && !label.ends_with('.')),
    }
}

fn valid_port(p: &str) -> bool {
    !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit())
}

/// Empty-body 403 unless the `Host` header passes `host_allowed`.
async fn require_allowed_host(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok());
    if !host_allowed(host) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

fn audit_call(conn: &Connection, user: &str, tool: &str, args: &Value, outcome: &AppResult<()>) {
    // The write already happened, so an audit failure must not turn it into an
    // error (the client would retry and duplicate it). Log the code only.
    if let Err(e) = audit::record(conn, Some(user), tool, args, outcome) {
        eprintln!("mcp audit write failed: {}", e.code());
    }
}

/// Same variant and message (`AppError` is not `Clone`).
fn copy_error(e: &AppError) -> AppError {
    match e {
        AppError::Validation(m) => AppError::Validation(m.clone()),
        AppError::NotFound(m) => AppError::NotFound(m.clone()),
        AppError::Conflict(m) => AppError::Conflict(m.clone()),
        AppError::Database(m) => AppError::Database(m.clone()),
        AppError::Ai(c, m) => AppError::Ai(c, m.clone()),
        AppError::RateLimited(m) => AppError::RateLimited(m.clone()),
    }
}

/// Caller identity forwarded by `require_token`, truncated; `None` is a tagged device.
fn caller(ctx: &RequestContext<RoleServer>) -> String {
    ctx.extensions
        .get::<axum::http::request::Parts>()
        .and_then(|p| p.extensions.get::<CallerIdentity>())
        .and_then(|c| c.0.as_deref())
        .map(|s| s.chars().take(MAX_IDENTITY_CHARS).collect())
        .unwrap_or_else(|| TAGGED_DEVICE.to_string())
}

fn to_result(result: AppResult<Value>) -> CallToolResult {
    match result {
        Ok(v) => CallToolResult::success(vec![ContentBlock::text(v.to_string())]),
        Err(e) => {
            let text = serde_json::to_string(&e)
                .unwrap_or_else(|_| r#"{"code":"DatabaseError","message":"Unknown error"}"#.into());
            CallToolResult::error(vec![ContentBlock::text(text)])
        }
    }
}

#[derive(Clone)]
struct SensHandler {
    shared: Arc<Shared>,
}

impl ServerHandler for SensHandler {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sens", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Sens personal finance (MYR). Amounts are integer cents; accounts and categories accept an id or exact name.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.shared.tools.clone()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.shared.tools.iter().find(|t| t.name == name).cloned()
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let user = caller(&context);
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        let shared = self.shared.clone();
        let result = tokio::task::spawn_blocking(move || shared.run(&name, args, &user))
            .await
            .unwrap_or_else(|_| Err(AppError::Database("Tool call failed unexpectedly".into())));
        Ok(to_result(result).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::mcp::{audit, auth};
    use crate::service;
    use rmcp::model::CallToolRequestParams;
    use rmcp::service::RunningService;
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
    use rmcp::transport::StreamableHttpClientTransport;
    use rmcp::{RoleClient, ServiceExt};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TOKEN: &str = "test-token-123";

    struct Harness {
        server: RunningServer,
        db: Arc<Mutex<Connection>>,
        writes: Arc<AtomicUsize>,
        account: String,
    }

    fn harness() -> Harness {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let conn = open_in_memory().unwrap();
        let account = service::create_account(&conn, "Maybank", "cash", 100_000, None, None, None, None).unwrap().id;
        service::create_category(&conn, "Lunch Runs", "expense", "x", None, None).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let writes = Arc::new(AtomicUsize::new(0));
        let w = writes.clone();
        let server = start(ServerConfig {
            port: 0,
            db: db.clone(),
            token_hash: Arc::new(RwLock::new(auth::hash_token(TOKEN))),
            on_write: Arc::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
        })
        .unwrap();
        assert_ne!(server.port, 0, "port 0 must report the real port");
        Harness { server, db, writes, account }
    }

    async fn client(port: u16) -> RunningService<RoleClient, ()> {
        let cfg = StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp"))
            .auth_header(TOKEN);
        ().serve(StreamableHttpClientTransport::from_config(cfg)).await.unwrap()
    }

    /// Calls a tool; returns (isError, parsed JSON text).
    async fn call(c: &RunningService<RoleClient, ()>, name: &str, args: Value) -> (bool, Value) {
        let Value::Object(obj) = args else { panic!("args must be an object") };
        let r = c
            .call_tool(CallToolRequestParams::new(name.to_string()).with_arguments(obj))
            .await
            .unwrap();
        let text = &r.content[0].as_text().expect("text content").text;
        (r.is_error.unwrap_or(false), serde_json::from_str(text).unwrap())
    }

    fn expense(amount: i64) -> Value {
        json!({"accountId": "Maybank", "categoryId": "lunch runs", "amountCents": amount,
               "date": "2026-10-23", "time": "12:00"})
    }

    fn balance(v: &Value, account: &str) -> i64 {
        v.as_array()
            .unwrap()
            .iter()
            .find(|b| b["accountId"] == account)
            .unwrap()["balanceCents"]
            .as_i64()
            .unwrap()
    }

    fn audit_rows(db: &Arc<Mutex<Connection>>) -> Vec<crate::models::McpAuditEntry> {
        audit::list(&db.lock().unwrap(), 1000).unwrap()
    }

    #[tokio::test]
    async fn e2e_list_tools_and_create_expense() {
        let h = harness();
        let c = client(h.server.port).await;

        let tools = c.list_all_tools().await.unwrap();
        assert!(tools.len() >= 28, "only {} tools", tools.len());
        assert!(tools.iter().any(|t| t.name == "create_expense"));
        let ce = tools.iter().find(|t| t.name == "create_expense").unwrap();
        assert_eq!(ce.input_schema.get("type"), Some(&json!("object")));

        // A read writes no audit row and does not fire on_write.
        let (err, before) = call(&c, "get_account_balances", json!({})).await;
        assert!(!err);
        assert_eq!(balance(&before, &h.account), 100_000);
        assert!(audit_rows(&h.db).is_empty());
        assert_eq!(h.writes.load(Ordering::SeqCst), 0);

        let (err, tx) = call(&c, "create_expense", expense(800)).await;
        assert!(!err, "{tx}");
        assert_eq!(tx["amountCents"], 800);

        let (_, after) = call(&c, "get_account_balances", json!({})).await;
        assert_eq!(balance(&after, &h.account), 100_000 - 800);

        let rows = audit_rows(&h.db);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tool, "create_expense");
        assert_eq!(rows[0].tailscale_user.as_deref(), Some("tagged device"));
        assert!(rows[0].ok);
        assert_eq!(h.writes.load(Ordering::SeqCst), 1);

        // A failing write is a tool error with the AppError JSON, audited, no on_write.
        let (err, e) = call(&c, "create_expense", expense(-5)).await;
        assert!(err);
        assert_eq!(e["code"], "ValidationError");
        assert!(e["message"].is_string());
        let rows = audit_rows(&h.db);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|r| !r.ok).count(), 1);
        assert_eq!(h.writes.load(Ordering::SeqCst), 1);

        c.cancel().await.unwrap();
        h.server.stop();
    }

    #[tokio::test]
    async fn e2e_user_header_identity_is_audited_and_truncated() {
        let h = harness();
        let long = format!("me@example.com{}", "x".repeat(400));
        let mut headers = std::collections::HashMap::new();
        headers.insert(
            axum::http::HeaderName::from_static("tailscale-user-login"),
            axum::http::HeaderValue::from_str(&long).unwrap(),
        );
        let cfg = StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{}/mcp", h.server.port))
            .auth_header(TOKEN)
            .custom_headers(headers);
        let c = ().serve(StreamableHttpClientTransport::from_config(cfg)).await.unwrap();
        let (err, _) = call(&c, "create_expense", expense(100)).await;
        assert!(!err);
        let rows = audit_rows(&h.db);
        assert_eq!(rows.len(), 1);
        let expected: String = long.chars().take(256).collect();
        assert_eq!(rows[0].tailscale_user.as_deref(), Some(expected.as_str()));
        c.cancel().await.unwrap();
        h.server.stop();
    }

    #[tokio::test]
    async fn e2e_no_token_is_401() {
        let h = harness();
        let url = format!("http://127.0.0.1:{}/mcp", h.server.port);
        let http = reqwest::Client::new();
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let r = http.post(&url).json(&body).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        let r = http.post(&url).bearer_auth("wrong").json(&body).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        h.server.stop();
    }

    #[tokio::test]
    async fn e2e_61st_write_in_a_minute_is_rate_limited_and_audited() {
        let h = harness();
        let c = client(h.server.port).await;
        for i in 0..60 {
            let (err, v) = call(&c, "create_expense", expense(100)).await;
            assert!(!err, "write {i}: {v}");
        }
        let (err, v) = call(&c, "create_expense", expense(100)).await;
        assert!(err);
        assert_eq!(v["code"], "rate_limited");
        assert!(v["message"].is_string());

        // Reads are not rate limited.
        let (err, bal) = call(&c, "get_account_balances", json!({})).await;
        assert!(!err);
        assert_eq!(balance(&bal, &h.account), 100_000 - 60 * 100);

        let rows = audit_rows(&h.db);
        assert_eq!(rows.len(), 61);
        assert_eq!(rows.iter().filter(|r| r.ok).count(), 60);
        let blocked: Vec<_> = rows.iter().filter(|r| !r.ok).collect();
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].error_code.as_deref(), Some("rate_limited"));
        assert_eq!(blocked[0].tool, "create_expense");
        assert_eq!(h.writes.load(Ordering::SeqCst), 60);

        c.cancel().await.unwrap();
        h.server.stop();
    }

    #[tokio::test]
    async fn port_in_use_returns_conflict() {
        let h = harness();
        let port = h.server.port;
        let err = start(ServerConfig {
            port,
            db: h.db.clone(),
            token_hash: Arc::new(RwLock::new(auth::hash_token(TOKEN))),
            on_write: Arc::new(|| {}),
        })
        .err()
        .expect("second bind must fail");
        assert!(matches!(&err, AppError::Conflict(m) if *m == format!("Port {port} is in use")), "{err:?}");
        h.server.stop();
    }

    #[test]
    fn host_allowed_cases() {
        for ok in [
            "localhost", "localhost:8123", "LOCALHOST", "127.0.0.1", "127.0.0.1:80", "[::1]",
            "[::1]:8123", "mac.tail1234.ts.net", "MAC.TAIL1234.TS.NET", "mac.tail1234.ts.net:443",
        ] {
            assert!(host_allowed(Some(ok)), "{ok}");
        }
        for bad in [
            "evil.example", "ts.net.evil.example", "nots.net", ".ts.net", "ts.net", "",
            "localhost:abc", "localhost:", "[::1]x", "[::2]", "::1", "127.0.0.2", "evil.example:443",
        ] {
            assert!(!host_allowed(Some(bad)), "{bad}");
        }
        assert!(!host_allowed(None));
    }

    /// POSTs an `initialize` with a valid token and the given Host; returns the status.
    async fn initialize_with_host(port: u16, host: &str) -> u16 {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "t", "version": "1"}}});
        reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .bearer_auth(TOKEN)
            .header(reqwest::header::HOST, host)
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    #[tokio::test]
    async fn host_header_allowlist() {
        let h = harness();
        let port = h.server.port;
        for ok in [
            format!("localhost:{port}"),
            "127.0.0.1".to_string(),
            format!("[::1]:{port}"),
            "mac.tail1234.ts.net".to_string(),
            "MAC.TAIL1234.TS.NET".to_string(),
        ] {
            assert_eq!(initialize_with_host(port, &ok).await, 200, "{ok}");
        }
        for bad in ["evil.example", "ts.net.evil.example", "nots.net"] {
            assert_eq!(initialize_with_host(port, bad).await, 403, "{bad}");
        }

        // Missing Host (HTTP/1.0 lets a client omit it), valid token: 403, empty body.
        let raw = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "POST /mcp HTTP/1.0\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}"
            );
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        })
        .await
        .unwrap();
        assert!(raw.starts_with("HTTP/1.0 403") || raw.starts_with("HTTP/1.1 403"), "{raw}");
        assert!(raw.ends_with("\r\n\r\n"), "403 must have an empty body: {raw}");

        // Auth runs first: a bad Host without a token learns only 401.
        let r = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header(reqwest::header::HOST, "evil.example")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 401);
        h.server.stop();
    }

    #[test]
    fn bind_error_mapping() {
        use std::io::{Error, ErrorKind};
        let e = bind_error(8123, Error::from(ErrorKind::AddrInUse));
        assert!(matches!(&e, AppError::Conflict(m) if m == "Port 8123 is in use"), "{e:?}");
        let e = bind_error(80, Error::new(ErrorKind::PermissionDenied, "permission denied"));
        assert!(
            matches!(&e, AppError::Database(m) if m == "Could not listen on 127.0.0.1:80: permission denied"),
            "{e:?}"
        );
    }

    #[tokio::test]
    async fn panicking_tool_does_not_poison_the_connection() {
        let h = harness();
        let c = client(h.server.port).await;
        let (err, v) = call(&c, TEST_PANIC_TOOL, json!({})).await;
        assert!(err);
        assert_eq!(v["code"], "DatabaseError");
        assert_eq!(v["message"], "Internal error while running the tool");
        assert!(!h.db.is_poisoned());

        // Audited as a failed write, no on_write.
        let rows = audit_rows(&h.db);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tool, TEST_PANIC_TOOL);
        assert!(!rows[0].ok);
        assert_eq!(rows[0].error_code.as_deref(), Some("DatabaseError"));
        assert_eq!(h.writes.load(Ordering::SeqCst), 0);

        // The shared connection still works for the server and the desktop UI.
        let (err, v) = call(&c, "create_expense", expense(100)).await;
        assert!(!err, "{v}");
        assert_eq!(h.writes.load(Ordering::SeqCst), 1);
        assert!(service::get_account_balances(&h.db.lock().unwrap()).is_ok());

        c.cancel().await.unwrap();
        h.server.stop();
    }

    #[tokio::test]
    async fn poisoned_lock_returns_database_error_not_panic() {
        let h = harness();
        let c = client(h.server.port).await;
        let lock = h.db.clone();
        let _ = std::thread::spawn(move || {
            let _g = lock.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(h.db.is_poisoned());

        for (name, args) in [("get_account_balances", json!({})), ("create_expense", expense(100))] {
            let (err, v) = call(&c, name, args).await;
            assert!(err, "{name}");
            assert_eq!(v["code"], "DatabaseError", "{name}");
            assert_eq!(v["message"], "Database lock poisoned", "{name}");
        }
        assert_eq!(h.writes.load(Ordering::SeqCst), 0);

        c.cancel().await.unwrap();
        h.server.stop();
    }
}
