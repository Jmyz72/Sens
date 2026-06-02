//! Versioned schema migrations. Each migration runs inside its own
//! transaction (see `db::run_migrations`). The schema declares foreign keys,
//! CHECK constraints, and indexes per the design spec's Database Design.

/// Ordered list of `(version, sql)`. Append-only — never edit a shipped one.
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003), (4, MIGRATION_004), (5, MIGRATION_005), (6, MIGRATION_006), (7, MIGRATION_007)];

// Double-entry posting engine (unreleased; version set at release time). Adds a
// `postings` ledger that is the authoritative source for account balances. Each
// posting is either a real
// account leg (account_id set) or a nominal counter leg (system_bucket set).
// Data-preserving: backfills two balanced legs per existing transaction using
// the canonical sign rule, so older databases upgrade automatically. Fresh
// installs run 001→006; the backfill is a no-op with zero transactions.
const MIGRATION_006: &str = r#"
CREATE TABLE postings (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id     TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  system_bucket  TEXT CHECK (system_bucket IN ('income', 'expense', 'equity')),
  amount_cents   INTEGER NOT NULL,
  CHECK ((account_id IS NOT NULL AND system_bucket IS NULL)
      OR (account_id IS NULL     AND system_bucket IS NOT NULL))
);
CREATE INDEX idx_postings_account ON postings(account_id);
CREATE INDEX idx_postings_txn     ON postings(transaction_id);

-- Leg 1: the real-money leg on account_id.
INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
SELECT 'p1-' || id, id, account_id, NULL,
       CASE kind WHEN 'expense'  THEN -amount_cents
                 WHEN 'transfer' THEN -amount_cents
                 ELSE amount_cents END
FROM transactions;

-- Leg 2: the counter leg — destination account for transfers, else a system bucket.
INSERT INTO postings (id, transaction_id, account_id, system_bucket, amount_cents)
SELECT 'p2-' || id, id,
       CASE kind WHEN 'transfer' THEN to_account_id ELSE NULL END,
       CASE kind WHEN 'income'  THEN 'income'
                 WHEN 'expense' THEN 'expense'
                 WHEN 'transfer' THEN NULL
                 ELSE 'equity' END,
       CASE kind WHEN 'income'   THEN -amount_cents
                 WHEN 'expense'  THEN  amount_cents
                 WHEN 'transfer' THEN  amount_cents
                 ELSE -amount_cents END
FROM transactions;
"#;

// v-next — transaction time support. Adds a nullable `transaction_time` column
// ("HH:MM", 24-hour) to `transactions`. A plain ADD COLUMN is used (NOT a table
// rebuild): the column participates in no CHECK, and migration 006 added
// `postings.transaction_id ... ON DELETE CASCADE`, so a rebuild would
// cascade-delete every posting. Existing rows get NULL.
const MIGRATION_007: &str = r#"
ALTER TABLE transactions ADD COLUMN transaction_time TEXT;
"#;

// v0.5.0 — non-cashflow transactions. Opening balance becomes a structural
// `opening` transaction (one per account) and income/expense gain an
// `excluded_from_reporting` flag. Data-preserving: every existing account's
// opening balance is backfilled as an `opening` row before the column is
// dropped, so older databases upgrade automatically with no data loss.
//
// The `transactions` table must be REBUILT (a table-level CHECK can't be
// altered in place) to add the `opening` kind + the new column. This is FK-safe
// because nothing references `transactions`. Order matters: rebuild first (so
// `opening` rows are legal), THEN backfill, THEN drop the now-redundant column.
const MIGRATION_005: &str = r#"
CREATE TABLE transactions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment', 'opening')),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL,
  description      TEXT,
  transaction_date TEXT NOT NULL,
  excluded_from_reporting INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_reporting IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (kind IN ('income', 'expense') AND amount_cents > 0  AND to_account_id IS NULL     AND category_id IS NOT NULL) OR
    (kind = 'transfer'   AND amount_cents > 0  AND to_account_id IS NOT NULL AND to_account_id <> account_id AND category_id IS NULL AND excluded_from_reporting = 0) OR
    (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0) OR
    (kind = 'opening'    AND                       to_account_id IS NULL     AND category_id IS NULL          AND excluded_from_reporting = 0)
  )
);

INSERT INTO transactions_new
  (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
  SELECT id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, 0, created_at, updated_at
  FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_tx_date ON transactions(transaction_date);
CREATE INDEX idx_tx_account ON transactions(account_id);
CREATE INDEX idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);
CREATE INDEX idx_tx_kind ON transactions(kind);

