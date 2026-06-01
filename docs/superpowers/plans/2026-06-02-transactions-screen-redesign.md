# Transactions Screen Redesign ("Evolved List" / A+) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Transactions screen as a warm, date-grouped "Evolved List" with a smart toolbar, sticky day subtotals, hover quick-actions, an inline-editable detail sidebar that morphs into an adaptive multi-select panel, a per-row-editable bulk preview sheet, and a Settings toggle to govern that preview.

**Architecture:** Frontend-only. All behavior reuses existing Tauri commands (`listTransactions` with `fromDate`/`toDate`, `updateTransaction`, `deleteTransaction`, `createIncome`/`createExpense`/`createTransfer`, `getSetting`/`setSetting`) and their already-mirrored `mock.ts` equivalents. Pure logic (date-range presets, selection summary, bulk eligibility/partitioning) lives in new testable `src/lib` modules; the screen and a few focused components consume them.

**Tech Stack:** React 19 + TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`), Vite, Vitest. Theming via `useTheme()` tokens — never hardcode colors. Money is integer MYR cents formatted only at the edge.

**Spec:** `docs/superpowers/specs/2026-06-02-transactions-screen-redesign-design.md`

---

## File Structure

**New files:**
- `src/lib/txnFilters.ts` — date-range presets → `{ fromDate?, toDate? }` (exclusive `toDate`), plus `nextDay`.
- `src/lib/txnSelection.ts` — `summarizeSelection()` and `planBulk()` (eligibility/partition + reasons) for the multi-select panel and preview sheet.
- `src/components/BulkPreviewSheet.tsx` — the preview modal (will-change / removed-by-you / can't-change, per-row skip + add-back, live counts, Apply).
- `src/components/TxnDetailPanel.tsx` — single-transaction sidebar: inline edit + balance-impact + Duplicate/Delete.
- `src/components/TxnSelectionPanel.tsx` — multi-select sidebar: summary + adaptive action buttons.
- Tests: `src/__tests__/txnFilters.test.ts`, `src/__tests__/txnSelection.test.ts`.

**Modified files:**
- `src/components/TxnRow.tsx` — density prop, category color dot, aligned amount column, selection checkbox slot, hover quick-actions slot.
- `src/screens/Transactions.tsx` — orchestration: toolbar, filters, grouped list with sticky day subtotals, selection state, three-state sidebar, bulk apply, keyboard nav.
- `src/screens/Settings.tsx` — "Preview bulk actions" toggle row.

**Reused as-is:** `computeRunningBalances`/`signedFor` (`src/lib/kinds.ts`), `categoryTree`/`categoryPickerItems` (`src/lib/categories.ts`), `fmtMoney`/`fmtDate`/`dateGroupLabel`/`currentMonth`/`shiftMonth`/`todayISO` (`src/lib/format.ts`), atoms in `src/components/ui.tsx`, `useToast()`.

---

## Conventions for every task

- Run the **frontend gate** after code changes: `npm run build` (must stay clean — strict TS).
- Run **unit tests**: `npm test` (or a single file, e.g. `npx vitest run src/__tests__/txnFilters.test.ts`).
- Vitest imports: `import { describe, it, expect } from "vitest";`.
- Commit after each task with a conventional-commit message; end the body with the project trailer when committing manually is not required by the harness (the executing skill handles commits).

---

## Task 1: Date-range preset helper (`txnFilters.ts`)

Date-range presets must map to `listTransactions` params. The mock filters with `toDate` **exclusive** (`t.transactionDate < f.toDate` in `mock.ts:321`), so all ranges use an exclusive upper bound. Custom ranges take an **inclusive** end date from the UI and convert it with `nextDay`.

**Files:**
- Create: `src/lib/txnFilters.ts`
- Test: `src/__tests__/txnFilters.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/txnFilters.test.ts
import { describe, it, expect } from "vitest";
import { nextDay, rangeForPreset, type DateRangePreset } from "../lib/txnFilters";

