# Sens Desktop Finance Tracker Design

## Summary

Sens is a local-first personal finance tracking desktop app. Version 1 focuses on manual finance tracking with multiple MYR accounts, income and expense transactions, transfers between accounts, default categories, and a dashboard that summarizes the user's current financial position.

The first implementation targets desktop using Tauri, React, TypeScript, Rust, and SQLite. Mobile support may come later, so the architecture should keep business rules and data boundaries clear, but v1 does not need sync, mobile packaging, or multi-currency support.

## Goals

- Build a maintainable desktop-first finance tracker named Sens.
- Store all user data locally in SQLite.
- Support multiple manual accounts created from templates or custom entry.
- Support manual income, expense, and transfer transactions.
- Use MYR only in v1.
- Provide a useful dashboard for account balances and monthly activity.
- Document architecture, modules, function boundaries, development phases, and database tables before implementation.

## Non-Goals For V1

- Mobile app support.
- Cloud sync.
- Import or export.
- Multi-currency accounts or reports.
- App password, encryption, or custom authentication.
- Automatic bank connection.
- Special investment, BNPL, credit, or loan behavior.
- Budgeting.
- Recurring transactions.

## Technology Stack

- Desktop shell: Tauri
- Frontend: React
- Frontend language: TypeScript
- Backend: Rust through Tauri commands
- Database: SQLite
- Storage mode: local-first
- Currency: MYR only

## Architecture

Sens should use a layered architecture so UI, business rules, and persistence stay separate.

### React UI Layer

The React layer owns screens, forms, navigation, tables, charts, and user interaction states. It does not access SQLite directly.

Expected responsibilities:

- Render the app shell and desktop layout.
- Render account, transaction, category, and dashboard screens.
- Collect form input and show validation messages.
- Display loading, empty, and error states.
- Call typed TypeScript client functions instead of raw Tauri commands directly from components.

### TypeScript Client And Domain Layer

The TypeScript layer wraps Tauri commands and provides frontend-specific helpers.

Expected responsibilities:

- Expose typed client functions such as `createAccountFromTemplate`, `listTransactions`, and `getDashboardSummary`.
- Define shared frontend types that mirror command request and response shapes.
- Format MYR values, dates, account labels, and category labels.
- Build view models and reusable hooks for UI screens.
- Perform lightweight frontend validation for user feedback before submit.

Backend services remain the source of truth for business validation.

### Tauri Command Layer

The Tauri command layer is the boundary between React and Rust backend logic. Commands should be action-oriented instead of exposing raw database operations.

Expected responsibilities:

- Receive typed command input from the frontend.
- Call the correct Rust service.
- Return typed success responses or structured app errors.
- Avoid embedding SQL or UI-specific behavior.

### Rust Service Layer

The Rust service layer owns business rules and data correctness.

Expected responsibilities:

- Validate account, category, and transaction operations.
- Enforce MYR-only behavior.
- Prevent transactions against archived accounts, including the transfer destination (`to_account_id`).
- Prevent invalid transfers, including same-account transfers.
- Validate category kind against transaction kind for income and expense; allow a null category for transfers and adjustments.
- Reconcile account balances by editing the opening balance (no transactions) or inserting a signed adjustment transaction (transactions exist).
- Calculate balances and dashboard summaries, including the on-the-fly running balance.
- Coordinate multi-step operations through repositories.

### Rust Repository Layer

Repositories own SQLite queries and persistence details.

Expected responsibilities:

- Execute SQL queries and map rows to Rust structs.
- Keep SQL isolated from command and service layers.
- Use transactions where multiple database writes must succeed or fail together.
- Avoid business decisions beyond basic database constraints.
- Generate application IDs (UUIDs) and `created_at`/`updated_at` timestamps in Rust. The frontend never supplies these; the backend is the source of truth for identity and time.
- Open every SQLite connection with `PRAGMA foreign_keys = ON`. SQLite disables foreign key enforcement by default, so this must be set per connection or constraints are silently ignored.

### SQLite Database Layer

SQLite stores all user data locally. Schema setup should use versioned migrations, and seed data should be idempotent so startup can safely initialize a new database.

Expected responsibilities:

- Persist account templates, user accounts, categories, transactions, and app settings.
- Enforce basic relational integrity with foreign keys and check constraints.
- Provide indexes for common dashboard and transaction queries.

## Core Modules

### Accounts

The accounts module manages user-created financial accounts.

