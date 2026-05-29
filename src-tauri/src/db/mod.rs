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
#[cfg(test)]
pub fn tests_subtype_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM account_subtypes", [], |r| r.get(0)).unwrap()
}

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

#[cfg(test)]
mod migration_tests {
    use super::migrations::MIGRATIONS;
    use rusqlite::Connection;

    #[test]
    fn migration_002_remaps_legacy_subtypes_and_drops_account_type() {
        let conn = Connection::open_in_memory().unwrap();
        // v1 schema only.
        conn.execute_batch(MIGRATIONS[0].1).unwrap();
        // Legacy rows spanning the old account_type values.
        conn.execute_batch(
            "INSERT INTO accounts (id,template_key,name,account_type,subtype,opening_balance_cents,currency,is_archived,created_at,updated_at) VALUES
               ('1',NULL,'Bank','bank','savings',0,'MYR',0,'t','t'),
               ('2',NULL,'BNPL','bnpl','bnpl',0,'MYR',0,'t','t'),
               ('3',NULL,'Wallet','ewallet','ewallet',0,'MYR',0,'t','t'),
               ('4',NULL,'Inv','investment','investment',0,'MYR',0,'t','t'),
               ('5',NULL,'Weird','custom','totally-custom',0,'MYR',0,'t','t');",
        )
        .unwrap();
        // Apply v1.1.
        conn.execute_batch(MIGRATIONS[1].1).unwrap();

        let sub = |id: &str| -> String {
            conn.query_row("SELECT subtype FROM accounts WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(sub("1"), "savings");
        assert_eq!(sub("2"), "bnpl");
        assert_eq!(sub("3"), "ewallet");
        assert_eq!(sub("4"), "investment");
        assert_eq!(sub("5"), "cash"); // unknown → cash
        assert_eq!(super::tests_subtype_count(&conn), 16);

        // account_type column is gone.
        assert!(conn.prepare("SELECT account_type FROM accounts").is_err());
    }
}
