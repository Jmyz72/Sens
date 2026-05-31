//! Idempotent seed data: the built-in MYR provider template catalog and the
//! default categories. Templates upsert on their stable `key`; categories use
//! `INSERT OR IGNORE` against the unique `(kind, name)` index so re-running the
//! seed never duplicates and new defaults can be added later (see the spec's
//! Seed Data Strategy).

use crate::error::AppResult;
use rusqlite::Connection;

/// (key, name, group_name, default_subtype, sort_order). `group_name` only
/// organises the provider picker in the UI; `default_subtype` is a suggested
/// starting subtype. The authoritative type/group for an account come from the
/// `account_subtypes` taxonomy (seeded by migration 002), not from the template.
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
    let crypto = [("luno", "Luno")];

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
    push(&crypto, "Crypto", "crypto", &mut order);
    out
}

/// (name, kind, emoji, color, sort_order)
const CATEGORIES: &[(&str, &str, &str, &str, i64)] = &[
    // Income
    ("Salary", "income", "\u{1F4B0}", "#46d39a", 0),
    ("Bonus", "income", "\u{1F389}", "#3fcf8e", 1),
    ("Freelance", "income", "\u{1F4BB}", "#5aa66d", 2),
    ("Gift", "income", "\u{1F381}", "#56b3c4", 3),
    ("Investments", "income", "\u{1F4C8}", "#2fbf71", 4),
    ("Other Income", "income", "\u{2795}", "#7bbf8f", 5),
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

/// (parent_kind, parent_name, child_name, emoji, color, sort_order). Seeded as
/// non-system rows; users may archive or delete any they don't want.
const SUBCATEGORIES: &[(&str, &str, &str, &str, &str, i64)] = &[
    // Expense
    ("expense", "Food", "Dining out",        "\u{1F37D}\u{FE0F}", "#e0a13c", 0),
    ("expense", "Food", "Coffee",            "\u{2615}",  "#c08a4a", 1),
    ("expense", "Food", "Delivery/Takeaway", "\u{1F6F5}", "#d99a3c", 2),
    ("expense", "Food", "Snacks",            "\u{1F36A}", "#e3b15c", 3),
    ("expense", "Transport", "Fuel",            "\u{26FD}", "#8b7bd8", 0),
    ("expense", "Transport", "Parking & Tolls", "\u{1F17F}\u{FE0F}", "#9a8be0", 1),
    ("expense", "Transport", "Ride-hailing",    "\u{1F695}", "#7d6dd0", 2),
    ("expense", "Transport", "Public transit",  "\u{1F687}", "#a89bea", 3),
    ("expense", "Transport", "Car maintenance", "\u{1F527}", "#6f5fc0", 4),
    ("expense", "Bills", "Rent",          "\u{1F3E0}", "#56b3c4", 0),
    ("expense", "Bills", "Electricity",   "\u{1F4A1}", "#5fbecf", 1),
    ("expense", "Bills", "Water",         "\u{1F6BF}", "#4aa6b8", 2),
    ("expense", "Bills", "Internet",      "\u{1F4F6}", "#63c5d6", 3),
    ("expense", "Bills", "Mobile",        "\u{1F4F1}", "#52aebf", 4),
    ("expense", "Bills", "Subscriptions", "\u{1F4FA}", "#48a2b4", 5),
    ("expense", "Shopping", "Clothing",    "\u{1F457}", "#d9728f", 0),
    ("expense", "Shopping", "Electronics", "\u{1F50C}", "#e07f9a", 1),
    ("expense", "Shopping", "Home",        "\u{1F6CB}\u{FE0F}", "#cf6685", 2),
    ("expense", "Shopping", "Gifts",       "\u{1F381}", "#e58aa3", 3),
    ("expense", "Health", "Pharmacy",      "\u{1F48A}", "#f0708c", 0),
    ("expense", "Health", "Clinic/Doctor", "\u{1FA7A}", "#f37e98", 1),
    ("expense", "Health", "Insurance",     "\u{1F6E1}\u{FE0F}", "#e96680", 2),
    ("expense", "Health", "Fitness",       "\u{1F3CB}\u{FE0F}", "#f58aa2", 3),
    ("expense", "Entertainment", "Movies", "\u{1F3AC}", "#a78bfa", 0),
    ("expense", "Entertainment", "Games",  "\u{1F3AE}", "#b39bfb", 1),
    ("expense", "Entertainment", "Events",  "\u{1F39F}\u{FE0F}", "#9b7df9", 2),
    ("expense", "Entertainment", "Hobbies", "\u{1F3A8}", "#bfa9fc", 3),
    ("expense", "Education", "Courses", "\u{1F393}", "#5b8def", 0),
    ("expense", "Education", "Books",   "\u{1F4D6}", "#6b97f1", 1),
    ("expense", "Education", "Tuition", "\u{1F9D1}", "#4f83ed", 2),
    ("expense", "Travel", "Flights",       "\u{2708}\u{FE0F}",  "#33c9d6", 0),
    ("expense", "Travel", "Accommodation", "\u{1F3E8}", "#45d0dc", 1),
    ("expense", "Travel", "Activities",    "\u{1F3DD}\u{FE0F}", "#28bdca", 2),
    // Income
    ("income", "Salary", "Base pay",   "\u{1F4B5}", "#46d39a", 0),
    ("income", "Salary", "Overtime",   "\u{23F0}",  "#52d8a2", 1),
    ("income", "Salary", "Allowances", "\u{1F9FE}", "#3fcf8e", 2),
    ("income", "Salary", "Commission", "\u{1F4CA}", "#5bddaa", 3),
    ("income", "Freelance", "Projects",   "\u{1F4BB}", "#5aa66d", 0),
    ("income", "Freelance", "Consulting", "\u{1F4BC}", "#66b079", 1),
    ("income", "Investments", "Dividends",     "\u{1F4B9}", "#3fcf8e", 0),
    ("income", "Investments", "Interest",      "\u{1F3E6}", "#4bd699", 1),
    ("income", "Investments", "Capital gains", "\u{1F4C8}", "#37c886", 2),
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
    seed_categories(conn, now)?;
    Ok(())
}

/// Idempotent: inserts default top-level categories and subcategories via
/// INSERT OR IGNORE (deduped by the partial unique indexes). Safe to re-run;
/// used by both first-run seeding and the existing-user backfill.
pub fn seed_categories(conn: &Connection, now: &str) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    for (name, kind, emoji, color, sort) in CATEGORIES {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO categories
               (id, name, kind, emoji, color, sort_order, is_archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
            rusqlite::params![id, name, kind, emoji, color, sort, now],
        )?;
    }
    for (parent_kind, parent_name, child_name, emoji, color, sort) in SUBCATEGORIES {
        let parent_id: Option<String> = conn
            .query_row(
                "SELECT id FROM categories WHERE kind = ?1 AND name = ?2 AND parent_id IS NULL",
                rusqlite::params![parent_kind, parent_name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(pid) = parent_id {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT OR IGNORE INTO categories
                   (id, name, kind, emoji, color, parent_id, sort_order, is_archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
                rusqlite::params![id, child_name, parent_kind, emoji, color, pid, sort, now],
            )?;
        }
    }
    Ok(())
}