INSERT INTO transactions
  (id, kind, account_id, to_account_id, category_id, amount_cents, description, transaction_date, excluded_from_reporting, created_at, updated_at)
  SELECT 'opening-' || id, 'opening', id, NULL, NULL, opening_balance_cents, 'Opening balance', substr(created_at, 1, 10), 0, created_at, updated_at
  FROM accounts;

ALTER TABLE accounts DROP COLUMN opening_balance_cents;
"#;

const MIGRATION_004: &str = r#"
ALTER TABLE categories DROP COLUMN is_system;
"#;

const MIGRATION_003: &str = r#"
ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT;

DROP INDEX idx_categories_kind_name;

CREATE UNIQUE INDEX idx_categories_top_kind_name
  ON categories(kind, name) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX idx_categories_sub_parent_name
  ON categories(parent_id, name) WHERE parent_id IS NOT NULL;
"#;

const MIGRATION_002: &str = r#"
CREATE TABLE account_subtypes (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('fund','financial','receivable','payable','credit')),
  account_group TEXT NOT NULL CHECK (account_group IN ('own','owe')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

INSERT INTO account_subtypes (key, label, type, account_group, sort_order) VALUES
  ('cash',          'Cash',                     'fund',       'own', 0),
  ('ewallet',       'E-wallet',                 'fund',       'own', 1),
  ('savings',       'Savings account',          'fund',       'own', 2),
  ('current',       'Current / Checking',       'fund',       'own', 3),
  ('fixed-deposit', 'Fixed deposit',            'financial',  'own', 4),
  ('investment',    'Investment / Brokerage',   'financial',  'own', 5),
  ('unit-trust',    'Unit trust / ASNB',        'financial',  'own', 6),
  ('crypto',        'Crypto',                   'financial',  'own', 7),
  ('lent',          'Lent to someone (IOU)',    'receivable', 'own', 8),
  ('borrowed',      'Borrowed from someone',    'payable',    'owe', 9),
  ('credit-card',   'Credit card',              'credit',     'owe', 10),
  ('bnpl',          'BNPL',                     'credit',     'owe', 11),
  ('personal-loan', 'Personal loan',            'credit',     'owe', 12),
  ('mortgage',      'Mortgage',                 'credit',     'owe', 13),
  ('car-loan',      'Car / Hire-purchase loan', 'credit',     'owe', 14),
  ('other-debt',    'Other debt',               'credit',     'owe', 15);

UPDATE accounts SET subtype = CASE
  WHEN subtype IN ('cash','ewallet','savings','current','fixed-deposit','investment',
                   'unit-trust','crypto','lent','borrowed','credit-card','bnpl',
                   'personal-loan','mortgage','car-loan','other-debt') THEN subtype
  WHEN account_type IN ('bank','digital_bank') THEN 'savings'
  WHEN account_type = 'ewallet'        THEN 'ewallet'
  WHEN account_type = 'global_fintech' THEN 'ewallet'
  WHEN account_type = 'bnpl'           THEN 'bnpl'
  WHEN account_type = 'investment'     THEN 'investment'
  ELSE 'cash'
END;

INSERT OR IGNORE INTO account_templates
  (key, name, group_name, default_subtype, icon_asset, brand_color, sort_order, is_active)
  VALUES ('luno', 'Luno', 'Crypto', 'crypto', 'luno', NULL, 49, 1);

ALTER TABLE accounts DROP COLUMN account_type;
"#;

const MIGRATION_001: &str = r#"
CREATE TABLE account_templates (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  default_subtype TEXT NOT NULL,
  icon_asset      TEXT NOT NULL,
  brand_color     TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  template_key          TEXT REFERENCES account_templates(key) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  account_type          TEXT NOT NULL,
  subtype               TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
  is_archived           INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
  emoji       TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_categories_kind_name ON categories(kind, name);

CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'transfer', 'adjustment')),
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  amount_cents     INTEGER NOT NULL,
  description      TEXT,
  transaction_date TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (kind IN ('income', 'expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
    (kind = 'transfer'   AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id) OR
    (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL AND category_id IS NULL)
  )
);

CREATE INDEX idx_tx_date ON transactions(transaction_date);
CREATE INDEX idx_tx_account ON transactions(account_id);
CREATE INDEX idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);
CREATE INDEX idx_tx_kind ON transactions(kind);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