Features:

- Create an account from a provider template.
- Create a custom account when no provider template applies.
- Edit account name, subtype, and display metadata.
- Archive accounts that should no longer appear by default.
- List active and archived accounts.
- Calculate account balances from opening balances and transactions.
- Correct an account's balance to match reality (reconciliation).

In v1, all account types behave as normal manual accounts. Bank, digital bank, e-wallet, BNPL, investment, and global fintech templates do not have special behavior.

#### Opening Balance And Balance Correction

The opening balance is the account's starting point at the moment tracking begins. How a balance edit behaves depends on whether the account already has transactions:

- **No transactions yet:** editing the balance updates `opening_balance_cents` directly. With no history, the opening balance and the current balance are the same number.
- **Transactions exist:** the user enters their real current balance, and the system records an **adjustment transaction** for the difference (`real_balance − current_computed_balance`), dated today. The opening balance and all past running balances are left untouched, because they were correct at the time; only the balance from the adjustment forward changes to match reality.

This separates two distinct intents: "my starting balance was wrong" (edit the opening balance) versus "my balance drifted from reality, fix it as of now" (record an adjustment). See the `adjustment` transaction kind in Transactions and Database Design.

### Account Templates

The account template module owns the built-in selectable provider catalog.

Template groups:

- Banks
- Digital banks
- E-wallets
- Buy now, pay later
- Investment
- Global fintech

Templates should include a stable key, display name, group, default subtype, local icon asset reference, optional brand color, sort order, and active state. Provider icons should be bundled as local app assets. The app does not need to treat brand/legal concerns as a v1 blocker.

### Categories

The categories module manages default and user-created categories.

Features:

- Seed default income, expense, and transfer categories.
- Use emoji for category icons.
- Filter categories by kind in transaction forms.
- Allow future edit, archive, and reorder behavior without changing the core model.

Categories use one table with a `kind` field. Valid category kinds are `income`, `expense`, and `transfer`. Categories are optional for transfers and required for income and expense transactions. There is no `adjustment` category kind: adjustment is a transaction-only kind that never carries a category.

### Transactions

The transactions module manages manual money movement.

Features:

- Create income transactions.
- Create expense transactions.
- Create transfers between accounts.
- Record balance adjustments (reconciliation).
- List, filter, edit, and delete transactions.
- Keep balances explainable from opening balances plus transaction history.

Transaction kinds are `income`, `expense`, `transfer`, and `adjustment`.

Transfers use one user-visible transaction row. The source account is stored in `account_id`, and the destination account is stored in `to_account_id`. Transfers do not require a category; `category_id` is required only for income and expense transactions.

Adjustment transactions are produced by balance correction (see Accounts). They carry no category and no destination account, and their `amount_cents` is signed: positive raises the balance, negative lowers it. Adjustments affect balances but are excluded from dashboard income, expense, spending breakdown, and net cashflow — like transfers, they are not real income or spending.

In the transaction list, adjustments are labeled as a balance adjustment and may be **deleted** (which re-opens the discrepancy) but are not editable through the normal transaction form, and their kind cannot be changed. To re-correct a balance, the user runs balance correction again, which appends another adjustment. Editing a transaction's kind (above) therefore applies only between `income`, `expense`, and `transfer`; a row cannot be changed into or out of `adjustment`.

Editing a transaction may change its `kind`. When the kind changes, the backend re-validates the whole record under the new kind's rules: switching to or from `transfer` adds or clears `to_account_id`, and `category_id` is required or cleared as the new kind demands. The service must reject an edit that leaves the record invalid for its resulting kind (for example, a transfer with no destination, or an income with no category).

#### Running Balance

Balances are never stored on a transaction row. The "balance after this transaction" column shown in the transaction list is computed on the fly: transactions are ordered and accumulated from the account's opening balance each time the list is read. This means inserting a back-dated transaction, editing an amount, or deleting a row automatically recomputes every following balance with no stored bookkeeping to update.

Accumulation order is `transaction_date` ascending, then `created_at` ascending as a stable tiebreaker for same-day transactions. The list view typically displays newest first but the running balance is computed from the oldest-to-newest accumulation.

### Dashboard

The dashboard module aggregates account and transaction data for the selected month.

V1 dashboard content:

- Total balance.
- This month income.
- This month expenses.
- Net cashflow.
- Spending breakdown by category.
- Account balances.
- Recent transactions.

