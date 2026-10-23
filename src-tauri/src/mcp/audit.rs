//! MCP write-call audit log and rate limiter.

use crate::error::AppResult;
use crate::models::McpAuditEntry;
use crate::repo;
use rusqlite::Connection;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Rows kept in the audit log; older rows are trimmed after each insert.
pub const MAX_AUDIT_ROWS: i64 = 10_000;
/// Longest stored `args_json`, in bytes, including the truncation marker.
pub const MAX_ARGS_BYTES: usize = 8 * 1024;
/// Appended to a cut `args_json` (which is then no longer valid JSON).
pub const TRUNCATION_MARKER: &str = "...[truncated]";

/// Record one write tool call and trim the log to `MAX_AUDIT_ROWS`.
/// `args_json` stores `{"args": <args>, "affectedId": <id or null>}`, capped
/// at `MAX_ARGS_BYTES`.
pub fn record(
    conn: &Connection,
    user: Option<&str>,
    tool: &str,
    args: &serde_json::Value,
    affected_id: Option<&str>,
    outcome: &AppResult<()>,
) -> AppResult<()> {
    let stored = serde_json::json!({"args": args, "affectedId": affected_id}).to_string();
    let entry = McpAuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        at: crate::now(),
        tailscale_user: user.map(str::to_string),
        tool: tool.to_string(),
        args_json: cap_args(stored),
        ok: outcome.is_ok(),
        error_code: outcome.as_ref().err().map(|e| e.code().to_string()),
    };
    repo::insert_mcp_audit(conn, &entry)?;
    repo::trim_mcp_audit(conn, MAX_AUDIT_ROWS)
}

/// Cut to `MAX_ARGS_BYTES` on a char boundary, ending with the marker.
fn cap_args(s: String) -> String {
    if s.len() <= MAX_ARGS_BYTES {
        return s;
    }
    let mut cut = MAX_ARGS_BYTES - TRUNCATION_MARKER.len();
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TRUNCATION_MARKER}", &s[..cut])
}

/// Newest first.
pub fn list(conn: &Connection, limit: i64) -> AppResult<Vec<McpAuditEntry>> {
    repo::list_mcp_audit(conn, limit)
}

/// What the limiter decided for one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Allowed,
    /// Over the limit. `first` is true only for the first blocked call of the
    /// window, the only one worth an audit row.
    Blocked { first: bool },
}

