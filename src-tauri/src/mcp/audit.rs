//! MCP write-call audit log and rate limiter.

use crate::error::AppResult;
use crate::models::McpAuditEntry;
use crate::repo;
use rusqlite::Connection;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Record one write tool call. `args` is the serialized tool args.
pub fn record(
    conn: &Connection,
    user: Option<&str>,
    tool: &str,
    args: &serde_json::Value,
    outcome: &AppResult<()>,
) -> AppResult<()> {
    let entry = McpAuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        at: crate::now(),
        tailscale_user: user.map(str::to_string),
        tool: tool.to_string(),
        args_json: args.to_string(),
        ok: outcome.is_ok(),
        error_code: outcome.as_ref().err().map(|e| e.code().to_string()),
    };
    repo::insert_mcp_audit(conn, &entry)
}

/// Newest first.
pub fn list(conn: &Connection, limit: i64) -> AppResult<Vec<McpAuditEntry>> {
    repo::list_mcp_audit(conn, limit)
}

/// Fixed-window limiter: at most `max` allowed calls per `window`.
pub struct RateLimiter {
    max: usize,
    window: Duration,
    state: Mutex<(Instant, usize)>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { max, window, state: Mutex::new((Instant::now(), 0)) }
    }

    /// True if the call is allowed.
    pub fn check(&self, now: Instant) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if now.saturating_duration_since(s.0) >= self.window {
            *s = (now, 0);
        }
        if s.1 < self.max {
            s.1 += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn record_then_list_newest_first() {
        let c = open_in_memory().unwrap();
        record(&c, Some("me@tailnet"), "add_expense", &json!({"a": 1}), &Ok(())).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let err: AppResult<()> = Err(AppError::Validation("bad".into()));
        record(&c, None, "add_income", &json!({"b": 2}), &err).unwrap();
        let rows = list(&c, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tool, "add_income");
        assert!(!rows[0].ok);
        assert_eq!(rows[0].error_code.as_deref(), Some("ValidationError"));
        assert_eq!(rows[0].tailscale_user, None);
        assert_eq!(rows[0].args_json, r#"{"b":2}"#);
        assert_eq!(rows[1].tool, "add_expense");
        assert!(rows[1].ok);
        assert_eq!(rows[1].error_code, None);
        assert_eq!(rows[1].tailscale_user.as_deref(), Some("me@tailnet"));
    }

    #[test]
    fn list_respects_limit() {
        let c = open_in_memory().unwrap();
        for i in 0..5 {
            record(&c, None, &format!("t{i}"), &json!({}), &Ok(())).unwrap();
        }
        assert_eq!(list(&c, 3).unwrap().len(), 3);
    }

    #[test]
    fn rate_limiter_allows_60_then_blocks_61st() {
        let rl = RateLimiter::new(60, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..60 {
            assert!(rl.check(now));
        }
        assert!(!rl.check(now));
    }

    #[test]
    fn rate_limiter_window_resets() {
        let rl = RateLimiter::new(60, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..60 {
            assert!(rl.check(now));
        }
        assert!(!rl.check(now));
        assert!(rl.check(now + Duration::from_secs(61)));
    }
}