Dashboard calculation rules:

- **Total balance** sums the balances of active (non-archived) accounts only. Archived accounts retain their balance and remain queryable individually through `get_account_balance(account_id)`, but are excluded from `get_account_balances()` totals and the dashboard.
- An account's balance is `opening_balance_cents` plus all `income` amounts and incoming transfers (rows where `to_account_id` is the account), plus all `adjustment` amounts (signed), minus all `expense` amounts and outgoing transfers (rows where `account_id` is the account).
- **This month income** sums `income` transactions in the selected month. **This month expenses** sums `expense` transactions in the selected month. Both exclude `transfer` and `adjustment` rows, since neither represents money entering or leaving the system.
- **Net cashflow** is this month income minus this month expenses. Transfers and adjustments are excluded.
- **Spending breakdown by category** groups `expense` transactions in the selected month by `category_id`. Transfers, adjustments, and income are excluded.
- The selected month is interpreted in the user's local time. Month filtering uses a half-open date range over `transaction_date` (`>= first day of month AND < first day of next month`).

### Settings

The settings module stores small app preferences.

V1 examples:

- First-run status.
- Default dashboard month or last selected month.

Settings should not include auth, sync, import/export, encryption, or mobile preferences in v1.

### Migrations And Seeds

This module owns schema setup and initial data.

Responsibilities:

- Run versioned SQLite migrations, each inside its own transaction so a failure rolls back cleanly.
- Seed account templates.
- Seed default categories.
- Keep seeds idempotent.
- Run first-run seeding and the first-run flag set in a single transaction, so a crash mid-seed leaves the flag unset and the seed safely re-runs.

## UI Color System

Transaction kinds and balances are color-coded for fast scanning. Color is never the only signal: every amount also carries a sign (`+` / `−`) and a per-kind icon, and rows carry a text label, so meaning survives for color-blind users and in grayscale. Each token has a light and dark variant for desktop theming.

| Element | Meaning | Light | Dark | Sign / icon |
| --- | --- | --- | --- | --- |
| Income | Money in | `#16A34A` | `#4ADE80` | `+`, incoming arrow |
| Expense | Money out | `#DC2626` | `#F87171` | `−`, outgoing arrow |
| Transfer | Internal movement between own accounts | `#2563EB` | `#60A5FA` | `⇄`, swap arrows |
| Adjustment | Balance correction (signed) | `#D97706` | `#FBBF24` | `=`, sliders/wrench |
| Opening balance | Starting baseline (not a transaction) | `#475569` | `#94A3B8` | `▸`, start marker |

Balance number rules, distinct from transaction-row colors:

- A positive balance uses the default neutral text color, not green, so the UI does not turn uniformly green and income stays visually distinct.
- A negative balance reuses the expense red.

Rationale:

- Transfer is blue rather than green or red because money is not entering or leaving the user's world, only moving between their own accounts; it should not read as gain or loss.
- Adjustment is amber because it is signed and can raise or lower a balance; the color marks it as a manual correction regardless of direction, and stands apart from the green/red/blue activity colors.
- Opening balance is slate/neutral because it is a baseline rather than activity, and should feel quieter than the transaction colors.

These are semantic tokens, not raw hex used inline. Components reference the token (for example `color-income`), and the light/dark values resolve from the active theme.

## Function Boundaries

Tauri commands should expose app actions. React should call typed TypeScript wrappers around these commands.

### Account Commands

- `list_account_templates()`
- `create_account_from_template(template_key, name, opening_balance_cents)`
- `create_custom_account(name, account_type, subtype, opening_balance_cents)`
- `list_accounts(include_archived)`
- `update_account(input)`
- `archive_account(id)`
- `restore_account(id)` — un-archives an account.
- `set_account_balance(account_id, real_balance_cents)` — reconciles the account to a real balance. With no transactions it updates the opening balance; with transactions it inserts a signed `adjustment` transaction for the difference, dated today. No-op if the balance already matches.

### Category Commands

- `list_categories(kind)`
- `create_category(name, kind, emoji, color)`
- `update_category(input)`
- `archive_category(id)`
- `restore_category(id)` — un-archives a category.

### Transaction Commands

