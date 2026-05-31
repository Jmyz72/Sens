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

/// (name, kind, emoji, color, sort_order). Append-only by convention: the
/// backfill (see `db::mod`) can INSERT but never rename or delete, so renaming
/// a default here would leave existing users with both the old and new row.
/// Saving/investing, loan/debt servicing, reimbursements and credit-card
/// payments are intentionally NOT categories — they get dedicated features in
/// later phases (see ROADMAP) and are money-movement, not spend/earn.
const CATEGORIES: &[(&str, &str, &str, &str, i64)] = &[
    // Income
    ("Salary", "income", "\u{1F4B0}", "#46d39a", 0),
    ("Bonus", "income", "\u{1F389}", "#3fcf8e", 1),
    ("Freelance", "income", "\u{1F4BB}", "#5aa66d", 2),
    ("Business", "income", "\u{1F3EA}", "#4bd699", 3),
    ("Rental Income", "income", "\u{1F3D8}\u{FE0F}", "#5bddaa", 4),
    ("Government & Aid", "income", "\u{1F3DB}\u{FE0F}", "#37c886", 5),
    ("Cashback & Rewards", "income", "\u{1FA99}", "#66b079", 6),
    ("Gift", "income", "\u{1F381}", "#56b3c4", 7),
    ("Other Income", "income", "\u{2795}", "#7bbf8f", 8),
    // Expense
    ("Food", "expense", "\u{1F354}", "#e0a13c", 10),
    ("Groceries", "expense", "\u{1F6D2}", "#5aa66d", 11),
    ("Transport", "expense", "\u{1F697}", "#8b7bd8", 12),
    ("Bills", "expense", "\u{1F9FE}", "#56b3c4", 13),
    ("Family & Dependents", "expense", "\u{1F46A}", "#e08a5c", 14),
    ("Kids", "expense", "\u{1F9F8}", "#f0a868", 15),
    ("Insurance & Protection", "expense", "\u{1F6E1}\u{FE0F}", "#e96680", 16),
    ("Health", "expense", "\u{1F3E5}", "#f0708c", 17),
    ("Personal Care", "expense", "\u{1F488}", "#d98fb0", 18),
    ("Shopping", "expense", "\u{1F6CD}", "#d9728f", 19),
    ("Home & Living", "expense", "\u{1F3E1}", "#c98a6a", 20),
    ("Entertainment", "expense", "\u{1F3AC}", "#a78bfa", 21),
    ("Education", "expense", "\u{1F4DA}", "#5b8def", 22),
    ("Travel", "expense", "\u{2708}", "#33c9d6", 23),
    ("Donations & Religious", "expense", "\u{1F64F}", "#b39bd8", 24),
    ("Government & Fees", "expense", "\u{1F3DB}\u{FE0F}", "#7a93c4", 25),
    ("Pets", "expense", "\u{1F43E}", "#9ab06a", 26),
    ("Fees & Charges", "expense", "\u{1F4B3}", "#9aa4b2", 27),
    ("Other Expense", "expense", "\u{1F4B8}", "#9aa4b2", 28),
    // Transfer
    ("Transfer", "transfer", "\u{1F501}", "#9aa4b2", 30),
];

