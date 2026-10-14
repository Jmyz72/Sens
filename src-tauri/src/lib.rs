//! Sens backend entry point. Wires the SQLite connection into Tauri managed
//! state and registers the command surface.

mod apportion;
mod commands;
mod db;
pub mod error;
mod models;
mod recurrence;
mod repo;
mod schedules;
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
            commands::update_net_worth,
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
            commands::create_payment_transaction,
            commands::create_reimbursement_transaction,
            commands::update_reimbursement_transaction,
            commands::set_expected_reimbursement,
            commands::list_transactions,
            commands::update_transaction,
            commands::delete_transaction,
            commands::get_dashboard_summary,
            commands::get_account_balance,
            commands::get_account_balances,
            commands::get_awaiting_reimbursement,
            commands::get_plan,
            commands::set_budgets,
            commands::create_goal,
            commands::update_goal,
            commands::delete_goal,
            commands::get_setting,
            commands::set_setting,
            commands::reset_app,
            commands::create_schedule,
            commands::update_schedule,
            commands::delete_schedule,
            commands::list_schedules,
            commands::list_upcoming,
            commands::post_occurrence,
            commands::skip_occurrence,
            commands::run_schedule_pass,
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

    fn test_db() -> rusqlite::Connection {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
        service::create_account(conn, name, "savings", opening, None, None, None, None).unwrap()
    }
    fn validation_message(err: AppError) -> String {
        match err {
            AppError::Validation(m) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }
    fn expense_cat(conn: &rusqlite::Connection) -> String {
        service::list_categories(conn, Some("expense"), false).unwrap()[0].id.clone()
    }
    fn income_cat(conn: &rusqlite::Connection) -> String {
        service::list_categories(conn, Some("income"), false)
            .unwrap()
            .into_iter()
            .find(|cat| !cat.is_system && cat.parent_id.is_none())
            .unwrap()
            .id
    }
    fn nth_expense_category_id(conn: &rusqlite::Connection, n: i64) -> String {
        conn.query_row(
            "SELECT id FROM categories WHERE kind='expense' AND is_system=0 ORDER BY sort_order LIMIT 1 OFFSET ?1",
            [n],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn migration_009_creates_splits_table() {
        let conn = open_in_memory().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='transaction_splits'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_014_adds_value_category_columns() {
        let c = test_db();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('accounts') WHERE name IN ('gain_category_id', 'loss_category_id')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
        let acc = service::create_account(&c, "Stash", "investment", 10_000, None, None, None, None).unwrap();
        assert_eq!(acc.gain_category_id, None);
        assert_eq!(acc.loss_category_id, None);
    }

    #[test]
    fn migration_015_creates_schedule_tables() {
        let c = test_db();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('schedules', 'schedule_occurrences')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    fn value_pair(gain: Option<&str>, loss: Option<&str>) -> ValueCategories {
        ValueCategories {
            gain_category_id: gain.map(str::to_string),
            loss_category_id: loss.map(str::to_string),
        }
    }

    #[test]
    fn create_investment_saves_gain_and_loss_categories() {
        let c = test_db();
        let gain = income_cat(&c);
        let loss = expense_cat(&c);
        let acc = service::create_account(&c, "Stash", "investment", 10_000, None, None, Some(&gain), Some(&loss)).unwrap();
        assert_eq!(acc.gain_category_id.as_deref(), Some(gain.as_str()));
        assert_eq!(acc.loss_category_id.as_deref(), Some(loss.as_str()));
    }

    #[test]
    fn create_savings_rejects_a_value_category() {
        let c = test_db();
        let gain = income_cat(&c);
        let err = service::create_account(&c, "Cash", "savings", 0, None, None, Some(&gain), None).unwrap_err();
        assert_eq!(
            validation_message(err),
            "Gain and loss categories only apply to fixed deposits, investments, unit trusts, and crypto."
        );
    }

    #[test]
    fn gain_category_must_be_income_and_not_system() {
        let c = test_db();
        let expense = expense_cat(&c);
        let err = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&expense), None).unwrap_err();
        assert_eq!(validation_message(err), "Gain category must be an income category.");
        let system = service::list_categories(&c, Some("income"), true).unwrap()
            .into_iter().find(|cat| cat.is_system).unwrap();
        let err = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&system.id), None).unwrap_err();
        assert_eq!(validation_message(err), "That category can't be selected.");
    }

    #[test]
    fn loss_category_must_be_expense() {
        let c = test_db();
        let income = income_cat(&c);
        let err = service::create_account(&c, "UT", "unit-trust", 0, None, None, None, Some(&income)).unwrap_err();
        assert_eq!(validation_message(err), "Loss category must be an expense category.");
    }

    #[test]
    fn edit_can_set_clear_and_keep_value_categories() {
        let c = test_db();
        let gain = income_cat(&c);
        let loss = expense_cat(&c);
        let acc = service::create_account(&c, "Luno", "crypto", 0, None, None, None, None).unwrap();
        let set = service::update_account(&c, UpdateAccountInput {
            id: acc.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: None,
            value_categories: Some(value_pair(Some(&gain), Some(&loss))),
        }).unwrap();
        assert_eq!(set.gain_category_id.as_deref(), Some(gain.as_str()));
        let kept = service::update_account(&c, UpdateAccountInput {
            id: acc.id.clone(), name: Some("Luno 2".into()), subtype: None, opening_balance_cents: None,
            credit_limit_cents: None, value_categories: None,
        }).unwrap();
        assert_eq!(kept.gain_category_id.as_deref(), Some(gain.as_str()));
        assert_eq!(kept.loss_category_id.as_deref(), Some(loss.as_str()));
        let cleared = service::update_account(&c, UpdateAccountInput {
            id: acc.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: None,
            value_categories: Some(value_pair(None, Some(&loss))),
        }).unwrap();
        assert_eq!(cleared.gain_category_id, None);
        assert_eq!(cleared.loss_category_id.as_deref(), Some(loss.as_str()));
    }

    #[test]
    fn leaving_the_four_subtypes_clears_value_categories() {
        let c = test_db();
        let gain = income_cat(&c);
        let acc = service::create_account(&c, "FD", "fixed-deposit", 0, None, None, Some(&gain), None).unwrap();
        let cleared = service::update_account(&c, UpdateAccountInput {
            id: acc.id.clone(), name: None, subtype: Some("savings".into()), opening_balance_cents: None,
            credit_limit_cents: None, value_categories: None,
        }).unwrap();
        assert_eq!(cleared.subtype, "savings");
        assert_eq!(cleared.gain_category_id, None);
    }

    #[test]
    fn subcategory_and_archived_category_can_be_saved() {
        let c = test_db();
        let parent = income_cat(&c);
        let child = service::create_category(&c, "Dividends", "income", "💸", None, Some(&parent)).unwrap();
        let archived = service::create_category(&c, "Old loss", "expense", "📉", None, None).unwrap();
        service::archive_category(&c, &archived.id).unwrap();
        let acc = service::create_account(&c, "Broker", "investment", 0, None, None, Some(&child.id), Some(&archived.id)).unwrap();
        assert_eq!(acc.gain_category_id.as_deref(), Some(child.id.as_str()));
        assert_eq!(acc.loss_category_id.as_deref(), Some(archived.id.as_str()));
    }

    #[test]
    fn splits_insert_and_hydrate() {
        use crate::repo;
        let conn = open_in_memory().unwrap();
        let acc = service::create_account(&conn, "Checking", "cash", 0, None, None, None, None).unwrap();
        let cat_a = nth_expense_category_id(&conn, 0);
        let cat_b = nth_expense_category_id(&conn, 1);
        let now = "2026-06-06T00:00:00Z";
        let t = repo::insert_transaction(
            &conn, "tx1", "expense", &acc.id, None, Some(&cat_a), 15000, Some("Lotus"), "2026-06-06", None, false, now,
        )
        .unwrap();
        repo::insert_split(&conn, "s1", &t.id, &cat_a, 10000, 0, now).unwrap();
        repo::insert_split(&conn, "s2", &t.id, &cat_b, 5000, 1, now).unwrap();
        let got = repo::get_transaction(&conn, &t.id).unwrap();
        assert_eq!(got.splits.len(), 2);
        assert_eq!(got.splits.iter().map(|s| s.amount_cents).sum::<i64>(), 15000);
    }

    #[test]
    fn create_split_expense_sums_and_attributes() {
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let b = nth_expense_category_id(&conn, 1);
        let splits = vec![
            SplitInput { category_id: a.clone(), amount_cents: 10000 },
            SplitInput { category_id: b.clone(), amount_cents: 5000 },
        ];
        let t = service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-06", None, false, Some(splits)).unwrap();
        assert_eq!(t.category_id.as_deref(), Some(a.as_str())); // header = first split's category
        assert_eq!(t.splits.len(), 2);
        assert_eq!(t.amount_cents, 15000);
        // Balance is impacted by the full total via the header postings.
        assert_eq!(service::get_account_balance(&conn, &acc.id).unwrap(), -15000);
    }

    #[test]
    fn create_split_rejects_sum_mismatch() {
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let b = nth_expense_category_id(&conn, 1);
        let splits = vec![
            SplitInput { category_id: a, amount_cents: 10000 },
            SplitInput { category_id: b, amount_cents: 4000 },
        ];
        let err = service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-06", None, false, Some(splits)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn create_split_rejects_single_line() {
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let splits = vec![SplitInput { category_id: a, amount_cents: 15000 }];
        let err = service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-06", None, false, Some(splits)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn update_single_to_split_and_back() {
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let b = nth_expense_category_id(&conn, 1);
        let t = service::create_expense(&conn, &acc.id, Some(&a), 15000, None, "2026-06-06", None, false, None).unwrap();
        // single -> split
        let upd = UpdateTransactionInput {
            id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(), to_account_id: None,
            category_id: None, amount_cents: 15000, description: None, transaction_date: "2026-06-06".into(),
            transaction_time: None, excluded_from_reporting: false,
            splits: Some(vec![
                SplitInput { category_id: a.clone(), amount_cents: 9000 },
                SplitInput { category_id: b.clone(), amount_cents: 6000 },
            ]),
        };
        let t2 = service::update_transaction(&conn, upd).unwrap();
        assert_eq!(t2.splits.len(), 2);
        assert_eq!(t2.category_id.as_deref(), Some(a.as_str())); // header = first split
        // split -> single
        let upd2 = UpdateTransactionInput {
            id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(), to_account_id: None,
            category_id: Some(a.clone()), amount_cents: 15000, description: None, transaction_date: "2026-06-06".into(),
            transaction_time: None, excluded_from_reporting: false, splits: None,
        };
        let t3 = service::update_transaction(&conn, upd2).unwrap();
        assert_eq!(t3.splits.len(), 0);
        assert_eq!(t3.category_id.as_deref(), Some(a.as_str()));
    }

    #[test]
    fn breakdown_attributes_split_lines() {
        use crate::repo;
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let b = nth_expense_category_id(&conn, 1);
        service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-10", None, false,
            Some(vec![
                SplitInput { category_id: a.clone(), amount_cents: 10000 },
                SplitInput { category_id: b.clone(), amount_cents: 5000 },
            ])).unwrap();
        let rows = repo::spending_breakdown(&conn, "2026-06-01", "2026-07-01").unwrap();
        let total: i64 = rows.iter().map(|r| r.total_cents).sum();
        assert_eq!(total, 15000); // exactly the split total, header NOT double-counted
        assert!(rows.iter().any(|r| r.total_cents == 10000));
        assert!(rows.iter().any(|r| r.total_cents == 5000));
    }

    #[test]
    fn category_count_includes_split_refs() {
        use crate::repo;
        let conn = test_db();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let a = nth_expense_category_id(&conn, 0);
        let b = nth_expense_category_id(&conn, 1);
        service::create_expense(&conn, &acc.id, None, 15000, None, "2026-06-10", None, false,
            Some(vec![
                SplitInput { category_id: a.clone(), amount_cents: 10000 },
                SplitInput { category_id: b.clone(), amount_cents: 5000 },
            ])).unwrap();
        assert!(repo::count_transactions_for_category(&conn, &a).unwrap() >= 1);
        assert!(repo::count_transactions_for_category(&conn, &b).unwrap() >= 1);
    }

    #[test]
    fn seeds_templates_and_categories() {
        let c = test_db();
        assert_eq!(service::list_account_templates(&c).unwrap().len(), 51); // +Luno, +Cash
        assert!(!service::list_categories(&c, Some("expense"), false).unwrap().is_empty());
    }

    #[test]
    fn create_account_derives_type_and_group() {
        let c = test_db();
        let a = service::create_account(&c, "My Maybank", "savings", 10000, Some("maybank"), None, None, None).unwrap();
        assert_eq!(a.account_type, "fund");
        assert_eq!(a.group, "own");
        assert_eq!(a.balance_cents, 10000);
    }

    #[test]
    fn income_and_expense_affect_balance() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, Some(&income_cat(&c)), 5000, None, "2026-05-10", None, false, None).unwrap();
        service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 2000, None, "2026-05-11", None, false, None).unwrap();
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), 3000);
    }

    #[test]
    fn transfer_moves_between_accounts() {
        let c = test_db();
        let a = acct(&c, "Checking", 10000);
        let b = acct(&c, "Savings", 0);
        service::create_transfer(&c, &a.id, &b.id, 4000, None, "2026-05-10", None).unwrap();
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), 6000);
        assert_eq!(service::get_account_balance(&c, &b.id).unwrap(), 4000);
    }

    #[test]
    fn rejects_same_account_transfer() {
        let c = test_db();
        let a = acct(&c, "Checking", 10000);
        assert!(service::create_transfer(&c, &a.id, &a.id, 1000, None, "2026-05-10", None).is_err());
    }

    #[test]
    fn rejects_archived_account_usage() {
        let c = test_db();
        let a = acct(&c, "Checking", 1000);
        service::archive_account(&c, &a.id).unwrap();
        assert!(service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", None, false, None).is_err());
    }

    #[test]
    fn category_kind_must_match() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        // expense category used for income → rejected
        assert!(service::create_income(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", None, false, None).is_err());
    }

    #[test]
    fn balance_correction_no_txns_edits_opening() {
        let c = test_db();
        let a = acct(&c, "Checking", 1000);
        let updated = service::set_account_balance(&c, &a.id, 5000, false).unwrap();
        assert_eq!(updated.opening_balance_cents, 5000);
        assert_eq!(updated.balance_cents, 5000);
    }

    #[test]
    fn balance_correction_with_txns_inserts_adjustment() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, Some(&income_cat(&c)), 3350_00, None, "2026-05-10", None, false, None).unwrap();
        let updated = service::set_account_balance(&c, &a.id, 3400_00, false).unwrap();
        assert_eq!(updated.opening_balance_cents, 0); // untouched
        assert_eq!(updated.balance_cents, 3400_00); // adjustment applied
    }

    #[test]
    fn create_account_inserts_one_opening_transaction() {
        let c = test_db();
        let a = acct(&c, "Checking", 10000);
        let txns = service::list_transactions(&c, TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() }).unwrap();
        let openings: Vec<_> = txns.iter().filter(|t| t.kind == "opening").collect();
        assert_eq!(openings.len(), 1, "exactly one opening transaction");
        assert_eq!(openings[0].amount_cents, 10000);
        assert_eq!(a.opening_balance_cents, 10000); // derived
        assert_eq!(a.balance_cents, 10000);
    }

    #[test]
    fn owe_account_opening_is_negative() {
        let c = test_db();
        let a = service::create_account(&c, "Visa", "credit-card", -50000, None, Some(1_000_000), None, None).unwrap();
        assert_eq!(a.group, "owe");
        assert_eq!(a.balance_cents, -50000);
        assert_eq!(service::get_dashboard_summary(&c, "2026-05").unwrap().liabilities_cents, -50000);
    }

    #[test]
    fn excluded_income_and_expense_skip_the_dashboard() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, Some(&income_cat(&c)), 5000, None, "2026-05-10", None, false, None).unwrap();
        service::create_income(&c, &a.id, Some(&income_cat(&c)), 1200, None, "2026-05-11", None, true, None).unwrap();
        service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 700, None, "2026-05-12", None, false, None).unwrap();
        service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 300, None, "2026-05-13", None, true, None).unwrap();
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.income_cents, 5000, "flagged income excluded");
        assert_eq!(s.expense_cents, 700, "flagged expense excluded");
        assert_eq!(s.net_worth_cents, 5200); // 0 +5000 +1200 -700 -300
    }

    #[test]
    fn toggling_excluded_from_reporting_reclassifies_in_dashboard() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        let tx = service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 800, None, "2026-05-12", None, false, None).unwrap();
        assert_eq!(service::get_dashboard_summary(&c, "2026-05").unwrap().expense_cents, 800);
        // Flip it to money movement via update_transaction → it drops out of the dashboard.
        let updated = service::update_transaction(&c, UpdateTransactionInput {
            id: tx.id.clone(), kind: "expense".into(), account_id: a.id.clone(),
            to_account_id: None, category_id: tx.category_id.clone(), amount_cents: 800,
            description: Some("Reimbursement".into()), transaction_date: "2026-05-12".into(),
            transaction_time: None, excluded_from_reporting: true, splits: None,
        }).unwrap();
        assert!(updated.excluded_from_reporting);
        assert_eq!(service::get_dashboard_summary(&c, "2026-05").unwrap().expense_cents, 0);
        // Balance is unaffected by the flag.
        assert_eq!(service::get_account_balance(&c, &a.id).unwrap(), -800);
    }

    #[test]
    fn check_rejects_flag_on_non_income_expense() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        let b = acct(&c, "Savings", 0);
        let res = c.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
             VALUES ('x', 'transfer', ?1, ?2, NULL, 100, NULL, '2026-05-10', 1, 't', 't')",
            rusqlite::params![a.id, b.id],
        );
        assert!(res.is_err(), "flag on a transfer must be rejected by the CHECK");
    }

    #[test]
    fn editing_opening_balance_moves_the_balance_without_new_rows() {
        let c = test_db();
        let a = acct(&c, "Checking", 1000);
        let updated = service::update_account(&c, UpdateAccountInput {
            id: a.id.clone(), name: None, subtype: None, opening_balance_cents: Some(7500), credit_limit_cents: None,
            value_categories: None,
        }).unwrap();
        assert_eq!(updated.opening_balance_cents, 7500);
        assert_eq!(updated.balance_cents, 7500);
        let txns = service::list_transactions(&c, TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() }).unwrap();
        assert_eq!(txns.iter().filter(|t| t.kind == "opening").count(), 1, "still exactly one opening row");
        assert_eq!(txns.len(), 1, "no extra rows created");
    }

    #[test]
    fn opening_transaction_cannot_be_edited_or_deleted() {
        let c = test_db();
        let a = acct(&c, "Checking", 1000);
        let opening = service::list_transactions(&c, TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() })
            .unwrap().into_iter().find(|t| t.kind == "opening").unwrap();
        // delete is rejected
        assert!(service::delete_transaction(&c, &opening.id).is_err(), "opening cannot be deleted");
        // editing it (even keeping kind=opening) is rejected
        let edit = UpdateTransactionInput {
            id: opening.id.clone(), kind: "opening".into(), account_id: a.id.clone(),
            to_account_id: None, category_id: None, amount_cents: 9999,
            description: None, transaction_date: "2026-05-01".into(), transaction_time: None, excluded_from_reporting: false, splits: None,
        };
        assert!(service::update_transaction(&c, edit).is_err(), "opening cannot be edited");
        // it is unchanged
        let still = service::get_account_balance(&c, &a.id).unwrap();
        assert_eq!(still, 1000);
    }

    #[test]
    fn migration_007_adds_nullable_time_column() {
        let c = test_db();
        // Column exists and defaults to NULL for rows created without a time.
        let a = acct(&c, "Checking", 1000);
        let txns = service::list_transactions(
            &c,
            TransactionFilters { account_id: Some(a.id.clone()), ..Default::default() },
        )
        .unwrap();
        assert!(txns.iter().all(|t| t.transaction_time.is_none()));
        // The postings backfilled by migration 006 survive (no cascade delete).
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0))
            .unwrap();
        assert!(n >= 2, "opening transaction still has its two postings");
    }

    fn enable_time(conn: &rusqlite::Connection) {
        service::set_setting(conn, "transaction_time_enabled", "1").unwrap();
    }

    #[test]
    fn missing_time_setting_requires_a_time() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let err = service::create_expense(
            &c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", None, false, None,
        ).unwrap_err();
        assert_eq!(validation_message(err), "A time is required");
        let t = service::create_expense(
            &c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("09:00"), false, None,
        ).unwrap();
        assert_eq!(t.transaction_time.as_deref(), Some("09:00"));
    }

    #[test]
    fn time_required_when_setting_on() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        enable_time(&c);
        assert!(service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", None, false, None).is_err());
        let t = service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("08:15"), false, None).unwrap();
        assert_eq!(t.transaction_time.as_deref(), Some("08:15"));
        assert!(service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("8:1"), false, None).is_err());
        assert!(service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("25:00"), false, None).is_err());
    }

    #[test]
    fn time_ignored_when_setting_off() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        let t = service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("08:15"), false, None).unwrap();
        assert_eq!(t.transaction_time, None);
    }

    #[test]
    fn update_preserves_time_when_setting_off() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        enable_time(&c);
        let t = service::create_expense(&c, &a.id, Some(&expense_cat(&c)), 100, None, "2026-05-10", Some("08:15"), false, None).unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        let updated = service::update_transaction(&c, UpdateTransactionInput {
            id: t.id.clone(), kind: "expense".into(), account_id: a.id.clone(), to_account_id: None,
            category_id: Some(expense_cat(&c)), amount_cents: 200, description: None,
            transaction_date: "2026-05-10".into(), transaction_time: None, excluded_from_reporting: false, splits: None,
        }).unwrap();
        assert_eq!(updated.transaction_time.as_deref(), Some("08:15"));
    }

    #[test]
    fn adjustments_excluded_from_dashboard_income_expense() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        service::create_income(&c, &a.id, Some(&income_cat(&c)), 1000, None, "2026-05-10", None, false, None).unwrap();
        service::set_account_balance(&c, &a.id, 99999, false).unwrap(); // big adjustment this month
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.income_cents, 1000); // adjustment not counted as income
        assert_eq!(s.expense_cents, 0);
        assert_eq!(s.net_worth_cents, 99999); // but balance reflects it
    }

    #[test]
    fn dashboard_month_range_filters() {
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        let ec = expense_cat(&c);
        service::create_expense(&c, &a.id, Some(&ec), 500, None, "2026-05-15", None, false, None).unwrap();
        service::create_expense(&c, &a.id, Some(&ec), 700, None, "2026-04-30", None, false, None).unwrap();
        let s = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(s.expense_cents, 500);
    }

    #[test]
    fn settings_roundtrip() {
        let c = test_db();
        service::set_setting(&c, "dashboard_month", "2026-05").unwrap();
        let v = service::get_setting(&c, "dashboard_month").unwrap();
        assert_eq!(v, Some("2026-05".to_string()));
    }

    #[test]
    fn settings_overwrite_updates_value() {
        let c = test_db();
        service::set_setting(&c, "dashboard_month", "2026-04").unwrap();
        service::set_setting(&c, "dashboard_month", "2026-05").unwrap();
        let v = service::get_setting(&c, "dashboard_month").unwrap();
        assert_eq!(v, Some("2026-05".to_string()));
    }

    #[test]
    fn settings_unknown_key_returns_none() {
        let c = test_db();
        let v = service::get_setting(&c, "nonexistent_key").unwrap();
        assert_eq!(v, None);
    }

    #[test]
    fn settings_key_is_trimmed() {
        let c = test_db();
        service::set_setting(&c, " theme ", "dark").unwrap();
        assert_eq!(service::get_setting(&c, "theme").unwrap(), Some("dark".to_string()));
    }

    #[test]
    fn seeded_categories_can_be_archived() {
        let c = test_db();
        // After dropping is_system, every seeded category is archivable.
        let cat = service::list_categories(&c, None, false).unwrap().into_iter().next().unwrap();
        let updated = service::archive_category(&c, &cat.id).unwrap();
        assert!(updated.is_archived, "seeded category should archive successfully");
    }

    #[test]
    fn list_categories_can_include_archived() {
        let c = test_db();
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
        let c = test_db();
        let food = service::create_category(&c, "Food P2", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "income", "☕", None, Some(&food.id)).unwrap();
        // kind is derived from the parent, not the passed-in "income"
        assert_eq!(coffee.kind, "expense");
        assert_eq!(coffee.parent_id.as_deref(), Some(food.id.as_str()));
    }

    #[test]
    fn cannot_nest_subcategory_under_a_subcategory() {
        let c = test_db();
        let food = service::create_category(&c, "Food P3", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        let nested = service::create_category(&c, "Latte", "expense", "🥛", None, Some(&coffee.id));
        assert!(nested.is_err(), "two-level cap: cannot nest under a subcategory");
    }

    #[test]
    fn subcategory_names_unique_within_parent_only() {
        let c = test_db();
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
        let c = test_db();
        assert_eq!(service::list_account_subtypes(&c).unwrap().len(), 16);
    }

    #[test]
    fn rejects_invalid_subtype() {
        let c = test_db();
        let err = service::create_account(&c, "Bad", "not-a-subtype", 0, None, None, None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn owe_account_stores_signed_and_nets_worth() {
        let c = test_db();
        service::create_account(&c, "Cash", "cash", 30_000_00, None, None, None, None).unwrap();
        let card = service::create_account(&c, "CIMB Card", "credit-card", -5_000_00, None, Some(1_000_000), None, None).unwrap();
        assert_eq!(card.group, "owe");
        let d = service::get_dashboard_summary(&c, "2026-05").unwrap();
        assert_eq!(d.assets_cents, 30_000_00);
        assert_eq!(d.liabilities_cents, -5_000_00);
        assert_eq!(d.net_worth_cents, 25_000_00);
    }

    #[test]
    fn archiving_parent_cascades_to_children_and_restores_them() {
        let c = test_db();
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
        let c = test_db();
        let a = acct(&c, "Checking", 0);
        let food = service::create_category(&c, "Food P6", "expense", "🍔", None, None).unwrap();
        let coffee = service::create_category(&c, "Coffee", "expense", "☕", None, Some(&food.id)).unwrap();
        // one expense on the PARENT, one on the SUB — both should land in the parent bucket
        service::create_expense(&c, &a.id, Some(&food.id), 1000, None, "2026-05-10", None, false, None).unwrap();
        service::create_expense(&c, &a.id, Some(&coffee.id), 500, None, "2026-05-11", None, false, None).unwrap();

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
        let c = test_db();
        // Unused leaf category: deletes fine.
        let unused = service::create_category(&c, "Throwaway", "expense", "🗑️", None, None).unwrap();
        service::delete_category(&c, &unused.id).unwrap();
        assert!(service::list_categories(&c, None, true).unwrap().iter().all(|x| x.id != unused.id));

        // Parent with a child: blocked.
        let parent = service::create_category(&c, "Parent X", "expense", "📦", None, None).unwrap();
        let _child = service::create_category(&c, "Child X", "expense", "📦", None, Some(&parent.id)).unwrap();
        assert!(matches!(service::delete_category(&c, &parent.id), Err(AppError::Conflict(_))));

        // Category referenced by a transaction: blocked.
        let acc = service::create_account(&c, "Acc", "cash", 0, None, None, None, None).unwrap();
        let used = service::create_category(&c, "Used Cat", "expense", "💳", None, None).unwrap();
        service::create_expense(&c, &acc.id, Some(&used.id), 1000, None, "2026-05-10", None, false, None).unwrap();
        assert!(matches!(service::delete_category(&c, &used.id), Err(AppError::Conflict(_))));
    }

    #[test]
    fn deleting_an_unused_saved_category_clears_the_account() {
        let c = test_db();
        let gain = service::create_category(&c, "Growth", "income", "📈", None, None).unwrap();
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain.id), None).unwrap();
        service::delete_category(&c, &gain.id).unwrap();
        let after = service::get_account(&c, &acc.id).unwrap();
        assert_eq!(after.gain_category_id, None);
    }

    #[test]
    fn reorder_categories_sets_sort_order() {
        let c = test_db();
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
        let c = test_db();
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
        let c = test_db();
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
    fn cannot_reparent_under_system_category() {
        let c = test_db();
        let sys_id: String = c
            .query_row(
                "SELECT id FROM categories WHERE is_system=1 AND kind='expense' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Create a normal top-level expense leaf to attempt moving under the system category.
        let leaf =
            service::create_category(&c, "Temp Leaf", "expense", "🧪", None, None).unwrap();
        assert!(
            service::set_category_parent(&c, &leaf.id, Some(&sys_id)).is_err(),
            "must not allow reparenting under a system category"
        );
    }

    #[test]
    fn set_categories_archived_bulk_with_cascade() {
        let c = test_db();
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
        let c = test_db();
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
        let c = test_db();
        let income = service::list_categories(&c, Some("income"), false).unwrap();
        let pos = |name: &str| income.iter().position(|x| x.name == name).unwrap();
        assert!(
            pos("Other Income") > pos("Salary"),
            "Other Income must come after the named income categories by default"
        );
    }

    #[test]
    fn system_categories_are_protected() {
        let c = crate::db::open_in_memory().unwrap();
        let sys_id: String = c
            .query_row(
                "SELECT id FROM categories WHERE is_system = 1 AND kind = 'expense' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(crate::service::delete_category(&c, &sys_id).is_err(), "delete must be blocked");
        let upd = crate::models::UpdateCategoryInput { id: sys_id.clone(), name: Some("Renamed".into()), emoji: None, color: None, sort_order: None };
        assert!(crate::service::update_category(&c, upd).is_err(), "rename must be blocked");
        assert!(crate::service::archive_category(&c, &sys_id).is_err(), "archive must be blocked");
        assert!(crate::service::set_category_parent(&c, &sys_id, None).is_err(), "reparent must be blocked");
    }

    #[test]
    fn account_with_unknown_subtype_still_lists() {
        // An account whose subtype isn't in the taxonomy (e.g. a future rename or
        // a direct DB edit) must stay visible via the LEFT JOIN + COALESCE fallback,
        // not silently vanish. Insert one directly to bypass service validation.
        let c = test_db();
        c.execute(
            "INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at)
             VALUES ('orphan', NULL, 'Mystery', 'gone-subtype', 'MYR', 0, 't', 't')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
             VALUES ('orphan-open', 'opening', 'orphan', NULL, NULL, 100, 'Opening balance', '2026-05-01', 0, 't', 't')",
            [],
        )
        .unwrap();
        // Postings required so balance_expr (now postings-based) returns 100.
        c.execute(
            "INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('orphan-p1', 'orphan-open', 'orphan', NULL, 100)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('orphan-p2', 'orphan-open', NULL, 'equity', -100)",
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
    fn migration_006_backfills_balanced_postings() {
        use rusqlite::Connection;
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Run migrations 1..=5 only — a pre-postings database.
        for (v, sql) in crate::db::migrations::MIGRATIONS {
            if *v <= 5 {
                c.execute_batch(sql).unwrap();
            }
        }
        // Minimal fixture: two accounts (subtypes 'cash'/'savings' seeded by migration 002),
        // one expense category, and one of each money-moving kind.
        let now = "2026-01-01T00:00:00Z";
        c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
                   VALUES ('a1', NULL, 'Cash', 'cash', 'MYR', 0, ?1, ?1)", [now]).unwrap();
        c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
                   VALUES ('a2', NULL, 'Bank', 'savings', 'MYR', 0, ?1, ?1)", [now]).unwrap();
        c.execute("INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at) \
                   VALUES ('cx', 'Food', 'expense', '🍜', NULL, NULL, 0, 0, ?1, ?1)", [now]).unwrap();
        c.execute("INSERT INTO categories (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at) \
                   VALUES ('ci', 'Salary', 'income', '💰', NULL, NULL, 0, 0, ?1, ?1)", [now]).unwrap();
        let ins = |id: &str, kind: &str, acc: &str, to: Option<&str>, cat: Option<&str>, amt: i64| {
            c.execute(
                "INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '2026-01-02', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![id, kind, acc, to, cat, amt],
            ).unwrap();
        };
        ins("t_open", "opening", "a1", None, None, 10_000);
        ins("t_inc", "income", "a1", None, Some("ci"), 5_000);
        ins("t_exp", "expense", "a1", None, Some("cx"), 2_000);
        ins("t_xfer", "transfer", "a1", Some("a2"), None, 1_000);
        ins("t_adj", "adjustment", "a1", None, None, -500);

        // Run migration 006.
        let (_, sql6) = crate::db::migrations::MIGRATIONS.iter().find(|(v, _)| *v == 6).unwrap();
        c.execute_batch(sql6).unwrap();

        // Every transaction's postings sum to zero.
        let unbalanced: i64 = c.query_row(
            "SELECT COUNT(*) FROM (SELECT transaction_id, SUM(amount_cents) s FROM postings GROUP BY transaction_id) WHERE s <> 0",
            [], |r| r.get(0)).unwrap();
        assert_eq!(unbalanced, 0, "all transactions must balance to zero");

        // a1 balance from postings = 10000 + 5000 - 2000 - 1000 (transfer out) - 500 (adj) = 11500.
        let bal_a1: i64 = c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id='a1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bal_a1, 11_500);
        // a2 receives the transfer: +1000.
        let bal_a2: i64 = c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id='a2'", [], |r| r.get(0)).unwrap();
        assert_eq!(bal_a2, 1_000);
    }

    // Helper: assert every transaction in the DB has postings summing to zero.
    fn assert_books_balance(c: &rusqlite::Connection) {
        let unbalanced: i64 = c.query_row(
            "SELECT COUNT(*) FROM (SELECT transaction_id, SUM(amount_cents) s FROM postings GROUP BY transaction_id) WHERE s <> 0",
            [], |r| r.get(0)).unwrap();
        assert_eq!(unbalanced, 0, "every transaction's postings must sum to zero");
    }

    #[test]
    fn create_income_expense_transfer_write_balanced_postings() {
        let c = test_db();
        let acc = crate::service::create_account(&c, "Cash", "cash", 10_000, None, None, None, None).unwrap();
        let bank = crate::service::create_account(&c, "Bank", "savings", 0, None, None, None, None).unwrap();
        let cats = crate::service::list_categories(&c, Some("income"), false).unwrap();
        let inc_cat = cats.first().expect("seeded income categories expected").id.clone();
        let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
        let exp_cat = xcats.first().expect("seeded expense categories expected").id.clone();

        crate::service::create_income(&c, &acc.id, Some(&inc_cat), 5_000, None, "2026-02-01", None, false, None).unwrap();
        crate::service::create_expense(&c, &acc.id, Some(&exp_cat), 2_000, None, "2026-02-02", None, false, None).unwrap();
        crate::service::create_transfer(&c, &acc.id, &bank.id, 1_000, None, "2026-02-03", None).unwrap();

        // Stronger RED assertion: postings must exist before the balance check.
        let posting_count: i64 = c.query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0)).unwrap();
        assert!(posting_count > 0, "expected postings to have been written but got 0");

        assert_books_balance(&c);
        // Cash: opening 10000 + income 5000 - expense 2000 - transfer 1000 = 12000.
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 12_000);
        // Bank: opening 0 + transfer in 1000 = 1000.
        assert_eq!(crate::repo::get_account(&c, &bank.id).unwrap().balance_cents, 1_000);
    }

    #[test]
    fn update_and_delete_keep_postings_consistent() {
        let c = test_db();
        let acc = crate::service::create_account(&c, "Cash", "cash", 0, None, None, None, None).unwrap();
        let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
        let exp_cat = xcats.first().expect("seeded expense categories expected").id.clone();
        let t = crate::service::create_expense(&c, &acc.id, Some(&exp_cat), 2_000, None, "2026-02-02", None, false, None).unwrap();
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, -2_000);

        // Edit the amount up to 5000.
        let input = crate::models::UpdateTransactionInput {
            id: t.id.clone(), kind: "expense".into(), account_id: acc.id.clone(),
            to_account_id: None, category_id: Some(exp_cat.clone()),
            amount_cents: 5_000, description: None, transaction_date: "2026-02-02".into(),
            transaction_time: None, excluded_from_reporting: false, splits: None,
        };
        crate::service::update_transaction(&c, input).unwrap();
        assert_books_balance(&c);
        let posting_bal: i64 = c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id = ?1", [&acc.id], |r| r.get(0)).unwrap();
        assert_eq!(posting_bal, -5_000, "postings must reflect the edited amount");
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, -5_000);
        // Exactly 2 postings remain for the txn (no stale rows from the old amount).
        let n: i64 = c.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id = ?1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);

        // Delete cascades postings away.
        crate::service::delete_transaction(&c, &t.id).unwrap();
        let after: i64 = c.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id = ?1", [&t.id], |r| r.get(0)).unwrap();
        assert_eq!(after, 0);
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 0);
    }

    #[test]
    fn set_account_balance_keeps_postings_consistent() {
        let c = test_db();
        // Fresh account, only the opening row exists → reconcile edits opening.
        let acc = crate::service::create_account(&c, "Cash", "cash", 1_000, None, None, None, None).unwrap();
        crate::service::set_account_balance(&c, &acc.id, 4_000, false).unwrap();
        assert_books_balance(&c);
        let pbal = |id: &str| c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 4_000);
        assert_eq!(pbal(&acc.id), 4_000, "opening postings must reflect the reconciled balance");

        // Now create real activity, then reconcile → inserts a balanced adjustment.
        let xcats = crate::service::list_categories(&c, Some("expense"), false).unwrap();
        let exp_cat = xcats.first().expect("seeded expense categories expected").id.clone();
        crate::service::create_expense(&c, &acc.id, Some(&exp_cat), 500, None, "2026-03-01", None, false, None).unwrap();
        // balance is now 3500; reconcile to 3000 → adjustment of -500.
        crate::service::set_account_balance(&c, &acc.id, 3_000, false).unwrap();
        assert_books_balance(&c);
        assert_eq!(crate::repo::get_account(&c, &acc.id).unwrap().balance_cents, 3_000);
        assert_eq!(pbal(&acc.id), 3_000, "adjustment postings must reflect the reconciled balance");
    }

    #[test]
    fn reset_app_wipes_data_and_reseeds_defaults() {
        let c = test_db();
        // Arrange: an account, a transaction, and a custom category.
        let a = acct(&c, "Wallet", 10_000);
        let cat = expense_cat(&c);
        service::create_expense(&c, &a.id, Some(&cat), 500, None, "2026-01-01", None, false, None).unwrap();
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

    #[test]
    fn update_account_opening_balance_remateralizes_postings() {
        let c = crate::db::open_in_memory().unwrap();
        let acc = crate::service::create_account(&c, "Cash", "cash", 1_000, None, None, None, None).unwrap();
        let pbal = |id: &str| c.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE account_id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(pbal(&acc.id), 1_000);

        // Edit the opening balance to 6000 via the account-edit path.
        let input = crate::models::UpdateAccountInput {
            id: acc.id.clone(),
            name: None,
            subtype: None,
            opening_balance_cents: Some(6_000),
            credit_limit_cents: None,
            value_categories: None,
        };
        crate::service::update_account(&c, input).unwrap();

        assert_books_balance(&c);
        assert_eq!(pbal(&acc.id), 6_000, "opening postings must reflect the edited opening balance");
        // Exactly one opening transaction with two postings (no duplicates/stale rows).
        let n: i64 = c.query_row(
            "SELECT COUNT(*) FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.account_id = ?1 AND t.kind = 'opening'",
            [&acc.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn seeds_two_protected_adjustment_categories() {
        let c = crate::db::open_in_memory().unwrap();
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE is_system = 1 AND name = 'Adjustment' AND parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2, "expected one income + one expense Adjustment system category");
        let kinds: Vec<String> = {
            let mut stmt = c
                .prepare("SELECT kind FROM categories WHERE is_system = 1 AND name = 'Adjustment' ORDER BY kind")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(kinds, vec!["expense".to_string(), "income".to_string()]);
    }

    #[test]
    fn backfill_promotes_preexisting_adjustment_category() {
        let c = crate::db::open_in_memory().unwrap();
        // Simulate an existing user who never hit the v4 gate AND owns a plain
        // top-level expense "Adjustment". Delete the seeded system rows + clear the
        // gate so backfill runs seed_categories again.
        c.execute("UPDATE categories SET is_system = 0 WHERE name = 'Adjustment'", []).unwrap();
        c.execute("DELETE FROM categories WHERE name = 'Adjustment' AND kind = 'income'", []).unwrap();
        c.execute("DELETE FROM app_settings WHERE key = 'defaults_v4_seeded'", []).unwrap();
        crate::db::backfill_defaults_for_test(&c).unwrap();
        // The pre-existing expense "Adjustment" is promoted; the income one is created.
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE is_system = 1 AND name = 'Adjustment' AND parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let kinds: Vec<String> = {
            let mut stmt = c
                .prepare("SELECT kind FROM categories WHERE is_system = 1 AND name = 'Adjustment' ORDER BY kind")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(kinds, vec!["expense".to_string(), "income".to_string()]);
    }

    #[test]
    fn reset_app_clears_postings() {
        let c = crate::db::open_in_memory().unwrap();
        let _acc = crate::service::create_account(&c, "Cash", "cash", 1_000, None, None, None, None).unwrap();
        let before: i64 = c.query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0)).unwrap();
        assert!(before > 0, "account creation should have written postings");
        crate::db::reset_to_defaults(&c).unwrap();
        let after: i64 = c.query_row("SELECT COUNT(*) FROM postings", [], |r| r.get(0)).unwrap();
        assert_eq!(after, 0, "factory reset must clear postings");
    }

    #[test]
    fn correction_as_income_books_income_with_system_category() {
        let c = test_db();
        let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None, None, None, None).unwrap();
        // Real activity so the income/expense path (not opening edit) is used.
        let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
        crate::service::create_expense(&c, &a.id, Some(&cat), 100_00, None, "2026-06-01", None, false, None).unwrap();
        // Balance now 900.00; correct UP to 950.00 → +50.00 income.
        crate::service::set_account_balance(&c, &a.id, 950_00, true).unwrap();
        let sys: String = c.query_row("SELECT id FROM categories WHERE is_system=1 AND kind='income' LIMIT 1", [], |r| r.get(0)).unwrap();
        let (kind, amt, cat_id): (String, i64, Option<String>) = c
            .query_row(
                "SELECT kind, amount_cents, category_id FROM transactions WHERE kind IN ('income','expense','adjustment') AND account_id=?1 ORDER BY created_at DESC LIMIT 1",
                [&a.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "income");
        assert_eq!(amt, 50_00);
        assert_eq!(cat_id.as_deref(), Some(sys.as_str()));
        assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 950_00);
    }

    #[test]
    fn correction_as_income_books_expense_when_diff_negative() {
        let c = test_db();
        let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None, None, None, None).unwrap();
        let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
        crate::service::create_expense(&c, &a.id, Some(&cat), 100_00, None, "2026-06-01", None, false, None).unwrap();
        // Balance 900.00; correct DOWN to 850.00 → -50.00 expense.
        crate::service::set_account_balance(&c, &a.id, 850_00, true).unwrap();
        let sys: String = c.query_row("SELECT id FROM categories WHERE is_system=1 AND kind='expense' LIMIT 1", [], |r| r.get(0)).unwrap();
        let (kind, amt, cat_id): (String, i64, Option<String>) = c
            .query_row(
                "SELECT kind, amount_cents, category_id FROM transactions WHERE kind IN ('income','expense','adjustment') AND account_id=?1 ORDER BY created_at DESC LIMIT 1",
                [&a.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "expense");
        assert_eq!(amt, 50_00);
        assert_eq!(cat_id.as_deref(), Some(sys.as_str()));
        assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 850_00);
    }

    #[test]
    fn correction_flag_ignored_when_no_activity_edits_opening() {
        let c = crate::db::open_in_memory().unwrap();
        let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None, None, None, None).unwrap();
        crate::service::set_account_balance(&c, &a.id, 1_500_00, true).unwrap();
        // No income/expense/adjustment row created; opening was edited instead.
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE account_id=?1 AND kind IN ('income','expense','adjustment')", [&a.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(crate::service::get_account_balance(&c, &a.id).unwrap(), 1_500_00);
    }

    #[test]
    fn correction_income_expense_cannot_be_edited() {
        let c = test_db();
        let a = crate::service::create_account(&c, "Cash", "cash", 1_000_00, None, None, None, None).unwrap();
        let cat: String = c.query_row("SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
        crate::service::create_expense(&c, &a.id, Some(&cat), 100_00, None, "2026-06-01", None, false, None).unwrap();
        crate::service::set_account_balance(&c, &a.id, 950_00, true).unwrap();
        let corr_id: String = c.query_row("SELECT id FROM transactions WHERE kind='income' AND account_id=?1 LIMIT 1", [&a.id], |r| r.get(0)).unwrap();
        let income_cat: String = c.query_row("SELECT id FROM categories WHERE kind='income' AND is_system=0 LIMIT 1", [], |r| r.get(0)).unwrap();
        let input = crate::models::UpdateTransactionInput {
            id: corr_id,
            kind: "income".into(),
            account_id: a.id.clone(),
            to_account_id: None,
            category_id: Some(income_cat),
            amount_cents: 50_00,
            description: None,
            transaction_date: "2026-06-02".into(),
            transaction_time: None,
            excluded_from_reporting: false,
            splits: None,
        };
        assert!(crate::service::update_transaction(&c, input).is_err(), "editing a balance correction must be blocked");
    }

    #[test]
    fn balance_reads_from_postings() {
        use rusqlite::Connection;
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        for (_, sql) in crate::db::migrations::MIGRATIONS {
            c.execute_batch(sql).unwrap();
        }
        let now = crate::now();
        c.execute("INSERT INTO accounts (id, template_key, name, subtype, currency, is_archived, created_at, updated_at) \
                   VALUES ('a1', NULL, 'Cash', 'cash', 'MYR', 0, ?1, ?1)", [&now]).unwrap();
        c.execute("INSERT INTO transactions (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at) \
                   VALUES ('o1','opening','a1',NULL,NULL,7000,'Opening balance','2026-01-01',0,?1,?1)", [&now]).unwrap();
        // Postings DELIBERATELY diverge from the header (9000, not 7000) to prove the
        // balance is read from postings, not the transaction header.
        c.execute("INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('o1a','o1','a1',NULL,9000)", []).unwrap();
        c.execute("INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents) VALUES ('o1b','o1',NULL,'equity',-9000)", []).unwrap();

        let acc = crate::repo::get_account(&c, "a1").unwrap();
        assert_eq!(acc.balance_cents, 9000, "balance must come from postings, not the transaction header");
    }

    #[test]
    fn credit_card_and_bnpl_roundtrip_a_positive_limit() {
        let c = test_db();
        let card = service::create_account(&c, "Visa", "credit-card", -200_000, None, Some(1_000_000), None, None).unwrap();
        let bnpl = service::create_account(&c, "Atome", "bnpl", -50_000, None, Some(300_000), None, None).unwrap();
        assert_eq!(card.credit_limit_cents, Some(1_000_000));
        assert_eq!(card.balance_cents, -200_000);
        assert_eq!(bnpl.credit_limit_cents, Some(300_000));
        let again = service::list_accounts(&c, false).unwrap();
        assert_eq!(again.iter().find(|a| a.id == card.id).unwrap().credit_limit_cents, Some(1_000_000));
    }

    #[test]
    fn limit_subtype_rejects_a_missing_zero_or_negative_limit() {
        let c = test_db();
        let missing = service::create_account(&c, "Visa", "credit-card", 0, None, None, None, None).unwrap_err();
        assert_eq!(validation_message(missing), "Credit limit is required for this account.");
        let zero = service::create_account(&c, "Visa", "bnpl", 0, None, Some(0), None, None).unwrap_err();
        assert_eq!(validation_message(zero), "Credit limit must be greater than zero.");
        let neg = service::create_account(&c, "Visa", "credit-card", 0, None, Some(-1), None, None).unwrap_err();
        assert_eq!(validation_message(neg), "Credit limit must be greater than zero.");
    }

    #[test]
    fn non_limit_subtype_rejects_a_limit_and_stores_null_without_one() {
        let c = test_db();
        let rejected = service::create_account(&c, "Cash", "savings", 100, None, Some(500), None, None).unwrap_err();
        assert_eq!(validation_message(rejected), "Credit limit only applies to credit cards and BNPL.");
        let savings = service::create_account(&c, "Cash", "savings", 100, None, None, None, None).unwrap();
        assert_eq!(savings.credit_limit_cents, None);
    }

    #[test]
    fn update_replaces_keeps_clears_or_requires_the_limit() {
        let c = test_db();
        let card = service::create_account(&c, "Visa", "credit-card", -100, None, Some(1_000_000), None, None).unwrap();
        let replaced = service::update_account(&c, UpdateAccountInput {
            id: card.id.clone(), name: None, subtype: None, opening_balance_cents: None, credit_limit_cents: Some(2_000_000),
            value_categories: None,
        }).unwrap();
        assert_eq!(replaced.credit_limit_cents, Some(2_000_000));

        let kept = service::update_account(&c, UpdateAccountInput {
            id: card.id.clone(), name: Some("Visa Gold".into()), subtype: None, opening_balance_cents: None, credit_limit_cents: None,
            value_categories: None,
        }).unwrap();
        assert_eq!(kept.credit_limit_cents, Some(2_000_000));

        let cleared = service::update_account(&c, UpdateAccountInput {
            id: card.id.clone(), name: None, subtype: Some("savings".into()), opening_balance_cents: None, credit_limit_cents: None,
            value_categories: None,
        }).unwrap();
        assert_eq!(cleared.subtype, "savings");
        assert_eq!(cleared.credit_limit_cents, None);

        let savings = service::create_account(&c, "Cash", "savings", 0, None, None, None, None).unwrap();
        let need = service::update_account(&c, UpdateAccountInput {
            id: savings.id.clone(), name: None, subtype: Some("credit-card".into()), opening_balance_cents: None, credit_limit_cents: None,
            value_categories: None,
        }).unwrap_err();
        assert_eq!(validation_message(need), "Credit limit is required for this account.");

        let switched = service::update_account(&c, UpdateAccountInput {
            id: savings.id.clone(), name: None, subtype: Some("bnpl".into()), opening_balance_cents: None, credit_limit_cents: Some(400_000),
            value_categories: None,
        }).unwrap();
        assert_eq!(switched.credit_limit_cents, Some(400_000));

        let wrong = service::update_account(&c, UpdateAccountInput {
            id: switched.id.clone(), name: None, subtype: Some("cash".into()), opening_balance_cents: None, credit_limit_cents: Some(10),
            value_categories: None,
        }).unwrap_err();
        assert_eq!(validation_message(wrong), "Credit limit only applies to credit cards and BNPL.");
    }

    #[test]
    fn expense_past_the_limit_still_posts_and_keeps_the_limit() {
        let c = test_db();
        let card = service::create_account(&c, "Visa", "credit-card", -800_000, None, Some(1_000_000), None, None).unwrap();
        service::create_expense(&c, &card.id, Some(&expense_cat(&c)), 500_000, None, "2026-10-12", None, false, None).unwrap();
        let after = service::list_accounts(&c, true).unwrap().into_iter().find(|a| a.id == card.id).unwrap();
        assert_eq!(after.balance_cents, -1_300_000);
        assert_eq!(after.credit_limit_cents, Some(1_000_000));
    }

    fn value_rows(c: &rusqlite::Connection, account_id: &str) -> Vec<Transaction> {
        service::list_transactions(c, TransactionFilters {
            account_id: Some(account_id.to_string()),
            ..TransactionFilters::default()
        }).unwrap().into_iter().filter(|t| t.description.as_deref() == Some("Value update")).collect()
    }

    #[test]
    fn update_net_worth_rise_uses_the_saved_gain_category() {
        let c = test_db();
        let gain = income_cat(&c);
        let other = service::create_category(&c, "Other income", "income", "💵", None, None).unwrap();
        let acc = service::create_account(&c, "Stash", "unit-trust", 10_000, None, None, Some(&gain), None).unwrap();
        let opening = acc.opening_balance_cents;
        let after = service::update_net_worth(&c, &acc.id, 10_500, Some(&other.id), None).unwrap();
        assert_eq!(after.balance_cents, 10_500);
        assert_eq!(after.opening_balance_cents, opening);
        assert_eq!(after.gain_category_id.as_deref(), Some(gain.as_str()));
        let rows = value_rows(&c, &acc.id);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "income");
        assert_eq!(rows[0].amount_cents, 500);
        assert_eq!(rows[0].category_id.as_deref(), Some(gain.as_str()));
        assert_eq!(rows[0].transaction_date, crate::today());
        assert_eq!(rows[0].transaction_time, None);
        assert!(!rows[0].excluded_from_reporting);
        assert!(rows[0].splits.is_empty());
        assert_books_balance(&c);
    }

    #[test]
    fn update_net_worth_drop_uses_the_saved_loss_category() {
        let c = test_db();
        let loss = expense_cat(&c);
        let acc = service::create_account(&c, "FD", "fixed-deposit", 8_000, None, None, None, Some(&loss)).unwrap();
        let after = service::update_net_worth(&c, &acc.id, 7_250, None, None).unwrap();
        assert_eq!(after.balance_cents, 7_250);
        let rows = value_rows(&c, &acc.id);
        assert_eq!(rows[0].kind, "expense");
        assert_eq!(rows[0].amount_cents, 750);
        assert_eq!(rows[0].category_id.as_deref(), Some(loss.as_str()));
        assert_books_balance(&c);
    }

    #[test]
    fn update_net_worth_with_only_an_opening_does_not_rewrite_it() {
        let c = test_db();
        let gain = income_cat(&c);
        let acc = service::create_account(&c, "Luno", "crypto", 2_000, None, None, Some(&gain), None).unwrap();
        service::update_net_worth(&c, &acc.id, 2_100, None, None).unwrap();
        let opening = service::list_transactions(&c, TransactionFilters {
            account_id: Some(acc.id.clone()),
            ..TransactionFilters::default()
        }).unwrap().into_iter().find(|t| t.kind == "opening").unwrap();
        assert_eq!(opening.amount_cents, 2_000);
    }

    #[test]
    fn update_net_worth_zero_diff_writes_nothing() {
        let c = test_db();
        let acc = service::create_account(&c, "Stash", "investment", 5_000, None, None, None, None).unwrap();
        let after = service::update_net_worth(&c, &acc.id, 5_000, None, None).unwrap();
        assert_eq!(after.balance_cents, 5_000);
        assert!(value_rows(&c, &acc.id).is_empty());
    }

    #[test]
    fn update_net_worth_without_a_saved_category_uses_the_passed_one_once() {
        let c = test_db();
        let gain = income_cat(&c);
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
        let after = service::update_net_worth(&c, &acc.id, 1_200, Some(&gain), None).unwrap();
        assert_eq!(after.gain_category_id, None);
        assert_eq!(value_rows(&c, &acc.id)[0].category_id.as_deref(), Some(gain.as_str()));
    }

    #[test]
    fn update_net_worth_requires_a_category_when_none_is_saved() {
        let c = test_db();
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
        let err = service::update_net_worth(&c, &acc.id, 1_100, None, None).unwrap_err();
        assert_eq!(validation_message(err), "Pick a category for this update.");
    }

    #[test]
    fn update_net_worth_rejects_the_wrong_kind_and_a_system_category() {
        let c = test_db();
        let expense = expense_cat(&c);
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
        let err = service::update_net_worth(&c, &acc.id, 1_100, Some(&expense), None).unwrap_err();
        assert_eq!(validation_message(err), "Category kind 'expense' does not match transaction kind 'income'");
        let system = service::list_categories(&c, Some("income"), true).unwrap().into_iter().find(|cat| cat.is_system).unwrap();
        let err = service::update_net_worth(&c, &acc.id, 1_100, Some(&system.id), None).unwrap_err();
        assert_eq!(validation_message(err), "That category can't be selected.");
    }

    #[test]
    fn update_net_worth_rejects_bad_targets_and_accounts() {
        let c = test_db();
        let missing = service::update_net_worth(&c, "nope", 1, None, None).unwrap_err();
        assert!(matches!(missing, AppError::NotFound(m) if m == "Account not found"));
        let cash = service::create_account(&c, "Cash", "savings", 1_000, None, None, None, None).unwrap();
        let err = service::update_net_worth(&c, &cash.id, 1_100, None, None).unwrap_err();
        assert_eq!(validation_message(err), "Update Net Worth only applies to fixed deposits, investments, unit trusts, and crypto.");
        let acc = service::create_account(&c, "FD", "fixed-deposit", 1_000, None, None, None, None).unwrap();
        let err = service::update_net_worth(&c, &acc.id, -1, None, None).unwrap_err();
        assert_eq!(validation_message(err), "Balance must be zero or more.");
        service::archive_account(&c, &acc.id).unwrap();
        let err = service::update_net_worth(&c, &acc.id, 1_000, None, None).unwrap_err();
        assert!(matches!(err, AppError::Conflict(m) if m == "Cannot update an archived account"));
    }

    #[test]
    fn update_net_worth_requires_time_only_when_the_setting_is_on() {
        let c = test_db();
        let gain = income_cat(&c);
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain), None).unwrap();
        service::update_net_worth(&c, &acc.id, 1_100, None, None).unwrap();
        assert_eq!(value_rows(&c, &acc.id)[0].transaction_time, None);
        service::set_setting(&c, "transaction_time_enabled", "1").unwrap();
        let err = service::update_net_worth(&c, &acc.id, 1_250, None, None).unwrap_err();
        assert_eq!(validation_message(err), "A time is required");
        service::update_net_worth(&c, &acc.id, 1_250, None, Some("09:30")).unwrap();
        let timed = value_rows(&c, &acc.id).into_iter().find(|t| t.amount_cents == 150).unwrap();
        assert_eq!(timed.transaction_time.as_deref(), Some("09:30"));
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        service::update_net_worth(&c, &acc.id, 1_300, None, Some("11:00")).unwrap();
        let ignored = value_rows(&c, &acc.id).into_iter().find(|t| t.amount_cents == 50).unwrap();
        assert_eq!(ignored.transaction_time, None);
    }

    #[test]
    fn correct_balance_still_rewrites_an_opening_only_investment() {
        let c = test_db();
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, None, None).unwrap();
        service::set_account_balance(&c, &acc.id, 4_000, true).unwrap();
        let after = service::get_account(&c, &acc.id).unwrap();
        assert_eq!(after.opening_balance_cents, 4_000);
        assert_eq!(after.balance_cents, 4_000);
        assert!(value_rows(&c, &acc.id).is_empty());
    }

    #[test]
    fn deleting_a_category_used_by_a_value_update_keeps_the_column() {
        let c = test_db();
        let gain = service::create_category(&c, "Growth", "income", "📈", None, None).unwrap();
        let acc = service::create_account(&c, "Stash", "investment", 1_000, None, None, Some(&gain.id), None).unwrap();
        service::update_net_worth(&c, &acc.id, 1_500, None, None).unwrap();
        let err = service::delete_category(&c, &gain.id).unwrap_err();
        assert!(matches!(err, AppError::Conflict(m) if m == "In use by transactions — archive it instead"));
        assert_eq!(service::get_account(&c, &acc.id).unwrap().gain_category_id.as_deref(), Some(gain.id.as_str()));
    }
}