- `create_income_transaction(account_id, category_id, amount_cents, description, date)`
- `create_expense_transaction(account_id, category_id, amount_cents, description, date)`
- `create_transfer_transaction(from_account_id, to_account_id, amount_cents, description, date)`
- `list_transactions(filters)` — `filters` includes optional account, category, kind, and date-range filters plus `limit` and `offset` for pagination. Results are ordered by `transaction_date` descending. The transaction list must paginate rather than load the full history.
- `update_transaction(input)`
- `delete_transaction(id)`

### Dashboard Commands

- `get_dashboard_summary(month)`
- `get_account_balance(account_id)`
- `get_account_balances()`

## Database Design

Amounts should be stored as integer cents to avoid floating point errors. V1 uses MYR only, but `accounts.currency` is still included with a default of `MYR` to keep future migration paths simple.

General conventions:

- All tables are created through versioned migrations. Foreign keys and check constraints are declared in the schema, and every connection sets `PRAGMA foreign_keys = ON`. Foreign keys use `ON DELETE RESTRICT` so a referenced account or category can never be hard-deleted out from under a transaction; lifecycle is managed by archiving, not deletion.
- IDs are application-generated UUID strings produced in the Rust layer.
- Date and timestamp columns store text. `transaction_date` is a local date in `YYYY-MM-DD` format so month ranges can be filtered with simple string comparisons. `created_at` and `updated_at` are ISO 8601 timestamps set by the backend.

### `account_templates`

Built-in selectable account providers.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | TEXT PRIMARY KEY | Stable template key, for example `maybank` |
| `name` | TEXT NOT NULL | Display name |
| `group_name` | TEXT NOT NULL | Bank, digital bank, e-wallet, BNPL, investment, or global fintech |
| `default_subtype` | TEXT NOT NULL | Default account subtype |
| `icon_asset` | TEXT NOT NULL | Local bundled icon asset path or key |
| `brand_color` | TEXT | Optional display color |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | Template ordering |
| `is_active` | INTEGER NOT NULL DEFAULT 1 | Whether the template is selectable |

### `accounts`

User-created accounts.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Application-generated ID |
| `template_key` | TEXT REFERENCES `account_templates(key)` | Optional reference to a template |
| `name` | TEXT NOT NULL | User-visible account name |
| `account_type` | TEXT NOT NULL | Bank, digital bank, e-wallet, BNPL, investment, global fintech, or custom |
| `subtype` | TEXT NOT NULL | Savings, current, e-wallet, BNPL, investment, or custom |
| `opening_balance_cents` | INTEGER NOT NULL DEFAULT 0 | Opening balance in MYR cents |
| `currency` | TEXT NOT NULL DEFAULT 'MYR' CHECK (`currency` = 'MYR') | V1 must be MYR |
| `is_archived` | INTEGER NOT NULL DEFAULT 0 CHECK (`is_archived` IN (0, 1)) | Archive state |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

Opening balance may be edited at any time, including after transactions exist; balances always recompute as opening balance plus transaction history.

### `categories`

Default and user-created categories.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Application-generated ID |
| `name` | TEXT NOT NULL | Category name |
| `kind` | TEXT NOT NULL CHECK (`kind` IN ('income', 'expense', 'transfer')) | Transaction kind this category applies to |
| `emoji` | TEXT NOT NULL | Category emoji |
| `color` | TEXT | Optional display color |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | Display ordering |
| `is_system` | INTEGER NOT NULL DEFAULT 0 CHECK (`is_system` IN (0, 1)) | Seeded system category marker |
| `is_archived` | INTEGER NOT NULL DEFAULT 0 CHECK (`is_archived` IN (0, 1)) | Archive state |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

A unique index on (`kind`, `name`) prevents duplicate categories and gives system-category seeding a stable conflict target for idempotent inserts (see Seed Data Strategy).

### `transactions`

Manual income, expense, and transfer records.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Application-generated ID |
| `kind` | TEXT NOT NULL CHECK (`kind` IN ('income', 'expense', 'transfer', 'adjustment')) | Transaction kind |
| `account_id` | TEXT NOT NULL REFERENCES `accounts(id)` | Income/expense/adjustment account or transfer source account |
| `to_account_id` | TEXT REFERENCES `accounts(id)` | Transfer destination account; null otherwise |
| `category_id` | TEXT REFERENCES `categories(id)` | Required for income/expense, optional for transfers, null for adjustments |
| `amount_cents` | INTEGER NOT NULL | Positive for income/expense/transfer; signed and non-zero for adjustment |
| `description` | TEXT | Optional note |
| `transaction_date` | TEXT NOT NULL | User-selected local date, `YYYY-MM-DD` |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

