# New Account modal redesign — design

**Date:** 2026-05-31
**Status:** Approved (brainstorm)
**Touches:** `src/modals/AddAccount.tsx`, new logo asset system, `src/screens/Accounts.tsx` (list rows)

## What this is

A redesign of the **New Account** modal (`src/modals/AddAccount.tsx`). The current
single-screen modal crams a provider grid, a provider/custom toggle, two type/subtype
dropdowns, name, and balance into one 460px dialog. It feels cramped, the flow is
clunky, and the account type is hard to find. Providers are rendered as brand-colour
**monogram tiles** (first letter of the name), not real logos.

This redesign replaces it with a **two-step, provider-first flow** with real bundled
provider logos, an explicit visual type picker, and more breathing room. The same real
logos also replace the monogram tiles on the **Accounts screen** list rows.

## Goals

1. **Clearer flow** — split into two focused steps instead of one dense screen.
2. **Easy-to-find type** — make account type an explicit, visual 5-card choice.
3. **Less cramped** — progressive disclosure across two steps; chips instead of dropdowns.
4. **Real provider logos** — every provider gets a real, bundled logo (no monogram
   fallback for known providers); logos also appear on the Accounts list.

## Non-goals

- No change to the data model, `create_account` signature, validation, or the
  account taxonomy. Backend/Rust + mock business logic is **unchanged**.
- No per-subtype behaviour (credit limits, schedules, interest) — still deferred.
- `EditAccount` / `SetBalance` modals are out of scope (may reuse the new logo
  component later, but not in this change).

## Key principle (from brainstorm)

**The provider is branding only — fully independent of account type and subtype.**
Maybank backs savings, current, fixed deposits, loans, and credit cards alike. Picking a
provider therefore **never** pre-selects or constrains the type/subtype. It only:

- attaches its logo to the account (via the already-persisted `templateKey`), and
- pre-fills the **account name** with the provider name (user-editable).

This is consistent with the existing CLAUDE.md note that "providers are branding only,"
and makes the redesign drop the old `default_subtype`-based type pre-selection.

## The taxonomy (16 subtypes → 5 types → 2 groups)

Canonical source: `account_subtypes` (migration 002), mirrored by `SUBTYPE_ROWS` in
`mock.ts`. The Step 2 type-cards and subtype-chips render directly from this.

| Group | Type (`TYPE_LABEL`) | Subtypes |
|---|---|---|
| `own` (asset, +balance) | `fund` — *Cash & funds* | cash · ewallet · savings · current |
| `own` | `financial` — *Investments* | fixed-deposit · investment · unit-trust · crypto |
| `own` | `receivable` — *Receivables* | lent |
| `owe` (liability, −balance) | `payable` — *Payables* | borrowed |
| `owe` | `credit` — *Credit & loans* | credit-card · bnpl · personal-loan · mortgage · car-loan · other-debt |

Design consequences:

- **Group drives sign + balance label.** `own` → positive, "Opening balance (RM)".
  `owe` (`payable`, `credit`) → stored negative, "Amount owed (RM)". `receivable`
  (lent) is **own / positive**, not owe.
- **`receivable` and `payable` each have exactly one subtype** (lent / borrowed). When
  those type-cards are selected the subtype row is a single auto-selected chip; the
  picker auto-selects it (and may de-emphasize the lone chip). `credit` has 6, `fund`
  and `financial` have 4 each.

## Flow

### Step 1 · Provider

- Header: **"New account" · "Step 1 of 2 · Provider"**.
- A search input filtering providers by name (banks, e-wallets, brokers…).
- Providers shown in the existing **groups** (Banks, Digital banks, E-wallets, Buy now
  pay later, Investment, Global fintech, Crypto), each provider rendered as a **real
  logo on a white rounded tile** with the provider name beneath.
- A dashed **"Custom"** tile (no provider) at the end of the grid.
- **Clicking a provider or Custom advances immediately to Step 2** (no "Next" button).

### Step 2 · Details

- Header: **"New account" · "Step 2 of 2 · Details"**.
- **Provider summary row**: the chosen provider's logo + name + a **"Change provider"**
  link that returns to Step 1. For a Custom account, a neutral "No provider" row (still
  offering "Change provider" to go back and pick one).
- **"What kind of account?"** — the 5 account **types** as a visual card picker, using
  the existing `TYPE_ORDER` / `TYPE_LABEL`: Cash & funds, Investments, Receivables,
  Payables, Credit & loans. **Defaults to `fund` (Cash & funds)** regardless of provider.
- **Subtype** — chips for the subtypes of the selected type (replaces the old `<select>`),
  driven by `subtypesForType`; selecting a type resets to its first subtype.
- **Account name** — text input, pre-filled with the provider name when arriving from a
  provider tile, blank for Custom; always editable.
