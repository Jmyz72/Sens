# New Account Modal Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped single-screen New Account modal with a two-step, provider-first flow that uses real bundled provider logos and an explicit visual type/subtype picker, and show the same logos on the Accounts list rows.

**Architecture:** Pure frontend + static asset change — no Rust/service/seam logic changes. A new frontend provider catalog (`src/lib/providers.ts`) mirrors the Rust seed (all 50 providers) and feeds the browser mock; a logo asset map (`src/lib/logos.ts`) resolves `src/assets/logos/<key>.svg`; a shared `ProviderLogo` component renders a logo on a white plate (monogram fallback only for provider-less custom accounts). `AddAccount.tsx` becomes a 2-step state machine. The account's `subtype` is the only stored classifier; the type-card picker is non-persisted UI that filters the subtype chips.

**Tech Stack:** React 19 + TypeScript (strict, `noUnusedLocals`), Vite (`import.meta.glob`), Vitest. Existing UI atoms in `src/components/ui.tsx`, theme tokens via `useTheme()`.

**Reference spec:** `docs/superpowers/specs/2026-05-31-new-account-modal-redesign-design.md`

---

## File Structure

- **Create** `src/lib/providers.ts` — frontend mirror of the Rust template seed (50 providers, grouped). Single source for the mock + logo coverage test.
- **Create** `src/lib/logos.ts` — `logoFor(key)` asset map over `src/assets/logos/*.svg`.
- **Create** `src/components/ProviderLogo.tsx` — logo-on-white-plate tile with monogram fallback.
- **Create** `src/assets/logos/<key>.svg` — 50 real provider logos.
- **Modify** `src/client/mock.ts` — build templates from `PROVIDER_GROUPS` (replaces the inline 33-provider `TPL_GROUPS`).
- **Rewrite** `src/modals/AddAccount.tsx` — two-step provider-first flow.
- **Modify** `src/screens/Accounts.tsx` — list rows use `ProviderLogo`.
- **Create** `src/__tests__/providers.test.ts`, `src/__tests__/logos.test.ts`.
- **Modify** `CHANGELOG.md`, `CLAUDE.md` — document the redesign.

---

## Task 1: Provider catalog + mock parity

The browser mock currently seeds only 33 providers while the Rust app (`src-tauri/src/db/seed.rs`) seeds 50. Extract the frontend list into one module mirroring the full Rust seed, and feed the mock from it.

**Files:**
- Create: `src/lib/providers.ts`
- Create: `src/__tests__/providers.test.ts`
- Modify: `src/client/mock.ts:42-58` (the `TPL_GROUPS` block + `templates` builder)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/providers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROVIDER_GROUPS, PROVIDER_KEYS } from "../lib/providers";