Table-level check constraint, with the rest enforced in the service layer:

```sql
CHECK (
  (kind IN ('income', 'expense') AND amount_cents > 0 AND to_account_id IS NULL AND category_id IS NOT NULL) OR
  (kind = 'transfer'   AND amount_cents > 0 AND to_account_id IS NOT NULL AND to_account_id <> account_id) OR
  (kind = 'adjustment' AND amount_cents <> 0 AND to_account_id IS NULL AND category_id IS NULL)
)
```

Rules:

- `amount_cents` is positive for income, expense, and transfer; for adjustment it is signed and must be non-zero (positive raises the balance, negative lowers it).
- `to_account_id` is required for transfers and null for income, expense, and adjustment.
- `account_id` and `to_account_id` must differ for transfers.
- `category_id` is required for income and expense, and must match the transaction kind; it is optional for transfers and null for adjustments.
- Neither `account_id` nor `to_account_id` may reference an archived account.

### Indexes

- `transactions(transaction_date)` — month-range and recent-transaction queries.
- `transactions(account_id)` and `transactions(to_account_id)` — per-account balance queries.
- `transactions(category_id)` — spending-breakdown grouping.
- `transactions(kind)` — filtering and excluding transfers/adjustments from income/expense aggregates.
- Unique `categories(kind, name)` — duplicate prevention and idempotent seed conflict target.

### `app_settings`

Small key-value app preferences.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | TEXT PRIMARY KEY | Setting name |
| `value` | TEXT NOT NULL | Serialized setting value |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

## Seed Data Strategy

Account templates should be shipped as static seed data and inserted idempotently during database initialization. Because templates are keyed by a stable `key`, idempotency is achieved with an upsert / insert-or-ignore on `account_templates.key`.

Default categories use application-generated IDs, so idempotency relies on the unique `(kind, name)` index rather than the primary key. Seed system categories with `is_system = 1` using an insert-or-ignore that conflicts on `(kind, name)`, so re-running the seed never creates duplicates. Re-running the seed must not overwrite user edits to a system category (such as a renamed or archived category beyond a matching `(kind, name)`).

This approach lets new default categories be added to the seed list at any time during development: a new entry simply appears on the next launch, and existing categories are skipped, without wiping the database.

> **Post-launch consideration (not for v1):** insert-or-ignore matches on `(kind, name)`, so once real users can edit categories, a default that a user renamed will look "missing" and be re-added as a fresh copy. Before shipping to real users, revisit whether system categories should carry a stable hidden key (independent of name) so user edits to a default are never duplicated or reverted across updates.

Initial template groups should include:

- 19 banks: Maybank, CIMB, Public Bank, RHB, Hong Leong Bank, AmBank, Bank Islam, Bank Rakyat, Bank Muamalat, Affin Bank, Alliance Bank, BSN, Agrobank, MBSB Bank, Al Rajhi Bank, OCBC, UOB, HSBC, Standard Chartered.
- 5 digital banks: GXBank, Boost Bank, AEON Bank, KAF Digital Bank, Ryt Bank.
- 8 e-wallets: Touch 'n Go eWallet, GrabPay, Boost, ShopeePay, MAE, Setel, BigPay, Lazada Wallet.
- 5 BNPL providers: Atome, Shopee PayLater, Grab PayLater, Boost PayFlex, Riipay.
- 7 investment providers: ASNB, StashAway, Versa, Wahed, Rakuten Trade, Moomoo, KDI.
- 5 global fintech providers: PayPal, Wise, Revolut, N26, Payoneer.

Default categories should be seeded by kind and use emoji for display. Example groups:

- Income: Salary, Bonus, Freelance, Gift, Other Income.
- Expense: Food, Transport, Bills, Shopping, Health, Entertainment, Groceries, Education, Travel, Other Expense.
- Transfer: Transfer.

## Error Handling

Rust commands should return structured app errors.

Expected error categories:

- `ValidationError`: Invalid input such as empty name, invalid amount, invalid kind, same-account transfer, or category mismatch.
- `NotFound`: Referenced account, category, template, or transaction does not exist.
- `Conflict`: Operation conflicts with current state, such as using an archived account.
- `DatabaseError`: Unexpected persistence failure.

React maps structured errors into form-level messages, field-level messages, or page-level error states.

## Edge Cases And Invariants