describe("nextDay", () => {
  it("advances one day", () => {
    expect(nextDay("2026-06-02")).toBe("2026-06-03");
  });
  it("rolls over a month boundary", () => {
    expect(nextDay("2026-05-31")).toBe("2026-06-01");
  });
  it("rolls over a year boundary", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("rangeForPreset", () => {
  const today = "2026-06-15";
  it("this month → [first, next-month-first)", () => {
    expect(rangeForPreset("thisMonth", today)).toEqual({ fromDate: "2026-06-01", toDate: "2026-07-01" });
  });
  it("last month → previous calendar month", () => {
    expect(rangeForPreset("lastMonth", today)).toEqual({ fromDate: "2026-05-01", toDate: "2026-06-01" });
  });
  it("all → no bounds", () => {
    expect(rangeForPreset("all", today)).toEqual({});
  });
  it("custom → inclusive end converted to exclusive toDate", () => {
    expect(rangeForPreset("custom", today, { fromDate: "2026-03-10", toDateInclusive: "2026-03-20" }))
      .toEqual({ fromDate: "2026-03-10", toDate: "2026-03-21" });
  });
  it("custom with only a start date", () => {
    expect(rangeForPreset("custom", today, { fromDate: "2026-03-10" })).toEqual({ fromDate: "2026-03-10" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/txnFilters.test.ts`
Expected: FAIL — cannot find module `../lib/txnFilters`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/txnFilters.ts
// Maps a date-range preset to listTransactions params. toDate is ALWAYS an
// exclusive upper bound (the backend + mock filter with transactionDate < toDate).

export type DateRangePreset = "thisMonth" | "lastMonth" | "all" | "custom";

export interface DateRange {
  fromDate?: string;
  toDate?: string; // exclusive
}

export interface CustomRange {
  fromDate?: string;
  toDateInclusive?: string;
}

/** "YYYY-MM-DD" + 1 calendar day, in UTC to avoid TZ drift. */
export function nextDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function monthOf(iso: string): string {
  return iso.slice(0, 7); // "YYYY-MM"
}

function firstOfNextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

function firstOfPrevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-01`;
}

export function rangeForPreset(preset: DateRangePreset, today: string, custom?: CustomRange): DateRange {
  if (preset === "all") return {};
  if (preset === "custom") {
    const out: DateRange = {};
    if (custom?.fromDate) out.fromDate = custom.fromDate;
    if (custom?.toDateInclusive) out.toDate = nextDay(custom.toDateInclusive);
    return out;
  }
  const month = monthOf(today);
  if (preset === "thisMonth") {
    return { fromDate: `${month}-01`, toDate: firstOfNextMonth(month) };
  }
  // lastMonth
  return { fromDate: firstOfPrevMonth(month), toDate: `${month}-01` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/txnFilters.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build`
Then commit:
```bash
git add src/lib/txnFilters.ts src/__tests__/txnFilters.test.ts
git commit -m "feat(txn): date-range preset helper for transactions filtering"
```

---

## Task 2: Selection summary + bulk eligibility (`txnSelection.ts`)

This is the core logic behind the multi-select panel and the preview sheet. Two pure functions:

- `summarizeSelection(txns)` → counts, In/Out, net, other-kind counts, already-excluded count.
- `planBulk(action, txns)` → partitions the selection into `changeable` and `lockedSkipped` (with reasons), per the backend guards.

Guard rules (from `service.rs`): `adjustment`/`opening` can't be edited; `opening` can't be deleted; `transfer` has no category and two accounts; `excludedFromReporting` is income/expense-only. Exclude/Include count only rows whose flag actually flips.

**Files:**
- Create: `src/lib/txnSelection.ts`
- Test: `src/__tests__/txnSelection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/txnSelection.test.ts
import { describe, it, expect } from "vitest";
import { summarizeSelection, planBulk } from "../lib/txnSelection";
import type { Transaction, TransactionKind } from "../types";

function tx(kind: TransactionKind, amountCents: number, over: Partial<Transaction> = {}): Transaction {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    kind,
    accountId: "a1",
    toAccountId: kind === "transfer" ? "a2" : null,
    categoryId: kind === "income" || kind === "expense" ? "c1" : null,
    amountCents,
    description: null,
    transactionDate: "2026-06-01",
    excludedFromReporting: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

describe("summarizeSelection", () => {
  it("sums In/Out/net and counts other kinds", () => {
    const s = summarizeSelection([
      tx("income", 320000),
      tx("expense", 14280),
      tx("transfer", 50000),
      tx("adjustment", 800),
      tx("opening", 100000),
    ]);
    expect(s.count).toBe(5);
    expect(s.inCents).toBe(320000);
    expect(s.outCents).toBe(14280);
    expect(s.netCents).toBe(320000 - 14280);
    expect(s.otherCounts).toEqual({ transfer: 1, adjustment: 1, opening: 1 });
  });
  it("counts already-excluded income/expense", () => {
    const s = summarizeSelection([
      tx("expense", 100, { excludedFromReporting: true }),
      tx("expense", 200),
    ]);
    expect(s.excludedCount).toBe(1);
  });
});

describe("planBulk", () => {
  const sel = [
    tx("income", 320000, { id: "inc" }),
    tx("expense", 14280, { id: "exp" }),
    tx("transfer", 50000, { id: "trf" }),
    tx("adjustment", 800, { id: "adj" }),
    tx("opening", 100000, { id: "opn" }),
  ];

  it("recategorize: only income/expense change; others locked with reasons", () => {
    const p = planBulk("recategorize", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["exp", "inc"]);
    expect(p.lockedSkipped.map((l) => l.tx.id).sort()).toEqual(["adj", "opn", "trf"]);
    expect(p.lockedSkipped.find((l) => l.tx.id === "trf")!.reason).toMatch(/categor/i);
  });

  it("move: same eligibility as recategorize", () => {
    const p = planBulk("move", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["exp", "inc"]);
  });

  it("delete: everything except opening changes; opening locked", () => {
    const p = planBulk("delete", sel);
    expect(p.changeable.map((t) => t.id).sort()).toEqual(["adj", "exp", "inc", "trf"]);
    expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["opn"]);
  });

  it("exclude: only not-yet-excluded income/expense change; others locked or omitted", () => {
    const withFlag = [
      tx("expense", 100, { id: "already", excludedFromReporting: true }),
      tx("expense", 200, { id: "fresh" }),
      tx("transfer", 50, { id: "trf" }),
    ];
    const p = planBulk("exclude", withFlag);
    expect(p.changeable.map((t) => t.id)).toEqual(["fresh"]);
    // transfer is locked (not income/expense); already-excluded is omitted entirely
    expect(p.lockedSkipped.map((l) => l.tx.id)).toEqual(["trf"]);
  });

  it("include: only currently-excluded income/expense change", () => {
    const withFlag = [
      tx("expense", 100, { id: "already", excludedFromReporting: true }),
      tx("expense", 200, { id: "fresh" }),
    ];
    const p = planBulk("include", withFlag);
    expect(p.changeable.map((t) => t.id)).toEqual(["already"]);
    expect(p.lockedSkipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/txnSelection.test.ts`
Expected: FAIL — cannot find module `../lib/txnSelection`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/txnSelection.ts
// Pure logic for the multi-select panel and bulk preview sheet.
import type { Transaction } from "./../types";

export type BulkAction = "recategorize" | "move" | "exclude" | "include" | "delete";

export interface SelectionSummary {
  count: number;
  inCents: number;
  outCents: number; // positive magnitude
  netCents: number; // in - out
  otherCounts: { transfer: number; adjustment: number; opening: number };
  excludedCount: number; // income/expense already excluded
}

export function summarizeSelection(txns: Transaction[]): SelectionSummary {
  let inCents = 0, outCents = 0, excludedCount = 0;
  const otherCounts = { transfer: 0, adjustment: 0, opening: 0 };
  for (const t of txns) {
    if (t.kind === "income") inCents += t.amountCents;
    else if (t.kind === "expense") outCents += t.amountCents;
    else otherCounts[t.kind] += 1;
    if ((t.kind === "income" || t.kind === "expense") && t.excludedFromReporting) excludedCount += 1;
  }
  return { count: txns.length, inCents, outCents, netCents: inCents - outCents, otherCounts, excludedCount };
}

export interface LockedRow { tx: Transaction; reason: string }
export interface BulkPlan { action: BulkAction; changeable: Transaction[]; lockedSkipped: LockedRow[] }

const isCashflow = (t: Transaction) => t.kind === "income" || t.kind === "expense";

/** Reason a row can't take part in an editing action (recategorize/move). */
function editLockReason(t: Transaction, action: BulkAction): string {
  if (t.kind === "transfer") {
    return action === "recategorize" ? "Transfers have no category" : "Transfers move between two accounts";
  }
  if (t.kind === "adjustment") return "Adjustments can't be edited";
  return "Opening balances can't be edited"; // opening
}

export function planBulk(action: BulkAction, txns: Transaction[]): BulkPlan {
  const changeable: Transaction[] = [];
  const lockedSkipped: LockedRow[] = [];

  for (const t of txns) {
    switch (action) {
      case "recategorize":
      case "move":
        if (isCashflow(t)) changeable.push(t);
        else lockedSkipped.push({ tx: t, reason: editLockReason(t, action) });
        break;
      case "delete":
        if (t.kind === "opening") lockedSkipped.push({ tx: t, reason: "Opening balances can't be deleted" });
        else changeable.push(t);
        break;
      case "exclude":
        if (isCashflow(t)) { if (!t.excludedFromReporting) changeable.push(t); /* already-excluded omitted */ }
        else lockedSkipped.push({ tx: t, reason: "Only income & expense affect reporting" });
        break;
      case "include":
        if (isCashflow(t)) { if (t.excludedFromReporting) changeable.push(t); /* already-included omitted */ }
        else lockedSkipped.push({ tx: t, reason: "Only income & expense affect reporting" });
        break;
    }
  }
  return { action, changeable, lockedSkipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/txnSelection.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build`
```bash
git add src/lib/txnSelection.ts src/__tests__/txnSelection.test.ts
git commit -m "feat(txn): selection summary + bulk eligibility planning"
```

---

## Task 3: TxnRow enhancements (density, color dot, checkbox, quick-actions)

Extend `TxnRow` with optional props so the same row renders in the list (with checkbox + hover actions + density) and in the preview sheet (compact, no actions). Defaults keep current call sites (Dashboard, account activity) unchanged.

**Files:**
- Modify: `src/components/TxnRow.tsx`

- [ ] **Step 1: Add props and wire them**

Edit the `TxnRow` signature and body. New optional props: `density?: "comfortable" | "compact"` (default `"comfortable"`), `selected?: boolean`, `onToggleSelect?: () => void`, `quickActions?: ReactNode`. The category color dot overlays the glyph; the amount column gets a fixed width.

Replace the component’s prop list and the row container/glyph/amount blocks with:

```tsx
import type { ReactNode } from "react";
// ...existing imports unchanged...

export function TxnRow({ tx, accounts, categories, perspectiveAccountId, onClick, showDate = true, balanceAfterCents,
  density = "comfortable", selected = false, onToggleSelect, quickActions }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; perspectiveAccountId?: string; onClick?: () => void;
  showDate?: boolean; balanceAfterCents?: number;
  density?: "comfortable" | "compact"; selected?: boolean; onToggleSelect?: () => void; quickActions?: ReactNode;
}) {
  const t = useTheme();
  // ...existing cat/meta/color/title/subtitle/signed logic unchanged...

  const rowH = density === "compact" ? 42 : 50;
  const glyph = density === "compact" ? 28 : 32;

  return (
    <div className={`sens-row${onClick ? " click" : ""}`} onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 8px", margin: "0 -8px", height: rowH, borderRadius: 9, background: selected ? hexA(t.accent, 0.08) : undefined, position: "relative" }}>
      {onToggleSelect && (
        <button onClick={(e) => { e.stopPropagation(); onToggleSelect(); }} aria-label="Select transaction"
          style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 6, border: `1.5px solid ${selected ? t.accent : t.borderStrong}`, background: selected ? t.accent : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          {selected && <Icon name="check" size={11} color={t.onAccent} stroke={3} />}
        </button>
      )}
      <div style={{ position: "relative", flexShrink: 0 }}>
        {cat ? <GlyphTile tone={cat.color ?? color} size={glyph} emoji={cat.emoji} />
          : <GlyphTile tone={color} size={glyph} icon={meta.icon} />}
        <span style={{ position: "absolute", left: -3, top: -3, width: 9, height: 9, borderRadius: 99, background: cat?.color ?? color, border: `2px solid ${t.panel}` }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* existing title + excluded chip + subtitle blocks unchanged */}
      </div>
      {quickActions && <div className="sens-row-quick" style={{ display: "flex", gap: 4, flexShrink: 0 }}>{quickActions}</div>}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, width: 110, flexShrink: 0 }}>
        {/* existing Money + balanceAfter block unchanged */}
      </div>
    </div>
  );
}
```

Keep the existing title/subtitle/Money inner JSX exactly as-is; only the container, the new checkbox, the glyph wrapper (with color dot), the `quickActions` slot, and the fixed-width amount column are added.

Note: `check` must be a valid `IconName`. Verify with `grep -n "check" src/components/Icon.tsx`; if absent, use `name="tick"` or the existing affirmative icon found there.

- [ ] **Step 1b: Add a `copy` icon for Duplicate**

`src/components/Icon.tsx` has no copy/duplicate glyph (union is `dots…flag`). Add one. In the `IconName` union add `| "copy"`, and in the `paths` map add:

```tsx
copy: <>{<rect x="8" y="8" width="11" height="11" rx="2" {...P} />}<path {...P} d="M5 15V5h10" /></>,
```

(Match the existing `P` spread + element style used by neighboring entries like `trash`/`check`.)

- [ ] **Step 2: Reveal quick-actions on hover via CSS**

`TxnRow` uses the existing `sens-row` class. Add a hover rule so `.sens-row-quick` is hidden until row hover. Find where `sens-row` is defined (`grep -rn "sens-row" src/theme src/components src/index.css 2>/dev/null`) and add, in that same stylesheet:

```css
.sens-row-quick { opacity: 0; transition: opacity .12s; }
.sens-row:hover .sens-row-quick { opacity: 1; }
```

If `sens-row` styles are injected from `ThemeProvider.tsx`, append these rules to that injected string instead.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: clean. Fix any `IconName`/unused-prop errors.

- [ ] **Step 4: Smoke-check existing call sites**

Run: `npm run dev`, open the Dashboard and an account’s activity. Rows must look unchanged (color dot is additive; no checkbox/quick-actions where not passed).

- [ ] **Step 5: Commit**

```bash
git add src/components/TxnRow.tsx
git commit -m "feat(txn): TxnRow density, color dot, checkbox + quick-action slots"
```

---

## Task 4: Toolbar, filters, and date-ranged data load

Rebuild the top of `Transactions.tsx`: search, date-range segmented control (drives `listTransactions` `fromDate`/`toDate`), sort control, density toggle (persisted), kind chips (client-side multi), account pill, and live In/Out totals. Default range: **This month**.

**Files:**
- Modify: `src/screens/Transactions.tsx`

- [ ] **Step 1: Add state + the date-ranged fetch**

At the top of the `Transactions` component, add state and replace the data effect:

```tsx
import { rangeForPreset, type DateRangePreset, type CustomRange } from "../lib/txnFilters";
import { todayISO } from "../lib/format";
// ...

const [preset, setPreset] = useState<DateRangePreset>("thisMonth");
const [custom, setCustom] = useState<CustomRange>({});
const [sort, setSort] = useState<"date-desc" | "date-asc" | "amount-desc" | "amount-asc">("date-desc");
const [density, setDensity] = useState<"comfortable" | "compact">(
  () => (localStorage.getItem("sens.txn.density") as "comfortable" | "compact") || "comfortable",
);
useEffect(() => { localStorage.setItem("sens.txn.density", density); }, [density]);

useEffect(() => {
  const r = rangeForPreset(preset, todayISO(), custom);
  client.listTransactions({ limit: 1000, ...r }).then(setTxns).catch(() => {});
}, [version, preset, custom]);
```

Remove the old unconditional `listTransactions({ limit: 500 })` effect.

- [ ] **Step 2: Apply sort + keep client-side kind/account/search filtering**

After the existing `filtered` memo, derive a sorted list:

```tsx
import { txnSortKey } from "../lib/kinds";
// ...
const sorted = useMemo(() => {
  const arr = [...filtered];
  arr.sort((a, b) => {
    if (sort === "amount-desc") return b.amountCents - a.amountCents;
    if (sort === "amount-asc") return a.amountCents - b.amountCents;
    const ka = txnSortKey(a), kb = txnSortKey(b);
    return sort === "date-asc" ? (ka < kb ? -1 : ka > kb ? 1 : 0) : (ka < kb ? 1 : ka > kb ? -1 : 0);
  });
  return arr;
}, [filtered, sort]);
```

Use `sorted` (not `filtered`) to build `groups`. Keep `totalIn`/`totalOut` computed from `filtered`.

- [ ] **Step 3: Render the toolbar**

Replace the existing search/totals header block with a toolbar containing: the existing search input; a segmented control for `This month / Last month / Custom / All` (set `preset`; for Custom, reveal two `<input type="date">` bound to `custom.fromDate` / `custom.toDateInclusive`); a sort `<select>`; and a density toggle button (`comfortable`↔`compact`). Use `useTheme()` tokens and the existing input styling pattern already in this file. Keep In/Out totals on the filter line, right-aligned (existing markup).

Concrete segmented-control + density snippet (place in the toolbar row):

```tsx
{(["thisMonth","lastMonth","custom","all"] as DateRangePreset[]).map((p) => (
  <button key={p} onClick={() => setPreset(p)}
    style={{ height: 34, padding: "0 12px", fontSize: 12.5, border: `0.5px solid ${t.border}`,
      background: preset === p ? t.panel3 : t.panel, color: preset === p ? t.text : t.dim,
      borderRadius: 9, cursor: "pointer" }}>
    {p === "thisMonth" ? "This month" : p === "lastMonth" ? "Last month" : p === "custom" ? "Custom" : "All"}
  </button>
))}
<button onClick={() => setDensity((d) => d === "compact" ? "comfortable" : "compact")}
  title="Toggle density" style={{ height: 34, padding: "0 12px", border: `0.5px solid ${t.border}`,
    background: t.panel, color: t.dim, borderRadius: 9, cursor: "pointer" }}>
  {density === "compact" ? "Comfortable" : "Compact"}
</button>
```

- [ ] **Step 4: Typecheck + verify**

Run: `npm run build` (clean), then `npm run dev`. Confirm: default shows this-month rows; switching presets re-queries (row set changes); Custom reveals date inputs; sort reorders; density toggles row height and persists across reload.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Transactions.tsx
git commit -m "feat(txn): smart toolbar with date-range, sort, density, live totals"
```

---

## Task 5: Sticky day headers with net subtotal + selection checkboxes

Render the grouped list with sticky day headers showing the day’s net (income − expense), pass `density`, and add per-row selection checkboxes feeding a `Set<string>` of selected ids.

**Files:**
- Modify: `src/screens/Transactions.tsx`

- [ ] **Step 1: Selection state + day-net helper**

```tsx
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
const toggleSelect = (id: string) => setSelectedIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

function dayNet(items: Transaction[]): number {
  return items.reduce((s, x) => s + (x.kind === "income" ? x.amountCents : x.kind === "expense" ? -x.amountCents : 0), 0);
}
```

- [ ] **Step 2: Render sticky headers + rows**

In the groups map, make the date header sticky and show the net; render each `TxnRow` with `density`, `selected`, `onToggleSelect`, and a `quickActions` slot:

```tsx
<div key={g.date}>
  <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "9px 18px", fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4,
    background: t.panel2, borderBottom: `0.5px solid ${t.divider}` }}>
    <span>{dateGroupLabel(g.date)}</span>
    <Money cents={dayNet(g.items)} signed size={11} weight={700} />
  </div>
  <div style={{ padding: "4px 16px" }}>
    {g.items.map((tx) => (
      <TxnRow key={tx.id} tx={tx} accounts={accounts} categories={categories} showDate={false}
        density={density} selected={selectedIds.has(tx.id)} onToggleSelect={() => toggleSelect(tx.id)}
        onClick={() => { setSelId(tx.id); }}
        quickActions={<>
          {tx.kind !== "adjustment" && tx.kind !== "opening" && <IconBtn name="pencil" icon={13} onClick={() => setEditing(tx)} title="Edit" />}
          {tx.kind !== "adjustment" && tx.kind !== "opening" && <IconBtn name="copy" icon={13} onClick={() => onDuplicate(tx)} title="Duplicate" />}
          {tx.kind !== "opening" && <IconBtn name="trash" icon={13} onClick={() => onDelete(tx.id)} title="Delete" />}
        </>} />
    ))}
  </div>
</div>
```

Verify icon names exist (`grep -nE "pencil|copy|trash|sliders" src/components/Icon.tsx`); substitute the nearest available names if any are missing.

- [ ] **Step 3: Add the `onDuplicate` handler**

```tsx
async function onDuplicate(tx: Transaction) {
  if (tx.kind === "income" && tx.categoryId) await client.createIncome(tx.accountId, tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, tx.excludedFromReporting);
  else if (tx.kind === "expense" && tx.categoryId) await client.createExpense(tx.accountId, tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, tx.excludedFromReporting);
  else if (tx.kind === "transfer" && tx.toAccountId) await client.createTransfer(tx.accountId, tx.toAccountId, tx.amountCents, tx.description, tx.transactionDate);
  await reload();
}
```

- [ ] **Step 4: Typecheck + verify**

Run: `npm run build`, then `npm run dev`. Confirm: day headers stick while scrolling and show a signed net; checkboxes toggle highlight; hover reveals Edit/Duplicate/Delete (hidden appropriately for adjustment/opening); Duplicate creates a copy dated the same day.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Transactions.tsx
git commit -m "feat(txn): sticky day subtotals, row selection, hover quick-actions, duplicate"
```

---

## Task 6: Single-transaction detail panel with inline edit (`TxnDetailPanel.tsx`)

Extract and upgrade the right sidebar. For income/expense/transfer: inline-editable category (tree), account(s), date, note, amount, and (income/expense) an Exclude-from-reporting toggle, saved via `updateTransaction`. For adjustment/opening: read-only with the existing note. Header shows kind badge, big signed amount, and a balance-impact line via `computeRunningBalances`.

**Files:**
- Create: `src/components/TxnDetailPanel.tsx`
- Modify: `src/screens/Transactions.tsx` (use the new component; pass the full `txns` for balance impact)

- [ ] **Step 1: Create the component**

```tsx
// src/components/TxnDetailPanel.tsx
import { useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Btn, Money, GlyphTile, IconBtn } from "./ui";
import { Icon } from "./Icon";
import { client } from "../client";
import { accountName } from "../store";
import { fmtDate } from "../lib/format";
import { KIND_META, kindColor, signedFor, computeRunningBalances } from "../lib/kinds";
import { categoryPickerItems } from "../lib/categories";

export function TxnDetailPanel({ tx, accounts, categories, allTxns, onClose, onDuplicate, onDelete, onSaved }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; allTxns: Transaction[];
  onClose: () => void; onDuplicate: () => void; onDelete: () => void; onSaved: () => void;
}) {
  const t = useTheme();
  const color = kindColor(t, tx.kind);
  const meta = KIND_META[tx.kind];
  const editable = tx.kind === "income" || tx.kind === "expense" || tx.kind === "transfer";

  const [categoryId, setCategoryId] = useState(tx.categoryId);
  const [accountId, setAccountId] = useState(tx.accountId);
  const [toAccountId, setToAccountId] = useState(tx.toAccountId);
  const [date, setDate] = useState(tx.transactionDate);
  const [desc, setDesc] = useState(tx.description ?? "");
  const [excluded, setExcluded] = useState(tx.excludedFromReporting);
  const [busy, setBusy] = useState(false);

  // Balance impact: balance AFTER this txn on its source account.
  const acctTxns = allTxns.filter((x) => x.accountId === accountId || x.toAccountId === accountId);
  const after = computeRunningBalances(acctTxns, accountId).get(tx.id);
  const before = after != null ? after - signedFor(tx.kind, tx.amountCents, tx.toAccountId === accountId) : undefined;

  async function save() {
    setBusy(true);
    try {
      await client.updateTransaction({
        id: tx.id, kind: tx.kind, accountId,
        toAccountId: tx.kind === "transfer" ? toAccountId : null,
        categoryId: tx.kind === "transfer" ? null : categoryId,
        amountCents: tx.amountCents, description: desc.trim() || null, transactionDate: date,
        excludedFromReporting: tx.kind === "transfer" ? false : excluded,
      });
      onSaved();
    } finally { setBusy(false); }
  }

  const signedCents = signedFor(tx.kind, tx.amountCents, false);
  const catItems = categoryPickerItems(categories, tx.kind === "income" ? "income" : "expense");

  return (
    <Card className="sens-pop" pad={0} style={{ overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 0 }}>
      <div style={{ padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <GlyphTile tone={color} size={40} icon={meta.icon} />
          <IconBtn name="close" onClick={onClose} title="Close" icon={16} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 12 }}>{tx.description || meta.label}</div>
        <div style={{ marginTop: 6 }}>
          <Money cents={tx.kind === "transfer" ? tx.amountCents : signedCents} signed={tx.kind !== "transfer"}
            color={tx.kind === "transfer" ? color : undefined} size={26} weight={700} />
        </div>
        {before != null && after != null && (
          <div style={{ fontSize: 11.5, color: t.faint, marginTop: 6 }}>
            {accountName(accounts, accountId)} balance {(before / 100).toFixed(2)} → <b style={{ color: t.text }}>{(after / 100).toFixed(2)}</b>
          </div>
        )}
      </div>

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {editable ? (
          <>
            {tx.kind !== "transfer" && (
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>Category</span>
                <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)}
                  style={{ background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }}>
                  {catItems.map((c) => <option key={c.id} value={c.id}>{c.depth ? "— " : ""}{c.emoji} {c.label}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <span style={{ color: t.dim }}>{tx.kind === "transfer" ? "From" : "Account"}</span>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
                style={{ background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {tx.kind === "transfer" && (
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>To</span>
                <select value={toAccountId ?? ""} onChange={(e) => setToAccountId(e.target.value || null)}
                  style={{ background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                style={{ background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }} />
            </label>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, gap: 10 }}>
              <span style={{ color: t.dim }}>Note</span>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="—"
                style={{ flex: 1, background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }} />
            </label>
            {tx.kind !== "transfer" && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>Exclude from reporting</span>
                <button role="switch" aria-checked={excluded} onClick={() => setExcluded((v) => !v)}
                  style={{ width: 38, height: 22, borderRadius: 99, border: "none", background: excluded ? t.opening : t.panel3, position: "relative", cursor: "pointer" }}>
                  <span style={{ position: "absolute", top: 2, left: excluded ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: excluded ? t.onAccent : t.dim, transition: "left .15s" }} />
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <Btn size="sm" onClick={save} disabled={busy} style={{ flex: 1, justifyContent: "center" }}>Save</Btn>
              <Btn variant="outline" icon="copy" size="sm" onClick={onDuplicate} style={{ flex: 1, justifyContent: "center" }}>Duplicate</Btn>
            </div>
            <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ justifyContent: "center" }}>Delete</Btn>
          </>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Date</span><span style={{ fontWeight: 600 }}>{fmtDate(tx.transactionDate)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Account</span><span style={{ fontWeight: 600 }}>{accountName(accounts, tx.accountId)}</span>
            </div>
            <div style={{ fontSize: 12, color: t.dim, background: t.panel2, padding: "8px 12px", borderRadius: 8, display: "flex", gap: 7, alignItems: "center" }}>
              <Icon name={meta.icon} size={14} color={color} />
              {tx.kind === "opening" ? "The opening balance is set from the account." : "Adjustments can be deleted but not edited."}
            </div>
            {tx.kind !== "opening" && <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ justifyContent: "center" }}>Delete</Btn>}
          </>
        )}
      </div>
    </Card>
  );
}
```

`PickerItem` is `{ id, label, emoji, depth: 0 | 1 }` (confirmed in `src/lib/categories.ts`) — use `c.label`, not `c.name`. `Btn` accepts `disabled` (see `ui.tsx:21`). The `Btn icon="copy"` here relies on the `copy` icon added in Task 3 Step 1b.

- [ ] **Step 2: Wire into the screen**

In `Transactions.tsx`, replace the old inline `DetailPanel` usage. Render `TxnDetailPanel` only when there is a single click selection and **no** multi-selection (`selectedIds.size === 0`):

```tsx
{sel && selectedIds.size === 0 && (
  <TxnDetailPanel tx={sel} accounts={accounts} categories={categories} allTxns={txns}
    onClose={() => setSelId(null)} onDuplicate={() => onDuplicate(sel)} onDelete={() => onDelete(sel.id)}
    onSaved={() => { reload(); }} />
)}
```

Delete the old `DetailPanel` function from `Transactions.tsx`. Update the grid template to show the side column when `(sel && selectedIds.size === 0) || selectedIds.size > 0`.

- [ ] **Step 3: Typecheck + verify**

Run: `npm run build`, then `npm run dev`. For an expense: edit category/account/date/note, Save → row updates; toggle Exclude → the row’s "Excluded" chip appears. Open an adjustment and an opening: read-only with the right note; opening has no Delete. Confirm the balance-impact line reads sensibly.

- [ ] **Step 4: Commit**

```bash
git add src/components/TxnDetailPanel.tsx src/screens/Transactions.tsx
git commit -m "feat(txn): inline-editable detail panel with balance impact"
```

---

## Task 7: Bulk preview sheet (`BulkPreviewSheet.tsx`)

The modal that previews a bulk action: a will-change list (with before→after for recategorize/move), a reversible "Removed by you" bucket (per-row Skip / Add back), a locked "Can't change" bucket, live counts, and Apply. Takes a `BulkPlan` plus a resolved target; returns the final id set to apply.

**Files:**
- Create: `src/components/BulkPreviewSheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/BulkPreviewSheet.tsx
import { useMemo, useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Modal, Btn, Money } from "./ui";
import { Icon } from "./Icon";
import type { BulkAction, BulkPlan } from "../lib/txnSelection";

export interface BulkTarget { categoryName?: string; accountName?: string }

const VERB: Record<BulkAction, string> = {
  recategorize: "Re-categorize", move: "Move to account",
  exclude: "Exclude from reporting", include: "Include in reporting", delete: "Delete",
};

export function BulkPreviewSheet({ plan, target, accounts, categories, onCancel, onApply, onChangeTarget }: {
  plan: BulkPlan; target?: BulkTarget; accounts: Account[]; categories: Category[];
  onCancel: () => void; onApply: (ids: string[]) => void; onChangeTarget?: () => void;
}) {
  const t = useTheme();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const isDelete = plan.action === "delete";

  const changing = useMemo(() => plan.changeable.filter((x) => !removed.has(x.id)), [plan.changeable, removed]);
  const skippedTotal = plan.lockedSkipped.length + removed.size;
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "—";

  const row = (tx: Transaction, trailing: React.ReactNode, dim = false) => (
    <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 12.5, opacity: dim ? 0.6 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tx.description || VERB[plan.action]}</div>
        <div style={{ fontSize: 11, color: t.faint }}>{(accounts.find((a) => a.id === tx.accountId)?.name) ?? "—"} · {tx.transactionDate.slice(5)}</div>
      </div>
      {trailing}
    </div>
  );

  return (
    <Modal onClose={onCancel} width={480}>
      <div style={{ padding: "16px 18px", borderBottom: `0.5px solid ${t.divider}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {VERB[plan.action]}
          {target && (target.categoryName || target.accountName) && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: t.panel2, border: `0.5px solid ${t.borderStrong}`, borderRadius: 8, padding: "3px 9px", fontSize: 12.5 }}>
              {target.categoryName ?? target.accountName}
              {onChangeTarget && <span onClick={onChangeTarget} style={{ color: t.accent, cursor: "pointer", fontWeight: 500 }}>Change</span>}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: t.dim, marginTop: 7 }}>
          Applying to <b style={{ color: t.text }}>{changing.length}</b>
          {skippedTotal > 0 && ` · ${skippedTotal} skipped`}
        </div>
      </div>

      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.faint }}>Will change · {changing.length}</div>
        {changing.map((tx) => row(tx,
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {plan.action === "recategorize" && <span style={{ fontSize: 11, color: t.accent }}>→ {target?.categoryName}</span>}
            <Money cents={tx.kind === "income" ? tx.amountCents : -tx.amountCents} signed size={12} />
            <span onClick={() => setRemoved((p) => new Set(p).add(tx.id))} style={{ fontSize: 11, color: t.dim, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}>✕ Skip</span>
          </div>))}

        {removed.size > 0 && <>
          <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.accent }}>Removed by you · {removed.size}</div>
          {plan.changeable.filter((x) => removed.has(x.id)).map((tx) => row(tx,
            <span onClick={() => setRemoved((p) => { const n = new Set(p); n.delete(tx.id); return n; })} style={{ fontSize: 11, color: t.accent, border: `0.5px solid ${t.accent}`, borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}>＋ Add back</span>, true))}
        </>}

        {plan.lockedSkipped.length > 0 && <>
          <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.opening }}>Can't change · {plan.lockedSkipped.length}</div>
          {plan.lockedSkipped.map(({ tx, reason }) => row(tx, <span style={{ fontSize: 11, color: t.opening, fontStyle: "italic" }}>{reason}</span>, true))}
        </>}
      </div>

      <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: `0.5px solid ${t.divider}` }}>
        <Btn variant="outline" size="sm" onClick={onCancel}>Cancel</Btn>
        <Btn variant={isDelete ? "danger" : "primary"} size="sm" disabled={changing.length === 0}
          onClick={() => onApply(changing.map((x) => x.id))} style={{ flex: 1, justifyContent: "center" }}>
          {isDelete ? `Delete ${changing.length}` : `Apply to ${changing.length}`}
        </Btn>
      </div>
      {isDelete && <div style={{ padding: "0 18px 14px", fontSize: 11.5, color: t.faint }}>This can't be undone.</div>}
    </Modal>
  );
}
```

Verify `Modal` renders arbitrary children (it does — `ui.tsx:112`) and that `Btn` supports `variant="danger"|"outline"|"primary"` and `disabled` (it does).

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/BulkPreviewSheet.tsx
git commit -m "feat(txn): bulk preview sheet with per-row skip/add-back"
```

---

## Task 8: Selection panel + bulk apply + preview gating (`TxnSelectionPanel.tsx`)

The sidebar’s multi-select state: summary (count, net, In/Out, other counts) + adaptive action buttons showing affected counts. Wires into the screen’s bulk executor, which either opens `BulkPreviewSheet` (when the setting is on) or applies directly (off), with a delete-always-confirm fallback.

**Files:**
- Create: `src/components/TxnSelectionPanel.tsx`
- Modify: `src/screens/Transactions.tsx`

- [ ] **Step 1: Create the selection panel**

```tsx
// src/components/TxnSelectionPanel.tsx
import type { Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Money, IconBtn } from "./ui";
import { summarizeSelection, planBulk, type BulkAction } from "../lib/txnSelection";

const ACTIONS: { action: BulkAction; label: string; danger?: boolean }[] = [
  { action: "recategorize", label: "Re-categorize" },
  { action: "move", label: "Move to account" },
  { action: "exclude", label: "Exclude from reporting" },
  { action: "include", label: "Include in reporting" },
  { action: "delete", label: "Delete", danger: true },
];

export function TxnSelectionPanel({ selected, onClear, onAction }: {
  selected: Transaction[]; onClear: () => void; onAction: (a: BulkAction) => void;
}) {
  const t = useTheme();
  const s = summarizeSelection(selected);
  const others = [
    s.otherCounts.transfer && `${s.otherCounts.transfer} transfer`,
    s.otherCounts.adjustment && `${s.otherCounts.adjustment} adjustment`,
    s.otherCounts.opening && `${s.otherCounts.opening} opening`,
  ].filter(Boolean).join(", ");

  return (
    <Card pad={0} style={{ overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 0 }}>
      <div style={{ padding: 16, borderBottom: `0.5px solid ${t.divider}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 21, fontWeight: 700 }}>{s.count} <span style={{ fontSize: 12, color: t.dim, fontWeight: 500 }}>selected</span></div>
          <div style={{ marginTop: 6 }}><span style={{ fontSize: 12, color: t.dim }}>net </span><Money cents={s.netCents} signed size={16} weight={700} /></div>
        </div>
        <IconBtn name="close" onClick={onClear} title="Clear selection" icon={16} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "8px 16px", borderBottom: `0.5px solid ${t.divider}` }}>
        <span style={{ color: t.dim }}>In · {selected.filter((x) => x.kind === "income").length}</span>
        <Money cents={s.inCents} signed color={t.income} size={12.5} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "8px 16px", borderBottom: `0.5px solid ${t.divider}` }}>
        <span style={{ color: t.dim }}>Out · {selected.filter((x) => x.kind === "expense").length}</span>
        <Money cents={-s.outCents} signed color={t.expense} size={12.5} />
      </div>
      {others && <div style={{ fontSize: 11.5, color: t.faint, padding: "9px 16px", borderBottom: `0.5px solid ${t.divider}` }}>Also selected (not in net): {others}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        {ACTIONS.map(({ action, label, danger }) => {
          const n = planBulk(action, selected).changeable.length;
          const skipped = selected.length - n - (action === "exclude" || action === "include" ? selected.filter((x) => (x.kind === "income" || x.kind === "expense")).length - planBulk(action, selected).changeable.length - planBulk(action, selected).lockedSkipped.length : 0);
          const disabled = n === 0;
          return (
            <button key={action} disabled={disabled} onClick={() => onAction(action)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 12px", height: 34, borderRadius: 9,
                border: `0.5px ${disabled ? "dashed" : "solid"} ${t.borderStrong}`, background: disabled ? "transparent" : t.panel2,
                color: danger ? t.expense : t.text, opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer", fontSize: 12.5 }}>
              <span>{label}</span>
              <span style={{ fontFamily: t.mono, fontSize: 11, color: t.dim }}>{n}{action === "exclude" || action === "include" ? " to change" : ""}</span>
            </button>
          );
        })}
        <button onClick={onClear} style={{ height: 30, border: "none", background: "transparent", color: t.dim, cursor: "pointer", fontSize: 12.5 }}>Clear selection</button>
      </div>
    </Card>
  );
}
```

Simplify the `skipped` display if it proves noisy — the affected count `n` is the essential figure; a faint "· N skipped" suffix is optional polish. Keep `n` correct.

- [ ] **Step 2: Add the bulk executor + preview gating to the screen**

In `Transactions.tsx`:

```tsx
import { TxnSelectionPanel } from "../components/TxnSelectionPanel";
import { BulkPreviewSheet, type BulkTarget } from "../components/BulkPreviewSheet";
import { planBulk, type BulkAction } from "../lib/txnSelection";
import { useToast } from "../components/Toast";
// ...
const toast = useToast();
const [previewOn, setPreviewOn] = useState(true);
useEffect(() => { client.getSetting("bulk_action_preview").then((v) => setPreviewOn(v !== "0")).catch(() => {}); }, []);

