# Category Splits & Add-Transaction Redesign — Design

- **Status:** Draft (brainstorm complete, pending implementation plan)
- **Date:** 2026-06-06
- **Author:** brainstorm session
- **Supersedes/extends:** Add Transaction modal (`src/modals/AddTransaction.tsx`), Transactions screen redesign (`docs/superpowers/specs/2026-06-02-transactions-screen-redesign-design.md`)

## 1. Summary

Two intertwined changes:

1. **Add Transaction redesign — "itemized builder."** Replace the slow category dropdown with a fast, tap-once flow: type an amount, tap a category tile from the full ordered list, press **Add** to stack it as an *item*, repeat, watch a **live Total** auto-sum, then **Save** once.
2. **Category splits.** A single transaction in a single account may divide its amount across **multiple categories** (e.g. an RM168.50 Lotus's run = Groceries 100 + Shopping 50 + Coffee 18.50). One item = an ordinary single-category transaction; **two or more items = a split**.

Splits apply to **income and expense only** (the only kinds that carry a user category). Each split line carries **only category + amount** — note and `excludedFromReporting` stay at the transaction level.

### Key insight: splits do not touch the balance engine

The double-entry `postings` layer (migration 006) records account/bucket legs, **not categories**. A split expense of RM168.50 from Maybank still produces exactly two legs: `−168.50` on the account and `+168.50` on the `expense` bucket. Categories are a separate attribution layer. Therefore:

- `service::postings_for` / `postingsFor` (`src/lib/kinds.ts`) are **unchanged**.
- Account balances (`balance_expr`) are **unchanged**.
- Dashboard income/expense/net-cashflow totals (`sum_kind_in_range`) are **unchanged** — they read the header `amount_cents`, which equals the sum of items.
- **Only `spending_breakdown`** (per-category attribution) must learn about split lines.

This keeps the blast radius small and the change data-preserving.

## 2. Goals / Non-goals

**Goals**
- Make manual entry materially faster (no dropdown; tap-once from a frequency-respecting, fully-visible category grid).
- Support category splits on income/expense, entered via the same builder.
- Display splits clearly in the Transactions list (one row), detail panel (breakdown), and dashboard (per-category attribution).
- Keep the Tauri chain and the dev-only mock (`src/client/mock.ts`) in lockstep.

**Non-goals (YAGNI for this spec)**
- Per-line notes or per-line `excludedFromReporting` (explicitly rejected — lines are category + amount only).
- Splitting transfers, adjustments, opening, or balance-correction rows.
- Splitting across multiple **accounts** (Splitwise-style shared expenses, true multi-account journal entries) — separate future feature.
- Natural-language quick-add parsing (prototyped as "Direction B"; deferred as a possible later power-user layer).

## 3. Add Transaction redesign — the itemized builder

### 3.1 Layout (one modal, no wizard steps)

```
┌ New transaction ──────────────── [Expense | Income | Transfer] ┐
│ ACCOUNT     (•Maybank) (CIMB) (Visa) (TNG) (Cash) (GXBank …)   │  ← all accounts, pills, single-select
│ ADD AN ITEM ┌───────────────────────────────────────────────┐ │
│             │            RM  0.00   (keyboard-focused)        │ │  ← current item amount
│             │ CATEGORY                              🔍 filter │ │
│             │ [🛒][🍜][☕][🚕][⛽][🏠][💡][📱] …  (scrolls)    │ │  ← FULL list, saved order, tap-once
│             │            [ + Add item ]                       │ │  ← appends item, resets builder
│             └───────────────────────────────────────────────┘ │
│ ITEMS                                          3 items · split │
│   🛒 Groceries                                      RM 100.00 ✕│
│   🛍️ Shopping                                        RM 50.00 ✕│
│   ☕ Coffee                                          RM 18.50 ✕│
│ ─────────────────────────────────────────────────────────────│
│ Total                                              RM 168.50   │  ← live auto-sum
│                        [ Save ]                                │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 Category grid

- Renders the user's **complete, non-archived category list in saved order** (the `sort_order` arrangement from the Categories screen, filtered to the current kind; subcategories indented/grouped under parents as in `categoryTree`). **No "More" tile** — the grid scrolls inside the modal when long.
- Tap a tile = select it for the current item (single-select within the builder).
- A **🔍 filter** affordance in the category header is hidden by default; revealing it shows a type-to-narrow box. Optional convenience for large lists; costs nothing when unused.
- System ("Adjustment") categories remain hidden, as today (`categoryTree` filters `isSystem`).

### 3.3 Builder mechanics

- **Add item:** enabled only when the current item has `amount > 0` and a category selected. On press: append `{categoryId, amountCents}` to the items list, reset the builder (amount → 0, category cleared), refocus the amount field.
- **Items list:** each row shows category emoji + name + amount + a remove (✕). Header shows count and "· split" when ≥2.
- **Total:** live sum of all items; this becomes the transaction's `amount_cents`.
- **Save:** enabled when ≥1 item exists. **A filled-but-unadded builder is auto-added as the final item before saving** (forgiving — nobody loses an entry by forgetting Add).
- **One item → ordinary transaction** (stored on `category_id`, no split rows). **Two+ items → split** (see §4).
- **Account / kind / date / time / description / excludedFromReporting** apply to the whole transaction (unchanged semantics). Time field still gated by `transaction_time_enabled`.

### 3.4 Edit mode

Editing an existing transaction opens the same builder pre-populated: a single-category transaction shows one item; a split shows its items. Saving re-derives single-vs-split from the resulting item count.

## 4. Data model

### 4.1 Approach: dedicated `transaction_splits` table (hybrid)

Add a child table; keep `transactions.category_id` for the common single-category case.

```sql
-- MIGRATION_009 (append-only, data-preserving)
CREATE TABLE transaction_splits (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES categories(id)   ON DELETE RESTRICT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_splits_txn ON transaction_splits(transaction_id);
CREATE INDEX idx_splits_cat ON transaction_splits(category_id);
```

**Invariant (enforced in the service layer, mirrored in mock):**
- A transaction is **single-category** (no split rows) or **split** (**≥2** split rows). "Is a split" is defined by **the presence of split rows**, never by a null `category_id`.
- **`transactions.category_id` is always set for income/expense** — including splits, where it holds the **first split line's category** as a representative header. This is mandatory: migration 005's table CHECK requires `category_id IS NOT NULL` for `income`/`expense`, and rebuilding `transactions` to relax it is unsafe (migration 006's `postings.transaction_id ON DELETE CASCADE` would cascade-delete every posting on a rebuild). The header category is **ignored for attribution** whenever split rows exist.
- Split rows exist only for `income`/`expense`.
- `SUM(transaction_splits.amount_cents) = transactions.amount_cents` (all positive; income/expense `amount_cents` is positive).
- Every split line's category must be valid for the transaction's kind (`validate_category_for`) and **non-system** (`ensure_not_system`). The header category equals `splits[0].category_id`, so it inherits that validity.

> **Migration is data-preserving and trivial:** existing transactions keep their `category_id`; no backfill needed (no existing transaction is a split). `ON DELETE CASCADE` means deleting a transaction removes its split rows. **`transactions` is NOT rebuilt** — we only add a new table, so neither the CHECK constraint nor the postings cascade is touched.

**Alternative considered & rejected:** making *every* income/expense transaction a list of ≥1 `transaction_lines` rows (dropping `category_id`). Conceptually uniform with the builder, but requires a large migration touching all existing rows and every `category_id` read path, for little gain. The hybrid leaves the majority path untouched.

### 4.2 Postings

Unchanged. `postings_for` still emits the real-account leg + one bucket leg for the **total** `amount_cents`. Splits are never reflected in `postings`.

## 5. Backend changes (Rust)

- **`repo.rs`**
  - New: `insert_split`, `list_splits_for(transaction_id)`, `delete_splits_for(transaction_id)`, `splits_for_many(ids)` (batch-load for list hydration).
  - `Transaction` row mapping gains `splits: Vec<TxnSplit>` (empty for single-category).
  - **`spending_breakdown`** rewritten to attribute split lines per category. A UNION of (a) **non-split** expense rows keyed by `t.category_id` (those with NO split rows), and (b) split lines keyed by `s.category_id`; both rolled up `GROUP BY COALESCE(parent_id, id)`. Crucially, the non-split branch must **exclude transactions that have split rows** (`NOT EXISTS`) so a split's representative header category is not double-counted:
    ```sql
    WITH attrib AS (
      SELECT t.category_id AS cat, t.amount_cents AS amt
      FROM transactions t
      WHERE t.kind='expense' AND t.excluded_from_reporting=0
        AND t.transaction_date >= ?1 AND t.transaction_date < ?2
        AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
      UNION ALL
      SELECT s.category_id AS cat, s.amount_cents AS amt
      FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
      WHERE t.kind='expense' AND t.excluded_from_reporting=0
        AND t.transaction_date >= ?1 AND t.transaction_date < ?2
    )
    SELECT COALESCE(c.parent_id, c.id) AS group_id, pc.name, pc.emoji, pc.color, SUM(a.amt) AS total
    FROM attrib a
    JOIN categories c  ON c.id = a.cat
    JOIN categories pc ON pc.id = COALESCE(c.parent_id, c.id)
    GROUP BY group_id ORDER BY total DESC;
    ```
  - `sum_kind_in_range` — **unchanged** (reads header `amount_cents`).
  - `count_transactions_for_category` — extend to also count split-line references, so category delete/restrict still works correctly when a category is only used inside splits.
- **`service.rs`**
  - `create_income` / `create_expense` gain an optional `splits: Vec<SplitInput>` parameter. When `splits.len() >= 2`: validate (sum, kinds, non-system), insert the transaction with **`category_id = splits[0].category_id`** (the representative header — required by the CHECK) and `amount_cents = Σ`, then insert split rows — all in one DB transaction. When 0/1 item: behave exactly as today (single `category_id`).
  - `update_transaction`: support replacing splits (delete + re-insert under the same invariant). Re-derive single↔split. Keep existing guards: opening/adjustment rows and **system-category correction rows** remain non-editable / non-splittable.
  - New shared validator `validate_splits(conn, kind, &splits, total)`.
- **`commands.rs`**: thread the optional `splits` arg through `create_income`/`create_expense`/`update_transaction` (camelCase `splits: Array<{categoryId, amountCents}>`).

## 6. Frontend changes (TypeScript)

- **`src/types.ts`**: add `TxnSplit { categoryId: string; amountCents: number }`; `Transaction.splits: TxnSplit[]` (empty when single); extend create/update inputs with optional `splits`.
- **`src/client/index.ts`**: pass `splits` through the relevant wrapper fns.
- **`src/client/mock.ts`**: mirror everything — split storage, the single↔split invariant, `spendingBreakdown` attribution, `countTransactionsForCategory` including split refs, `balanceOf` unaffected.
- **`src/lib/categories.ts`**: reuse `categoryPickerItems`/`categoryTree` to render the builder grid in saved order for the current kind.
- **`src/modals/AddTransaction.tsx`**: rebuilt around the itemized builder (§3). A 1-item save calls the ordinary create; a 2+-item save sends `splits`.
- **Transactions list (`TxnRow.tsx`)**: a split row shows a **split glyph** (tri-color or stacked dots) with an item-count badge, a **SPLIT · N** pill, and the category names in the subtitle. **Amount column shows the total only** — the per-item breakdown lives in the detail panel (keeps the list scannable).
- **`TxnDetailPanel.tsx`**: for a split, render the breakdown (proportion bar + per-item rows with amounts) and allow editing items; balance-impact line uses the total (unchanged).
- **Sorting/filtering**: a split's category filter match (`TransactionFilters.categoryId`) should match if **any** split line uses that category (backend `list_transactions` filter extended accordingly).

## 7. Display summary (validated via interactive mockups)

- **List:** one row, total amount, SPLIT·N pill, categories in subtitle.
- **Detail:** total + proportion bar + per-item rows; edit items here.
- **Dashboard:** each split item attributed to its own category bar (never a lump), rolled up to parent like subcategories.

## 8. Testing

- **Rust (`cargo test --lib`)**: split create (≥2), single create (0/1 item), sum-mismatch rejection, wrong-kind/system-category rejection, update single↔split↔single, delete cascades split rows, `spending_breakdown` attributes split lines (incl. subcategory rollup), `sum_kind_in_range` unchanged with splits, `count_transactions_for_category` counts split refs, balances unaffected by splits.
- **Vitest**: mock parity for all of the above; builder logic (add/remove item, live total, auto-add pending on save, 1-item collapses to non-split); `TxnRow` split rendering; detail-panel breakdown.
- **Gate:** `npm run build` clean, `npm test` green, `cargo test --lib` green.

## 9. Docs

Update `CLAUDE.md` (transaction model, splits, builder), `CHANGELOG.md` `[Unreleased]`, and `ROADMAP.md`. Per user memory: keep docs/specs/CHANGELOG in sync with code.

## 10. Open questions

- Exact split-glyph treatment (tri-color slice vs stacked dots vs first-category-emoji + "+N") — final visual TBD during implementation; mockups lean tri-color + count badge.
- Whether the 🔍 category filter ships in v1 or is deferred (current decision: keep it, hidden by default).
