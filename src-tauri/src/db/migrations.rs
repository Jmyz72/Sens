//! Versioned schema migrations. Each migration runs inside its own
//! transaction (see `db::run_migrations`). The schema declares foreign keys,
//! CHECK constraints, and indexes per the design spec's Database Design.

/// Ordered list of `(version, sql)`. Append-only — never edit a shipped one.
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001), (2, MIGRATION_002), (3, MIGRATION_003)];

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