const [pending, setPending] = useState<{ action: BulkAction; target?: BulkTarget } | null>(null);
const selectedTxns = useMemo(() => txns.filter((x) => selectedIds.has(x.id)), [txns, selectedIds]);

async function applyBulk(action: BulkAction, ids: string[], target?: BulkTarget) {
  const toApply = txns.filter((x) => ids.includes(x.id));
  for (const tx of toApply) {
    if (action === "delete") { await client.deleteTransaction(tx.id); continue; }
    const base = { id: tx.id, kind: tx.kind, accountId: tx.accountId, toAccountId: tx.toAccountId,
      categoryId: tx.categoryId, amountCents: tx.amountCents, description: tx.description,
      transactionDate: tx.transactionDate, excludedFromReporting: tx.excludedFromReporting };
    if (action === "recategorize") base.categoryId = target!.categoryId!;
    if (action === "move") base.accountId = target!.accountId!;
    if (action === "exclude") base.excludedFromReporting = true;
    if (action === "include") base.excludedFromReporting = false;
    await client.updateTransaction(base);
  }
  const skipped = selectedTxns.length - toApply.length;
  setSelectedIds(new Set());
  setPending(null);
  await reload();
  const verb = { recategorize: "Re-categorized", move: "Moved", exclude: "Excluded", include: "Included", delete: "Deleted" }[action];
  toast(`${verb} ${toApply.length}${skipped > 0 ? ` · ${skipped} skipped` : ""}`);
}