#[cfg(test)]
mod seed_catalog {
    //! Generates src/generated/seed-catalog.json from a freshly migrated+seeded
    //! in-memory DB and fails CI if the committed file is stale. The browser mock
    //! consumes that JSON, so this is the single source of truth for mock seed data.
    use crate::db::open_in_memory;
    use rusqlite::Connection;
    use serde::Serialize;
    use std::path::PathBuf;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SubtypeRow {
        key: String,
        label: String,
        #[serde(rename = "type")]
        ty: String,
        group: String,
        sort_order: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TemplateRow {
        key: String,
        name: String,
        group_name: String,
        default_subtype: String,
        sort_order: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CategoryRow {
        name: String,
        kind: String,
        emoji: String,
        color: Option<String>,
        parent_name: Option<String>,
        is_system: bool,
        sort_order: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SeedCatalog {
        subtypes: Vec<SubtypeRow>,
        templates: Vec<TemplateRow>,
        categories: Vec<CategoryRow>,
    }

    fn catalog_path() -> PathBuf {
        PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/generated/seed-catalog.json"
        ))
    }

    fn build(conn: &Connection) -> SeedCatalog {
        let subtypes = conn
            .prepare(
                "SELECT key, label, type, account_group, sort_order
                 FROM account_subtypes ORDER BY sort_order, key",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(SubtypeRow {
                    key: r.get(0)?,
                    label: r.get(1)?,
                    ty: r.get(2)?,
                    group: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let templates = conn
            .prepare(
                "SELECT key, name, group_name, default_subtype, sort_order
                 FROM account_templates ORDER BY sort_order, key",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(TemplateRow {
                    key: r.get(0)?,
                    name: r.get(1)?,
                    group_name: r.get(2)?,
                    default_subtype: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        // Top-level rows (parent_id IS NULL) sort first so the mock can resolve a
        // child's parent by (parentName, kind) in a second pass.
        let categories = conn
            .prepare(
                "SELECT c.name, c.kind, c.emoji, c.color, p.name AS parent_name,
                        c.is_system, c.sort_order
                 FROM categories c
                 LEFT JOIN categories p ON c.parent_id = p.id
                 ORDER BY (c.parent_id IS NOT NULL), c.kind, c.sort_order, c.name",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(CategoryRow {
                    name: r.get(0)?,
                    kind: r.get(1)?,
                    emoji: r.get(2)?,
                    color: r.get(3)?,
                    parent_name: r.get(4)?,
                    is_system: r.get::<_, i64>(5)? != 0,
                    sort_order: r.get(6)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        SeedCatalog {
            subtypes,
            templates,
            categories,
        }
    }

    fn generate(conn: &Connection) -> String {
        let mut s = serde_json::to_string_pretty(&build(conn)).unwrap();
        s.push('\n');
        s
    }

    #[test]
    fn seed_catalog_is_non_empty() {
        let conn = open_in_memory().unwrap();
        let catalog = build(&conn);
        assert_eq!(catalog.subtypes.len(), 16, "expected 16 account subtypes");
        assert!(
            catalog.templates.len() > 40,
            "expected the full provider template catalog"
        );
        assert!(
            catalog.categories.len() > 100,
            "expected the full category + subcategory tree"
        );
        // The two protected Adjustment system categories must be present.
        assert_eq!(
            catalog.categories.iter().filter(|c| c.is_system).count(),
            2,
            "expected exactly two system (Adjustment) categories"
        );
    }

    #[test]
    fn seed_catalog_json_is_fresh() {
        let conn = open_in_memory().unwrap();
        let generated = generate(&conn);
        let path = catalog_path();
        if std::env::var("UPDATE_SEED_CATALOG").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &generated).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "seed catalog missing at {} ({e}) — run `npm run gen:seed-catalog` and commit it",
                path.display()
            )
        });
        assert_eq!(
            committed, generated,
            "seed catalog is stale — run `npm run gen:seed-catalog` and commit src/generated/seed-catalog.json"
        );
    }

}

