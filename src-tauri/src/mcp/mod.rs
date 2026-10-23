//! Embedded MCP assistant server.
pub mod audit;
pub mod auth;
pub mod resolve;
pub mod server;
pub mod tools;
pub mod tools_manage;

use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tauri::{Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::models::McpStatus;
use crate::service;

use server::{RunningServer, ServerConfig};

const KEY_ENABLED: &str = "mcp_enabled";
const KEY_PORT: &str = "mcp_port";
const KEY_TOKEN_HASH: &str = "mcp_token_hash";
const DEFAULT_PORT: u16 = 8765;
/// `stop()` releases the listener asynchronously, so a restart on the same
/// port may need a few bind attempts.
const BIND_RETRY_TOTAL: Duration = Duration::from_secs(1);
const BIND_RETRY_STEP: Duration = Duration::from_millis(50);

type OnWrite = Arc<dyn Fn() + Send + Sync>;

/// A stored port that is missing, garbage or out of range means the default.
fn parse_port(raw: Option<&str>) -> u16 {
    raw.and_then(|s| s.parse::<u16>().ok()).filter(|p| *p != 0).unwrap_or(DEFAULT_PORT)
}

struct Settings {
    enabled: bool,
    port: u16,
    token_hash: String,
}

fn read_settings(db: &Arc<Mutex<Connection>>) -> AppResult<Settings> {
    let conn = db.lock().map_err(|_| AppError::Database("Database lock poisoned".into()))?;
    Ok(Settings {
        enabled: service::get_setting(&conn, KEY_ENABLED)?.as_deref() == Some("1"),
        port: parse_port(service::get_setting(&conn, KEY_PORT)?.as_deref()),
        token_hash: service::get_setting(&conn, KEY_TOKEN_HASH)?.unwrap_or_default(),
    })
}

/// Tauri managed state: the running server (if any), the live token hash
/// shared with its auth middleware, and the last start error.
pub struct McpHandle {
    server: Mutex<Option<RunningServer>>,
    token_hash: Arc<RwLock<String>>,
    error: Mutex<Option<String>>,
}

impl McpHandle {
    /// Seeds the live token hash from the stored one.
    pub fn new(db: &Arc<Mutex<Connection>>) -> Self {
        let stored = read_settings(db).map(|s| s.token_hash).unwrap_or_default();
        Self {
            server: Mutex::new(None),
            token_hash: Arc::new(RwLock::new(stored)),
            error: Mutex::new(None),
        }
    }

    fn set_live_hash(&self, hash: &str) {
        *self.token_hash.write().unwrap_or_else(|p| p.into_inner()) = hash.to_string();
    }

    fn set_error(&self, e: Option<String>) {
        *self.error.lock().unwrap_or_else(|p| p.into_inner()) = e;
    }

    pub fn status(&self, db: &Arc<Mutex<Connection>>) -> McpStatus {
        let running = self.server.lock().unwrap_or_else(|p| p.into_inner()).is_some();
        let error = self.error.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match read_settings(db) {
            Ok(s) => McpStatus {
                enabled: s.enabled,
                port: s.port,
                running,
                has_token: !s.token_hash.is_empty(),
                error,
            },
            Err(e) => McpStatus {
                enabled: false,
                port: DEFAULT_PORT,
                running,
                has_token: false,
                error: Some(e.to_string()),
            },
        }
    }

    /// Starts or stops the server to match the settings. Idempotent.
    pub fn apply_with(&self, db: &Arc<Mutex<Connection>>, on_write: OnWrite) -> McpStatus {
        let settings = match read_settings(db) {
            Ok(s) => s,
            Err(e) => {
                self.set_error(Some(e.to_string()));
                return self.status(db);
            }
        };
        {
            let mut guard = self.server.lock().unwrap_or_else(|p| p.into_inner());
            let running_port = guard.as_ref().map(|s| s.port);
            if !settings.enabled {
                if let Some(s) = guard.take() {
                    s.stop();
                }
                self.set_error(None);
            } else if running_port != Some(settings.port) {
                let restarting = guard.take().map(|s| s.stop()).is_some();
                let started = Instant::now();
                loop {
                    let cfg = ServerConfig {
                        port: settings.port,
                        db: db.clone(),
                        token_hash: self.token_hash.clone(),
                        on_write: on_write.clone(),
                    };
                    match server::start(cfg) {
                        Ok(s) => {
                            *guard = Some(s);
                            self.set_error(None);
                            break;
                        }
                        Err(e) => {
                            if !restarting || started.elapsed() >= BIND_RETRY_TOTAL {
                                self.set_error(Some(e.to_string()));
                                break;
                            }
                            std::thread::sleep(BIND_RETRY_STEP);
                        }
                    }
                }
            }
        }
        self.status(db)
    }

    pub fn set_enabled_with(
        &self,
        db: &Arc<Mutex<Connection>>,
        on_write: OnWrite,
        enabled: bool,
        port: Option<u16>,
    ) -> AppResult<McpStatus> {
        if port == Some(0) {
            return Err(AppError::Validation("Port must be between 1 and 65535.".into()));
        }
        {
            let conn = db.lock().map_err(|_| AppError::Database("Database lock poisoned".into()))?;
            if enabled && service::get_setting(&conn, KEY_TOKEN_HASH)?.unwrap_or_default().is_empty() {
                return Err(AppError::Validation("Generate a token first.".into()));
            }
            if let Some(p) = port {
                service::set_setting(&conn, KEY_PORT, &p.to_string())?;
            }
            service::set_setting(&conn, KEY_ENABLED, if enabled { "1" } else { "0" })?;
        }
        Ok(self.apply_with(db, on_write))
    }

    /// Generates a token, stores only its hash and swaps the live hash so the
    /// old token stops working at once. Returns the plaintext exactly once.
    pub fn rotate_token(&self, db: &Arc<Mutex<Connection>>) -> AppResult<String> {
        let token = auth::generate_token();
        let hash = auth::hash_token(&token);
        {
            let conn = db.lock().map_err(|_| AppError::Database("Database lock poisoned".into()))?;
            service::set_setting(&conn, KEY_TOKEN_HASH, &hash)?;
        }
        self.set_live_hash(&hash);
        Ok(token)
    }

    /// Factory reset: wipe data, drop the live token, stop the server.
    pub fn reset_with(&self, db: &Arc<Mutex<Connection>>, on_write: OnWrite) -> AppResult<McpStatus> {
        {
            let conn = db.lock().map_err(|_| AppError::Database("Database lock poisoned".into()))?;
            service::reset_app(&conn)?;
        }
        self.set_live_hash("");
        Ok(self.apply_with(db, on_write))
    }

    // Thin app wrappers: the DB handle and the `data-changed` event.

    fn app_parts(app: &tauri::AppHandle) -> (Arc<Mutex<Connection>>, OnWrite) {
        let db = app.state::<crate::DbState>().0.clone();
        let app = app.clone();
        let on_write: OnWrite = Arc::new(move || {
            let _ = app.emit("data-changed", ());
        });
        (db, on_write)
    }

    pub fn apply(&self, app: &tauri::AppHandle) -> McpStatus {
        let (db, on_write) = Self::app_parts(app);
        self.apply_with(&db, on_write)
    }

    pub fn get_status(&self, app: &tauri::AppHandle) -> McpStatus {
        self.status(&Self::app_parts(app).0)
    }

    pub fn set_enabled(&self, app: &tauri::AppHandle, enabled: bool, port: Option<u16>) -> AppResult<McpStatus> {
        let (db, on_write) = Self::app_parts(app);
        self.set_enabled_with(&db, on_write, enabled, port)
    }

    pub fn rotate(&self, app: &tauri::AppHandle) -> AppResult<String> {
        self.rotate_token(&Self::app_parts(app).0)
    }

    pub fn reset(&self, app: &tauri::AppHandle) -> AppResult<McpStatus> {
        let (db, on_write) = Self::app_parts(app);
        self.reset_with(&db, on_write)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use std::net::TcpListener;
    use std::time::Duration;

    fn db() -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(open_in_memory().unwrap()))
    }

    fn noop() -> OnWrite {
        Arc::new(|| {})
    }

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    fn setting(db: &Arc<Mutex<Connection>>, key: &str) -> Option<String> {
        service::get_setting(&db.lock().unwrap(), key).unwrap()
    }

    fn can_connect(port: u16) -> bool {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
    }

    fn wait_until_closed(port: u16) -> bool {
        for _ in 0..40 {
            if !can_connect(port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn rotate_token_stores_hash_not_plaintext() {
        let db = db();
        let handle = McpHandle::new(&db);
        let token = handle.rotate_token(&db).unwrap();
        assert_eq!(token.len(), 64);
        let stored = setting(&db, KEY_TOKEN_HASH).unwrap();
        assert_eq!(stored, auth::hash_token(&token));
        assert_ne!(stored, token);
        let all: String = {
            let conn = db.lock().unwrap();
            let mut stmt = conn.prepare("SELECT value FROM app_settings").unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|v| v.unwrap()).collect::<Vec<_>>().join("|")
        };
        assert!(!all.contains(&token), "plaintext token must not be stored");
        assert_eq!(*handle.token_hash.read().unwrap(), stored);
        assert_ne!(handle.rotate_token(&db).unwrap(), token);
    }

    #[test]
    fn enable_without_token_is_validation_error() {
        let db = db();
        let handle = McpHandle::new(&db);
        match handle.set_enabled_with(&db, noop(), true, Some(free_port())) {
            Err(AppError::Validation(m)) => assert_eq!(m, "Generate a token first."),
            other => panic!("expected Validation, got {other:?}"),
        }
        assert_ne!(setting(&db, KEY_ENABLED).as_deref(), Some("1"));
        assert!(!handle.status(&db).running);
    }

    #[test]
    fn status_reports_bind_failure_in_error_and_running_false() {
        let db = db();
        let handle = McpHandle::new(&db);
        handle.rotate_token(&db).unwrap();
        let blocker = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = blocker.local_addr().unwrap().port();
        let st = handle.set_enabled_with(&db, noop(), true, Some(port)).unwrap();
        assert!(st.enabled);
        assert!(!st.running);
        assert!(st.has_token);
        assert_eq!(st.port, port);
        assert!(st.error.is_some());
        assert!(handle.status(&db).error.is_some());
        // Freeing the port and applying again recovers.
        drop(blocker);
        let st = handle.apply_with(&db, noop());
        assert!(st.running, "{:?}", st.error);
        assert!(st.error.is_none());
        handle.set_enabled_with(&db, noop(), false, None).unwrap();
    }

    #[test]
    fn enable_then_disable_stops_server() {
        let db = db();
        let handle = McpHandle::new(&db);
        handle.rotate_token(&db).unwrap();
        let port = free_port();
        let st = handle.set_enabled_with(&db, noop(), true, Some(port)).unwrap();
        assert!(st.running, "{:?}", st.error);
        assert_eq!(st.port, port);
        assert!(can_connect(port));
        // Idempotent: a second apply leaves the same server in place.
        assert!(handle.apply_with(&db, noop()).running);
        let st = handle.set_enabled_with(&db, noop(), false, None).unwrap();
        assert!(!st.running);
        assert!(!st.enabled);
        assert!(wait_until_closed(port), "listener must be released");
    }

    #[test]
    fn invalid_port_rejected() {
        let db = db();
        let handle = McpHandle::new(&db);
        handle.rotate_token(&db).unwrap();
        assert!(matches!(
            handle.set_enabled_with(&db, noop(), true, Some(0)),
            Err(AppError::Validation(_))
        ));
        assert_ne!(setting(&db, KEY_ENABLED).as_deref(), Some("1"));
        // Garbage or out-of-range stored values fall back to the default.
        for bad in ["0", "65536", "99999999999", "abc", "", "-1"] {
            service::set_setting(&db.lock().unwrap(), KEY_PORT, bad).unwrap();
            assert_eq!(handle.status(&db).port, DEFAULT_PORT, "stored {bad:?}");
        }
        assert_eq!(parse_port(None), DEFAULT_PORT);
        assert_eq!(parse_port(Some("65535")), 65535);
    }

    #[test]
    fn reset_clears_token_and_stops() {
        let db = db();
        let handle = McpHandle::new(&db);
        handle.rotate_token(&db).unwrap();
        let port = free_port();
        assert!(handle.set_enabled_with(&db, noop(), true, Some(port)).unwrap().running);
        let st = handle.reset_with(&db, noop()).unwrap();
        assert!(!st.running);
        assert!(!st.enabled);
        assert!(!st.has_token);
        assert!(handle.token_hash.read().unwrap().is_empty());
        assert!(wait_until_closed(port));
    }

    #[tokio::test]
    async fn rotate_invalidates_old_token_live() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let db = db();
        let handle = McpHandle::new(&db);
        let old = handle.rotate_token(&db).unwrap();
        let port = free_port();
        let st = handle.set_enabled_with(&db, noop(), true, Some(port)).unwrap();
        assert!(st.running, "{:?}", st.error);
        let status_with = |token: String| async move {
            reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/mcp"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status()
        };
        assert_ne!(status_with(old.clone()).await, 401);
        let new = handle.rotate_token(&db).unwrap();
        assert_eq!(status_with(old).await, 401);
        assert_ne!(status_with(new).await, 401);
        assert!(handle.status(&db).running, "rotation must not restart the server");
        handle.set_enabled_with(&db, noop(), false, None).unwrap();
    }
}