/// (parent_kind, parent_name, child_name, emoji, color, sort_order). Seeded as
/// non-system rows; users may archive or delete any they don't want.
const SUBCATEGORIES: &[(&str, &str, &str, &str, &str, i64)] = &[
    // Expense
    ("expense", "Food", "Dining out",        "\u{1F37D}\u{FE0F}", "#e0a13c", 0),
    ("expense", "Food", "Mamak/Kopitiam",    "\u{1F35C}", "#dba24a", 1),
    ("expense", "Food", "Coffee",            "\u{2615}",  "#c08a4a", 2),
    ("expense", "Food", "Bubble tea/Drinks", "\u{1F9CB}", "#e0b060", 3),
    ("expense", "Food", "Delivery/Takeaway", "\u{1F6F5}", "#d99a3c", 4),
    ("expense", "Food", "Snacks",            "\u{1F36A}", "#e3b15c", 5),
    ("expense", "Groceries", "Supermarket",       "\u{1F6D2}", "#5aa66d", 0),
    ("expense", "Groceries", "Wet market",        "\u{1F41F}", "#6cb47d", 1),
    ("expense", "Groceries", "Convenience store", "\u{1F3EA}", "#4f9862", 2),
    ("expense", "Transport", "Fuel",            "\u{26FD}", "#8b7bd8", 0),
    ("expense", "Transport", "TnG/Toll reload", "\u{1F6E3}\u{FE0F}", "#9a8be0", 1),
    ("expense", "Transport", "Parking & Tolls", "\u{1F17F}\u{FE0F}", "#9a8be0", 2),
    ("expense", "Transport", "Ride-hailing",    "\u{1F695}", "#7d6dd0", 3),
    ("expense", "Transport", "Public transit",  "\u{1F687}", "#a89bea", 4),
    ("expense", "Transport", "Car maintenance", "\u{1F527}", "#6f5fc0", 5),
    ("expense", "Bills", "Rent",          "\u{1F3E0}", "#56b3c4", 0),
    ("expense", "Bills", "Electricity",   "\u{1F4A1}", "#5fbecf", 1),
    ("expense", "Bills", "Water",         "\u{1F6BF}", "#4aa6b8", 2),
    ("expense", "Bills", "Internet",      "\u{1F4F6}", "#63c5d6", 3),
    ("expense", "Bills", "Mobile",        "\u{1F4F1}", "#52aebf", 4),
    ("expense", "Bills", "Astro/TV",      "\u{1F4E1}", "#4f9fb0", 5),
    ("expense", "Bills", "Subscriptions", "\u{1F4FA}", "#48a2b4", 6),
    ("expense", "Family & Dependents", "Parents' allowance", "\u{1F474}", "#e08a5c", 0),
    ("expense", "Family & Dependents", "Childcare/Nursery",  "\u{1F476}", "#e6976c", 1),
    ("expense", "Family & Dependents", "School fees",        "\u{1F3EB}", "#da7f50", 2),
    ("expense", "Family & Dependents", "Maid/Helper",        "\u{1F9F9}", "#eba074", 3),
    ("expense", "Family & Dependents", "Pocket money",       "\u{1F4B5}", "#d97848", 4),
    ("expense", "Kids", "Diapers/Milk",      "\u{1F37C}", "#f0a868", 0),
    ("expense", "Kids", "Toys",              "\u{1F9F8}", "#f3b67e", 1),
    ("expense", "Kids", "Activities/Classes", "\u{26BD}",  "#ed9a54", 2),
    ("expense", "Kids", "School supplies",   "\u{270F}\u{FE0F}", "#f5be8c", 3),
    ("expense", "Insurance & Protection", "Life/Medical",   "\u{1F3E5}", "#e96680", 0),
    ("expense", "Insurance & Protection", "Car (Takaful)",  "\u{1F697}", "#ee7891", 1),
    ("expense", "Insurance & Protection", "Home",           "\u{1F3E0}", "#e35a76", 2),
    ("expense", "Insurance & Protection", "Travel",         "\u{2708}\u{FE0F}", "#f0859b", 3),
    ("expense", "Health", "Pharmacy",      "\u{1F48A}", "#f0708c", 0),
    ("expense", "Health", "Clinic/Doctor", "\u{1FA7A}", "#f37e98", 1),
    ("expense", "Health", "Dental",        "\u{1F9B7}", "#ee6a87", 2),
    ("expense", "Health", "Optical",       "\u{1F453}", "#f58aa2", 3),
    ("expense", "Health", "Mental health", "\u{1F9E0}", "#f0738e", 4),
    ("expense", "Health", "Fitness",       "\u{1F3CB}\u{FE0F}", "#f58aa2", 5),
    ("expense", "Personal Care", "Haircut/Salon",       "\u{1F487}", "#d98fb0", 0),
    ("expense", "Personal Care", "Skincare/Cosmetics",  "\u{1F484}", "#e09cbb", 1),
    ("expense", "Personal Care", "Spa/Grooming",        "\u{1F486}", "#d385a8", 2),
    ("expense", "Personal Care", "Laundry",             "\u{1F9FA}", "#e6a8c4", 3),
    ("expense", "Shopping", "Clothing",    "\u{1F457}", "#d9728f", 0),
    ("expense", "Shopping", "Electronics", "\u{1F50C}", "#e07f9a", 1),
    ("expense", "Shopping", "Home",        "\u{1F6CB}\u{FE0F}", "#cf6685", 2),
    ("expense", "Shopping", "Gifts",       "\u{1F381}", "#e58aa3", 3),
    ("expense", "Home & Living", "Furniture",          "\u{1F6CB}\u{FE0F}", "#c98a6a", 0),
    ("expense", "Home & Living", "Appliances",         "\u{1F50C}", "#d1977a", 1),
    ("expense", "Home & Living", "Repairs/Maintenance", "\u{1F527}", "#c08160", 2),
    ("expense", "Home & Living", "Cleaning supplies",  "\u{1F9FC}", "#d9a288", 3),
    ("expense", "Home & Living", "Renovation",         "\u{1F6E0}\u{FE0F}", "#b87a58", 4),
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
    ("expense", "Donations & Religious", "Zakat",           "\u{1F54C}", "#b39bd8", 0),
    ("expense", "Donations & Religious", "Tithe/Offering",  "\u{26EA}", "#bda8e0", 1),
    ("expense", "Donations & Religious", "Sedekah/Charity", "\u{1F932}", "#a78ed0", 2),
    ("expense", "Donations & Religious", "Temple/Church",   "\u{1F6D5}", "#c7b3e8", 3),
    ("expense", "Government & Fees", "Road tax",         "\u{1F697}", "#7a93c4", 0),
    ("expense", "Government & Fees", "Saman/Summons",    "\u{1F6A8}", "#8aa0cc", 1),
    ("expense", "Government & Fees", "JPJ/Immigration",  "\u{1F6C2}", "#6f88bc", 2),
    ("expense", "Government & Fees", "Passport/Visa",    "\u{1F4D8}", "#97aad4", 3),
    ("expense", "Pets", "Food",     "\u{1F9B4}", "#9ab06a", 0),
    ("expense", "Pets", "Vet",      "\u{1F436}", "#a8bb7c", 1),
    ("expense", "Pets", "Grooming", "\u{2702}\u{FE0F}", "#8da55e", 2),
    ("expense", "Pets", "Supplies", "\u{1F43E}", "#b3c48e", 3),
    ("expense", "Fees & Charges", "Bank charges",     "\u{1F3E6}", "#9aa4b2", 0),
    ("expense", "Fees & Charges", "ATM/transfer fees", "\u{1F3E7}", "#a6afbc", 1),
    ("expense", "Fees & Charges", "Late fees",        "\u{23F0}", "#8e99a8", 2),
    ("expense", "Fees & Charges", "Service charge",   "\u{1F9FE}", "#b2bac6", 3),
    // Income
    ("income", "Salary", "Base pay",   "\u{1F4B5}", "#46d39a", 0),
    ("income", "Salary", "Overtime",   "\u{23F0}",  "#52d8a2", 1),
    ("income", "Salary", "Allowances", "\u{1F9FE}", "#3fcf8e", 2),
    ("income", "Salary", "Commission", "\u{1F4CA}", "#5bddaa", 3),
    ("income", "Bonus", "Annual bonus", "\u{1F38A}", "#3fcf8e", 0),
    ("income", "Bonus", "Performance",  "\u{2B50}",  "#52d8a2", 1),
    ("income", "Bonus", "Festive/THR",  "\u{1F9E7}", "#5bddaa", 2),
    ("income", "Freelance", "Projects",   "\u{1F4BB}", "#5aa66d", 0),
    ("income", "Freelance", "Consulting", "\u{1F4BC}", "#66b079", 1),
    ("income", "Business", "Sales",          "\u{1F4B5}", "#4bd699", 0),
    ("income", "Business", "Side hustle",    "\u{1F6E0}\u{FE0F}", "#5bddaa", 1),
    ("income", "Business", "Online/Dropship", "\u{1F4E6}", "#3fcf8e", 2),
    ("income", "Rental Income", "Property rent", "\u{1F3E0}", "#5bddaa", 0),
    ("income", "Rental Income", "Room rent",     "\u{1F6CF}\u{FE0F}", "#66e0b4", 1),
    ("income", "Rental Income", "Asset rent",    "\u{1F697}", "#4fd6a4", 2),
    ("income", "Government & Aid", "STR/BR1M",        "\u{1F932}", "#37c886", 0),
    ("income", "Government & Aid", "Tax refund (LHDN)", "\u{1F9FE}", "#46d39a", 1),
    ("income", "Government & Aid", "Subsidies",       "\u{1F3AB}", "#2fbf71", 2),
    ("income", "Cashback & Rewards", "Card cashback",   "\u{1F4B3}", "#66b079", 0),
    ("income", "Cashback & Rewards", "e-Wallet rewards", "\u{1F4F2}", "#73bb8a", 1),
    ("income", "Cashback & Rewards", "Points redeemed", "\u{1F381}", "#5aa66d", 2),
    ("income", "Gift", "Cash gift",        "\u{1F4B5}", "#56b3c4", 0),
    ("income", "Gift", "Angpow/Duit raya", "\u{1F9E7}", "#63c0cf", 1),
    // Transfer
    ("transfer", "Transfer", "Own accounts",     "\u{1F501}", "#9aa4b2", 0),
    ("transfer", "Transfer", "Savings transfer", "\u{1F4B0}", "#a6afbc", 1),
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
