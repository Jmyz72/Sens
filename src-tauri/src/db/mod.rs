//! Database access: connection setup, the migration runner, and first-run
//! seeding. The SQLite file lives in the Tauri app-data directory and every
//! connection enables foreign-key enforcement.

mod migrations;
mod seed;

use crate::error::AppResult;
use rusqlite::Connection;
use std::path::Path;

const FIRST_RUN_KEY: &str = "seeded";

/// Open the database, enforce foreign keys, run migrations, and seed once.
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    run_migrations(&conn)?;
    seed_once(&conn)?;
    Ok(conn)
}

/// Open an in-memory database (used by tests).
#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&conn)?;
    seed_once(&conn)?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    )?;
    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?;
    for (version, sql) in migrations::MIGRATIONS {
        if *version > current {
            // Each migration in its own transaction so a failure rolls back cleanly.
            conn.execute_batch("BEGIN")?;
            let applied = (|| -> AppResult<()> {
                conn.execute_batch(sql)?;
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    rusqlite::params![version, crate::now()],
                )?;
                Ok(())
            })();
            match applied {
                Ok(()) => conn.execute_batch("COMMIT")?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
            }
        }
    }
    Ok(())
}

/// Seed templates and default categories exactly once, with the seed and the
/// first-run flag committed atomically so a crash mid-seed safely re-runs.
fn seed_once(conn: &Connection) -> AppResult<()> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = ?1)",
            [FIRST_RUN_KEY],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if done {
        return Ok(());
    }
    let now = crate::now();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        seed::seed(conn, &now)?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2)",
            rusqlite::params![FIRST_RUN_KEY, now],
        )?;
        Ok(())
    })();
    match res {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}