describe("provider catalog", () => {
  it("mirrors the full Rust seed: 50 providers, all keys unique", () => {
    expect(PROVIDER_KEYS.length).toBe(50);
    expect(new Set(PROVIDER_KEYS).size).toBe(50);
  });

  it("includes the providers the old 33-entry mock dropped", () => {
    for (const k of ["agrobank", "kaf-digital-bank", "bank-muamalat", "riipay", "kdi", "luno"]) {
      expect(PROVIDER_KEYS).toContain(k);
    }
  });

  it("every group carries a defaultSubtype", () => {
    for (const g of PROVIDER_GROUPS) expect(g.defaultSubtype.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/providers.test.ts`
Expected: FAIL — `Cannot find module '../lib/providers'`.

- [ ] **Step 3: Create the provider catalog**

Create `src/lib/providers.ts` (keys/names/groups copied verbatim from `src-tauri/src/db/seed.rs`):

```ts
// Frontend mirror of the Rust account-template seed (src-tauri/src/db/seed.rs).
// Providers are BRANDING ONLY — `group` organises the picker and `defaultSubtype`
// is a suggested starting subtype; neither determines an account's type/group.
// KEEP IN SYNC with seed.rs, which is authoritative for the packaged app.

export type ProviderGroup = {
  group: string;
  defaultSubtype: string;
  providers: [key: string, name: string][];
};

export const PROVIDER_GROUPS: ProviderGroup[] = [
  { group: "Banks", defaultSubtype: "savings", providers: [
    ["maybank", "Maybank"], ["cimb", "CIMB"], ["public-bank", "Public Bank"],
    ["rhb", "RHB"], ["hong-leong-bank", "Hong Leong Bank"], ["ambank", "AmBank"],
    ["bank-islam", "Bank Islam"], ["bank-rakyat", "Bank Rakyat"],
    ["bank-muamalat", "Bank Muamalat"], ["affin-bank", "Affin Bank"],
    ["alliance-bank", "Alliance Bank"], ["bsn", "BSN"], ["agrobank", "Agrobank"],
    ["mbsb-bank", "MBSB Bank"], ["al-rajhi-bank", "Al Rajhi Bank"],
    ["ocbc", "OCBC"], ["uob", "UOB"], ["hsbc", "HSBC"],
    ["standard-chartered", "Standard Chartered"],
  ] },
  { group: "Digital banks", defaultSubtype: "savings", providers: [
    ["gxbank", "GXBank"], ["boost-bank", "Boost Bank"], ["aeon-bank", "AEON Bank"],
    ["kaf-digital-bank", "KAF Digital Bank"], ["ryt-bank", "Ryt Bank"],
  ] },
  { group: "E-wallets", defaultSubtype: "ewallet", providers: [
    ["tng-ewallet", "Touch 'n Go eWallet"], ["grabpay", "GrabPay"], ["boost", "Boost"],
    ["shopeepay", "ShopeePay"], ["mae", "MAE"], ["setel", "Setel"],
    ["bigpay", "BigPay"], ["lazada-wallet", "Lazada Wallet"],
  ] },
  { group: "Buy now, pay later", defaultSubtype: "bnpl", providers: [
    ["atome", "Atome"], ["shopee-paylater", "Shopee PayLater"],
    ["grab-paylater", "Grab PayLater"], ["boost-payflex", "Boost PayFlex"],
    ["riipay", "Riipay"],
  ] },
  { group: "Investment", defaultSubtype: "investment", providers: [
    ["asnb", "ASNB"], ["stashaway", "StashAway"], ["versa", "Versa"],
    ["wahed", "Wahed"], ["rakuten-trade", "Rakuten Trade"], ["moomoo", "Moomoo"],
    ["kdi", "KDI"],
  ] },
  { group: "Global fintech", defaultSubtype: "ewallet", providers: [
    ["paypal", "PayPal"], ["wise", "Wise"], ["revolut", "Revolut"],
    ["n26", "N26"], ["payoneer", "Payoneer"],
  ] },
  { group: "Crypto", defaultSubtype: "crypto", providers: [
    ["luno", "Luno"],
  ] },
];

export const PROVIDER_KEYS: string[] =
  PROVIDER_GROUPS.flatMap((g) => g.providers.map(([key]) => key));
```

- [ ] **Step 4: Wire the mock to the catalog**

In `src/client/mock.ts`, add to the imports near the top (after the existing `import type { … }` block):

```ts
import { PROVIDER_GROUPS } from "../lib/providers";
```

Then replace the whole `// ── seed templates ──` block (the `TPL_GROUPS` constant and the `templates` builder, currently lines ~42-58) with:

```ts
// ── seed templates (mirrors src/lib/providers.ts → Rust seed) ──
const templates: AccountTemplate[] = [];
PROVIDER_GROUPS.forEach(({ group, defaultSubtype, providers }) =>
  providers.forEach(([key, name]) =>
    templates.push({
      key, name, groupName: group, defaultSubtype,
      iconAsset: key, brandColor: null, sortOrder: templates.length, isActive: true,
    }),
  ),
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/providers.test.ts src/__tests__/mock.test.ts src/__tests__/mock-accounts.test.ts`
Expected: PASS (catalog test green; mock tests still green with the larger list).

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: clean (`tsc` + `vite build` succeed).

- [ ] **Step 7: Commit**

```bash
git add src/lib/providers.ts src/__tests__/providers.test.ts src/client/mock.ts
git commit -m "feat(accounts): frontend provider catalog mirroring full Rust seed (50)"
```

---

## Task 2: Logo asset map + ProviderLogo component

**Files:**
- Create: `src/lib/logos.ts`
- Create: `src/components/ProviderLogo.tsx`
- Create: `src/__tests__/logos.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/logos.test.ts` (only the pure `logoFor` behavior here — asset coverage is Task 3):

```ts
import { describe, it, expect } from "vitest";
import { logoFor } from "../lib/logos";

describe("logoFor", () => {
  it("returns null for null/undefined key", () => {
    expect(logoFor(null)).toBeNull();
    expect(logoFor(undefined)).toBeNull();
  });

  it("returns null for an unknown provider key", () => {
    expect(logoFor("definitely-not-a-provider")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/logos.test.ts`
Expected: FAIL — `Cannot find module '../lib/logos'`.

- [ ] **Step 3: Create the logo asset map**

Create `src/lib/logos.ts`:

```ts
// Bundled provider logos, keyed by template key. Real brand marks live in
// src/assets/logos/<key>.svg and are rendered on a white plate by ProviderLogo.
// Every seeded provider must have one (enforced by src/__tests__/logos coverage).

const modules = import.meta.glob("../assets/logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byKey: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  const key = path.split("/").pop()!.replace(/\.svg$/, "");
  byKey[key] = url;
}

export function logoFor(key: string | null | undefined): string | null {
  return key ? byKey[key] ?? null : null;
}
```

- [ ] **Step 4: Create the ProviderLogo component**

Create `src/components/ProviderLogo.tsx`:

```tsx
import { useTheme } from "../theme/ThemeProvider";
import { GlyphTile } from "./ui";
import { accountTone } from "../lib/brand";
import { logoFor } from "../lib/logos";

// A white plate is the required substrate for brand logos (most assume a light
// background), so it stays white in both themes — treated as brand data, not a
// theme color.
const LOGO_PLATE = "#ffffff";

export function ProviderLogo({
  templateKey, name, size = 38, radius = 10, seed,
}: {
  templateKey: string | null | undefined;
  name?: string;
  size?: number;
  radius?: number;
  seed?: string;
}) {
  const t = useTheme();
  const url = logoFor(templateKey);
  if (url) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius, background: LOGO_PLATE,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
      }}>
        <img src={url} alt={name ?? ""} style={{ width: "72%", height: "72%", objectFit: "contain" }} />
      </div>
    );
  }
  // No provider (custom account) → brand-tinted monogram tile.
  return (
    <GlyphTile
      tone={accountTone({ templateKey, fallbackSeed: seed }, t.accent)}
      size={size}
      emoji={(name ?? "?")[0]}
      radius={radius}
    />
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/logos.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logos.ts src/components/ProviderLogo.tsx src/__tests__/logos.test.ts
git commit -m "feat(accounts): ProviderLogo + bundled-logo asset map"
```

---

## Task 3: Source all 50 provider logos (no gaps)

Source a real logo SVG for **every** key in `PROVIDER_KEYS` into `src/assets/logos/<key>.svg`. A coverage test enforces completeness — the redesign does not ship until it is green.

**Files:**
- Create: `src/assets/logos/<key>.svg` (×50)
- Modify: `src/__tests__/logos.test.ts` (add the coverage test)

The 50 keys:
```
maybank cimb public-bank rhb hong-leong-bank ambank bank-islam bank-rakyat
bank-muamalat affin-bank alliance-bank bsn agrobank mbsb-bank al-rajhi-bank
ocbc uob hsbc standard-chartered gxbank boost-bank aeon-bank kaf-digital-bank
ryt-bank tng-ewallet grabpay boost shopeepay mae setel bigpay lazada-wallet
atome shopee-paylater grab-paylater boost-payflex riipay asnb stashaway versa
wahed rakuten-trade moomoo kdi paypal wise revolut n26 payoneer luno
```

- [ ] **Step 1: Add the coverage test (goes red)**

Append to `src/__tests__/logos.test.ts`:

```ts
import { PROVIDER_KEYS } from "../lib/providers";

describe("provider logo coverage", () => {
  it("every seeded provider has a bundled logo asset (no gaps)", () => {
    const missing = PROVIDER_KEYS.filter((k) => !logoFor(k));
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/__tests__/logos.test.ts -t "no gaps"`
Expected: FAIL — `missing` lists all 50 keys (no assets yet).

- [ ] **Step 3: Source each logo into `src/assets/logos/<key>.svg`**

For each key, obtain a real brand mark and save it as `src/assets/logos/<key>.svg`. Guidance:

- **Prefer** the brand's official SVG or a clean Wikimedia Commons SVG; prefer the **symbol/icon mark** over a wide wordmark so it sits well in a square. Crop/trim to a roughly square viewBox.
- Acceptable to use a high-res PNG only if no SVG exists — but then save as `<key>.svg` is wrong; instead extend the glob in `logos.ts` to also match `*.png` and name it `<key>.png`. (Default to SVG; only widen the glob if forced.)
- Optimize with `npx svgo` where available to shrink and strip metadata.
- Use the **terminal** (WebFetch / curl) to fetch; do not hand-draw logos.
- This is nominative/identification use in a personal, local-first app — fine for that purpose; keep the marks unmodified beyond cropping.

**Gap handling (per spec):** any provider whose logo cannot be sourced cleanly stays in the failing `missing` list. Collect those keys and hand the user a short gap list to supply the asset. Do **not** substitute a monogram to force the test green — the no-gaps policy means this task stays open until the user provides the missing files.

- [ ] **Step 4: Run the coverage test to verify it passes**

Run: `npx vitest run src/__tests__/logos.test.ts`
Expected: PASS — `missing` is `[]`. If not, report the remaining keys as the gap list and pause.

- [ ] **Step 5: Verify the bundle builds with the assets**

Run: `npm run build`
Expected: clean; Vite bundles the SVGs.

- [ ] **Step 6: Commit**

```bash
git add src/assets/logos src/__tests__/logos.test.ts
git commit -m "feat(accounts): bundle real provider logos for all seeded providers"
```

---

## Task 4: Rewrite AddAccount as a two-step flow

**Files:**
- Rewrite: `src/modals/AddAccount.tsx`

- [ ] **Step 1: Replace the modal with the two-step implementation**

Overwrite `src/modals/AddAccount.tsx` with:

```tsx
// Create an account in two steps: (1) pick a provider (branding only) or Custom,
// (2) choose type + subtype (independent of the provider), name, and balance.
// Only `subtype` is persisted — the type cards are UI that filters subtype chips.
// For owe-group subtypes the balance field is "Amount owed" and is stored negative.

import { useEffect, useMemo, useState } from "react";
import type { AccountSubtype, AccountTemplate } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { ProviderLogo } from "../components/ProviderLogo";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

const TYPE_EMOJI: Record<string, string> = {
  fund: "💵", financial: "📈", receivable: "🤝", payable: "📄", credit: "💳",
};

export function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<AccountTemplate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("fund");
  const [subtype, setSubtype] = useState<string>("savings");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountTemplates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, AccountTemplate[]>();
    templates.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
      if (!map.has(x.groupName)) map.set(x.groupName, []);
      map.get(x.groupName)!.push(x);
    });
    return [...map.entries()];
  }, [templates, query]);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  const currentSubtype = subtypes.find((s) => s.key === subtype);
  const isOwe = currentSubtype?.group === "owe";

  // Keep subtype valid when the chosen type changes.
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  function chooseProvider(tpl: AccountTemplate) {
    setProvider(tpl);
    if (!name) setName(tpl.name); // provider pre-fills the name; user can edit
    setStep(2);
  }
  function chooseCustom() {
    setProvider(null);
    setStep(2);
  }

  const openingCents = opening ? parseAmountToCents(opening) ?? 0 : 0;
  const signedOpening = isOwe ? -openingCents : openingCents;
  const canCreate = name.trim().length > 0 && !!currentSubtype;

  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await client.createAccount(name.trim(), subtype, signedOpening, provider?.key ?? null);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not create account");
    } finally { setBusy(false); }
  }

  const tileBtn = (on: boolean) => ({
    flexDirection: "column" as const, gap: 6, padding: "11px 4px", height: "auto",
    borderRadius: 11, fontWeight: 600, textAlign: "center" as const,
    color: on ? t.text : t.dim,
    background: on ? t.accentSoft : t.panel2,
    border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}`,
  });

  return (
    <Modal onClose={onClose} width={460}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>New account</span>
        <span style={{ fontSize: 11.5, color: t.faint }}>Step {step} of 2 · {step === 1 ? "Provider" : "Details"}</span>
      </div>

      {step === 1 ? (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 9 }}>
            <Icon name="search" size={15} color={t.faint} />
            <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search banks, e-wallets, brokers…" autoFocus
              style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
          </div>
          <div style={{ maxHeight: 340, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, margin: "0 -4px", padding: "0 4px" }}>
            {groups.map(([group, items]) => (
              <div key={group}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {items.map((tpl) => (
                    <button key={tpl.key} className="sens-btn" onClick={() => chooseProvider(tpl)}
                      style={{ ...tileBtn(false), fontSize: 11 }}>
                      <ProviderLogo templateKey={tpl.key} name={tpl.name} size={38} radius={10} />
                      <span style={{ width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Other</div>
              <button className="sens-btn" onClick={chooseCustom}
                style={{ width: "100%", justifyContent: "center", gap: 8, height: 44, borderRadius: 11, fontSize: 12.5, fontWeight: 600, color: t.text, background: "transparent", border: `1px dashed ${t.border}` }}>
                <Icon name="plus" size={15} color={t.faint} /> Custom account
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 11 }}>
            <ProviderLogo templateKey={provider?.key ?? null} name={provider?.name ?? "?"} size={34} radius={9} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{provider?.name ?? "No provider"}</span>
            <button className="sens-btn sens-btn-ghost" onClick={() => setStep(1)}
              style={{ marginLeft: "auto", height: 26, padding: "0 8px", borderRadius: 7, fontSize: 11.5, fontWeight: 600, color: t.accent }}>
              Change provider
            </button>
          </div>

          <Field label="What kind of account?">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {TYPE_ORDER.map((x) => (
                <button key={x} className="sens-btn" onClick={() => setType(x)} style={{ ...tileBtn(type === x), fontSize: 10.5 }}>
                  <span style={{ fontSize: 17 }}>{TYPE_EMOJI[x]}</span>
                  <span style={{ width: "100%", lineHeight: 1.2 }}>{TYPE_LABEL[x]}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Subtype">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {subtypesForType.map((s) => {
                const on = subtype === s.key;
                return (
                  <button key={s.key} className="sens-btn" onClick={() => setSubtype(s.key)}
                    style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      color: on ? t.text : t.dim, background: on ? t.accentSoft : t.panel2,
                      border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}` }}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Account name">
            <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Everyday Savings" style={inputStyle(t)} />
          </Field>

          <Field label={isOwe ? "Amount owed (RM)" : "Opening balance (RM)"}>
            <input className="sens-input" value={opening} inputMode="decimal" placeholder="0.00"
              onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...inputStyle(t), fontFamily: t.mono }} />
          </Field>

          {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="outline" onClick={() => setStep(1)} style={{ flex: 1, justifyContent: "center", height: 38 }}>Back</Btn>
            <Btn variant="primary" onClick={submit} disabled={!canCreate || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Create account</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean. (If `tsc` flags the removed `GlyphTile`/`templateTone`/`hexA` imports, ensure the import line matches exactly the one above — `hexA` is still used; `GlyphTile` and `templateTone` are no longer imported here.)

- [ ] **Step 3: Manual smoke test (mock backend)**

Run: `npm run dev`, open the app, click **+ New account** on the Accounts screen and verify:
- Step 1 shows grouped logo tiles + search + a dashed "Custom account" tile.
- Clicking a provider jumps to Step 2 with its logo, name pre-filled, "Step 2 of 2 · Details".
- Type cards switch the subtype chips; picking **Credit & loans → Credit card** flips the balance label to "Amount owed (RM)".
- "Change provider" returns to Step 1; "Custom account" → Step 2 with "No provider".
- Create works for a provider account, a custom account, and an owe account (check the Accounts list balance sign).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modals/AddAccount.tsx
git commit -m "feat(accounts): two-step provider-first New Account modal"
```

---

## Task 5: Provider logos on the Accounts list rows

**Files:**
- Modify: `src/screens/Accounts.tsx` (the collapsed row tile at ~line 154, plus imports)

- [ ] **Step 1: Swap the row tile to ProviderLogo**

In `src/screens/Accounts.tsx`, replace the row tile:

```tsx
<GlyphTile tone={accountTone({ templateKey: a.templateKey, fallbackSeed: a.id }, t.accent)} size={36} emoji={a.name[0]} radius={10} />
```

with:

```tsx
<ProviderLogo templateKey={a.templateKey} name={a.name} seed={a.id} size={36} radius={10} />
```

- [ ] **Step 2: Fix imports**

Add near the other component imports:

```tsx
import { ProviderLogo } from "../components/ProviderLogo";
```

Then remove now-unused symbols to satisfy `noUnusedLocals`:
- In `import { Btn, Card, Empty, GlyphTile, Money } from "../components/ui";` drop `GlyphTile` → `import { Btn, Card, Empty, Money } from "../components/ui";` **only if** `GlyphTile` is unused elsewhere in the file (grep first: `grep -n GlyphTile src/screens/Accounts.tsx`).
- If `accountTone` is now unused (grep: `grep -n accountTone src/screens/Accounts.tsx`), remove it from its `../lib/brand` import. Keep any other symbols imported from that line (e.g. `balanceDisplay` comes from `../lib/accounts`, not brand — leave it).

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: clean (no unused-import errors).

- [ ] **Step 4: Manual check**

Run: `npm run dev`; on the Accounts screen, provider-backed accounts show real logos on white tiles; a custom account still shows the brand-tinted monogram.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Accounts.tsx
git commit -m "feat(accounts): real provider logos on Accounts list rows"
```

---

## Task 6: Documentation + final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Under the `## [Unreleased]` section in `CHANGELOG.md`, add (create an `### Changed` / `### Added` subsection if the section is empty):

```markdown
### Changed
- New Account modal redesigned as a two-step, provider-first flow: pick a provider
  (or Custom) from a searchable logo grid, then choose type + subtype, name, and
  balance. Provider is branding only and never determines the account type.

### Added
- Real bundled provider logos for all seeded providers, rendered via the new
  `ProviderLogo` component on a white plate; also shown on the Accounts list rows.
- `src/lib/providers.ts` — frontend provider catalog mirroring the Rust seed.
```

- [ ] **Step 2: Update CLAUDE.md frontend conventions**

In `CLAUDE.md`, in the **Frontend conventions** section, update the account-creation note to reflect the new flow and components. Replace the sentence describing AddAccount with:

```markdown
- **Account creation** is a two-step, provider-first modal (`src/modals/AddAccount.tsx`):
  Step 1 picks a provider (branding only) or Custom from a searchable logo grid;
  Step 2 picks type → subtype (chips), name (pre-filled from the provider, editable),
  and opening balance. Only `subtype` is persisted; the type cards filter the chips.
  Provider logos are bundled SVGs in `src/assets/logos/<key>.svg`, resolved by
  `src/lib/logos.ts` (`logoFor`) and rendered by `src/components/ProviderLogo.tsx`
  (white plate; monogram fallback for provider-less custom accounts). The frontend
  provider catalog `src/lib/providers.ts` mirrors the Rust seed and feeds the mock.
```

(Adjust the surrounding wording so it reads cleanly with the existing paragraph.)

- [ ] **Step 3: Full verification**

Run, and confirm each is clean/green:
```bash
npm run build
npm test
```
Expected: typecheck clean; all Vitest suites pass (including `providers`, `logos` coverage).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: document two-step New Account modal + provider logos"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** two-step provider-first flow (Task 4), explicit type/subtype picker with chips (Task 4), real bundled logos no-gaps (Tasks 2–3), provider=branding/name-prefill-only (Task 4), logos on Accounts rows (Task 5), seam parity / mock to 50 (Task 1), `subtype`-only persistence with unchanged `createAccount` (Task 4), owe-label flip (Task 4), docs (Task 6). All mapped.
- **No backend changes:** confirmed — `createAccount` signature, services, repos, and Rust seed are untouched; the mock only gains the providers it was missing.
- **Single-subtype types** (`receivable`/`payable`): handled by the existing `subtypesForType` + the "keep subtype valid" effect, which auto-selects the lone chip.
- **Type consistency:** `ProviderLogo` props (`templateKey`, `name`, `size`, `radius`, `seed`), `logoFor`, `PROVIDER_GROUPS`/`PROVIDER_KEYS` used identically across tasks.
