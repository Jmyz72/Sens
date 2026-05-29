//! Versioned schema migrations. Each migration runs inside its own
//! transaction (see `db::run_migrations`). The schema declares foreign keys,
//! CHECK constraints, and indexes per the design spec's Database Design.

/// Ordered list of `(version, sql)`. Append-only — never edit a shipped one.
pub const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001)];

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
