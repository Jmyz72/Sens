//! Database access: connection setup, the migration runner, and first-run
//! seeding. The SQLite file lives in the Tauri app-data directory and every
//! connection enables foreign-key enforcement.

pub mod migrations;
mod seed;

use crate::error::AppResult;
use rusqlite::Connection;
use std::path::Path;

const FIRST_RUN_KEY: &str = "seeded";
const DEFAULTS_V2_KEY: &str = "defaults_v2_seeded";
const DEFAULTS_V3_KEY: &str = "defaults_v3_seeded";
const DEFAULTS_V4_KEY: &str = "defaults_v4_seeded";

/// Backfill gate flags, applied in order on every open. Each gate runs the
/// idempotent category seed at most once; bump with a new flag whenever the
/// default category tree is enriched so existing users pick up the additions.
/// `seed_categories` always seeds the *current* full tree, so a single later
/// gate also covers users who never hit an earlier one.
const BACKFILL_GATES: &[&str] = &[DEFAULTS_V2_KEY, DEFAULTS_V3_KEY, DEFAULTS_V4_KEY];

/// Open the database, enforce foreign keys, run migrations, and seed once.
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    run_migrations(&conn)?;
    seed_once(&conn)?;
    backfill_defaults(&conn)?;
    backfill_templates(&conn)?;
    Ok(conn)
}

/// Re-seed the built-in provider template catalog on every open so existing
/// users pick up newly added templates (e.g. the Cash template). Idempotent
/// `INSERT OR IGNORE`; templates are not user-deletable, so this never
/// resurrects or duplicates anything. Ungated by design, unlike category
/// backfills, which must not resurrect categories a user has since deleted.
fn backfill_templates(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("BEGIN")?;
    match seed::seed_templates(conn) {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// Run every backfill gate in order (see `BACKFILL_GATES`).
fn backfill_defaults(conn: &Connection) -> AppResult<()> {
    for gate in BACKFILL_GATES {
        backfill_gate(conn, gate)?;
    }
    Ok(())
}

/// Test hook: re-run the backfill gates (used to exercise the promotion path).
#[cfg(test)]
pub fn backfill_defaults_for_test(conn: &Connection) -> AppResult<()> {
    backfill_defaults(conn)
}

/// Open an in-memory database (used by tests).
#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&conn)?;
    seed_once(&conn)?;
    backfill_defaults(&conn)?;
    backfill_templates(&conn)?;
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

/// Backfill the richer default category tree for existing users. Gated by the
/// given flag so it runs once per gate; INSERT OR IGNORE means it never
/// duplicates rows a fresh install already has, and never resurrects a default
/// the user deleted after that gate has run.
fn backfill_gate(conn: &Connection, gate: &str) -> AppResult<()> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = ?1)",
            [gate],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if done {
        return Ok(());
    }
    let now = crate::now();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        seed::seed_categories(conn, &now)?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2)",
            rusqlite::params![gate, now],
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