function startBulk(action: BulkAction) {
  // recategorize/move need a target first — open the appropriate picker, then:
  //   if previewOn → setPending({action, target}); else applyBulk(action, planBulk(action, selectedTxns).changeable.map(x=>x.id), target)
  // exclude/include/delete have no target:
  const plan = planBulk(action, selectedTxns);
  if (action === "delete" && !previewOn) {
    if (!confirm(`Delete ${plan.changeable.length} transaction(s)? This can't be undone.`)) return;
    applyBulk(action, plan.changeable.map((x) => x.id));
    return;
  }
  if (previewOn) { setPending({ action }); return; }
  applyBulk(action, plan.changeable.map((x) => x.id));
}
```

Add `BulkTarget` fields `categoryId?: string; accountId?: string` to its interface in `BulkPreviewSheet.tsx` (extend the existing interface). For Task-8 scope, wire **delete / exclude / include** end-to-end first (no target). Re-categorize / Move target pickers are Step 4.

- [ ] **Step 3: Render the selection panel + preview sheet**

```tsx
{selectedIds.size > 0 && (
  <TxnSelectionPanel selected={selectedTxns} onClear={() => setSelectedIds(new Set())} onAction={startBulk} />
)}
{pending && (
  <BulkPreviewSheet plan={planBulk(pending.action, selectedTxns)} target={pending.target}
    accounts={accounts} categories={categories}
    onCancel={() => setPending(null)} onApply={(ids) => applyBulk(pending.action, ids, pending.target)} />
)}
```

- [ ] **Step 4: Re-categorize / Move target pickers**

For `recategorize`/`move`, open a small picker before the preview. Reuse a lightweight popover or a `Modal` listing `categoryPickerItems(categories, ...)` / `accounts`. On choose, set the target (`{ categoryId, categoryName }` or `{ accountId, accountName }`) and then either open the preview (`setPending({ action, target })`) or apply directly when `previewOn` is false. The `Change` link in the sheet calls back to reopen this picker (`onChangeTarget`).

- [ ] **Step 5: Typecheck + verify**

Run: `npm run build`, then `npm run dev`. Select a mix of kinds. Confirm: panel shows count/net/In/Out/others; each action’s count matches the eligibility table; disabled+dashed when 0; with preview on, pressing opens the sheet (per-row Skip works, counts update live, Apply writes + toasts + clears); delete shows red Apply and "can't be undone"; re-categorize/move ask for a target then preview.

- [ ] **Step 6: Commit**

```bash
git add src/components/TxnSelectionPanel.tsx src/components/BulkPreviewSheet.tsx src/screens/Transactions.tsx
git commit -m "feat(txn): adaptive selection panel + bulk apply with preview gating"
```

---

## Task 9: Settings toggle "Preview bulk actions"

**Files:**
- Modify: `src/screens/Settings.tsx`

- [ ] **Step 1: Add state + handler (mirror remember_month)**

In the `Settings` component, near the `rememberMonth` state/effect:

```tsx
const [bulkPreview, setBulkPreview] = useState(true);
useEffect(() => { client.getSetting("bulk_action_preview").then((v) => setBulkPreview(v !== "0")).catch(() => {}); }, []);
function handleBulkPreviewToggle(val: boolean) {
  setBulkPreview(val);
  client.setSetting("bulk_action_preview", val ? "1" : "0").catch(() => {});
}
```

- [ ] **Step 2: Add the Settings card/row**

Add a new card (place after the Dashboard card):

```tsx
<Card>
  <SectionTitle>Transactions</SectionTitle>
  <SettingRow
    label="Preview bulk actions"
    hint="Show a confirmation sheet listing which transactions will change before re-categorizing, moving, excluding, or deleting in bulk."
    right={<Toggle on={bulkPreview} onChange={handleBulkPreviewToggle} />}
  />
