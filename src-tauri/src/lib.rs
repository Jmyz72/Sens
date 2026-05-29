//! Sens backend entry point. Wires the SQLite connection into Tauri managed
//! state and registers the command surface.

mod commands;
mod db;
pub mod error;
mod models;
mod repo;
mod service;

use std::sync::Mutex;
use tauri::Manager;

/// Shared SQLite connection. Single-user desktop app, so one guarded
/// connection is sufficient.
pub struct DbState(pub Mutex<rusqlite::Connection>);

/// Current timestamp as an ISO 8601 string (backend is the source of truth).
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Today's date in the user's local time as `YYYY-MM-DD`.
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("could not create app data dir");
            let conn = db::open(&dir.join("sens.db")).expect("could not open database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_account_templates,
            commands::create_account_from_template,
            commands::create_custom_account,
            commands::list_accounts,
            commands::update_account,
            commands::archive_account,
            commands::restore_account,
            commands::set_account_balance,
            commands::list_categories,
            commands::create_category,
            commands::update_category,
            commands::archive_category,
            commands::restore_category,
            commands::create_income_transaction,
            commands::create_expense_transaction,
            commands::create_transfer_transaction,
            commands::list_transactions,
            commands::update_transaction,
            commands::delete_transaction,
            commands::get_dashboard_summary,
            commands::get_account_balance,
            commands::get_account_balances,
            commands::get_setting,
            commands::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sens");
}

#[cfg(test)]
mod tests {
    use crate::db::open_in_memory;
    use crate::models::*;
    use crate::service;

    fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
        service::create_custom_account(conn, name, "bank", "savings", opening).unwrap()
    }
    fn expense_cat(conn: &rusqlite::Connection) -> String {
        service::list_categories(conn, Some("expense"), false).unwrap()[0].id.clone()
    }
    fn income_cat(conn: &rusqlite::Connection) -> String {
        service::list_categories(conn, Some("income"), false).unwrap()[0].id.clone()
    }

    #[test]
    fn seeds_templates_and_categories() {
        let c = open_in_memory().unwrap();
        assert_eq!(service::list_account_templates(&c).unwrap().len(), 49);
        assert!(!service::list_categories(&c, Some("expense"), false).unwrap().is_empty());
    }

    #[test]
    fn create_account_from_template_derives_type() {
        let c = open_in_memory().unwrap();
        let a = service::create_account_from_template(&c, "maybank", "My Maybank", 10000).unwrap();
        assert_eq!(a.account_type, "bank");
        assert_eq!(a.balance_cents, 10000);
    }

    #[test]
    fn income_and_expense_affect_balance() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, &income_cat(&c), 5000, None, "2026-05-10").unwrap();
        service::create_expense(&c, &a.id, &expense_cat(&c), 2000, None, "2026-05-11").unwrap();
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), 3000);
    }

    #[test]
    fn transfer_moves_between_accounts() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 10000);
        let b = acct(&c, "Savings", 0);
        service::create_transfer(&c, &a.id, &b.id, 4000, None, "2026-05-10").unwrap();
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), 6000);
        assert_eq!(service::get_account_balance(&c, &b.id).unwrap(), 4000);
    }

    #[test]
    fn rejects_same_account_transfer() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 10000);
        assert!(service::create_transfer(&c, &a.id, &a.id, 1000, None, "2026-05-10").is_err());
    }

    #[test]
    fn rejects_archived_account_usage() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 1000);
        service::archive_account(&c, &a.id).unwrap();
        assert!(service::create_expense(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10").is_err());
    }

    #[test]
    fn category_kind_must_match() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        // expense category used for income → rejected
        assert!(service::create_income(&c, &a.id, &expense_cat(&c), 100, None, "2026-05-10").is_err());
    }

    #[test]
    fn balance_correction_no_txns_edits_opening() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 1000);
        let updated = service::set_account_balance(&c, &a.id, 5000).unwrap();
        assert_eq!(updated.opening_balance_cents, 5000);
        assert_eq!(updated.balance_cents, 5000);
    }

    #[test]
    fn balance_correction_with_txns_inserts_adjustment() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, &income_cat(&c), 3350_00, None, "2026-05-10").unwrap();
        let updated = service::set_account_balance(&c, &a.id, 3400_00).unwrap();
        assert_eq!(updated.opening_balance_cents, 0); // untouched
        assert_eq!(updated.balance_cents, 3400_00); // adjustment applied
    }

    #[test]
    fn adjustments_excluded_from_dashboard_income_expense() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, &income_cat(&c), 1000, None, "2026-05-10").unwrap();
        service::set_account_balance(&c, &a.id, 99999).unwrap(); // big adjustment this month
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.income_cents, 1000); // adjustment not counted as income
        assert_eq!(s.expense_cents, 0);
        assert_eq!(s.total_balance_cents, 99999); // but balance reflects it
    }

    #[test]
    fn dashboard_month_range_filters() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let ec = expense_cat(&c);
        service::create_expense(&c, &a.id, &ec, 500, None, "2026-05-15").unwrap();
        service::create_expense(&c, &a.id, &ec, 700, None, "2026-04-30").unwrap();
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.expense_cents, 500);
    }

    #[test]
    fn settings_roundtrip() {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "dashboard_month", "2026-05").unwrap();
        let v = service::get_setting(&c, "dashboard_month").unwrap();
        assert_eq!(v, Some("2026-05".to_string()));
    }

    #[test]
    fn settings_overwrite_updates_value() {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "dashboard_month", "2026-04").unwrap();
        service::set_setting(&c, "dashboard_month", "2026-05").unwrap();
        let v = service::get_setting(&c, "dashboard_month").unwrap();
        assert_eq!(v, Some("2026-05".to_string()));
    }

    #[test]
    fn settings_unknown_key_returns_none() {
        let c = open_in_memory().unwrap();
        let v = service::get_setting(&c, "nonexistent_key").unwrap();
        assert_eq!(v, None);
    }

    #[test]
    fn settings_key_is_trimmed() {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, " theme ", "dark").unwrap();
        assert_eq!(service::get_setting(&c, "theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn list_categories_can_include_archived() {
        let c = open_in_memory().unwrap();
        // Create a custom expense category and immediately archive it.
        let cat = service::create_category(&c, "Old Food", "expense", "🍔", None).unwrap();
        service::archive_category(&c, &cat.id).unwrap();

        // Without include_archived the category must not appear.
        let visible = service::list_categories(&c, None, false).unwrap();
        assert!(!visible.iter().any(|c| c.id == cat.id), "archived category should be hidden by default");

        // With include_archived it must appear.
        let all = service::list_categories(&c, None, true).unwrap();
        assert!(all.iter().any(|c| c.id == cat.id), "archived category should be visible when include_archived=true");

        // The kind filter must also work in combination with include_archived.
        let all_expense = service::list_categories(&c, Some("expense"), true).unwrap();
        assert!(all_expense.iter().any(|c| c.id == cat.id), "archived expense category should appear under kind filter with include_archived=true");
    }
}
