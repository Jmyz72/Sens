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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("could not create app data dir");
            let conn = db::open(&dir.join("sens.db")).expect("could not open database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_account_templates,
            commands::list_account_subtypes,
            commands::create_account,
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
    use crate::error::AppError;
    use crate::models::*;
    use crate::service;

    fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
        service::create_account(conn, name, "savings", opening, None).unwrap()
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
        assert_eq!(service::list_account_templates(&c).unwrap().len(), 50); // +Luno
        assert!(!service::list_categories(&c, Some("expense"), false).unwrap().is_empty());
    }

    #[test]
    fn create_account_derives_type_and_group() {
        let c = open_in_memory().unwrap();
        let a = service::create_account(&c, "My Maybank", "savings", 10000, Some("maybank")).unwrap();
        assert_eq!(a.account_type, "fund");
        assert_eq!(a.group, "own");
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
        assert_eq!(s.net_worth_cents, 99999); // but balance reflects it
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
    fn cannot_archive_system_category() {
        let c = open_in_memory().unwrap();
        // All seeded categories are is_system=1; pick the first one.
        let sys = service::list_categories(&c, None, false).unwrap().into_iter().next().unwrap();
        assert!(sys.is_system, "expected a system category");
        let result = service::archive_category(&c, &sys.id);
        assert!(result.is_err(), "archiving a system category should fail");
    }

    #[test]
    fn list_categories_can_include_archived() {
        let c = open_in_memory().unwrap();
        // Create a custom expense category and immediately archive it.
        let cat = service::create_category(&c, "Old Food", "expense", "🍔", None, None).unwrap();
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

    #[test]
    fn subcategory_inherits_parent_kind() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P2", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "income", "☕", None, Some(&food.id)).unwrap();
        // kind is derived from the parent, not the passed-in "income"
        assert_eq!(coffee.kind, "expense");
        assert_eq!(coffee.parent_id.as_deref(), Some(food.id.as_str()));
    }

    #[test]
    fn cannot_nest_subcategory_under_a_subcategory() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P3", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        let nested = service::create_category(&c, "Latte", "expense", "🥛", None, Some(&coffee.id));
        assert!(nested.is_err(), "two-level cap: cannot nest under a subcategory");
    }

    #[test]
    fn subcategory_names_unique_within_parent_only() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P4", "expense", "🍔", None, None).unwrap();
        let work = service::create_category(&c, "Work P4", "expense", "💼", None, None).unwrap();
        service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        // same name under a DIFFERENT parent is allowed
        service::create_category(&c, "Coffee", "expense", "☕", None, Some(&work.id)).unwrap();
        // duplicate under the SAME parent is rejected
        let dupe = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id));
        assert!(dupe.is_err(), "duplicate sibling name should conflict");
    }

    #[test]
    fn lists_sixteen_subtypes() {
        let c = open_in_memory().unwrap();
        assert_eq!(service::list_account_subtypes(&c).unwrap().len(), 16);
    }

    #[test]
    fn rejects_invalid_subtype() {
        let c = open_in_memory().unwrap();
        let err = service::create_account(&c, "Bad", "not-a-subtype", 0, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn owe_account_stores_signed_and_nets_worth() {
        let c = open_in_memory().unwrap();
        service::create_account(&c, "Cash", "cash", 30_000_00, None).unwrap();
        let card = service::create_account(&c, "CIMB Card", "credit-card", -5_000_00, None).unwrap();
        assert_eq!(card.group, "owe");
        let d = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(d.assets_cents, 30_000_00);
        assert_eq!(d.liabilities_cents, -5_000_00);
        assert_eq!(d.net_worth_cents, 25_000_00);
    }

    #[test]
    fn archiving_parent_cascades_to_children_and_restores_them() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food P5", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();

        service::archive_category(&c, &food.id).unwrap();
        let archived = service::list_categories(&c, None, true).unwrap();
        let child = archived.iter().find(|x| x.id == coffee.id).unwrap();
        assert!(child.is_archived, "child should be archived with its parent");

        service::restore_category(&c, &food.id).unwrap();
        let restored = service::list_categories(&c, None, true).unwrap();
        let child2 = restored.iter().find(|x| x.id == coffee.id).unwrap();
        assert!(!child2.is_archived, "child should be restored with its parent");
    }

    #[test]
    fn account_with_unknown_subtype_still_lists() {
        // An account whose subtype isn't in the taxonomy (e.g. a future rename or
        // a direct DB edit) must stay visible via the LEFT JOIN + COALESCE fallback,
        // not silently vanish. Insert one directly to bypass service validation.
        let c = open_in_memory().unwrap();
        c.execute(
            "INSERT INTO accounts (id, template_key, name, subtype, opening_balance_cents, currency, is_archived, created_at, updated_at)
             VALUES ('orphan', NULL, 'Mystery', 'gone-subtype', 100, 'MYR', 0, 't', 't')",
            [],
        )
        .unwrap();
        let all = service::list_accounts(&c, true).unwrap();
        let a = all.iter().find(|x| x.id == "orphan").expect("orphan account should still appear");
        assert_eq!(a.account_type, "fund"); // COALESCE fallback type
        assert_eq!(a.group, "own"); // COALESCE fallback group
        // get_account must resolve (not a misleading NotFound) and net worth includes it.
        assert_eq!(service::get_account_balance(&c, "orphan").unwrap(), 100);
        assert_eq!(service::get_dashboard_summary(&c, "2026-05").unwrap().net_worth_cents, 100);
    }
}
