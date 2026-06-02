# Transaction time support — design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)
**Builds on:** v0.6.0. Latest migration is 006 (postings engine); this adds **migration 007**.

## Summary

Add an optional time-of-day to transactions, gated by a new Settings toggle.
Two goals, equally weighted:

1. **Accurate record-keeping** — a visible, editable time-of-day field per transaction
   (e.g. "coffee at 8:15 am").
2. **Correct same-day ordering** — multiple transactions on the same day sort in the
   real order they happened, not by insertion order.

The change is **purely additive**. The existing `transaction_date` (`YYYY-MM-DD` TEXT)
column, all date-range filtering, the opening-row substring logic, and balance/posting
math are **untouched**. Existing installs see **no behavioral change** until the user
opts in via the new setting.

## Data model

### New column

Add a single **nullable** column to `transactions`:

```sql
transaction_time TEXT   -- 24-hour "HH:MM", e.g. "08:15"; NULL when absent
```

- Format: 24-hour `"HH:MM"` (minute granularity; no seconds).
- `NULL` means "no time recorded" — the case for every pre-existing row, every row
  created while the setting is off, and every structural `opening` row.

### Migration 007 — `ALTER TABLE ... ADD COLUMN` (no rebuild)

```sql
ALTER TABLE transactions ADD COLUMN transaction_time TEXT;
```

**Why a plain `ADD COLUMN`, not a table rebuild:** migration 005 had to rebuild
`transactions` only because it *modified* the table-level `CHECK` (adding the `opening`
kind). A brand-new **nullable** column that participates in **no** `CHECK` can be added
in place — `ALTER TABLE ADD COLUMN` is universally supported by SQLite even on tables
with `CHECK` constraints.

**Why a rebuild would be actively wrong here:** migration 006 added
`postings.transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE`.
With `PRAGMA foreign_keys = ON` (which the migration runner sets), dropping and
recreating `transactions` as part of a rebuild would **cascade-delete every posting**.
The in-place `ADD COLUMN` avoids this entirely.

- Append-only: `MIGRATIONS` gains `(7, MIGRATION_007)`.
- Existing rows get `transaction_time = NULL` automatically (no backfill).
- Fresh installs run 001→007 to the same end schema.
- The `idx_tx_date` index on `transaction_date` is unchanged.

### Mock parity

`src/client/mock.ts` mirrors the new column: the in-memory transaction shape gains
`transactionTime: string | null`, with the same sort order, the same
required-when-on / ignored-when-off validation, and the same `HH:MM` format check as
the Rust service.

## Settings toggle

New app setting persisted in `app_settings`:

```
transaction_time_enabled : bool   -- default FALSE (opt-in)
```

- Read/written through the existing settings command chain (`get_settings` /
  `update_settings` or equivalent) and mirrored in the mock. Surfaced on the Settings
  screen as a toggle row ("Record transaction times").
- **Default off** so existing users see no change until they choose to enable it.

### Behavior by state

**When OFF (default):**
- The time field is hidden in Add/Edit Transaction.
- New transactions are saved with `transactionTime = null`.
- No time is displayed anywhere. App behaves exactly as it does in v0.6.0.

**When ON:**
- The time field appears in Add/Edit Transaction and is **required**.
- On **add**: the field pre-fills with the **current local time**, rounded to the minute.
- On **edit**: the field shows the row's existing time; if the row has none (created
  before the feature or while off), it pre-fills with "now".

**Toggling OFF after times exist:**
- Stored times are **kept, not wiped**. They still drive same-day sort order; they are
  simply hidden from entry and display.
- Toggling back ON reveals them again. This avoids destructive data loss from flipping
  a setting.

### Validation

- **Setting on:** the service **and** the mock reject a create/update with a
  missing/blank time → `ValidationError`.
- **Setting off:** a provided time on a new write is ignored and stored as `null`.
- **Format:** when present, time must match 24-hour `HH:MM` (00–23 : 00–59), validated
  in both the service and the mock.

## Sorting

All transaction listing queries change their order clause to:

```sql
ORDER BY transaction_date DESC, transaction_time DESC NULLS LAST, created_at DESC
```

- Rows without a time fall back to insertion order (`created_at`), so mixed
  null/non-null days are well-defined.
- The Transactions screen's day grouping and sticky day-header net subtotals are
  **unchanged** (still grouped by `transaction_date`). Time only affects intra-day order.
- The "sort by date" toolbar control now uses time as the tiebreaker.
- `computeRunningBalances` / `signedFor` (the per-account "balance after" column) read
  transaction headers and are unaffected beyond honoring this new order.

## UI

- **Time format:** stored 24-hour `HH:MM`; **displayed** 12-hour `h:mm am/pm` (friendlier
  for the local audience) via a new `fmtTime` helper in `src/lib/format.ts`.
- **Add/Edit Transaction** (`src/modals/AddTransaction.tsx`, `TxnDetailPanel.tsx`): a
  native time input rendered next to the existing date field, shown only when the
  setting is on.
- **Transactions screen** (`src/screens/Transactions.tsx`): when the setting is on, each
  row shows its time (secondary line / detail panel); when off, no time is shown.

## Command / service / repo wiring

Strict layering preserved (UI → client → invoke seam → commands → service → repo → SQLite),
with the mock mirroring every behavior change.

- `create_income` / `create_expense` / `create_transfer` (and the adjustment/opening
  paths) gain an optional `time` parameter threaded through
  `commands.rs → service.rs → repo.rs` (`insert_transaction` gains the column).
- `update_transaction` accepts `transactionTime`.
- `opening` rows are always created with `transaction_time = NULL` (structural).
- Backend remains the source of truth for ids/timestamps; `transaction_time` is
  user-supplied like `transaction_date`.
- Types: `Transaction.transactionTime: string | null` and
  `UpdateTransactionInput.transactionTime: string | null` in `src/types.ts`; the typed
  client wrappers (`src/client/index.ts`) and create commands pass it through.

## Testing

**Vitest (`src/__tests__`):**
- `fmtTime` formatting (24h → 12h, midnight/noon edge cases).
- Sort tiebreaker: same-day rows order by time, nulls last, then `created_at`.
- Mock validation: required-when-on, ignored-when-off, `HH:MM` format rejection.
- Settings round-trip for `transaction_time_enabled`.

**Rust (`cargo test --lib`):**
- Migration 007: column added, existing rows `NULL`, postings intact (no cascade).
- Insert/update with and without time.
- Sort order in repo listing.
- Service validation gate (required-when-on).

## Out of scope

- No backfill of times onto existing rows.
- No seconds granularity, no timezone storage (local-first, single-timezone app).
- No per-account or per-category time defaults.
- Opening-balance rows never carry a time.

## Documentation impact

Update on implementation: `CLAUDE.md` (transaction-kinds / schema section, settings),
`CHANGELOG.md` `[Unreleased]`, and `ROADMAP.md` if it tracks this. Per the user's
standing "always update documentation" memory.
