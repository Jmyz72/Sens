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
- Prevent transactions against archived accounts.
- Prevent invalid transfers, including same-account transfers.
- Validate category kind against transaction kind.
- Calculate balances and dashboard summaries.
- Coordinate multi-step operations through repositories.

### Rust Repository Layer

Repositories own SQLite queries and persistence details.

Expected responsibilities:

- Execute SQL queries and map rows to Rust structs.
- Keep SQL isolated from command and service layers.
- Use transactions where multiple database writes must succeed or fail together.
- Avoid business decisions beyond basic database constraints.

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

In v1, all account types behave as normal manual accounts. Bank, digital bank, e-wallet, BNPL, investment, and global fintech templates do not have special behavior.

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

Categories use one table with a `kind` field. Valid kinds are `income`, `expense`, and `transfer`.

### Transactions

The transactions module manages manual money movement.

Features:

- Create income transactions.
- Create expense transactions.
- Create transfers between accounts.
- List, filter, edit, and delete transactions.
- Keep balances explainable from opening balances plus transaction history.

Transfers use one user-visible transaction row. The source account is stored in `account_id`, and the destination account is stored in `to_account_id`.

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

### Settings

The settings module stores small app preferences.

V1 examples:

- First-run status.
- Default dashboard month or last selected month.

Settings should not include auth, sync, import/export, encryption, or mobile preferences in v1.

### Migrations And Seeds

This module owns schema setup and initial data.

Responsibilities:

- Run versioned SQLite migrations.
- Seed account templates.
- Seed default categories.
- Keep seeds idempotent.

## Function Boundaries

Tauri commands should expose app actions. React should call typed TypeScript wrappers around these commands.

### Account Commands

- `list_account_templates()`
- `create_account_from_template(template_key, name, opening_balance_cents)`
- `create_custom_account(name, account_type, subtype, opening_balance_cents)`
- `list_accounts(include_archived)`
- `update_account(input)`
- `archive_account(id)`

### Category Commands

- `list_categories(kind)`
- `create_category(name, kind, emoji, color)`
- `update_category(input)`
- `archive_category(id)`

### Transaction Commands

- `create_income_transaction(account_id, category_id, amount_cents, description, date)`
- `create_expense_transaction(account_id, category_id, amount_cents, description, date)`
- `create_transfer_transaction(from_account_id, to_account_id, amount_cents, description, date)`
- `list_transactions(filters)`
- `update_transaction(input)`
- `delete_transaction(id)`

### Dashboard Commands

- `get_dashboard_summary(month)`
- `get_account_balance(account_id)`
- `get_account_balances()`

## Database Design

Amounts should be stored as integer cents to avoid floating point errors. V1 uses MYR only, but `accounts.currency` is still included with a default of `MYR` to keep future migration paths simple.

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
| `template_key` | TEXT | Optional reference to `account_templates.key` |
| `name` | TEXT NOT NULL | User-visible account name |
| `account_type` | TEXT NOT NULL | Bank, digital bank, e-wallet, BNPL, investment, global fintech, or custom |
| `subtype` | TEXT NOT NULL | Savings, current, e-wallet, BNPL, investment, or custom |
| `opening_balance_cents` | INTEGER NOT NULL DEFAULT 0 | Opening balance in MYR cents |
| `currency` | TEXT NOT NULL DEFAULT 'MYR' | V1 must be MYR |
| `is_archived` | INTEGER NOT NULL DEFAULT 0 | Archive state |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

### `categories`

Default and user-created categories.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Application-generated ID |
| `name` | TEXT NOT NULL | Category name |
| `kind` | TEXT NOT NULL | `income`, `expense`, or `transfer` |
| `emoji` | TEXT NOT NULL | Category emoji |
| `color` | TEXT | Optional display color |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | Display ordering |
| `is_system` | INTEGER NOT NULL DEFAULT 0 | Seeded system category marker |
| `is_archived` | INTEGER NOT NULL DEFAULT 0 | Archive state |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

### `transactions`

Manual income, expense, and transfer records.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Application-generated ID |
| `kind` | TEXT NOT NULL | `income`, `expense`, or `transfer` |
| `account_id` | TEXT NOT NULL | Income/expense account or transfer source account |
| `to_account_id` | TEXT | Transfer destination account |
| `category_id` | TEXT NOT NULL | Category matching the transaction kind |
| `amount_cents` | INTEGER NOT NULL | Positive MYR amount in cents |
| `description` | TEXT | Optional note |
| `transaction_date` | TEXT NOT NULL | User-selected date |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

Rules:

- `amount_cents` must be positive.
- `to_account_id` is required for transfers and null for income or expense.
- `account_id` and `to_account_id` must differ for transfers.
- The selected category must match the transaction kind.

### `app_settings`

Small key-value app preferences.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | TEXT PRIMARY KEY | Setting name |
| `value` | TEXT NOT NULL | Serialized setting value |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

## Seed Data Strategy

Account templates should be shipped as static seed data and inserted idempotently during database initialization.

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

## Testing Strategy

### Rust Tests

Rust service tests should cover:

- Creating accounts from templates.
- Creating custom accounts.
- Creating income transactions.
- Creating expense transactions.
- Creating transfer transactions.
- Rejecting invalid transfers.
- Rejecting archived account usage.
- Balance calculations.
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
- Transaction edit and delete behavior.
- Dashboard numbers after several sample transactions.
- Empty states and validation states.

## Development Phases

### Phase 0: Foundation

- Scaffold Tauri, React, and TypeScript.
- Configure Rust backend structure.
- Configure SQLite access.
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
- Build transaction list.
- Support transaction edit and delete.
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