#[cfg(test)]
mod payment_tests {
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::models::Account;
    use crate::repo;
    use crate::service;

    fn test_db() -> rusqlite::Connection {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn validation_message(err: AppError) -> String {
        match err {
            AppError::Validation(m) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn pay_pair(conn: &rusqlite::Connection) -> (Account, Account) {
        let savings = service::create_account(conn, "Maybank", "savings", 500_000, None, None, None, None).unwrap();
        let card = service::create_account(conn, "Visa", "credit-card", -80_000, None, Some(1_000_000), None, None).unwrap();
        (savings, card)
    }

    #[test]
    fn payment_moves_savings_down_and_card_debt_down() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let pay = service::create_payment(&c, &savings.id, &card.id, 30_000, Some("Card payment"), "2026-06-01", None).unwrap();
        assert_eq!(pay.kind, "payment");
        assert_eq!(pay.category_id, None);
        assert!(!pay.excluded_from_reporting);
        let savings = repo::get_account(&c, &savings.id).unwrap();
        let card = repo::get_account(&c, &card.id).unwrap();
        assert_eq!(savings.balance_cents, 470_000);
        assert_eq!(card.balance_cents, -50_000);
    }

    #[test]
    fn payment_allows_partial_and_overpay() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        service::create_payment(&c, &savings.id, &card.id, 100_000, None, "2026-06-02", None).unwrap();
        let card = repo::get_account(&c, &card.id).unwrap();
        assert_eq!(card.balance_cents, 20_000);
    }

    #[test]
    fn payment_accepts_each_allowed_source() {
        let c = test_db();
        let card = service::create_account(&c, "Visa", "credit-card", -10_000, None, Some(100_000), None, None).unwrap();
        for subtype in ["cash", "ewallet", "savings", "current"] {
            let src = service::create_account(&c, subtype, subtype, 50_000, None, None, None, None).unwrap();
            service::create_payment(&c, &src.id, &card.id, 1_000, None, "2026-06-03", None).unwrap();
        }
        let bnpl = service::create_account(&c, "Atome", "bnpl", -5_000, None, Some(30_000), None, None).unwrap();
        let cash = service::create_account(&c, "Wallet", "cash", 20_000, None, None, None, None).unwrap();
        let pay = service::create_payment(&c, &cash.id, &bnpl.id, 5_000, None, "2026-06-03", None).unwrap();
        assert_eq!(pay.kind, "payment");
    }

    #[test]
    fn payment_rejects_bad_shape() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let invest = service::create_account(&c, "Stash", "investment", 0, None, None, None, None).unwrap();
        let loan = service::create_account(&c, "Loan", "personal-loan", 0, None, None, None, None).unwrap();
        assert_eq!(
            validation_message(service::create_payment(&c, &savings.id, &card.id, 0, None, "2026-06-01", None).unwrap_err()),
            "Amount must be greater than zero"
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &card.id, &card.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Cannot pay the same account."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &invest.id, &card.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only come from cash, an e-wallet, savings, or a current account."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &card.id, &savings.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only pay a credit card or BNPL."
        );
        assert_eq!(
            validation_message(service::create_payment(&c, &savings.id, &loan.id, 100, None, "2026-06-01", None).unwrap_err()),
            "Payments can only pay a credit card or BNPL."
        );
    }

