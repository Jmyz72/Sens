//! Embedded MCP server: rmcp Streamable HTTP at `/mcp` behind bearer auth.
//!
//! All rmcp types stay inside this file. Tools come dynamically from
//! `tools::definitions()`; write tools are rate limited and audited here.
//! The token and request headers are never logged.
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::middleware::from_fn_with_state;
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
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", cfg.port))
        .map_err(|_| AppError::Conflict(format!("Port {} is in use", cfg.port)))?;
    std_listener.set_nonblocking(true).map_err(start_failed)?;
    let port = std_listener.local_addr().map_err(start_failed)?.port();

    let defs = tools::definitions();
    let shared = Arc::new(Shared {
        db: cfg.db,
        on_write: cfg.on_write,
        limiter: RateLimiter::new(WRITE_LIMIT, WRITE_WINDOW),
        write_tools: defs.iter().filter(|d| d.writes).map(|d| d.name).collect(),
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

    // Host validation is off: Tailscale Serve forwards the tailnet hostname as
    // `Host`. DNS rebinding is already covered by the loopback-peer check plus
    // the required bearer token in `require_token`.
    let http_config = StreamableHttpServerConfig::default().disable_allowed_hosts();
    let sessions_ct = http_config.cancellation_token.clone();
    let factory_shared = shared.clone();
    let mcp = StreamableHttpService::new(
        move || Ok(SensHandler { shared: factory_shared.clone() }),
        Arc::new(LocalSessionManager::default()),
        http_config,
    );
    let app = Router::new()
        .nest_service("/mcp", mcp)
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
        if !writes {
            return tools::call(&conn, name, args);
        }
        let result = tools::call(&conn, name, args.clone());
        let outcome = match &result {
            Ok(_) => Ok(()),
            Err(e) => Err(copy_error(e)),
        };
        audit_call(&conn, user, name, &args, &outcome);
        drop(conn);
        if result.is_ok() {
            (self.on_write)();
        }
        result
    }
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
