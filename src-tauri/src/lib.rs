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
            commands::delete_category,
            commands::reorder_categories,
            commands::set_category_parent,
            commands::set_categories_archived,
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
            commands::reset_app,
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
        assert_eq!(service::list_account_templates(&c).unwrap().len(), 51); // +Luno, +Cash
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
    fn seeded_categories_can_be_archived() {
        let c = open_in_memory().unwrap();
        // After dropping is_system, every seeded category is archivable.
        let cat = service::list_categories(&c, None, false).unwrap().into_iter().next().unwrap();
        let updated = service::archive_category(&c, &cat.id).unwrap();
        assert!(updated.is_archived, "seeded category should archive successfully");
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
    fn spending_breakdown_rolls_subcategories_into_parent() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let food = service::create_category(&c, "Food P6", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        // one expense on the PARENT, one on the SUB — both should land in the parent bucket
        service::create_expense(&c, &a.id, &food.id, 1000, None, "2026-05-10").unwrap();
        service::create_expense(&c, &a.id, &coffee.id, 500, None, "2026-05-11").unwrap();

        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        let row = s.spending_breakdown.iter().find(|b| b.category_id == food.id).unwrap();
        assert_eq!(row.total_cents, 1500, "parent + sub spend rolled up");
        assert!(
            !s.spending_breakdown.iter().any(|b| b.category_id == coffee.id),
            "subcategory must not appear as its own bar"
        );
    }

    #[test]
    fn delete_category_rules() {
        let c = open_in_memory().unwrap();
        // Unused leaf category: deletes fine.
        let unused = service::create_category(&c, "Throwaway", "expense", "🗑️", None, None).unwrap();
        service::delete_category(&c, &unused.id).unwrap();
        assert!(service::list_categories(&c, None, true).unwrap().iter().all(|x| x.id != unused.id));

        // Parent with a child: blocked.
        let parent = service::create_category(&c, "Parent X", "expense", "📦", None, None).unwrap();
        let _child = service::create_category(&c, "Child X", "expense", "📦", None, Some(&parent.id)).unwrap();
        assert!(matches!(service::delete_category(&c, &parent.id), Err(AppError::Conflict(_))));

        // Category referenced by a transaction: blocked.
        let acc = service::create_account(&c, "Acc", "cash", 0, None).unwrap();
        let used = service::create_category(&c, "Used Cat", "expense", "💳", None, None).unwrap();
        service::create_expense(&c, &acc.id, &used.id, 1000, None, "2026-05-10").unwrap();
        assert!(matches!(service::delete_category(&c, &used.id), Err(AppError::Conflict(_))));
    }

    #[test]
    fn reorder_categories_sets_sort_order() {
        let c = open_in_memory().unwrap();
        let a = service::create_category(&c, "AA", "expense", "🅰️", None, None).unwrap();
        let b = service::create_category(&c, "BB", "expense", "🅱️", None, None).unwrap();
        // Put b before a.
        service::reorder_categories(&c, &[b.id.clone(), a.id.clone()]).unwrap();
        let a2 = service::list_categories(&c, None, true).unwrap().into_iter().find(|x| x.id == a.id).unwrap();
        let b2 = service::list_categories(&c, None, true).unwrap().into_iter().find(|x| x.id == b.id).unwrap();
        assert_eq!(b2.sort_order, 0);
        assert_eq!(a2.sort_order, 1);
    }

    #[test]
    fn set_category_parent_move_promote_demote() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food MP", "expense", "🍔", None, None).unwrap();
        let fun = service::create_category(&c, "Fun MP", "expense", "🎮", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee MP", "expense", "☕", None, Some(&food.id)).unwrap();

        // Move sub to another parent.
        let moved = service::set_category_parent(&c, &coffee.id, Some(&fun.id)).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(fun.id.as_str()));

        // Promote sub to top-level.
        let promoted = service::set_category_parent(&c, &coffee.id, None).unwrap();
        assert_eq!(promoted.parent_id, None);
        assert_eq!(promoted.kind, "expense");

        // Demote a childless top-level under another parent.
        let demoted = service::set_category_parent(&c, &coffee.id, Some(&food.id)).unwrap();
        assert_eq!(demoted.parent_id.as_deref(), Some(food.id.as_str()));
    }

    #[test]
    fn set_category_parent_rejects_invalid() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food R", "expense", "🍔", None, None).unwrap();
        let salary = service::create_category(&c, "Salary R", "income", "💰", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee R", "expense", "☕", None, Some(&food.id)).unwrap();

        // Cross-kind move rejected.
        assert!(matches!(service::set_category_parent(&c, &coffee.id, Some(&salary.id)), Err(AppError::Validation(_))));

        // Cannot demote a parent that still has children (use a same-kind target so the
        // children guard — not the cross-kind guard — is what rejects it).
        let dessert = service::create_category(&c, "Dessert R", "expense", "🍰", None, None).unwrap();
        assert!(matches!(service::set_category_parent(&c, &food.id, Some(&dessert.id)), Err(AppError::Validation(_))));

        // New parent must be top-level (not a subcategory).
        let snack = service::create_category(&c, "Snack R", "expense", "🍪", None, Some(&food.id)).unwrap();
        assert!(matches!(service::set_category_parent(&c, &snack.id, Some(&coffee.id)), Err(AppError::Validation(_))));
    }

    #[test]
    fn set_categories_archived_bulk_with_cascade() {
        let c = open_in_memory().unwrap();
        let food = service::create_category(&c, "Food B", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee B", "expense", "☕", None, Some(&food.id)).unwrap();
        let fun = service::create_category(&c, "Fun B", "expense", "🎮", None, None).unwrap();

        service::set_categories_archived(&c, &[food.id.clone(), fun.id.clone()], true).unwrap();
        let all = service::list_categories(&c, None, true).unwrap();
        assert!(all.iter().find(|x| x.id == food.id).unwrap().is_archived);
        assert!(all.iter().find(|x| x.id == fun.id).unwrap().is_archived);
        // Cascade archived the child too.
        assert!(all.iter().find(|x| x.id == coffee.id).unwrap().is_archived);

        service::set_categories_archived(&c, &[food.id.clone()], false).unwrap();
        let all = service::list_categories(&c, None, true).unwrap();
        assert!(!all.iter().find(|x| x.id == coffee.id).unwrap().is_archived);
    }

    #[test]
    fn seeds_subcategories_under_food() {
        let c = open_in_memory().unwrap();
        let all = service::list_categories(&c, Some("expense"), false).unwrap();
        let food = all.iter().find(|x| x.name == "Food" && x.parent_id.is_none()).unwrap();
        let coffee = all.iter().find(|x| x.name == "Coffee" && x.parent_id.as_deref() == Some(food.id.as_str()));
        assert!(coffee.is_some(), "expected a seeded 'Coffee' subcategory under Food");
        // A richer income top-level seeded by the default set.
        let inc = service::list_categories(&c, Some("income"), false).unwrap();
        assert!(inc.iter().any(|x| x.name == "Business" && x.parent_id.is_none()), "expected seeded 'Business' income category");
    }

    #[test]
    fn other_income_sorts_last() {
        let c = open_in_memory().unwrap();
        let income = service::list_categories(&c, Some("income"), false).unwrap();
        let pos = |name: &str| income.iter().position(|x| x.name == name).unwrap();
        assert!(
            pos("Other Income") > pos("Salary"),
            "Other Income must come after the named income categories by default"
        );
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

    #[test]
    fn reset_app_wipes_data_and_reseeds_defaults() {
        let c = open_in_memory().unwrap();
        // Arrange: an account, a transaction, and a custom category.
        let a = acct(&c, "Wallet", 10_000);
        let cat = expense_cat(&c);
        service::create_expense(&c, &a.id, &cat, 500, None, "2026-01-01").unwrap();
        service::create_category(&c, "Bespoke", "expense", "🦄", None, None).unwrap();
        let default_income = service::list_categories(&c, Some("income"), false).unwrap().len();

        // Act
        service::reset_app(&c).unwrap();

        // Assert: user data gone, defaults restored.
        assert!(service::list_accounts(&c, true).unwrap().is_empty(), "accounts wiped");
        assert!(
            service::list_transactions(&c, TransactionFilters::default()).unwrap().is_empty(),
            "transactions wiped"
        );
        let income = service::list_categories(&c, Some("income"), false).unwrap();
        assert_eq!(income.len(), default_income, "default income categories reseeded");
        assert!(
            !service::list_categories(&c, Some("expense"), true).unwrap().iter().any(|x| x.name == "Bespoke"),
            "custom category removed"
        );
    }
}