    #[test]
    fn transfer_onto_a_card_is_rejected() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let err = service::create_transfer(&c, &savings.id, &card.id, 1_000, None, "2026-06-01", None).unwrap_err();
        assert_eq!(validation_message(err), "Pay a credit card or BNPL as a payment.");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE kind='transfer' AND to_account_id=?1", [&card.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn payment_does_not_change_dashboard_income_or_expense() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        service::create_payment(&c, &savings.id, &card.id, 10_000, None, "2026-06-15", None).unwrap();
        let after = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(after.income_cents, before.income_cents);
        assert_eq!(after.expense_cents, before.expense_cents);
    }

    fn payment_update(id: &str, kind: &str, from: &str, to: &str, amount: i64) -> crate::models::UpdateTransactionInput {
        crate::models::UpdateTransactionInput {
            id: id.into(),
            kind: kind.into(),
            account_id: from.into(),
            to_account_id: Some(to.into()),
            category_id: None,
            amount_cents: amount,
            description: None,
            transaction_date: "2026-06-04".into(),
            transaction_time: None,
            excluded_from_reporting: false,
            splits: None,
        }
    }

    #[test]
    fn editing_a_payment_updates_both_balances() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let cash = service::create_account(&c, "Cash", "cash", 40_000, None, None, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 10_000, None, "2026-06-01", None).unwrap();
        service::update_transaction(&c, payment_update(&pay.id, "payment", &cash.id, &card.id, 4_000)).unwrap();
        assert_eq!(repo::get_account(&c, &savings.id).unwrap().balance_cents, 500_000);
        assert_eq!(repo::get_account(&c, &cash.id).unwrap().balance_cents, 36_000);
        assert_eq!(repo::get_account(&c, &card.id).unwrap().balance_cents, -76_000);
    }

    #[test]
    fn editing_the_destination_flips_kind() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let wallet = service::create_account(&c, "TNG", "ewallet", 0, None, None, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let flipped = service::update_transaction(&c, payment_update(&pay.id, "transfer", &savings.id, &wallet.id, 5_000)).unwrap();
        assert_eq!(flipped.kind, "transfer");
        let back = service::update_transaction(&c, payment_update(&pay.id, "payment", &savings.id, &card.id, 5_000)).unwrap();
        assert_eq!(back.kind, "payment");
    }

    #[test]
    fn editing_a_payment_rejects_an_investment_source_without_writing() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let invest = service::create_account(&c, "Stash", "investment", 0, None, None, None, None).unwrap();
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let err = service::update_transaction(&c, payment_update(&pay.id, "payment", &invest.id, &card.id, 5_000)).unwrap_err();
        assert_eq!(
            validation_message(err),
            "Payments can only come from cash, an e-wallet, savings, or a current account."
        );
        let stored = repo::get_transaction(&c, &pay.id).unwrap();
        assert_eq!(stored.account_id, savings.id);
        assert_eq!(stored.kind, "payment");
    }

    #[test]
    fn updating_a_transfer_onto_a_card_is_rejected() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let wallet = service::create_account(&c, "TNG", "ewallet", 0, None, None, None, None).unwrap();
        let xfer = service::create_transfer(&c, &savings.id, &wallet.id, 2_000, None, "2026-06-01", None).unwrap();
        let err = service::update_transaction(&c, payment_update(&xfer.id, "transfer", &savings.id, &card.id, 2_000)).unwrap_err();
        assert_eq!(validation_message(err), "Pay a credit card or BNPL as a payment.");
        assert_eq!(repo::get_transaction(&c, &xfer.id).unwrap().kind, "transfer");
    }

    #[test]
    fn payment_rejects_splits_and_can_be_deleted() {
        let c = test_db();
        let (savings, card) = pay_pair(&c);
        let pay = service::create_payment(&c, &savings.id, &card.id, 5_000, None, "2026-06-01", None).unwrap();
        let mut input = payment_update(&pay.id, "payment", &savings.id, &card.id, 5_000);
        let cat: String = c.query_row(
            "SELECT id FROM categories WHERE kind='expense' AND is_system=0 LIMIT 1",
            [],
            |r| r.get(0),
        ).unwrap();
        input.splits = Some(vec![crate::models::SplitInput { category_id: cat, amount_cents: 5_000 }]);
        assert_eq!(
            validation_message(service::update_transaction(&c, input).unwrap_err()),
            "Payments can't be split."
        );
        service::delete_transaction(&c, &pay.id).unwrap();
        assert_eq!(repo::get_account(&c, &savings.id).unwrap().balance_cents, 500_000);
        assert_eq!(repo::get_account(&c, &card.id).unwrap().balance_cents, -80_000);
    }
}