/// Fixed-window limiter: at most `max` allowed calls per `window`.
pub struct RateLimiter {
    max: usize,
    window: Duration,
    /// (window start, allowed calls, blocked calls) in the current window.
    state: Mutex<(Instant, usize, usize)>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { max, window, state: Mutex::new((Instant::now(), 0, 0)) }
    }

    pub fn check(&self, now: Instant) -> Limit {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if now.saturating_duration_since(s.0) >= self.window {
            *s = (now, 0, 0);
        }
        if s.1 < self.max {
            s.1 += 1;
            Limit::Allowed
        } else {
            s.2 += 1;
            Limit::Blocked { first: s.2 == 1 }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    fn count(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM mcp_audit_log", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn record_then_list_newest_first() {
        let c = open_in_memory().unwrap();
        record(&c, Some("me@tailnet"), "add_expense", &json!({"a": 1}), Some("t-1"), &Ok(())).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let err: AppResult<()> = Err(AppError::Validation("bad".into()));
        record(&c, None, "add_income", &json!({"b": 2}), None, &err).unwrap();
        let rows = list(&c, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tool, "add_income");
        assert!(!rows[0].ok);
        assert_eq!(rows[0].error_code.as_deref(), Some("ValidationError"));
        assert_eq!(rows[0].tailscale_user, None);
        let v: Value = serde_json::from_str(&rows[0].args_json).unwrap();
        assert_eq!(v, json!({"args": {"b": 2}, "affectedId": null}));
        assert_eq!(rows[1].tool, "add_expense");
        assert!(rows[1].ok);
        assert_eq!(rows[1].error_code, None);
        assert_eq!(rows[1].tailscale_user.as_deref(), Some("me@tailnet"));
        let v: Value = serde_json::from_str(&rows[1].args_json).unwrap();
        assert_eq!(v, json!({"args": {"a": 1}, "affectedId": "t-1"}));
    }

    #[test]
    fn list_respects_limit() {
        let c = open_in_memory().unwrap();
        for i in 0..5 {
            record(&c, None, &format!("t{i}"), &json!({}), None, &Ok(())).unwrap();
        }
        assert_eq!(list(&c, 3).unwrap().len(), 3);
    }

    #[test]
    fn oversized_args_are_truncated() {
        let c = open_in_memory().unwrap();
        // Multi-byte chars make sure the cut lands on a char boundary.
        let big = "é".repeat(20_000);
        record(&c, None, "create_expense", &json!({"description": big}), None, &Ok(())).unwrap();
        let stored = &list(&c, 1).unwrap()[0].args_json;
        assert!(stored.len() <= MAX_ARGS_BYTES, "{}", stored.len());
        assert!(stored.len() > MAX_ARGS_BYTES - 16, "{}", stored.len());
        assert!(stored.ends_with(TRUNCATION_MARKER));
        assert!(stored.starts_with(r#"{"affectedId":null,"args":{"description":"é"#), "{}", &stored[..60]);
        // Small args are stored whole.
        record(&c, None, "create_expense", &json!({"a": 1}), None, &Ok(())).unwrap();
        assert!(!list(&c, 1).unwrap()[0].args_json.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn audit_trims_to_10000_rows() {
        let c = open_in_memory().unwrap();
        {
            let tx = c.unchecked_transaction().unwrap();
            for i in 0..MAX_AUDIT_ROWS {
                let e = McpAuditEntry {
                    id: format!("old-{i}"),
                    at: format!("2000-01-01T00:00:00.{i:06}Z"),
                    tailscale_user: None,
                    tool: "create_expense".into(),
                    args_json: "{}".into(),
                    ok: true,
                    error_code: None,
                };
                repo::insert_mcp_audit(&tx, &e).unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(count(&c), MAX_AUDIT_ROWS);
        record(&c, None, "newest", &json!({}), None, &Ok(())).unwrap();
        assert_eq!(count(&c), MAX_AUDIT_ROWS);
        let gone: i64 = c.query_row("SELECT COUNT(*) FROM mcp_audit_log WHERE id = 'old-0'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0, "the oldest row is trimmed");
        assert_eq!(list(&c, 1).unwrap()[0].tool, "newest");
        assert_eq!(MAX_AUDIT_ROWS, 10_000);
    }

    #[test]
    fn rate_limiter_allows_60_then_blocks_61st() {
        let rl = RateLimiter::new(60, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..60 {
            assert_eq!(rl.check(now), Limit::Allowed);
        }
        assert_eq!(rl.check(now), Limit::Blocked { first: true });
    }

    #[test]
    fn blocked_calls_after_the_first_are_not_audited() {
        // Only the first blocked call of a window is flagged for auditing.
        let rl = RateLimiter::new(2, Duration::from_secs(60));
        let now = Instant::now();
        assert_eq!(rl.check(now), Limit::Allowed);
        assert_eq!(rl.check(now), Limit::Allowed);
        assert_eq!(rl.check(now), Limit::Blocked { first: true });
        for _ in 0..5 {
            assert_eq!(rl.check(now), Limit::Blocked { first: false });
        }
        // A new window resets both counters.
        let later = now + Duration::from_secs(61);
        assert_eq!(rl.check(later), Limit::Allowed);
        assert_eq!(rl.check(later), Limit::Allowed);
        assert_eq!(rl.check(later), Limit::Blocked { first: true });
        assert_eq!(rl.check(later), Limit::Blocked { first: false });
    }

    #[test]
    fn rate_limiter_window_resets() {
        let rl = RateLimiter::new(60, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..60 {
            assert_eq!(rl.check(now), Limit::Allowed);
        }
        assert_ne!(rl.check(now), Limit::Allowed);
        assert_eq!(rl.check(now + Duration::from_secs(61)), Limit::Allowed);
    }
}
