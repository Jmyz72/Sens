# Advanced Sidebar And Top Bar Design

## Summary

Upgrade the Sens app shell by making the sidebar more informative and structured while keeping the top bar familiar. The selected direction is a "Finance Status Sidebar": it adds a compact financial snapshot, grouped navigation, item counts, and a clearer workspace footer. The top bar remains the screen title and action area, with light refinements only.

## Goals

- Make the sidebar feel more advanced without turning it into a second dashboard.
- Surface useful finance context from existing app data: assets, debts, net worth, and monthly change.
- Keep navigation scannable and consistent with the current macOS-native visual style.
- Preserve the existing screen router, month state, add menu, theme toggle, and data loading flow.
- Keep changes frontend-only unless existing client functions are insufficient.

## Non-Goals

- No new financial rules, reports, persistence tables, or settings.
- No custom sidebar layout configuration.
- No global search, command palette, notifications center, or major top-bar workflow changes.
- No mobile layout work.

## Sidebar Design

The sidebar should remain a fixed desktop navigation rail, widened slightly if needed to fit the new content. It will contain four zones:

1. Brand header: Sens icon, app name, and a small "Personal finance" descriptor.
2. Finance status card: net worth as the primary number, with assets, debts, and monthly change below.
3. Grouped navigation: sections for Overview, Money, and System.
4. Workspace footer: "Personal" workspace label plus the existing theme toggle.

The status card should use existing account and dashboard data. Assets are the sum of active `own` account balances. Debts are the sum of active `owe` account balances and should display as a debt value while respecting the frontend sign conventions. Net worth is assets plus debts. Monthly change should come from the selected dashboard month's net cashflow if available; if loading or unavailable, the card should render a neutral loading or placeholder state.

## Navigation Details

The existing screens remain unchanged:

- Dashboard
- Accounts
- Transactions
- Categories
- Settings

Navigation should be visually grouped but still use the existing `ScreenId` router. Counts may be shown where cheap and already available:

- Accounts: active account count.
- Categories: category count.
- Transactions: omit the count unless the current screen data already exposes it without adding a new backend query.

The selected item should keep the current accent-soft treatment and icon styling. Section labels should be small, quiet, and token-based.

## Top Bar Design

The top bar should stay close to the current structure:

- Current screen title and subtitle on the left.
- Dashboard month selector when Dashboard is active.
- Add menu on the right.

Refinements are limited to better spacing, alignment with the widened sidebar, and making room for the richer sidebar. The top bar should not introduce search or filter controls in this change.

## Data Flow

`App.tsx` already owns accounts, categories, selected month, and reload state. The sidebar status card can derive account totals from `accounts` locally using existing account `group` and signed `balanceCents` values. Monthly change may reuse existing dashboard summary behavior only if that can be done without duplicating business logic in the shell. If not, the first implementation should show assets, debts, and net worth only, leaving monthly change out.

All money formatting must use existing helpers from `src/lib/format.ts`. Balance presentation for debts must follow the account sign conventions in `src/lib/accounts.ts`.

## Styling

Use only semantic theme tokens from `useTheme()`. The app shell should keep the current dark/light support, hairline borders, compact radii, and system font stack. No hardcoded component colors should be added outside existing token helpers such as `hexA`.

The design should avoid decorative gradients or marketing-style visual treatment. Cards should be compact, functional, and no more than 8-10px radius to match the existing UI language.

## Testing And Verification

- `npm run build` must pass.
- Any new pure helper for sidebar totals should have a focused Vitest test.
- Browser dev should render without console/runtime errors.
- Verify the sidebar in dark and light themes.
- Confirm text does not overflow at the app's minimum practical desktop width.

## Risks And Assumptions

- Assumption: "More advanced" means richer information density and stronger navigation hierarchy, not new workflows.
- The monthly change line is optional because pulling dashboard summary into the app shell may add unnecessary loading complexity.
- The change should stay in `App.tsx` and small helper code unless the implementation becomes too large, in which case the sidebar can be extracted into a focused component.
