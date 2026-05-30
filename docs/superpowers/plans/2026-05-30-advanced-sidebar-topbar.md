# Advanced Sidebar And Top Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Finance Status Sidebar direction for Sens while keeping the top bar familiar.

**Architecture:** Add a small pure helper for deriving sidebar portfolio totals from the existing `Account[]`, test it first, then update `App.tsx` to render a richer sidebar using existing theme tokens and UI primitives. Keep behavior frontend-only and avoid new backend commands.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, existing Sens theme tokens and icon system.

---

## File Structure

- Modify `src/lib/accounts.ts`: add `sidebarPortfolioSummary(accounts)` pure helper.
- Modify `src/__tests__/accounts.test.ts`: add focused tests for assets, debts, net worth, and archived account exclusion.
- Modify `src/App.tsx`: derive sidebar summary and render the advanced sidebar zones.

## Task 1: Sidebar Portfolio Summary Helper

**Files:**
- Modify: `src/lib/accounts.ts`
- Test: `src/__tests__/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests showing that active own accounts contribute to assets, active owe accounts contribute to liabilities, net worth is the signed sum, and archived accounts are ignored.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/accounts.test.ts`

Expected: fail because `sidebarPortfolioSummary` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add:

```ts
export interface SidebarPortfolioSummary {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
}

export function sidebarPortfolioSummary(accounts: Pick<Account, "group" | "balanceCents" | "isArchived">[]): SidebarPortfolioSummary {
  return accounts.reduce<SidebarPortfolioSummary>((summary, account) => {
    if (account.isArchived) return summary;
    if (account.group === "own") summary.assetsCents += account.balanceCents;
    else summary.liabilitiesCents += account.balanceCents;
    summary.netWorthCents = summary.assetsCents + summary.liabilitiesCents;
    return summary;
  }, { assetsCents: 0, liabilitiesCents: 0, netWorthCents: 0 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/accounts.test.ts`

Expected: pass.

## Task 2: Advanced Sidebar UI

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Use helper in App**

Import `sidebarPortfolioSummary`, derive `portfolioSummary` with `useMemo`, and derive `activeAccountCount` / `activeCategoryCount` from existing loaded data.

- [ ] **Step 2: Replace sidebar markup**

Update the sidebar to render:

- Brand header with Sens and "Personal finance".
- Portfolio card showing net worth, assets, debts, and current selected month.
- Grouped navigation sections: Overview, Money, System.
- Footer with Personal workspace and theme toggle.

- [ ] **Step 3: Preserve existing behavior**

Ensure `go()`, active screen state, Add menu, dashboard month selector, theme toggle, and modals still use the existing state.

- [ ] **Step 4: Run frontend gate**

Run: `npm run build`

Expected: TypeScript and Vite build pass.

## Task 3: Final Verification

**Files:**
- Verify: whole frontend

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run src/__tests__/accounts.test.ts`

Expected: pass.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: pass.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: pass.