#[cfg(test)]
mod reimbursement_tests {
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::models::{Account, Allocation, SplitInput, Transaction, UpdateTransactionInput};
    use crate::repo;
    use crate::service;
    use rusqlite::Connection;

    fn test_db() -> rusqlite::Connection {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn expense_cat(c: &Connection, n: i64) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE kind='expense' AND is_system=0 AND parent_id IS NULL ORDER BY sort_order LIMIT 1 OFFSET ?1",
            [n],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn pair(c: &Connection) -> (Account, Account) {
        let savings = service::create_account(c, "Maybank", "savings", 500_000, None, None, None, None).unwrap();
        let card = service::create_account(c, "Visa", "credit-card", -80_000, None, Some(1_000_000), None, None).unwrap();
        (savings, card)
    }

    fn spend(c: &Connection, account_id: &str, cents: i64, date: &str) -> Transaction {
        let cat = expense_cat(c, 0);
        service::create_expense(c, account_id, Some(&cat), cents, Some("Dinner"), date, None, false, None).unwrap()
    }

    fn validation_message(err: AppError) -> String {
        match err {
            AppError::Validation(m) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn conflict_message(err: AppError) -> String {
        match err {
            AppError::Conflict(m) => m,
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    fn income_cat(c: &Connection) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE kind='income' AND is_system=0 AND parent_id IS NULL ORDER BY sort_order LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn alloc(expense: &Transaction, cents: i64) -> Allocation {
        Allocation { expense_id: expense.id.clone(), amount_cents: cents }
    }

    fn reimburse(c: &Connection, account_id: &str, cents: i64, date: &str, allocs: Vec<Allocation>) -> Transaction {
        service::create_reimbursement(c, account_id, cents, Some("Back"), date, None, allocs).unwrap()
    }

    fn balance(c: &Connection, id: &str) -> i64 {
        repo::get_account(c, id).unwrap().balance_cents
    }

    fn expense_update(e: &Transaction, amount: i64) -> UpdateTransactionInput {
        UpdateTransactionInput {
            id: e.id.clone(),
            kind: "expense".into(),
            account_id: e.account_id.clone(),
            to_account_id: None,
            category_id: e.category_id.clone(),
            amount_cents: amount,
            description: e.description.clone(),
            transaction_date: e.transaction_date.clone(),
            transaction_time: None,
            excluded_from_reporting: false,
            splits: None,
        }
    }

    #[test]
    fn expectation_can_be_set_changed_and_cleared() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let t = service::set_expected_reimbursement(&c, &e.id, Some(7_000)).unwrap();
        assert_eq!(t.expected_reimbursement_cents, Some(7_000));
        let t = service::set_expected_reimbursement(&c, &e.id, Some(10_000)).unwrap();
        assert_eq!(t.expected_reimbursement_cents, Some(10_000));

        let range = "Expected reimbursement must be more than zero and no more than the expense amount.";
        assert_eq!(validation_message(service::set_expected_reimbursement(&c, &e.id, Some(10_001)).unwrap_err()), range);
        assert_eq!(validation_message(service::set_expected_reimbursement(&c, &e.id, Some(0)).unwrap_err()), range);

        let inc_cat = income_cat(&c);
        let income = service::create_income(&c, &savings.id, Some(&inc_cat), 1_000, None, "2026-06-01", None, false, None).unwrap();
        assert_eq!(
            validation_message(service::set_expected_reimbursement(&c, &income.id, Some(100)).unwrap_err()),
            "Only expenses can expect a reimbursement."
        );

        let t = service::set_expected_reimbursement(&c, &e.id, None).unwrap();
        assert_eq!(t.expected_reimbursement_cents, None);
    }

    #[test]
    fn update_reimbursement_rewrites_amount_account_and_allocations() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let cash = service::create_account(&c, "Wallet", "cash", 0, None, None, None, None).unwrap();
        let e1 = spend(&c, &savings.id, 20_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        let r = reimburse(&c, &savings.id, 10_000, "2026-06-05", vec![alloc(&e1, 10_000)]);
        assert_eq!(balance(&c, &savings.id), 485_000);

        let u = service::update_reimbursement(
            &c, &r.id, &cash.id, 6_000, Some("Fixed"), "2026-06-09", None,
            vec![alloc(&e1, 1_000), alloc(&e2, 5_000)],
        )
        .unwrap();

        assert_eq!(u.amount_cents, 6_000);
        assert_eq!(u.account_id, cash.id);
        assert_eq!(u.description.as_deref(), Some("Fixed"));
        assert_eq!(u.allocations, vec![alloc(&e1, 1_000), alloc(&e2, 5_000)]);
        assert_eq!(repo::get_transaction(&c, &e1.id).unwrap().reimbursed_cents, 1_000);
        assert_eq!(repo::get_transaction(&c, &e2.id).unwrap().reimbursed_cents, 5_000);
        assert_eq!(balance(&c, &cash.id), 6_000);
        assert_eq!(balance(&c, &savings.id), 475_000);
    }

    #[test]
    fn update_reimbursement_ignores_its_own_links_when_checking_what_is_left() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 10_000, "2026-06-05", vec![alloc(&e, 10_000)]);
        let u = service::update_reimbursement(&c, &r.id, &savings.id, 10_000, None, "2026-06-06", None, vec![alloc(&e, 10_000)])
            .unwrap();
        assert_eq!(u.allocations, vec![alloc(&e, 10_000)]);
    }

    #[test]
    fn a_failed_update_reimbursement_changes_nothing() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);
        let err = service::update_reimbursement(&c, &r.id, &savings.id, 12_000, None, "2026-06-06", None, vec![alloc(&e, 12_000)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Allocation exceeds what's left on that expense.");
        let stored = repo::get_transaction(&c, &r.id).unwrap();
        assert_eq!(stored.amount_cents, 4_000);
        assert_eq!(stored.allocations, vec![alloc(&e, 4_000)]);
        assert_eq!(balance(&c, &savings.id), 494_000);
    }

    #[test]
    fn update_reimbursement_rolls_back_when_a_write_fails_midway() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let cash = service::create_account(&c, "Wallet", "cash", 0, None, None, None, None).unwrap();
        let e1 = spend(&c, &savings.id, 20_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        let r = reimburse(&c, &savings.id, 10_000, "2026-06-05", vec![alloc(&e1, 10_000)]);

        let before_r = repo::get_transaction(&c, &r.id).unwrap();
        let before_e1 = repo::get_transaction(&c, &e1.id).unwrap();
        let before_e2 = repo::get_transaction(&c, &e2.id).unwrap();
        let before_savings = balance(&c, &savings.id);
        let before_cash = balance(&c, &cash.id);

        // Fails on the first allocation insert, after validation, header update, and delete.
        // Without service::update_reimbursement's unchecked_transaction, those earlier writes
        // would persist on `c` and leave header/postings/allocations inconsistent.
        c.execute_batch(
            "CREATE TRIGGER fail_alloc BEFORE INSERT ON reimbursement_allocations
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        assert!(
            service::update_reimbursement(
                &c,
                &r.id,
                &cash.id,
                6_000,
                Some("Fixed"),
                "2026-06-09",
                None,
                vec![alloc(&e1, 1_000), alloc(&e2, 5_000)],
            )
            .is_err()
        );

        let stored = repo::get_transaction(&c, &r.id).unwrap();
        assert_eq!(stored.amount_cents, before_r.amount_cents);
        assert_eq!(stored.account_id, before_r.account_id);
        assert_eq!(stored.transaction_date, before_r.transaction_date);
        assert_eq!(stored.allocations, before_r.allocations);
        assert_eq!(repo::get_transaction(&c, &e1.id).unwrap().reimbursed_cents, before_e1.reimbursed_cents);
        assert_eq!(repo::get_transaction(&c, &e2.id).unwrap().reimbursed_cents, before_e2.reimbursed_cents);
        assert_eq!(balance(&c, &savings.id), before_savings);
        assert_eq!(balance(&c, &cash.id), before_cash);
    }

    #[test]
    fn update_reimbursement_only_accepts_reimbursements() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let err = service::update_reimbursement(&c, &e.id, &savings.id, 100, None, "2026-06-06", None, vec![alloc(&e, 100)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Only reimbursements can be edited here.");
    }

    #[test]
    fn update_transaction_refuses_reimbursements() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);

        let mut input = expense_update(&e, 4_000);
        input.id = r.id.clone();
        input.kind = "reimbursement".into();
        assert_eq!(
            validation_message(service::update_transaction(&c, input).unwrap_err()),
            "Edit a reimbursement from its own form."
        );
        let mut as_expense = expense_update(&e, 4_000);
        as_expense.id = r.id.clone();
        assert_eq!(
            validation_message(service::update_transaction(&c, as_expense).unwrap_err()),
            "Edit a reimbursement from its own form."
        );
    }

    #[test]
    fn a_reimbursed_expense_cannot_be_deleted_shrunk_or_retyped() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let r = reimburse(&c, &savings.id, 6_000, "2026-06-05", vec![alloc(&e, 6_000)]);

        let locked = "This expense has been reimbursed. Edit or delete the reimbursement first.";
        assert_eq!(conflict_message(service::delete_transaction(&c, &e.id).unwrap_err()), locked);
        assert_eq!(
            validation_message(service::update_transaction(&c, expense_update(&e, 5_000)).unwrap_err()),
            "Amount can't go below what's already been reimbursed."
        );
        service::update_transaction(&c, expense_update(&e, 6_000)).unwrap();

        let mut retyped = expense_update(&e, 6_000);
        retyped.kind = "income".into();
        retyped.category_id = None;
        assert_eq!(conflict_message(service::update_transaction(&c, retyped).unwrap_err()), locked);

        service::delete_transaction(&c, &r.id).unwrap();
        assert_eq!(repo::get_transaction(&c, &e.id).unwrap().reimbursed_cents, 0);
        assert_eq!(balance(&c, &savings.id), 494_000);
        service::delete_transaction(&c, &e.id).unwrap();
    }

    #[test]
    fn editing_an_expense_clamps_or_clears_the_expectation() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        service::set_expected_reimbursement(&c, &e.id, Some(10_000)).unwrap();

        let shrunk = service::update_transaction(&c, expense_update(&e, 8_000)).unwrap();
        assert_eq!(shrunk.expected_reimbursement_cents, Some(8_000));

        let mut as_income = expense_update(&e, 8_000);
        as_income.kind = "income".into();
        as_income.category_id = Some(income_cat(&c));
        let flipped = service::update_transaction(&c, as_income).unwrap();
        assert_eq!(flipped.kind, "income");
        assert_eq!(flipped.expected_reimbursement_cents, None);
    }

    #[test]
    fn reimbursement_raises_the_balance_and_offsets_the_expense_bucket() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        assert_eq!(balance(&c, &savings.id), 480_000);

        let r = reimburse(&c, &savings.id, 15_000, "2026-06-05", vec![alloc(&e, 15_000)]);