This section collects rules that cut across modules so they are not rediscovered during implementation.

### Dates And Balances

- **Future-dated transactions are allowed.** A transaction may be dated later than today; it counts toward the account balance and appears in its calendar month. The running balance naturally includes it.
- **Negative balances are allowed.** No floor is enforced on an account balance or on total balance; over-spends, BNPL, and credit-style accounts can go negative. Negative values are displayed in red. No transaction is rejected for driving a balance below zero.
- **Running balance** is display-only and recomputed on read (see Transactions). It is never persisted.

### Lifecycle

- **Archiving is reversible** via `restore_account` / `restore_category`. Archived records keep their data and historical references; they are only hidden from default lists and new-entry pickers.
- **Archived accounts** are excluded from total balance but remain individually queryable. Their historical transactions remain valid and visible in the transaction list.
- **Archived categories** still appear as the selected value when editing an older transaction that used them, but are not offered when choosing a category for a new entry.
- **No hard deletes** of accounts or categories in v1; foreign keys are `ON DELETE RESTRICT`.

### Adjustments

- Created only by balance correction; deletable but not editable, and never convertible to or from another kind (see Transactions).
- Excluded from income, expense, spending breakdown, and net cashflow; included in balances.

### Input Validation

- Names are trimmed; empty-after-trim is a `ValidationError`.
- Amounts are parsed and rounded to whole cents on the frontend; the backend rejects non-integer or out-of-range cents.
- The frontend disables the submit button while a create is in flight to reduce accidental double-submission. v1 has no backend idempotency key, so this is a known, accepted limitation.

## Testing Strategy

### Rust Tests

Rust service tests should cover:

- Creating accounts from templates.
- Creating custom accounts.
- Creating income transactions.
- Creating expense transactions.
- Creating transfer transactions.
- Rejecting invalid transfers.
- Rejecting archived account usage, including as a transfer destination.
- Balance calculations, including running balance after a back-dated insert, edit, and delete.
- Balance correction: editing opening balance with no transactions, and inserting a signed adjustment when transactions exist.
- Adjustments are excluded from monthly income, expense, and cashflow but included in balances.
- Dashboard monthly summaries.

### TypeScript Tests

TypeScript tests should cover:

- MYR formatting.
- Date formatting.
- Command wrapper input and output mapping.
- View model helpers where logic is non-trivial.

### Manual Verification

Before calling v1 complete, manually verify:

- First-run database setup.
- Account creation from templates.
- Custom account creation.
- Income, expense, and transfer creation.
- Transaction edit and delete behavior, including the running balance updating after a back-dated entry.
- Balance correction: editing balance on a fresh account vs. an account with transactions (adjustment).
- Dashboard numbers after several sample transactions, confirming adjustments move balances without affecting income/expense.
- Empty states and validation states.

## Development Phases

### Phase 0: Foundation

- Scaffold Tauri, React, and TypeScript.
- Configure Rust backend structure.
- Configure SQLite access, storing the database file in the Tauri per-OS app data directory and enabling `PRAGMA foreign_keys = ON` on every connection.
- Add migration runner.
- Add app shell, routing, shared types, and command wrappers.

### Phase 1: Seed Data

- Add account template catalog with local real provider icons.
- Add default MYR-only categories with emoji.
- Add first-run database initialization.
- Verify idempotent seed behavior.

### Phase 2: Accounts

- Build account template picker.
- Build custom account creation.
- Build account list.
- Support opening balances.
- Support account edit and archive behavior.

### Phase 3: Transactions

- Build income form.
- Build expense form.
- Build transfer form.
- Build transaction list with on-the-fly running balance.
- Support transaction edit and delete.
- Support balance correction (opening-balance edit and adjustment transactions).
- Add validation rules.

### Phase 4: Dashboard

- Show total balance.
- Show monthly income, expenses, and net cashflow.
- Show category breakdown.
- Show account balances.
- Show recent transactions.

### Phase 5: Polish And Reliability

- Add empty states.
- Add error and loading states.
- Improve desktop responsive layout.
- Add focused test coverage.
- Add packaging basics.

## Future Roadmap Hooks

The v1 architecture should leave room for:

- Mobile support.
- Sync.
- Import/export.
- Multi-currency.
- Budgets.
- Recurring transactions.
- App lock or encryption.
- Special handling for credit, BNPL, investment, and loan accounts.
- Rich reports.

These should not be implemented in v1.