</Card>
```

- [ ] **Step 3: Typecheck + verify**

Run: `npm run build`, then `npm run dev`. Toggle the setting off; on Transactions, a bulk edit applies without the sheet, but bulk Delete still confirms. Toggle on; the sheet returns.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Settings.tsx
git commit -m "feat(settings): preview-bulk-actions toggle (default on)"
```

---

## Task 10: Keyboard navigation

Add screen-scoped keyboard handling: ↑/↓ move the single selection, `E` edit, `⌫` delete, `⌘A`/`Ctrl+A` select the visible range, `Esc` clears/closes, `Space` toggles the active checkbox. Ignore events while typing in an input.

**Files:**
- Modify: `src/screens/Transactions.tsx`

- [ ] **Step 1: Add the key handler**

```tsx
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
    const flat = sorted; // visible, filtered, sorted order
    const idx = flat.findIndex((x) => x.id === selId);
    if (e.key === "ArrowDown") { e.preventDefault(); const n = flat[Math.min(idx + 1, flat.length - 1)]; if (n) setSelId(n.id); }
    else if (e.key === "ArrowUp") { e.preventDefault(); const n = flat[Math.max(idx - 1, 0)]; if (n) setSelId(n.id); }
    else if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSelectedIds(new Set(flat.map((x) => x.id))); }
    else if (e.key === "Escape") { if (selectedIds.size) setSelectedIds(new Set()); else setSelId(null); }
    else if (e.key === " " && selId) { e.preventDefault(); toggleSelect(selId); }
    else if ((e.key === "e" || e.key === "E") && sel && sel.kind !== "adjustment" && sel.kind !== "opening") { setEditing(sel); }
    else if ((e.key === "Backspace" || e.key === "Delete") && sel && sel.kind !== "opening") { onDelete(sel.id); }
  }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [sorted, selId, sel, selectedIds]);
```