        assert_eq!(r.kind, "reimbursement");
        assert_eq!(r.category_id, None);
        assert_eq!(r.to_account_id, None);
        assert!(!r.excluded_from_reporting);
        assert_eq!(r.allocations, vec![alloc(&e, 15_000)]);
        assert_eq!(balance(&c, &savings.id), 495_000);
        let sum: i64 = c
            .query_row("SELECT COALESCE(SUM(amount_cents),0) FROM postings WHERE transaction_id=?1", [&r.id], |row| row.get(0))
            .unwrap();
        assert_eq!(sum, 0);
        let bucket: i64 = c
            .query_row(
                "SELECT amount_cents FROM postings WHERE transaction_id=?1 AND system_bucket='expense'",
                [&r.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bucket, -15_000);
        assert_eq!(repo::get_transaction(&c, &e.id).unwrap().reimbursed_cents, 15_000);
    }

    #[test]
    fn a_refund_can_land_on_the_card_that_was_charged() {
        let c = test_db();
        let (_savings, card) = pair(&c);
        let e = spend(&c, &card.id, 8_000, "2026-06-01");
        assert_eq!(balance(&c, &card.id), -88_000);
        reimburse(&c, &card.id, 8_000, "2026-06-03", vec![alloc(&e, 8_000)]);
        assert_eq!(balance(&c, &card.id), -80_000);
    }

    #[test]
    fn one_reimbursement_covers_many_and_one_expense_takes_parts() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e1 = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        reimburse(&c, &savings.id, 15_000, "2026-06-10", vec![alloc(&e1, 10_000), alloc(&e2, 5_000)]);
        assert_eq!(repo::get_transaction(&c, &e1.id).unwrap().reimbursed_cents, 10_000);
        assert_eq!(repo::get_transaction(&c, &e2.id).unwrap().reimbursed_cents, 5_000);

        let e3 = spend(&c, &savings.id, 10_000, "2026-06-03");
        reimburse(&c, &savings.id, 3_000, "2026-06-11", vec![alloc(&e3, 3_000)]);
        reimburse(&c, &savings.id, 2_000, "2026-06-12", vec![alloc(&e3, 2_000)]);
        assert_eq!(repo::get_transaction(&c, &e3.id).unwrap().reimbursed_cents, 5_000);

        let err = service::create_reimbursement(&c, &savings.id, 6_000, None, "2026-06-13", None, vec![alloc(&e3, 6_000)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Allocation exceeds what's left on that expense.");
    }

    #[test]
    fn create_rejects_each_bad_shape_without_writing() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 4_000, "2026-06-02");
        let inc_cat = income_cat(&c);
        let income = service::create_income(&c, &savings.id, Some(&inc_cat), 1_000, None, "2026-06-01", None, false, None).unwrap();

        let go = |amount: i64, allocs: Vec<Allocation>| {
            validation_message(
                service::create_reimbursement(&c, &savings.id, amount, None, "2026-06-02", None, allocs).unwrap_err(),
            )
        };
        assert_eq!(go(0, vec![alloc(&e, 1)]), "Amount must be greater than zero");
        assert_eq!(go(100, vec![]), "Pick at least one expense to reimburse.");
        assert_eq!(go(100, vec![alloc(&e, 0)]), "Each allocation must be greater than zero.");
        assert_eq!(go(200, vec![alloc(&e, 100), alloc(&e, 100)]), "An expense can only be listed once.");
        assert_eq!(go(100, vec![alloc(&income, 100)]), "Only expenses can be reimbursed.");
        assert_eq!(
            go(100, vec![Allocation { expense_id: "nope".into(), amount_cents: 100 }]),
            "Only expenses can be reimbursed."
        );
        assert_eq!(go(100, vec![alloc(&e, 60), alloc(&e2, 30)]), "Allocations must add up to the reimbursement amount.");
        assert_eq!(go(20_000, vec![alloc(&e, 20_000)]), "Allocation exceeds what's left on that expense.");
        // Huge client-supplied amounts must fail validation, never overflow.
        assert_eq!(go(i64::MAX, vec![alloc(&e, i64::MAX)]), "Allocation exceeds what's left on that expense.");
        assert_eq!(go(100, vec![alloc(&e, i64::MAX - 1), alloc(&e2, 100)]), "Allocation exceeds what's left on that expense.");

        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE kind='reimbursement'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn create_rejects_balance_corrections_and_archived_accounts() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-01");
        // A shortfall booked as an expense lands in the protected "Adjustment" category.
        service::set_account_balance(&c, &savings.id, 400_000, true).unwrap();
        let correction_id: String = c
            .query_row(
                "SELECT t.id FROM transactions t JOIN categories k ON k.id = t.category_id WHERE k.is_system = 1 AND t.kind = 'expense'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let correction = repo::get_transaction(&c, &correction_id).unwrap();
        let err = service::create_reimbursement(&c, &savings.id, 100, None, "2026-06-02", None, vec![alloc(&correction, 100)])
            .unwrap_err();
        assert_eq!(validation_message(err), "Only expenses can be reimbursed.");

        service::archive_account(&c, &savings.id).unwrap();
        let err = service::create_reimbursement(&c, &savings.id, 100, None, "2026-06-02", None, vec![alloc(&e, 100)])
            .unwrap_err();
        assert_eq!(conflict_message(err), "The selected account is archived");
    }

    #[test]
    fn allocations_hydrate_on_both_sides() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        let r = repo::insert_transaction(
            &c, "re1", "reimbursement", &savings.id, None, None, 15_000, Some("Back"),
            "2026-06-05", None, false, "2026-06-05T00:00:00Z",
        )
        .unwrap();
        repo::insert_allocation(&c, "al1", &r.id, &e.id, 15_000, "2026-06-05T00:00:00Z").unwrap();

        let expense = repo::get_transaction(&c, &e.id).unwrap();
        assert_eq!(expense.reimbursed_cents, 15_000);
        assert_eq!(expense.expected_reimbursement_cents, None);
        assert!(expense.allocations.is_empty());

        let reimbursement = repo::get_transaction(&c, &r.id).unwrap();
        assert_eq!(reimbursement.reimbursed_cents, 0);
        assert_eq!(
            reimbursement.allocations,
            vec![Allocation { expense_id: e.id.clone(), amount_cents: 15_000 }]
        );
    }

    #[test]
    fn factory_reset_clears_allocations() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-01");
        let r = repo::insert_transaction(
            &c, "re1", "reimbursement", &savings.id, None, None, 5_000, None,
            "2026-06-05", None, false, "2026-06-05T00:00:00Z",
        )
        .unwrap();
        repo::insert_allocation(&c, "al1", &r.id, &e.id, 5_000, "2026-06-05T00:00:00Z").unwrap();

        service::reset_app(&c).unwrap();

        let allocs: i64 = c.query_row("SELECT COUNT(*) FROM reimbursement_allocations", [], |row| row.get(0)).unwrap();
        let txns: i64 = c.query_row("SELECT COUNT(*) FROM transactions", [], |row| row.get(0)).unwrap();
        assert_eq!(allocs, 0);
        assert_eq!(txns, 0);
    }

    #[test]
    fn dashboard_uses_the_effective_expense_in_its_original_month() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 20_000, "2026-06-10");
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(before.expense_cents, 20_000);

        reimburse(&c, &savings.id, 15_000, "2026-07-03", vec![alloc(&e, 15_000)]);

        let june = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(june.expense_cents, 5_000);
        assert_eq!(june.income_cents, before.income_cents);
        assert_eq!(june.net_cashflow_cents, before.income_cents - 5_000);
        assert_eq!(june.spending_breakdown.len(), 1);
        assert_eq!(june.spending_breakdown[0].total_cents, 5_000);

        let july = service::get_dashboard_summary(&c, "2026-07").unwrap();
        assert_eq!(july.expense_cents, 0);
        assert_eq!(july.income_cents, 0);
    }

    #[test]
    fn a_split_expense_is_offset_in_proportion_across_its_lines() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let a = expense_cat(&c, 0);
        let b = expense_cat(&c, 1);
        let e = service::create_expense(
            &c, &savings.id, None, 10_000, None, "2026-06-10", None, false,
            Some(vec![
                SplitInput { category_id: a.clone(), amount_cents: 6_000 },
                SplitInput { category_id: b.clone(), amount_cents: 4_000 },
            ]),
        )
        .unwrap();
        reimburse(&c, &savings.id, 5_000, "2026-06-20", vec![alloc(&e, 5_000)]);

        let s = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(s.expense_cents, 5_000);
        let amount = |id: &str| s.spending_breakdown.iter().find(|x| x.category_id == id).map(|x| x.total_cents);
        assert_eq!(amount(&a), Some(3_000));
        assert_eq!(amount(&b), Some(2_000));
    }

    #[test]
    fn fully_reimbursed_and_excluded_expenses_report_correctly() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let full = spend(&c, &savings.id, 10_000, "2026-06-02");
        reimburse(&c, &savings.id, 10_000, "2026-06-03", vec![alloc(&full, 10_000)]);

        let cat = expense_cat(&c, 0);
        let excluded = service::create_expense(&c, &savings.id, Some(&cat), 7_000, None, "2026-06-04", None, true, None).unwrap();
        // Only partly repaid: the excluded expense and its allocation are both still skipped.
        reimburse(&c, &savings.id, 3_000, "2026-06-05", vec![alloc(&excluded, 3_000)]);

        let s = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(s.expense_cents, 0, "neither a fully repaid nor an excluded expense may go negative");
        assert!(s.spending_breakdown.is_empty());
    }

    #[test]
    fn a_reimbursement_never_counts_as_income() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e = spend(&c, &savings.id, 10_000, "2026-06-02");
        let before = service::get_dashboard_summary(&c, "2026-06").unwrap();
        reimburse(&c, &savings.id, 4_000, "2026-06-05", vec![alloc(&e, 4_000)]);
        let after = service::get_dashboard_summary(&c, "2026-06").unwrap();
        assert_eq!(after.income_cents, before.income_cents);
        assert_eq!(after.net_worth_cents, before.net_worth_cents + 4_000);
    }

    #[test]
    fn awaiting_summary_counts_outstanding_expectations_only() {
        let c = test_db();
        let (savings, _card) = pair(&c);
        let e1 = spend(&c, &savings.id, 10_000, "2026-06-01");
        let e2 = spend(&c, &savings.id, 5_000, "2026-06-02");
        let _plain = spend(&c, &savings.id, 3_000, "2026-06-03");
        service::set_expected_reimbursement(&c, &e1.id, Some(10_000)).unwrap();
        service::set_expected_reimbursement(&c, &e2.id, Some(5_000)).unwrap();

        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (2, 15_000));

        reimburse(&c, &savings.id, 4_000, "2026-06-10", vec![alloc(&e1, 4_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (2, 11_000));

        reimburse(&c, &savings.id, 6_000, "2026-06-11", vec![alloc(&e1, 6_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (1, 5_000));

        reimburse(&c, &savings.id, 5_000, "2026-06-12", vec![alloc(&e2, 5_000)]);
        let s = service::get_awaiting_reimbursement(&c).unwrap();
        assert_eq!((s.count, s.total_cents), (0, 0));
    }
}

#[cfg(test)]
mod plan_tests {
    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::models::*;
    use crate::service::{self, resolve_amount, shift_month};

    fn test_db() -> rusqlite::Connection {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn msg(err: AppError) -> String {
        err.to_string()
    }

    fn parent_and_child(conn: &rusqlite::Connection) -> (String, String) {
        // The seed already has a top-level expense category named Food.
        let food = service::create_category(conn, "Plan Food", "expense", "🍜", None, None).unwrap();
        let dining = service::create_category(conn, "Dining", "expense", "🍽️", None, Some(&food.id)).unwrap();
        (food.id, dining.id)
    }

    #[test]
    fn resolve_amount_uses_the_latest_version_on_or_before_the_month() {
        let versions = vec![
            ("2026-10".into(), Some(80_000)),
            ("2026-11".into(), None),
        ];
        assert_eq!(resolve_amount(&versions, "2026-09"), None);
        assert_eq!(resolve_amount(&versions, "2026-10"), Some(80_000));
        assert_eq!(resolve_amount(&versions, "2026-11"), None);
        assert_eq!(resolve_amount(&versions, "2026-12"), None);
    }

    #[test]
    fn set_budgets_versions_follow_the_current_month() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let today = crate::today();
        let current = &today[..7];
        let prev = shift_month(current, -1);
        let next = shift_month(current, 1);
        crate::repo::upsert_budget(&conn, "old", &food, &prev, Some(80_000), "t").unwrap();

        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(100_000) }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &prev), Some(80_000));
        assert_eq!(resolve_amount(&food_versions, current), Some(100_000));
        assert_eq!(resolve_amount(&food_versions, &next), Some(100_000));

        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(90_000) }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, current), Some(90_000), "a second edit replaces this month");

        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: None },
            BudgetWrite { category_id: dining, amount_cents: None },
        ]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &prev), Some(80_000));
        assert_eq!(resolve_amount(&food_versions, current), None);
    }

    #[test]
    fn set_budgets_rejects_a_bad_tree_and_keeps_the_old_amount() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        let income = service::list_categories(&conn, Some("income"), false).unwrap()[0].id.clone();
        let adjustment = service::list_categories(&conn, Some("expense"), true).unwrap()
            .into_iter().find(|c| c.is_system).unwrap().id;
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
        ]).unwrap();

        let err = service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(20_000) },
        ]).unwrap_err();
        assert_eq!(msg(err), "Subcategory budgets add up to more than the parent.");
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_amount = versions.iter().find(|v| v.0 == food).map(|v| v.2);
        assert_eq!(food_amount, Some(Some(80_000)), "the failed batch did not lower Food");

        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: dining.clone(), amount_cents: Some(1) }, BudgetWrite { category_id: food.clone(), amount_cents: None }]).unwrap_err()),
            "Set a budget on the parent category first."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: income, amount_cents: Some(1) }]).unwrap_err()),
            "Income categories can't have a budget."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: adjustment, amount_cents: Some(1) }]).unwrap_err()),
            "The Adjustment category can't have a budget."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(-1) }]).unwrap_err()),
            "A budget can't be negative."
        );
        assert_eq!(
            msg(service::set_budgets(&conn, &[
                BudgetWrite { category_id: food.clone(), amount_cents: Some(1) },
                BudgetWrite { category_id: food, amount_cents: Some(2) },
            ]).unwrap_err()),
            "A category can only be listed once."
        );
        service::set_budgets(&conn, &[]).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: dining.clone(), amount_cents: Some(0) }, BudgetWrite { category_id: parent_of(&conn, &dining), amount_cents: Some(0) }]).unwrap();
    }

    fn parent_of(conn: &rusqlite::Connection, id: &str) -> String {
        crate::repo::get_category(conn, id).unwrap().parent_id.unwrap()
    }

    #[test]
    fn archived_category_can_be_cleared_but_not_newly_budgeted() {
        let conn = open_in_memory().unwrap();
        let (food, _) = parent_and_child(&conn);
        service::archive_category(&conn, &food).unwrap();
        let err = service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: Some(1) }]).unwrap_err();
        assert_eq!(msg(err), "Archived categories can't be given a new budget.");
        let today = crate::today();
        crate::repo::upsert_budget(&conn, "pre", &food, &today[..7], Some(50), "t").unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: food.clone(), amount_cents: None }]).unwrap();
        let versions = crate::repo::list_budget_versions(&conn).unwrap();
        let food_versions: Vec<_> = versions.into_iter().filter(|v| v.0 == food).map(|v| (v.1, v.2)).collect();
        assert_eq!(resolve_amount(&food_versions, &today[..7]), None);
    }

    #[test]
    fn plan_spent_matches_the_dashboard_and_keeps_the_child() {
        let conn = test_db();
        let (food, dining) = parent_and_child(&conn);
        let groceries = service::create_category(&conn, "Groceries", "expense", "🛒", None, Some(&food)).unwrap();
        let acc = service::create_account(&conn, "Cash", "cash", 0, None, None, None, None).unwrap();
        let month = &crate::today()[..7];
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
        ]).unwrap();
        service::create_expense(&conn, &acc.id, Some(dining.as_str()), 30_000, None, &format!("{month}-02"), None, false, None).unwrap();
        service::create_expense(&conn, &acc.id, Some(groceries.id.as_str()), 10_000, None, &format!("{month}-03"), None, false, None).unwrap();
        let other = service::create_account(&conn, "Other", "savings", 0, None, None, None, None).unwrap();
        service::create_transfer(&conn, &acc.id, &other.id, 5_000, None, &format!("{month}-04"), None).unwrap();

        let plan = service::get_plan(&conn, month).unwrap();
        let row = |id: &str| plan.budgets.iter().find(|b| b.category_id == id).unwrap();
        assert_eq!(row(&dining).spent_cents, 30_000);
        assert_eq!(row(&food).spent_cents, 40_000);
        assert!(plan.budgets.iter().all(|b| b.category_id != groceries.id), "an unbudgeted child is absent");
        let dash = service::get_dashboard_summary(&conn, month).unwrap();
        let dash_food = dash.spending_breakdown.iter().find(|b| b.category_id == food).unwrap();
        assert_eq!(dash_food.total_cents, 40_000);

        let hidden = service::create_expense(&conn, &acc.id, Some(dining.as_str()), 9_000, None, &format!("{month}-05"), None, true, None).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == dining).unwrap().spent_cents, 30_000);
        let _ = hidden;

        let card = service::create_account(&conn, "Visa", "credit-card", 0, None, Some(500_000), None, None).unwrap();
        service::create_payment(&conn, &acc.id, &card.id, 4_000, None, &format!("{month}-06"), None).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == food).unwrap().spent_cents, 40_000);

        let owed = service::create_expense(&conn, &acc.id, Some(dining.as_str()), 5_000, None, &format!("{month}-07"), None, false, None).unwrap();
        let next = shift_month(month, 1);
        service::create_reimbursement(&conn, &acc.id, 2_000, None, &format!("{next}-01"), None, vec![Allocation { expense_id: owed.id, amount_cents: 2_000 }]).unwrap();
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == dining).unwrap().spent_cents, 33_000);
        assert_eq!(service::get_plan(&conn, month).unwrap().budgets.iter().find(|b| b.category_id == food).unwrap().spent_cents, 43_000);
    }

    #[test]
    fn moving_a_slice_is_rejected_when_the_new_parent_cannot_hold_it() {
        let conn = open_in_memory().unwrap();
        let (food, dining) = parent_and_child(&conn);
        // Seed already has a top-level expense category named Transport.
        let transport = service::create_category(&conn, "Plan Transport", "expense", "🚌", None, None).unwrap();
        service::set_budgets(&conn, &[
            BudgetWrite { category_id: food.clone(), amount_cents: Some(80_000) },
            BudgetWrite { category_id: dining.clone(), amount_cents: Some(25_000) },
            BudgetWrite { category_id: transport.id.clone(), amount_cents: Some(10_000) },
        ]).unwrap();
        let err = service::set_category_parent(&conn, &dining, Some(&transport.id)).unwrap_err();
        assert_eq!(msg(err), "This move would leave subcategory budgets that don't fit. Clear or lower them first.");
        assert_eq!(crate::repo::get_category(&conn, &dining).unwrap().parent_id.as_deref(), Some(food.as_str()));

        service::set_category_parent(&conn, &dining, None).unwrap();
        assert!(crate::repo::get_category(&conn, &dining).unwrap().parent_id.is_none());
    }

    #[test]
    fn deleting_a_category_deletes_its_budget_versions() {
        let conn = open_in_memory().unwrap();
        let lone = service::create_category(&conn, "Hobbies", "expense", "🎨", None, None).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: lone.id.clone(), amount_cents: Some(1_000) }]).unwrap();
        service::delete_category(&conn, &lone.id).unwrap();
        let left = crate::repo::list_budget_versions(&conn).unwrap();
        assert!(left.iter().all(|v| v.0 != lone.id));
    }

    #[test]
    fn monthly_required_matches_the_worked_examples() {
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 420_000, 1_000_000), Some(72_500));
        // Eight months (Oct through May), so ceil(1001/8) is 126. 334 is that gap over three months.
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 0, 1_001), Some(126));
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-01-01"), 0, 1_001), Some(334));
        assert_eq!(service::monthly_required("2026-10-14", None, 0, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-06-01"), 0, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2027-06-01"), 1_000, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-01-01"), 2_000, 1_000), None);
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-14"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-20"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-11-01"), 0, 500), Some(500));
        assert_eq!(service::monthly_required("2026-10-14", Some("2026-10-20"), -100, 500), Some(600));
    }

    #[test]
    fn a_goal_uses_the_live_balance_and_one_eligible_account() {
        let conn = open_in_memory().unwrap();
        let sav = service::create_account(&conn, "Maybank", "savings", 420_000, None, None, None, None).unwrap();
        let card = service::create_account(&conn, "Visa", "credit-card", 0, None, Some(500_000), None, None).unwrap();
        let goal = service::create_goal(&conn, GoalWrite {
            id: None, name: "  Emergency  ".into(), account_id: sav.id.clone(),
            target_cents: 1_000_000, target_date: Some("2027-06-01".into()),
        }).unwrap();
        assert_eq!(goal.name, "Emergency");
        assert_eq!(goal.balance_cents, 420_000);
        assert!(goal.monthly_cents.is_some());

        let err = service::create_goal(&conn, GoalWrite {
            id: None, name: "Holiday".into(), account_id: sav.id.clone(),
            target_cents: 1, target_date: None,
        }).unwrap_err();
        assert_eq!(msg(err), "This account already has a goal.");
        let err = service::create_goal(&conn, GoalWrite {
            id: None, name: "Card".into(), account_id: card.id.clone(),
            target_cents: 1, target_date: None,
        }).unwrap_err();
        assert_eq!(msg(err), "Goals can only sit on cash, an e-wallet, savings, or a current account.");
        let err = service::update_account(&conn, UpdateAccountInput {
            id: sav.id.clone(), name: None, subtype: Some("credit-card".into()),
            opening_balance_cents: None, credit_limit_cents: Some(100_000),
            value_categories: None,
        }).unwrap_err();
        assert_eq!(msg(err), "Delete this account's goal before changing its type.");

        service::archive_account(&conn, &sav.id).unwrap();
        assert!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.is_empty());
        service::restore_account(&conn, &sav.id).unwrap();
        assert_eq!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.len(), 1);

        service::delete_goal(&conn, &goal.id).unwrap();
        assert!(service::get_plan(&conn, &crate::today()[..7]).unwrap().goals.is_empty());
        assert_eq!(service::get_account(&conn, &sav.id).unwrap().balance_cents, 420_000);
    }

    #[test]
    fn factory_reset_clears_budgets_and_goals() {
        let conn = open_in_memory().unwrap();
        let sav = service::create_account(&conn, "Maybank", "savings", 0, None, None, None, None).unwrap();
        // Seed already has a top-level expense category named Food.
        let food = service::create_category(&conn, "Plan Food", "expense", "🍜", None, None).unwrap();
        service::set_budgets(&conn, &[BudgetWrite { category_id: food.id, amount_cents: Some(1) }]).unwrap();
        service::create_goal(&conn, GoalWrite {
            id: None, name: "Emergency".into(), account_id: sav.id, target_cents: 1, target_date: None,
        }).unwrap();
        service::reset_app(&conn).unwrap();
        assert_eq!(crate::repo::list_budget_versions(&conn).unwrap().len(), 0);
        let plan = service::get_plan(&conn, "2026-10").unwrap();
        assert!(plan.goals.is_empty());
    }

    #[test]
    fn update_goal_keeps_its_account_and_rejects_a_taken_one() {
        let conn = open_in_memory().unwrap();
        let sav = service::create_account(&conn, "Maybank", "savings", 0, None, None, None, None).unwrap();
        let cash = service::create_account(&conn, "Wallet", "cash", 0, None, None, None, None).unwrap();
        let current = service::create_account(&conn, "Checking", "current", 0, None, None, None, None).unwrap();
        let wallet = service::create_account(&conn, "TnG", "ewallet", 0, None, None, None, None).unwrap();
        let goal = service::create_goal(&conn, GoalWrite {
            id: None, name: "Emergency".into(), account_id: sav.id.clone(),
            target_cents: 500, target_date: Some("2027-06-01".into()),
        }).unwrap();

        let updated = service::update_goal(&conn, GoalWrite {
            id: Some(goal.id.clone()), name: "  Rainy day  ".into(), account_id: sav.id.clone(),
            target_cents: 800, target_date: None,
        }).unwrap();
        assert_eq!(updated.id, goal.id);
        assert_eq!(updated.name, "Rainy day");
        assert_eq!(updated.account_id, sav.id);
        assert_eq!(updated.target_cents, 800);
        assert!(updated.target_date.is_none());
        assert!(updated.monthly_cents.is_none());

        let moved = service::update_goal(&conn, GoalWrite {
            id: Some(goal.id.clone()), name: "Rainy day".into(), account_id: cash.id.clone(),
            target_cents: 800, target_date: None,
        }).unwrap();
        assert_eq!(moved.account_id, cash.id);

        service::create_goal(&conn, GoalWrite {
            id: None, name: "Holiday".into(), account_id: current.id.clone(),
            target_cents: 10, target_date: None,
        }).unwrap();
        service::create_goal(&conn, GoalWrite {
            id: None, name: "Phone".into(), account_id: wallet.id,
            target_cents: 10, target_date: None,
        }).unwrap();
        let err = service::update_goal(&conn, GoalWrite {
            id: Some(goal.id.clone()), name: "Rainy day".into(), account_id: current.id,
            target_cents: 800, target_date: None,
        }).unwrap_err();
        assert_eq!(msg(err), "This account already has a goal.");
        assert_eq!(
            msg(service::update_goal(&conn, GoalWrite {
                id: None, name: "Rainy day".into(), account_id: cash.id.clone(),
                target_cents: 800, target_date: None,
            }).unwrap_err()),
            "Goal not found"
        );
        assert_eq!(
            msg(service::update_goal(&conn, GoalWrite {
                id: Some(goal.id.clone()), name: "   ".into(), account_id: cash.id.clone(),
                target_cents: 800, target_date: None,
            }).unwrap_err()),
            "Goal name cannot be empty"
        );
        assert_eq!(
            msg(service::update_goal(&conn, GoalWrite {
                id: Some(goal.id.clone()), name: "Rainy day".into(), account_id: cash.id.clone(),
                target_cents: 0, target_date: None,
            }).unwrap_err()),
            "Target must be greater than zero."
        );
        assert_eq!(
            msg(service::update_goal(&conn, GoalWrite {
                id: Some(goal.id), name: "Rainy day".into(), account_id: cash.id.clone(),
                target_cents: 800, target_date: Some("2027-02-31".into()),
            }).unwrap_err()),
            "Date must be a real YYYY-MM-DD."
        );
        assert_eq!(msg(service::delete_goal(&conn, "missing").unwrap_err()), "Goal not found");

        service::archive_account(&conn, &cash.id).unwrap();
        assert_eq!(
            msg(service::create_goal(&conn, GoalWrite {
                id: None, name: "Again".into(), account_id: cash.id,
                target_cents: 1, target_date: None,
            }).unwrap_err()),
            "The selected account is archived"
        );
    }
}

