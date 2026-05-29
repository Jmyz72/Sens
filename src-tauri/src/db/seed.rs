//! Idempotent seed data: the built-in MYR provider template catalog and the
//! default categories. Templates upsert on their stable `key`; categories use
//! `INSERT OR IGNORE` against the unique `(kind, name)` index so re-running the
//! seed never duplicates and new defaults can be added later (see the spec's
//! Seed Data Strategy).

use crate::error::AppResult;
use rusqlite::Connection;

/// (key, name, group_name, default_subtype, sort_order). The account_type is
/// derived from the group at account-creation time (see service layer).
struct Tpl(&'static str, &'static str, &'static str, &'static str, i64);

fn templates() -> Vec<Tpl> {
    let banks = [
        ("maybank", "Maybank"), ("cimb", "CIMB"), ("public-bank", "Public Bank"),
        ("rhb", "RHB"), ("hong-leong-bank", "Hong Leong Bank"), ("ambank", "AmBank"),
        ("bank-islam", "Bank Islam"), ("bank-rakyat", "Bank Rakyat"),
        ("bank-muamalat", "Bank Muamalat"), ("affin-bank", "Affin Bank"),
        ("alliance-bank", "Alliance Bank"), ("bsn", "BSN"), ("agrobank", "Agrobank"),
        ("mbsb-bank", "MBSB Bank"), ("al-rajhi-bank", "Al Rajhi Bank"),
        ("ocbc", "OCBC"), ("uob", "UOB"), ("hsbc", "HSBC"),
        ("standard-chartered", "Standard Chartered"),
    ];
    let digital = [
        ("gxbank", "GXBank"), ("boost-bank", "Boost Bank"), ("aeon-bank", "AEON Bank"),
        ("kaf-digital-bank", "KAF Digital Bank"), ("ryt-bank", "Ryt Bank"),
    ];
    let ewallets = [
        ("tng-ewallet", "Touch 'n Go eWallet"), ("grabpay", "GrabPay"), ("boost", "Boost"),
        ("shopeepay", "ShopeePay"), ("mae", "MAE"), ("setel", "Setel"),
        ("bigpay", "BigPay"), ("lazada-wallet", "Lazada Wallet"),
    ];
    let bnpl = [
        ("atome", "Atome"), ("shopee-paylater", "Shopee PayLater"),
        ("grab-paylater", "Grab PayLater"), ("boost-payflex", "Boost PayFlex"),
        ("riipay", "Riipay"),
    ];
    let investment = [
        ("asnb", "ASNB"), ("stashaway", "StashAway"), ("versa", "Versa"),
        ("wahed", "Wahed"), ("rakuten-trade", "Rakuten Trade"), ("moomoo", "Moomoo"),
        ("kdi", "KDI"),
    ];
    let fintech = [
        ("paypal", "PayPal"), ("wise", "Wise"), ("revolut", "Revolut"),
        ("n26", "N26"), ("payoneer", "Payoneer"),
    ];

    let mut out = Vec::new();
    let mut order = 0i64;
    let mut push = |list: &[(&'static str, &'static str)], group: &'static str, sub: &'static str, order: &mut i64| {
        for (k, n) in list {
            out.push(Tpl(k, n, group, sub, *order));
            *order += 1;
        }
    };
    push(&banks, "Banks", "savings", &mut order);
    push(&digital, "Digital banks", "savings", &mut order);
    push(&ewallets, "E-wallets", "ewallet", &mut order);
    push(&bnpl, "Buy now, pay later", "bnpl", &mut order);
    push(&investment, "Investment", "investment", &mut order);
    push(&fintech, "Global fintech", "ewallet", &mut order);
    out
}

/// (name, kind, emoji, color, sort_order)
const CATEGORIES: &[(&str, &str, &str, &str, i64)] = &[
    // Income
    ("Salary", "income", "\u{1F4B0}", "#46d39a", 0),
    ("Bonus", "income", "\u{1F389}", "#3fcf8e", 1),
    ("Freelance", "income", "\u{1F4BB}", "#5aa66d", 2),
    ("Gift", "income", "\u{1F381}", "#56b3c4", 3),
    ("Other Income", "income", "\u{2795}", "#7bbf8f", 4),
    // Expense
    ("Food", "expense", "\u{1F354}", "#e0a13c", 10),
    ("Transport", "expense", "\u{1F697}", "#8b7bd8", 11),
    ("Bills", "expense", "\u{1F9FE}", "#56b3c4", 12),
    ("Shopping", "expense", "\u{1F6CD}", "#d9728f", 13),
    ("Health", "expense", "\u{1F3E5}", "#f0708c", 14),
    ("Entertainment", "expense", "\u{1F3AC}", "#a78bfa", 15),
    ("Groceries", "expense", "\u{1F6D2}", "#5aa66d", 16),
    ("Education", "expense", "\u{1F4DA}", "#5b8def", 17),
    ("Travel", "expense", "\u{2708}", "#33c9d6", 18),
    ("Other Expense", "expense", "\u{1F4B8}", "#9aa4b2", 19),
    // Transfer
    ("Transfer", "transfer", "\u{1F501}", "#9aa4b2", 30),
];

pub fn seed(conn: &Connection, now: &str) -> AppResult<()> {
    for t in templates() {
        conn.execute(
            "INSERT OR IGNORE INTO account_templates
               (key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 1)",
            rusqlite::params![t.0, t.1, t.2, t.3, t.0, t.4],
        )?;
    }
    for (name, kind, emoji, color, sort) in CATEGORIES {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO categories
               (id, name, kind, emoji, color, sort_order, is_system, is_archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?7)",
            rusqlite::params![id, name, kind, emoji, color, sort, now],
        )?;
    }
    Ok(())
}