- **Opening balance (RM)** — money input; label flips to **"Amount owed (RM)"** for
  `owe`-group subtypes (Payables / Credit), and the positive input is **negated before
  send**, exactly as today (`isOwe`, `signedOpening`).
- Footer: **Back** (returns to Step 1) and **Create account** (disabled until a name +
  valid subtype exist).

### Submission

Unchanged contract:
`client.createAccount(name.trim(), subtype, signedOpening, templateKey | null)`.
`templateKey` is the chosen provider's key, or `null` for Custom. The Tauri command,
service, repo, and `mock.ts` all stay as-is.

## Logo system

### Assets

- Real logos bundled under **`src/assets/logos/<template-key>.svg`** (SVG preferred;
  high-res PNG where no clean SVG exists), cropped to a roughly square mark. Prefer the
  brand **symbol**; fall back to a contained **wordmark** when no symbol exists.
- A frontend asset map resolves them, e.g. via Vite `import.meta.glob('../assets/logos/*',
  { eager: true })` keyed by template key → URL. This keeps logos **frontend-only**; no
  backend `icon_asset` wiring is required.

### `ProviderLogo` component

A small shared component (e.g. `src/components/ProviderLogo.tsx`):

- Props: `templateKey: string | null`, `size`, `radius`.
- Renders the logo **contained on a white rounded tile** so brand colours read in both
  dark and light themes (the white tile is an intentional constant, allowed like other
  brand data constants).
- For `templateKey === null` (Custom accounts), renders the existing brand-colour
  **monogram tile** fallback (`GlyphTile` + `FALLBACK_PALETTE`). The "no fallback" rule
  applies only to **known providers**; a custom account legitimately has no logo.

Used by both Step 1 grid tiles, the Step 2 summary row, and the Accounts list rows.

### No-gaps policy & gap list

Every one of the ~53 seeded providers must have a real logo before this ships — there is
**no monogram fallback for a known provider**. During implementation, source every logo
possible; any that cannot be sourced cleanly (likely candidates: Agrobank, MBSB Bank,
KAF Digital Bank, Bank Muamalat, Riipay, Al Rajhi Bank) are collected into a short
**gap list** handed to the user to supply. The redesign is not considered done until the
logo set is complete. A dev-only check (test or assertion) verifies every seeded
`template.key` has a corresponding bundled asset.

## Accounts screen change

`src/screens/Accounts.tsx` list rows currently render a monogram `GlyphTile`. Swap that
for `<ProviderLogo templateKey={account.templateKey} … />`, which shows the real logo for
provider-backed accounts and the monogram fallback for custom accounts. No other
behaviour on the Accounts screen changes.

## Component structure

`AddAccount.tsx` becomes a small step machine:

- Local state `step: 1 | 2`, plus existing `picked` (template | null, where "Custom" is a
  distinct null-but-chosen state), `name`, `type`, `subtype`, `opening`, `busy`, `error`.
- Step 1 renders search + grouped `ProviderLogo` grid + Custom tile; selecting sets
  `picked`, pre-fills `name` (if empty) from the provider, and sets `step = 2`.
- Step 2 renders the summary row, type cards, subtype chips, name, balance, Back/Create.
- The old header "Custom account / Pick a provider" toggle is removed (Custom is now a
  Step 1 tile; "Change provider" replaces the toggle).

Extract the type-card picker and subtype chips inline (or as tiny local components) for
readability; keep the file focused on the modal.

## Data flow & invariants preserved

- All money stays **integer MYR cents**; parsing via `parseAmountToCents`.
- `owe` negation handled in the frontend only (`signedOpening`); backend speaks signed
  cents. Unchanged.
- The **Tauri ↔ mock seam** needs no change — no command signatures or behaviours change.
  This is a pure frontend/asset redesign.

## Files touched

- `src/modals/AddAccount.tsx` — rewritten as the two-step flow.
- `src/components/ProviderLogo.tsx` — new shared logo component.
- `src/assets/logos/*.svg` — new bundled logo assets (all seeded providers).
- `src/screens/Accounts.tsx` — list rows use `ProviderLogo`.
- A logo-coverage test (every seeded `template.key` has an asset).

## Testing

- `npm run build` stays clean (strict TS).
- Existing Vitest suite passes; add a test asserting every template key resolves to a
  bundled logo asset (the no-gaps guard).
- Manual: `npm run dev` (mock backend) to click through both steps, provider → type →
  subtype combinations (e.g. Maybank + Credit card), the Custom path, owe-label flip, and
  the Accounts list showing real logos.

## Open items

- **Logo gap list** — providers with no cleanly sourceable logo, surfaced to the user
  during implementation; must be filled before shipping.