#[cfg(test)]
mod schedule_tests {
    use chrono::{NaiveDate, NaiveDateTime};

    use crate::db::open_in_memory;
    use crate::error::AppError;
    use crate::models::{Account, ScheduleWrite, TransactionFilters};
    use crate::recurrence::{self, End, Freq, MonthMode, Ordinal, OrdinalDay, Rule};
    use crate::repo;
    use crate::schedules;
    use crate::service;
    use rusqlite::Connection;

    fn acct(conn: &rusqlite::Connection, name: &str, opening: i64) -> Account {
        service::create_account(conn, name, "savings", opening, None, None, None, None).unwrap()
    }

    fn income_cat(conn: &rusqlite::Connection) -> String {
        service::list_categories(conn, Some("income"), false)
            .unwrap()
            .into_iter()
            .find(|cat| !cat.is_system && cat.parent_id.is_none())
            .unwrap()
            .id
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").unwrap()
    }

    fn test_db() -> Connection {
        let c = open_in_memory().unwrap();
        service::set_setting(&c, "transaction_time_enabled", "0").unwrap();
        c
    }

    fn expense_cat(conn: &Connection) -> (String, String) {
        let cat = service::list_categories(conn, Some("expense"), false)
            .unwrap()
            .into_iter()
            .find(|cat| !cat.is_system && cat.parent_id.is_none())
            .unwrap();
        (cat.id, cat.name)
    }

    fn kinds(conn: &Connection, kind: &str) -> Vec<crate::models::Transaction> {
        service::list_transactions(conn, TransactionFilters { kind: Some(kind.into()), ..Default::default() }).unwrap()
    }

    fn table_count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn posting_count(conn: &Connection, id: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM postings WHERE transaction_id = ?1", [id], |row| row.get(0)).unwrap()
    }

    fn posting_sum(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM postings WHERE transaction_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn salary_schedule(account_id: &str, category_id: &str) -> ScheduleWrite {
        ScheduleWrite {
            mode: "auto".into(),
            kind: "income".into(),
            amount_cents: 500_000,
            account_id: account_id.into(),
            to_account_id: None,
            category_id: Some(category_id.into()),
            description: Some("Salary".into()),
            start_date: "2026-10-25".into(),
            time: Some("09:00".into()),
            frequency: "monthly".into(),
            interval: 1,
            weekdays: vec![],
            month_mode: Some("each".into()),
            month_days: vec![25],
            ordinal: None,
            ordinal_day: None,
            months: vec![],
            day_of_month: None,
            end_mode: "never".into(),
            end_count: None,
            end_date: None,
        }
    }

    #[test]
    fn auto_posts_at_the_schedule_time() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let input = salary_schedule(&a.id, &cat);
        let early = NaiveDateTime::parse_from_str("2026-10-25T08:00", "%Y-%m-%dT%H:%M").unwrap();
        schedules::create_schedule(&c, input.clone(), early).unwrap();
        assert!(schedules::run_pass(&c, early).unwrap().posted.is_empty());
        assert!(schedules::list_upcoming(&c, early).unwrap().is_empty());
        let due = NaiveDateTime::parse_from_str("2026-10-25T09:00", "%Y-%m-%dT%H:%M").unwrap();
        let pass = schedules::run_pass(&c, due).unwrap();
        assert_eq!(pass.posted.len(), 1);
        assert_eq!(pass.posted[0].transaction_date, "2026-10-25");
        assert_eq!(pass.posted[0].transaction_time.as_deref(), Some("09:00"));
        assert_eq!(pass.posted[0].amount_cents, 500_000);
        assert!(schedules::run_pass(&c, due).unwrap().posted.is_empty());
    }

    #[test]
    fn tap_posts_a_chosen_amount_and_stays_settled_after_delete() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        let due = at("2026-10-25T09:00");
        let saved = schedules::create_schedule(&c, input, due).unwrap();
        assert!(schedules::run_pass(&c, due).unwrap().posted.is_empty());
        let upcoming = schedules::list_upcoming(&c, due).unwrap();
        assert_eq!(upcoming.len(), 1);
        assert_eq!(upcoming[0].occurrence_date, "2026-10-25");
        assert_eq!(upcoming[0].label, "Salary");
        assert_eq!(upcoming[0].account_name, "Salary");
        assert_eq!(upcoming[0].amount_cents, 500_000);

        let posted = schedules::post_occurrence(&c, &saved.id, "2026-10-25", 125_000, due).unwrap();
        assert_eq!(posted.amount_cents, 125_000);
        assert_eq!(posted.kind, "income");
        assert_eq!(schedules::list_schedules(&c, due).unwrap()[0].amount_cents, 500_000);