- [ ] **Step 2: Typecheck + verify**

Run: `npm run build`, then `npm run dev`. Confirm each shortcut; confirm typing in the search box or an inline-edit field does not trigger shortcuts.

- [ ] **Step 3: Commit**

```bash
git add src/screens/Transactions.tsx
git commit -m "feat(txn): keyboard navigation for the transactions screen"
```

---

## Task 11: Full-suite verification + docs

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md` (per the project’s "always update documentation" rule)

- [ ] **Step 1: Run the full gates**

Run: `npm test` (all green) and `npm run build` (clean). Fix any regressions.

- [ ] **Step 2: Manual pass against the spec**

In `npm run dev`, walk the spec’s testing checklist: mixed-kind bulk selection, inline edit of each editable kind, exclude/include toggling (inline + bulk), date-range switches, sort, density persistence, keyboard nav, read-only adjustment/opening, preview-on vs preview-off behavior, delete-always-confirms.

- [ ] **Step 3: Update docs**

Add a `CHANGELOG.md` `[Unreleased]` entry; add a row to `ROADMAP.md`; update the `Frontend conventions` section of `CLAUDE.md` to describe the redesigned Transactions screen (toolbar, sticky subtotals, three-state sidebar, bulk preview sheet, `bulk_action_preview` setting, `sens.txn.density` localStorage key). Reference this plan and the spec.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md ROADMAP.md CLAUDE.md
git commit -m "docs: changelog/roadmap/CLAUDE for transactions redesign"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Toolbar/date-range (T4), sort/density (T4), sticky subtotals + aligned amounts + color dot + quick-actions + duplicate (T3, T5), inline-edit detail + balance impact + exclude toggle (T6), adaptive selection panel (T8), preview sheet with per-row skip + locked/removed buckets (T7), consistent affected counts (T8), exclude/include flip-only counting (T2/T8), setting + delete-always-confirm (T8/T9), keyboard (T10). Mock parity already satisfied (`mock.ts:320-321`).
- **Type consistency:** `BulkAction`/`BulkPlan`/`LockedRow` defined in T2 are imported unchanged in T7/T8; `BulkTarget` is defined in T7 and extended (`categoryId`/`accountId`) before use in T8 Step 2.
- **Confirmed against source:** icons `pencil`/`trash`/`check`/`close` exist; `copy` does **not** and is added in Task 3 Step 1b. `PickerItem` is `{ id, label, emoji, depth }` — Task 6 uses `c.label`. Keep all colors via `useTheme()` tokens.
- **Watch item still open:** `IconBtn`/`Btn` `icon` prop typing — ensure the added `copy` lands in the `IconName` union before any component references `name="copy"`/`icon="copy"` (Task 3 precedes Tasks 5/6, so order is correct).