/// Factory reset: wipe all user data and re-run the idempotent seed so the
/// database returns to a fresh-install state. Done in one transaction. The
/// `account_subtypes` reference table and `schema_migrations` are preserved;
/// `account_templates` are reseeded by `seed::seed` (INSERT OR IGNORE).
pub fn reset_to_defaults(conn: &Connection) -> AppResult<()> {
    let now = crate::now();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        // Order respects ON DELETE RESTRICT FKs: postings reference transactions
        // (CASCADE) and accounts (RESTRICT); transactions reference accounts +
        // categories; categories self-reference via parent_id. Delete postings
        // first so the accounts delete below isn't blocked by the RESTRICT FK.
        // reimbursement_allocations.expense_id is ON DELETE RESTRICT, so the links
        // must go before the transactions they reference.
        conn.execute("DELETE FROM savings_goals", [])?;
        conn.execute("DELETE FROM category_budgets", [])?;
        conn.execute("DELETE FROM reimbursement_allocations", [])?;
        conn.execute("DELETE FROM postings", [])?;
        conn.execute("DELETE FROM transactions", [])?;
        conn.execute("DELETE FROM categories WHERE parent_id IS NOT NULL", [])?;
        conn.execute("DELETE FROM categories", [])?;
        conn.execute("DELETE FROM accounts", [])?;
        conn.execute("DELETE FROM app_settings", [])?;
        seed::seed(conn, &now)?;
        for key in [FIRST_RUN_KEY, DEFAULTS_V2_KEY, DEFAULTS_V3_KEY, DEFAULTS_V4_KEY] {
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2)",
                rusqlite::params![key, now],
            )?;
        }
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

    fn subtype_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM account_subtypes", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migration_002_remaps_legacy_subtypes_and_drops_account_type() {
        let conn = Connection::open_in_memory().unwrap();
        // v1 schema only.
        conn.execute_batch(MIGRATIONS[0].1).unwrap();
        // Legacy rows spanning the old account_type values.
        // Row '6' has account_type='digital_bank' and an invalid subtype, so it
        // exercises the WHEN account_type IN ('bank','digital_bank') THEN 'savings'
        // remap branch in migration 002.
        conn.execute_batch(
            "INSERT INTO accounts (id,template_key,name,account_type,subtype,currency,is_archived,created_at,updated_at) VALUES
               ('1',NULL,'Bank','bank','savings','MYR',0,'t','t'),
               ('2',NULL,'BNPL','bnpl','bnpl','MYR',0,'t','t'),
               ('3',NULL,'Wallet','ewallet','ewallet','MYR',0,'t','t'),
               ('4',NULL,'Inv','investment','investment','MYR',0,'t','t'),
               ('5',NULL,'Weird','custom','totally-custom','MYR',0,'t','t'),
               ('6',NULL,'OldDigital','digital_bank','legacy-thing','MYR',0,'t','t');",
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
        assert_eq!(sub("6"), "savings"); // digital_bank + invalid subtype → savings via account_type remap
        assert_eq!(subtype_count(&conn), 16);

        // account_type column is gone.
        assert!(conn.prepare("SELECT account_type FROM accounts").is_err());
    }

    #[test]
    fn migration_003_adds_parent_id_and_partial_indexes() {
        let conn = super::open_in_memory().unwrap();
        // parent_id column exists on categories
        let has_parent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('categories') WHERE name = 'parent_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_parent, 1, "categories.parent_id should exist");

        let idx = |name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(idx("idx_categories_top_kind_name"), 1, "top-level partial index");
        assert_eq!(idx("idx_categories_sub_parent_name"), 1, "sibling partial index");
        assert_eq!(idx("idx_categories_kind_name"), 0, "old global index should be dropped");
    }

    #[test]
    fn migration_005_upgrades_old_db_without_data_loss() {
        // Simulate an existing pre-v0.5.0 database: apply 001–004 with the same
        // foreign-keys-ON + per-migration-transaction discipline as the real
        // runner, seed old-shape data, then apply 005 and verify the opening
        // balance is preserved as a transaction and the column is gone.
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..4 {
            apply(MIGRATIONS[i].1); // 001–004
        }

        // Old-shape rows: an account with a non-zero opening balance and a real
        // transaction (an adjustment needs no category FK).
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, opening_balance_cents, currency, is_archived, created_at, updated_at)
               VALUES ('a1', NULL, 'Bank', 'savings', 5000, 'MYR', 0, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00');
             INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, created_at, updated_at)
               VALUES ('t1', 'adjustment', 'a1', NULL, NULL, 1000, 'Adj', '2026-04-01', '2026-04-01T00:00:00+00:00', '2026-04-01T00:00:00+00:00');",
        );

        // Upgrade.
        apply(MIGRATIONS[4].1); // 005

        // The opening balance became exactly one 'opening' transaction, dated the
        // account's creation day, carrying the old column value.
        let open_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE account_id='a1' AND kind='opening'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(open_count, 1, "exactly one opening row backfilled");
        let (amt, date): (i64, String) = conn
            .query_row(
                "SELECT amount_cents, transaction_date FROM transactions WHERE account_id='a1' AND kind='opening'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(amt, 5000, "opening amount preserved");
        assert_eq!(date, "2026-03-01", "opening dated the account's creation day");

        // The pre-existing transaction survived and gained the new flag column.
        let (desc, excluded): (String, i64) = conn
            .query_row(
                "SELECT description, excluded_from_reporting FROM transactions WHERE id='t1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(desc, "Adj", "existing transaction preserved");
        assert_eq!(excluded, 0, "excluded_from_reporting defaults to 0");

        // Balance reconciles to opening + history: 5000 + 1000 = 6000.
        let total: i64 = conn
            .query_row("SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE account_id='a1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 6000);

        // The redundant column is gone.
        assert!(conn.prepare("SELECT opening_balance_cents FROM accounts").is_err());
    }

    #[test]
    fn backfill_seeds_defaults_for_existing_users_without_disturbing_them() {
        let conn = super::open_in_memory().unwrap();
        // Simulate a pre-v0.4.1 database: top-level categories exist, but the
        // subcategory tree and the backfill flag do not.
        conn.execute("DELETE FROM categories WHERE parent_id IS NOT NULL", []).unwrap();
        conn.execute("DELETE FROM app_settings WHERE key = ?1", [super::DEFAULTS_V2_KEY]).unwrap();
        let food: String = conn
            .query_row(
                "SELECT id FROM categories WHERE name = 'Food' AND parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // An existing user may have archived a default before upgrading.
        conn.execute("UPDATE categories SET is_archived = 1 WHERE id = ?1", [&food]).unwrap();

        super::backfill_defaults(&conn).unwrap();

        let children = |id: &str| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM categories WHERE parent_id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        let subs = children(&food);
        assert!(subs > 0, "backfill should seed subcategories under an existing top-level");

        // The existing (archived) top-level is left untouched — not un-archived,
        // not duplicated.
        let archived: i64 = conn
            .query_row("SELECT is_archived FROM categories WHERE id = ?1", [&food], |r| r.get(0))
            .unwrap();
        assert_eq!(archived, 1, "backfill must not disturb an existing archived category");
        let food_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE name = 'Food' AND parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(food_count, 1, "backfill must not duplicate an existing top-level");

        // Re-seeding is idempotent: running the seed again adds nothing.
        super::seed::seed_categories(&conn, "t").unwrap();
        assert_eq!(children(&food), subs, "re-seeding must not duplicate subcategories");

        // The gate flag is now set, so a second backfill is a no-op.
        super::backfill_defaults(&conn).unwrap();
        assert_eq!(children(&food), subs, "a gated second backfill must change nothing");
    }

    #[test]
    fn v3_backfill_adds_new_top_level_categories_for_v2_users() {
        let conn = super::open_in_memory().unwrap();
        let count = |name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM categories WHERE name = ?1 AND parent_id IS NULL",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        // Simulate a user who upgraded through v2 (so its flag is set) but never
        // saw the v3 enrichment: drop the new top-levels and the v3 gate.
        for name in ["Family & Dependents", "Donations & Religious", "Pets"] {
            // Children first — parent_id FK is ON DELETE RESTRICT.
            conn.execute(
                "DELETE FROM categories WHERE parent_id IN
                   (SELECT id FROM categories WHERE name = ?1 AND parent_id IS NULL)",
                [name],
            )
            .unwrap();
            conn.execute("DELETE FROM categories WHERE name = ?1 AND parent_id IS NULL", [name])
                .unwrap();
            assert_eq!(count(name), 0);
        }
        conn.execute("DELETE FROM app_settings WHERE key = ?1", [super::DEFAULTS_V3_KEY]).unwrap();

        super::backfill_defaults(&conn).unwrap();

        for name in ["Family & Dependents", "Donations & Religious", "Pets"] {
            assert_eq!(count(name), 1, "v3 backfill should add {name}");
        }
        // Idempotent: a second pass (gate now set) changes nothing.
        super::backfill_defaults(&conn).unwrap();
        assert_eq!(count("Pets"), 1, "v3 backfill must not duplicate on re-run");
    }

    #[test]
    fn template_backfill_adds_cash_for_existing_users_and_keeps_it_first() {
        let conn = super::open_in_memory().unwrap();
        let cash_count = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM account_templates WHERE key = 'cash'", [], |r| r.get(0))
                .unwrap()
        };
        // Simulate a DB that predates the Cash template.
        conn.execute("DELETE FROM account_templates WHERE key = 'cash'", []).unwrap();
        assert_eq!(cash_count(&conn), 0);

        super::backfill_templates(&conn).unwrap();
        assert_eq!(cash_count(&conn), 1, "ungated template backfill should add Cash");

        // It sorts ahead of every other provider (negative sort_order).
        let first: String = conn
            .query_row(
                "SELECT key FROM account_templates WHERE is_active = 1 ORDER BY sort_order LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first, "cash", "Cash should lead the picker");

        // Idempotent: a second pass changes nothing.
        super::backfill_templates(&conn).unwrap();
        assert_eq!(cash_count(&conn), 1, "template backfill must not duplicate on re-run");
    }

    #[test]
    fn migration_011_copies_rows_and_accepts_payment() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..10 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('src', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                      ('card', NULL, 'Visa', 'credit-card', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('c1', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
               VALUES ('xfer', 'transfer', 'src', 'card', NULL, 4000, 'Old pay', '2026-02-01', 0, NULL, '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00'),
                      ('exp', 'expense', 'src', NULL, 'c1', 1500, 'Lunch', '2026-02-02', 0, NULL, '2026-02-02T00:00:00+00:00', '2026-02-02T00:00:00+00:00');
             INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
               VALUES ('p1', 'xfer', 'src', NULL, -4000), ('p2', 'xfer', 'card', NULL, 4000);
             INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
               VALUES ('s1', 'exp', 'c1', 1500, 0, '2026-02-02T00:00:00+00:00');",
        );
        apply(MIGRATIONS[10].1);

        let kind: String = conn.query_row("SELECT kind FROM transactions WHERE id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "transfer");
        let postings: i64 = conn.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(postings, 2);
        let splits: i64 = conn.query_row("SELECT COUNT(*) FROM transaction_splits WHERE transaction_id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(splits, 1);
        conn.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
             VALUES ('pay', 'payment', 'src', 'card', NULL, 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')",
            [],
        ).unwrap();
        let rejected = conn.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
             VALUES ('bad', 'payment', 'src', 'card', 'c1', 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')",
            [],
        );
        assert!(rejected.is_err(), "a payment cannot carry a category");
    }

    #[test]
    fn migration_012_copies_rows_and_adds_reimbursements() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..11 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('src', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                      ('card', NULL, 'Visa', 'credit-card', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('c1', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
               VALUES ('xfer', 'payment', 'src', 'card', NULL, 4000, 'Pay', '2026-02-01', 0, NULL, '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00'),
                      ('exp', 'expense', 'src', NULL, 'c1', 1500, 'Lunch', '2026-02-02', 0, NULL, '2026-02-02T00:00:00+00:00', '2026-02-02T00:00:00+00:00');
             INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
               VALUES ('p1', 'xfer', 'src', NULL, -4000), ('p2', 'xfer', 'card', NULL, 4000);
             INSERT INTO transaction_splits (id, transaction_id, category_id, amount_cents, sort_order, created_at)
               VALUES ('s1', 'exp', 'c1', 1500, 0, '2026-02-02T00:00:00+00:00');",
        );
        apply(MIGRATIONS[11].1);

        let kind: String = conn.query_row("SELECT kind FROM transactions WHERE id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "payment");
        let postings: i64 = conn.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id='xfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(postings, 2);
        let splits: i64 = conn.query_row("SELECT COUNT(*) FROM transaction_splits WHERE transaction_id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(splits, 1);
        let expected: Option<i64> = conn.query_row("SELECT expected_reimbursement_cents FROM transactions WHERE id='exp'", [], |r| r.get(0)).unwrap();
        assert_eq!(expected, None);

        let insert = |id: &str, kind: &str, to: &str, cat: &str| {
            conn.execute(
                &format!(
                    "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, transaction_time, created_at, updated_at)
                     VALUES ('{id}', '{kind}', 'src', {to}, {cat}, 1000, NULL, '2026-03-01', 0, NULL, '2026-03-01T00:00:00+00:00', '2026-03-01T00:00:00+00:00')"
                ),
                [],
            )
        };
        insert("re1", "reimbursement", "NULL", "NULL").unwrap();
        assert!(insert("bad1", "reimbursement", "NULL", "'c1'").is_err(), "a reimbursement cannot carry a category");
        assert!(insert("bad2", "reimbursement", "'card'", "NULL").is_err(), "a reimbursement cannot carry a destination");

        conn.execute("UPDATE transactions SET expected_reimbursement_cents = 1500 WHERE id='exp'", []).unwrap();
        assert!(
            conn.execute("UPDATE transactions SET expected_reimbursement_cents = 1501 WHERE id='exp'", []).is_err(),
            "expectation cannot exceed the expense amount"
        );
        assert!(
            conn.execute("UPDATE transactions SET expected_reimbursement_cents = 100 WHERE id='xfer'", []).is_err(),
            "only an expense can carry an expectation"
        );

        conn.execute(
            "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
             VALUES ('a1', 're1', 'exp', 1000, '2026-03-01T00:00:00+00:00')",
            [],
        ).unwrap();
        assert!(
            conn.execute(
                "INSERT INTO reimbursement_allocations (id, reimbursement_id, expense_id, amount_cents, created_at)
                 VALUES ('a2', 're1', 'exp', 100, '2026-03-01T00:00:00+00:00')",
                [],
            ).is_err(),
            "one reimbursement lists an expense once"
        );
        assert!(
            conn.execute("DELETE FROM transactions WHERE id='exp'", []).is_err(),
            "an expense with allocations cannot be deleted at the SQL level"
        );
        conn.execute("DELETE FROM transactions WHERE id='re1'", []).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM reimbursement_allocations", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "deleting a reimbursement removes its allocations");
    }

    #[test]
    fn migration_013_creates_budgets_and_goals() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let apply = |sql: &str| {
            conn.execute_batch("BEGIN").unwrap();
            conn.execute_batch(sql).unwrap();
            conn.execute_batch("COMMIT").unwrap();
        };
        for i in 0..12 {
            apply(MIGRATIONS[i].1);
        }
        apply(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
               VALUES ('sav', NULL, 'Savings', 'savings', 'MYR', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO categories (id, name, kind, emoji, sort_order, is_system, is_archived, created_at, updated_at)
               VALUES ('food', 'Food', 'expense', '🍜', 0, 0, 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        );
        apply(MIGRATIONS[12].1);

        conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b1', 'food', '2026-10', 80000, '2026-10-01T00:00:00+00:00')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g1', 'Emergency', 'sav', 1000000, '2027-06-01', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).unwrap();
        assert!(conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b2', 'food', '2026-10', 1, '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "one version per category per month");
        assert!(conn.execute(
            "INSERT INTO category_budgets (id, category_id, effective_month, amount_cents, created_at)
             VALUES ('b3', 'food', '2026-11', -1, '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "amount cannot be negative");
        assert!(conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g2', 'Other', 'sav', 1, NULL, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "one goal per account");
        assert!(conn.execute(
            "INSERT INTO savings_goals (id, name, account_id, target_cents, target_date, created_at, updated_at)
             VALUES ('g3', 'Zero', 'sav', 0, NULL, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00')",
            [],
        ).is_err(), "target must be > 0");
    }
}