        service::delete_transaction(&c, &posted.id).unwrap();
        assert!(schedules::list_upcoming(&c, due).unwrap().is_empty());
        assert!(schedules::run_pass(&c, due).unwrap().posted.is_empty());
        let row = repo::occurrence_status(&c, &saved.id, "2026-10-25").unwrap().unwrap();
        assert_eq!(row.status, "posted");
        assert!(row.transaction_id.is_none());
    }

    #[test]
    fn missed_months_post_for_auto_and_list_oldest_first_for_tap() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.start_date = "2026-01-01".into();
        input.month_days = vec![1];
        input.description = Some("Pay".into());
        let before = at("2025-12-01T12:00");
        schedules::create_schedule(&c, input.clone(), before).unwrap();
        let now = at("2026-03-15T12:00");
        let pass = schedules::run_pass(&c, now).unwrap();
        assert_eq!(
            pass.posted.iter().map(|t| t.transaction_date.as_str()).collect::<Vec<_>>(),
            vec!["2026-01-01", "2026-02-01", "2026-03-01"]
        );
        assert!(schedules::run_pass(&c, now).unwrap().posted.is_empty());

        input.mode = "tap".into();
        input.description = Some("Rent".into());
        schedules::create_schedule(&c, input.clone(), before).unwrap();
        for label in ["Alpha", "Beta"] {
            let mut one = input.clone();
            one.description = Some(label.into());
            one.start_date = "2026-03-01".into();
            one.frequency = "daily".into();
            one.month_mode = None;
            one.month_days = vec![];
            one.end_mode = "after".into();
            one.end_count = Some(1);
            schedules::create_schedule(&c, one, before).unwrap();
        }
        let upcoming = schedules::list_upcoming(&c, now).unwrap();
        assert_eq!(
            upcoming.iter().map(|row| row.occurrence_date.as_str()).collect::<Vec<_>>(),
            vec!["2026-01-01", "2026-02-01", "2026-03-01", "2026-03-01", "2026-03-01"]
        );
        assert_eq!(
            upcoming.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(),
            vec!["Rent", "Rent", "Alpha", "Beta", "Rent"]
        );
    }

    #[test]
    fn clock_jump_posts_the_missed_day_once() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let early = at("2026-10-24T22:00");
        schedules::create_schedule(&c, salary_schedule(&a.id, &cat), early).unwrap();
        assert_eq!(
            schedules::run_pass(&c, early).unwrap().next_wake_at.as_deref(),
            Some("2026-10-25T09:00")
        );
        let jumped = at("2026-10-28T08:00");
        let pass = schedules::run_pass(&c, jumped).unwrap();
        assert_eq!(pass.posted.len(), 1);
        assert_eq!(pass.posted[0].transaction_date, "2026-10-25");
        assert_eq!(pass.posted[0].transaction_time.as_deref(), Some("09:00"));
        assert_eq!(pass.next_wake_at.as_deref(), Some("2026-11-25T09:00"));
        assert!(schedules::run_pass(&c, jumped).unwrap().posted.is_empty());
    }

    #[test]
    fn skip_then_edit_keeps_the_skipped_date_and_moves_waiting_days() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Checking", 0);
        let (cat, _) = expense_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        input.kind = "expense".into();
        input.amount_cents = 80_000;
        input.description = Some("Rent".into());
        input.start_date = "2026-03-01".into();
        input.month_days = vec![1];
        let created = at("2026-02-01T12:00");
        let saved = schedules::create_schedule(&c, input.clone(), created).unwrap();
        let april = at("2026-04-15T12:00");
        schedules::skip_occurrence(&c, &saved.id, "2026-03-01", april).unwrap();
        input.amount_cents = 90_000;
        schedules::update_schedule(&c, &saved.id, input.clone(), april).unwrap();
        let upcoming = schedules::list_upcoming(&c, april)
            .unwrap()
            .into_iter()
            .filter(|row| row.schedule_id == saved.id)
            .collect::<Vec<_>>();
        assert!(upcoming.iter().all(|row| row.occurrence_date != "2026-03-01"));
        assert_eq!(
            upcoming.iter().find(|row| row.occurrence_date == "2026-04-01").unwrap().amount_cents,
            90_000
        );
        let skipped = repo::occurrence_status(&c, &saved.id, "2026-03-01").unwrap().unwrap();
        assert_eq!(skipped.status, "skipped");
        assert!(kinds(&c, "expense").iter().all(|t| t.transaction_date != "2026-03-01"));

        let mut waiting = input.clone();
        waiting.amount_cents = 80_000;
        waiting.description = Some("Waiting".into());
        let waiting_id = schedules::create_schedule(&c, waiting.clone(), created).unwrap().id;
        waiting.month_days = vec![5];
        schedules::update_schedule(&c, &waiting_id, waiting, april).unwrap();
        let moved = schedules::list_upcoming(&c, april)
            .unwrap()
            .into_iter()
            .filter(|row| row.schedule_id == waiting_id)
            .map(|row| row.occurrence_date)
            .collect::<Vec<_>>();
        assert_eq!(moved, vec!["2026-03-05".to_string(), "2026-04-05".to_string()]);

        let mut posted_input = input.clone();
        posted_input.amount_cents = 80_000;
        posted_input.description = Some("Posted".into());
        let posted_id = schedules::create_schedule(&c, posted_input.clone(), created).unwrap().id;
        let posted = schedules::post_occurrence(&c, &posted_id, "2026-03-01", 80_000, april).unwrap();
        posted_input.month_days = vec![5];
        schedules::update_schedule(&c, &posted_id, posted_input, april).unwrap();
        let still = kinds(&c, "expense").into_iter().find(|t| t.id == posted.id).unwrap();
        assert_eq!(still.transaction_date, "2026-03-01");
        assert_eq!(still.amount_cents, 80_000);
        let added = schedules::list_upcoming(&c, april)
            .unwrap()
            .into_iter()
            .filter(|row| row.schedule_id == posted_id)
            .map(|row| row.occurrence_date)
            .collect::<Vec<_>>();
        assert_eq!(added, vec!["2026-03-05".to_string(), "2026-04-05".to_string()]);
    }

    #[test]
    fn ten_daily_dates_with_two_skips_do_not_add_an_eleventh() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Cash", 0);
        let (cat, _) = expense_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        input.kind = "expense".into();
        input.frequency = "daily".into();
        input.start_date = "2026-10-01".into();
        input.month_mode = None;
        input.month_days = vec![];
        input.end_mode = "after".into();
        input.end_count = Some(10);
        let saved = schedules::create_schedule(&c, input, at("2026-09-01T12:00")).unwrap();
        let now = at("2026-10-11T12:00");
        schedules::skip_occurrence(&c, &saved.id, "2026-10-02", now).unwrap();
        schedules::skip_occurrence(&c, &saved.id, "2026-10-03", now).unwrap();

        let rule = Rule {
            start: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            frequency: Freq::Daily,
            interval: 1,
            weekdays: vec![],
            month_mode: MonthMode::Each,
            month_days: vec![],
            ordinal: Ordinal::First,
            ordinal_day: OrdinalDay::Weekday,
            months: vec![],
            day_of_month: 1,
            end: End::After(10),
        };
        let produced = recurrence::dates_through(&rule, NaiveDate::from_ymd_opt(2026, 10, 20).unwrap());
        assert_eq!(produced.len(), 10);
        assert!(!produced.iter().any(|date| date == &NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()));

        let upcoming = schedules::list_upcoming(&c, now).unwrap();
        let rows = repo::list_occurrences(&c, &saved.id).unwrap();
        let posted = rows.iter().filter(|row| row.status == "posted").count();
        let skipped = rows.iter().filter(|row| row.status == "skipped").count();
        assert_eq!(upcoming.len() + posted + skipped, 10);
        assert_eq!((upcoming.len(), posted, skipped), (8, 0, 2));
        assert!(!upcoming.iter().any(|row| row.occurrence_date == "2026-10-11"));
    }

    #[test]
    fn archived_account_blocks_post_and_still_allows_skip() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        let due = at("2026-10-25T10:00");
        let saved = schedules::create_schedule(&c, input, due).unwrap();
        service::archive_account(&c, &a.id).unwrap();
        let pass = schedules::run_pass(&c, due).unwrap();
        assert!(pass.posted.is_empty());
        assert_eq!(pass.next_wake_at.as_deref(), Some("2026-11-25T09:00"));
        let upcoming = schedules::list_upcoming(&c, due).unwrap();
        assert_eq!(upcoming.len(), 1);
        let err = schedules::post_occurrence(&c, &saved.id, "2026-10-25", 500_000, due).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        let message = err.to_string();
        assert_eq!(message, "The selected account is archived");
        assert_eq!(
            schedules::list_schedules(&c, due).unwrap()[0].block_reason.as_deref(),
            Some(message.as_str())
        );
        assert_eq!(
            schedules::list_upcoming(&c, due).unwrap()[0].block_reason.as_deref(),
            Some(message.as_str())
        );
        schedules::skip_occurrence(&c, &saved.id, "2026-10-25", due).unwrap();
        assert!(schedules::list_upcoming(&c, due).unwrap().is_empty());
    }

    #[test]
    fn time_is_required_when_on_and_stored_null_when_off() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.time = None;
        let err = schedules::create_schedule(&c, input.clone(), at("2026-10-25T08:00")).unwrap_err();
        assert_eq!(err.to_string(), "A time is required");
        input.time = Some("09:00".into());
        let saved = schedules::create_schedule(&c, input, at("2026-10-24T12:00")).unwrap();
        assert_eq!(saved.time.as_deref(), Some("09:00"));

        let c = test_db();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.time = Some("09:00".into());
        let saved = schedules::create_schedule(&c, input, at("2026-10-25T08:00")).unwrap();
        assert_eq!(saved.time, None);
        let income = kinds(&c, "income");
        assert_eq!(income.len(), 1);
        assert_eq!(income[0].transaction_date, "2026-10-25");
        assert_eq!(income[0].transaction_time, None);
    }

    #[test]
    fn delete_schedule_keeps_the_posted_transaction() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        input.start_date = "2026-01-01".into();
        input.month_days = vec![1];
        let saved = schedules::create_schedule(&c, input, at("2025-12-01T12:00")).unwrap();
        let now = at("2026-03-15T12:00");
        let posted = schedules::post_occurrence(&c, &saved.id, "2026-01-01", 500_000, now).unwrap();
        assert_eq!(schedules::list_upcoming(&c, now).unwrap().len(), 2);
        schedules::delete_schedule(&c, &saved.id).unwrap();
        assert!(kinds(&c, "income").iter().any(|t| t.id == posted.id));
        assert!(schedules::list_upcoming(&c, now).unwrap().is_empty());
        assert_eq!(table_count(&c, "schedules"), 0);
        assert_eq!(table_count(&c, "schedule_occurrences"), 0);
    }

    #[test]
    fn transfer_and_payment_balance_and_expense_lands_in_its_month() {
        let c = test_db();
        let from = acct(&c, "Checking", 0);
        let to = acct(&c, "Savings", 0);
        let card = service::create_account(&c, "Visa", "credit-card", -80_000, None, Some(1_000_000), None, None).unwrap();
        let (cat, cat_name) = expense_cat(&c);
        let now = at("2026-01-15T12:00");

        let mut transfer = salary_schedule(&from.id, &cat);
        transfer.kind = "transfer".into();
        transfer.category_id = None;
        transfer.to_account_id = Some(to.id.clone());
        transfer.amount_cents = 4_000;
        transfer.description = None;
        transfer.start_date = "2026-01-15".into();
        transfer.frequency = "daily".into();
        transfer.month_mode = None;
        transfer.month_days = vec![];
        transfer.end_mode = "after".into();
        transfer.end_count = Some(1);
        schedules::create_schedule(&c, transfer.clone(), now).unwrap();

        let mut payment = transfer.clone();
        payment.kind = "payment".into();
        payment.account_id = from.id.clone();
        payment.to_account_id = Some(card.id.clone());
        payment.amount_cents = 7_000;
        schedules::create_schedule(&c, payment.clone(), now).unwrap();

        let mut expense = salary_schedule(&from.id, &cat);
        expense.kind = "expense".into();
        expense.amount_cents = 12_345;
        expense.description = Some("Groceries".into());
        expense.start_date = "2026-01-15".into();
        expense.frequency = "daily".into();
        expense.month_mode = None;
        expense.month_days = vec![];
        expense.end_mode = "after".into();
        expense.end_count = Some(1);
        schedules::create_schedule(&c, expense, now).unwrap();

        let posted = kinds(&c, "transfer");
        assert_eq!(posted.len(), 1);
        assert_eq!(posting_count(&c, &posted[0].id), 2);
        assert_eq!(posting_sum(&c, &posted[0].id), 0);
        let paid = kinds(&c, "payment");
        assert_eq!(paid.len(), 1);
        assert_eq!(posting_count(&c, &paid[0].id), 2);
        assert_eq!(posting_sum(&c, &paid[0].id), 0);
        assert_eq!(service::get_dashboard_summary(&c, "2026-01").unwrap().expense_cents, 12_345);
        assert_eq!(service::get_dashboard_summary(&c, "2026-02").unwrap().expense_cents, 0);

        transfer.mode = "tap".into();
        payment.mode = "tap".into();
        schedules::create_schedule(&c, transfer, now).unwrap();
        schedules::create_schedule(&c, payment, now).unwrap();
        let mut named = salary_schedule(&from.id, &cat);
        named.mode = "tap".into();
        named.kind = "expense".into();
        named.description = None;
        named.start_date = "2026-01-15".into();
        named.frequency = "daily".into();
        named.month_mode = None;
        named.month_days = vec![];
        named.end_mode = "after".into();
        named.end_count = Some(1);
        schedules::create_schedule(&c, named, now).unwrap();
        let upcoming = schedules::list_upcoming(&c, now).unwrap();
        assert!(upcoming.iter().any(|row| row.kind == "transfer" && row.label == "Transfer"));
        assert!(upcoming.iter().any(|row| row.kind == "payment" && row.label == "Payment"));
        assert!(upcoming.iter().any(|row| row.kind == "expense" && row.label == cat_name));
    }

    #[test]
    fn factory_reset_leaves_schedule_tables_empty() {
        let c = test_db();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.start_date = "2026-01-01".into();
        input.month_days = vec![1];
        schedules::create_schedule(&c, input, at("2026-01-15T12:00")).unwrap();
        assert!(table_count(&c, "schedules") > 0);
        assert!(table_count(&c, "schedule_occurrences") > 0);
        service::reset_app(&c).unwrap();
        assert_eq!(table_count(&c, "schedules"), 0);
        assert_eq!(table_count(&c, "schedule_occurrences"), 0);
    }

    #[test]
    fn post_and_skip_reject_future_off_rule_and_settled_dates() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        input.start_date = "2026-01-01".into();
        input.month_days = vec![1];
        let saved = schedules::create_schedule(&c, input, at("2025-12-01T12:00")).unwrap();
        let now = at("2026-03-15T12:00");
        let not_due = "That date is not due.";
        let not_on = "That date is not on this schedule.";
        let settled = "That date was already posted or skipped.";
        assert_eq!(schedules::post_occurrence(&c, &saved.id, "2026-04-01", 100, now).unwrap_err().to_string(), not_due);
        assert_eq!(schedules::skip_occurrence(&c, &saved.id, "2026-04-01", now).unwrap_err().to_string(), not_due);
        assert_eq!(schedules::post_occurrence(&c, &saved.id, "2026-03-02", 100, now).unwrap_err().to_string(), not_on);
        assert_eq!(schedules::skip_occurrence(&c, &saved.id, "2026-03-02", now).unwrap_err().to_string(), not_on);
        schedules::skip_occurrence(&c, &saved.id, "2026-03-01", now).unwrap();
        assert_eq!(schedules::post_occurrence(&c, &saved.id, "2026-03-01", 100, now).unwrap_err().to_string(), settled);
        assert_eq!(schedules::skip_occurrence(&c, &saved.id, "2026-03-01", now).unwrap_err().to_string(), settled);
        schedules::post_occurrence(&c, &saved.id, "2026-02-01", 100, now).unwrap();
        assert_eq!(schedules::post_occurrence(&c, &saved.id, "2026-02-01", 100, now).unwrap_err().to_string(), settled);
        assert_eq!(schedules::skip_occurrence(&c, &saved.id, "2026-02-01", now).unwrap_err().to_string(), settled);
    }

    #[test]
    fn switching_to_auto_posts_waiting_dates_and_switching_back_keeps_them() {
        let c = open_in_memory().unwrap();
        let a = acct(&c, "Salary", 0);
        let cat = income_cat(&c);
        let mut input = salary_schedule(&a.id, &cat);
        input.mode = "tap".into();
        input.amount_cents = 10_000;
        input.start_date = "2026-01-01".into();
        input.month_days = vec![1];
        input.description = Some("Pay".into());
        let saved = schedules::create_schedule(&c, input.clone(), at("2025-12-01T08:00")).unwrap();
        let now = at("2026-02-15T12:00");
        assert_eq!(schedules::list_upcoming(&c, now).unwrap().len(), 2);
        input.mode = "auto".into();
        input.amount_cents = 25_000;
        schedules::update_schedule(&c, &saved.id, input.clone(), now).unwrap();
        let mut dates = kinds(&c, "income").into_iter().map(|t| (t.transaction_date, t.amount_cents)).collect::<Vec<_>>();
        dates.sort();
        assert_eq!(dates, vec![("2026-01-01".into(), 25_000), ("2026-02-01".into(), 25_000)]);

        input.mode = "tap".into();
        schedules::update_schedule(&c, &saved.id, input, now).unwrap();
        assert_eq!(kinds(&c, "income").len(), 2);
        assert!(schedules::run_pass(&c, now).unwrap().posted.is_empty());
        assert!(schedules::list_upcoming(&c, now).unwrap().is_empty());
    }
}
