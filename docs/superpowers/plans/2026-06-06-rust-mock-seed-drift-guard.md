# Rust↔mock Seed Drift Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the mock's seed data from the Rust source into a committed `src/generated/seed-catalog.json`, have the mock consume it, and fail CI when it goes stale — so the mock can no longer silently drift from the backend.

**Architecture:** A `#[cfg(test)]` Rust generator opens a migrated+seeded in-memory SQLite DB, dumps `account_subtypes` / `account_templates` / `categories` to a deterministic JSON string, and a freshness test asserts the committed file matches it (or rewrites it when `UPDATE_SEED_CATALOG=1`). The browser mock (`src/client/mock.ts`) and the mock-only provider catalog (`src/lib/providers.ts`) import that JSON instead of hand-maintaining arrays.

**Tech Stack:** Rust (rusqlite, serde, serde_json — all already direct deps), TypeScript/React 19, Vite (`resolveJsonModule` already on), Vitest, GitHub Actions (existing `cargo test --lib --locked` + `npm test` / `npm run build` jobs).

**Spec:** `docs/superpowers/specs/2026-06-06-rust-mock-seed-drift-guard-design.md`

**Working branch:** `drift-guard-seed-catalog` (already created; the spec commit lives here).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/lib.rs` | Modify (add a `#[cfg(test)]` module near existing `mod tests`) | Generator helper + freshness test + non-empty sanity test |
| `src/generated/seed-catalog.json` | Create (generated, committed) | The single shared seed artifact |
| `src/client/mock.ts` | Modify | Build `SUBTYPES`, `templates`, and seeded `categories` from the JSON; delete `SUBTYPE_ROWS` / `CAT_SEED` / `SUB_SEED` |
| `src/lib/providers.ts` | Modify | Derive `PROVIDER_GROUPS` / `PROVIDER_KEYS` from the JSON `templates` |
| `package.json` | Modify | Add `gen:seed-catalog` script |
| `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md` | Modify | Document the single-source flow |

**Determinism note (read before Task 1):** the generator builds `#[derive(Serialize)]` structs (not `serde_json::Value` maps) so field order is the Rust declaration order regardless of whether `serde_json`'s `preserve_order` feature is unified on. Rows are ordered by SQL `ORDER BY`. The output ends with a trailing `\n`. These three things together make regeneration byte-stable.

---

### Task 1: Rust generator + freshness test + the committed JSON

**Files:**
- Modify: `src-tauri/src/lib.rs` (add a new `#[cfg(test)] mod seed_catalog` — place it right after the existing `#[cfg(test)] mod tests { … }` block)
- Create: `src/generated/seed-catalog.json` (generated in Step 4)

- [ ] **Step 1: Write the generator + tests**

Add this module to `src-tauri/src/lib.rs` immediately after the closing brace of the existing `mod tests` block:

```rust
#[cfg(test)]
mod seed_catalog {
    //! Generates src/generated/seed-catalog.json from a freshly migrated+seeded
    //! in-memory DB and fails CI if the committed file is stale. The browser mock
    //! consumes that JSON, so this is the single source of truth for mock seed data.
    use crate::db::open_in_memory;
    use rusqlite::Connection;
    use serde::Serialize;
    use std::path::PathBuf;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SubtypeRow {
        key: String,
        label: String,
        #[serde(rename = "type")]
        ty: String,
        group: String,
        sort_order: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TemplateRow {
        key: String,
        name: String,
        group_name: String,
        default_subtype: String,
        sort_order: i64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CategoryRow {
        name: String,
        kind: String,
        emoji: String,
        color: Option<String>,
        parent_name: Option<String>,
        is_system: bool,
        sort_order: i64,
    }

    #[derive(Serialize)]
    struct SeedCatalog {
        subtypes: Vec<SubtypeRow>,
        templates: Vec<TemplateRow>,
        categories: Vec<CategoryRow>,
    }

    fn catalog_path() -> PathBuf {
        PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/generated/seed-catalog.json"
        ))
    }

    fn build(conn: &Connection) -> SeedCatalog {
        let subtypes = conn
            .prepare(
                "SELECT key, label, type, account_group, sort_order
                 FROM account_subtypes ORDER BY sort_order, key",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(SubtypeRow {
                    key: r.get(0)?,
                    label: r.get(1)?,
                    ty: r.get(2)?,
                    group: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let templates = conn
            .prepare(
                "SELECT key, name, group_name, default_subtype, sort_order
                 FROM account_templates ORDER BY sort_order, key",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(TemplateRow {
                    key: r.get(0)?,
                    name: r.get(1)?,
                    group_name: r.get(2)?,
                    default_subtype: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        // Top-level rows (parent_id IS NULL) sort first so the mock can resolve a
        // child's parent by (parentName, kind) in a second pass.
        let categories = conn
            .prepare(
                "SELECT c.name, c.kind, c.emoji, c.color, p.name AS parent_name,
                        c.is_system, c.sort_order
                 FROM categories c
                 LEFT JOIN categories p ON c.parent_id = p.id
                 ORDER BY (c.parent_id IS NOT NULL), c.kind, c.sort_order, c.name",
            )
            .unwrap()
            .query_map([], |r| {
                Ok(CategoryRow {
                    name: r.get(0)?,
                    kind: r.get(1)?,
                    emoji: r.get(2)?,
                    color: r.get(3)?,
                    parent_name: r.get(4)?,
                    is_system: r.get::<_, i64>(5)? != 0,
                    sort_order: r.get(6)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        SeedCatalog {
            subtypes,
            templates,
            categories,
        }
    }

    fn generate(conn: &Connection) -> String {
        let mut s = serde_json::to_string_pretty(&build(conn)).unwrap();
        s.push('\n');
        s
    }

    #[test]
    fn seed_catalog_is_non_empty() {
        let conn = open_in_memory().unwrap();
        let catalog = build(&conn);
        assert_eq!(catalog.subtypes.len(), 16, "expected 16 account subtypes");
        assert!(
            catalog.templates.len() > 40,
            "expected the full provider template catalog"
        );
        assert!(
            catalog.categories.len() > 100,
            "expected the full category + subcategory tree"
        );
        // The two protected Adjustment system categories must be present.
        assert_eq!(
            catalog.categories.iter().filter(|c| c.is_system).count(),
            2,
            "expected exactly two system (Adjustment) categories"
        );
    }

    #[test]
    fn seed_catalog_json_is_fresh() {
        let conn = open_in_memory().unwrap();
        let generated = generate(&conn);
        let path = catalog_path();
        if std::env::var("UPDATE_SEED_CATALOG").is_ok() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &generated).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            committed, generated,
            "seed catalog is stale — run `npm run gen:seed-catalog` and commit src/generated/seed-catalog.json"
        );
    }
}
```

- [ ] **Step 2: Run the freshness test to verify it fails (file does not exist yet)**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib seed_catalog_json_is_fresh`
Expected: FAIL — assertion mismatch (committed is empty, generated is the full JSON). The non-empty test (`seed_catalog_is_non_empty`) should PASS.

- [ ] **Step 3: Run the non-empty sanity test on its own to confirm the generator works**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib seed_catalog_is_non_empty`
Expected: PASS (16 subtypes, >40 templates, >100 categories, 2 system rows).

- [ ] **Step 4: Generate the committed JSON**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && UPDATE_SEED_CATALOG=1 cargo test --lib seed_catalog_json_is_fresh`
Expected: PASS (the test writes `src/generated/seed-catalog.json` and returns early).

Then confirm the file exists and is well-formed:

Run: `cd /Users/jimmyhew/Documents/Sens && head -c 200 src/generated/seed-catalog.json && echo && node -e "const c=require('./src/generated/seed-catalog.json'); console.log(c.subtypes.length, c.templates.length, c.categories.length)"`
Expected: prints the opening of the JSON, then `16 <NN> <NNN>` (templates > 40, categories > 100).

- [ ] **Step 5: Run the freshness test again to verify it now passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib seed_catalog`
Expected: PASS for both `seed_catalog_is_non_empty` and `seed_catalog_json_is_fresh`.

- [ ] **Step 6: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src-tauri/src/lib.rs src/generated/seed-catalog.json
git commit -m "feat: generate seed-catalog.json from Rust with a freshness guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mock consumes the JSON for subtypes + templates

**Files:**
- Modify: `src/client/mock.ts:18` (remove the `PROVIDER_GROUPS` import), `src/client/mock.ts:28-53` (replace `SUBTYPE_ROWS` / `SUBTYPES` and the template build)

- [ ] **Step 1: Add the JSON import**

In `src/client/mock.ts`, replace the line:

```ts
import { PROVIDER_GROUPS } from "../lib/providers";
```

with:

```ts
import catalog from "../generated/seed-catalog.json";
```

- [ ] **Step 2: Replace the subtype rows with a JSON-driven build**

Replace this block (currently `src/client/mock.ts:29-42`):

```ts
const SUBTYPE_ROWS: [string, string, AccountTypeName, AccountGroup][] = [
  ["cash","Cash","fund","own"],["ewallet","E-wallet","fund","own"],
  ["savings","Savings account","fund","own"],["current","Current / Checking","fund","own"],
  ["fixed-deposit","Fixed deposit","financial","own"],["investment","Investment / Brokerage","financial","own"],
  ["unit-trust","Unit trust / ASNB","financial","own"],["crypto","Crypto","financial","own"],
  ["lent","Lent to someone (IOU)","receivable","own"],["borrowed","Borrowed from someone","payable","owe"],
  ["credit-card","Credit card","credit","owe"],["bnpl","BNPL","credit","owe"],
  ["personal-loan","Personal loan","credit","owe"],["mortgage","Mortgage","credit","owe"],
  ["car-loan","Car / Hire-purchase loan","credit","owe"],["other-debt","Other debt","credit","owe"],
];
const SUBTYPES: AccountSubtype[] = SUBTYPE_ROWS.map(([key, label, type, group], i) => ({
  key, label, type, group, sortOrder: i, isActive: true,
}));
const subtypeOf = (key: string) => SUBTYPES.find((s) => s.key === key);
```

with:

```ts
const SUBTYPES: AccountSubtype[] = catalog.subtypes.map((s) => ({
  key: s.key,
  label: s.label,
  type: s.type as AccountTypeName,
  group: s.group as AccountGroup,
  sortOrder: s.sortOrder,
  isActive: true,
}));
const subtypeOf = (key: string) => SUBTYPES.find((s) => s.key === key);
```

- [ ] **Step 3: Replace the template build**

Replace this block (currently `src/client/mock.ts:44-53`):

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

with:

```ts
// ── seed templates (from src/generated/seed-catalog.json → Rust seed) ──
const templates: AccountTemplate[] = catalog.templates.map((t) => ({
  key: t.key,
  name: t.name,
  groupName: t.groupName,
  defaultSubtype: t.defaultSubtype,
  iconAsset: t.key,
  brandColor: null,
  sortOrder: t.sortOrder,
  isActive: true,
}));
```

- [ ] **Step 4: Typecheck + run the suite**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build && npm test`
Expected: PASS. `tsc` is clean (no unused `PROVIDER_GROUPS` import, no unused `AccountSubtype`/`AccountTemplate` — still referenced). Vitest green.

- [ ] **Step 5: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/client/mock.ts
git commit -m "refactor: mock builds subtypes + templates from seed-catalog.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mock consumes the JSON for categories

**Files:**
- Modify: `src/client/mock.ts:55-113` (replace `CAT_SEED`, `SUB_SEED`, and the body of `seedCategories`)

- [ ] **Step 1: Delete the hand-maintained category arrays and rewrite `seedCategories`**

Replace the entire block from the `// Mirrors src-tauri/src/db/seed.rs CATEGORIES …` comment (currently `src/client/mock.ts:55`) through the `seedCategories();` call (currently `src/client/mock.ts:113`) — i.e. `CAT_SEED`, `SUB_SEED`, the `const categories: Category[] = [];` line, the `seedCategories` function, and the immediate `seedCategories();` invocation — with:

```ts
const categories: Category[] = [];

// Built from src/generated/seed-catalog.json (generated from the Rust seed).
// Top-level rows are created first so each child resolves its parent by
// (parentName, kind); sort orders come straight from the catalog.
function seedCategories() {
  categories.length = 0;
  const topLevelId = new Map<string, string>(); // `${kind}\x00${name}` -> id
  for (const c of catalog.categories) {
    if (c.parentName != null) continue;
    const id = uid();
    categories.push({
      id,
      name: c.name,
      kind: c.kind as Category["kind"],
      emoji: c.emoji,
      color: c.color,
      parentId: null,
      sortOrder: c.sortOrder,
      isArchived: false,
      isSystem: c.isSystem,
      createdAt: now(),
      updatedAt: now(),
    });
    topLevelId.set(`${c.kind}\x00${c.name}`, id);
  }
  for (const c of catalog.categories) {
    if (c.parentName == null) continue;
    const parentId = topLevelId.get(`${c.kind}\x00${c.parentName}`);
    if (!parentId) continue;
    categories.push({
      id: uid(),
      name: c.name,
      kind: c.kind as Category["kind"],
      emoji: c.emoji,
      color: c.color,
      parentId,
      sortOrder: c.sortOrder,
      isArchived: false,
      isSystem: c.isSystem,
      createdAt: now(),
      updatedAt: now(),
    });
  }
}
seedCategories();
```

- [ ] **Step 2: Typecheck + run the suite**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build && npm test`
Expected: PASS. The mock now seeds the identical category tree (including both `Adjustment` system rows, which arrive from the catalog with `isSystem: true`).

- [ ] **Step 3: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/client/mock.ts
git commit -m "refactor: mock seeds categories from seed-catalog.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Derive `providers.ts` from the JSON

**Files:**
- Modify: `src/lib/providers.ts` (replace the hand-maintained `PROVIDER_GROUPS` literal with a derivation; keep the exported names + `ProviderGroup` type)

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `src/lib/providers.ts` with:

```ts
// Mock-only provider catalog, DERIVED from src/generated/seed-catalog.json
// (which is generated from the Rust seed in src-tauri/src/db/seed.rs and is the
// single source of truth). The packaged app gets providers from the
// `list_templates` Rust command, not from this file. Do not hand-edit the
// provider list here — edit the Rust seed and run `npm run gen:seed-catalog`.
import catalog from "../generated/seed-catalog.json";

export type ProviderGroup = {
  group: string;
  defaultSubtype: string;
  providers: [key: string, name: string][];
};

// Group the catalog templates by groupName, preserving catalog order (sort_order).
export const PROVIDER_GROUPS: ProviderGroup[] = (() => {
  const groups: ProviderGroup[] = [];
  const byName = new Map<string, ProviderGroup>();
  for (const t of catalog.templates) {
    let g = byName.get(t.groupName);
    if (!g) {
      g = { group: t.groupName, defaultSubtype: t.defaultSubtype, providers: [] };
      byName.set(t.groupName, g);
      groups.push(g);
    }
    g.providers.push([t.key, t.name]);
  }
  return groups;
})();

export const PROVIDER_KEYS: string[] = catalog.templates.map((t) => t.key);
```

- [ ] **Step 2: Run the provider + logo tests specifically**

Run: `cd /Users/jimmyhew/Documents/Sens && npx vitest run src/__tests__/providers.test.ts src/__tests__/logos.test.ts`
Expected: PASS. `PROVIDER_GROUPS` / `PROVIDER_KEYS` carry the identical data (same keys, names, groups, defaultSubtype, order), so both tests stay green.

- [ ] **Step 3: Full typecheck + suite**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add src/lib/providers.ts
git commit -m "refactor: derive providers.ts from seed-catalog.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ergonomics script + documentation

**Files:**
- Modify: `package.json` (add `gen:seed-catalog` to `scripts`)
- Modify: `CLAUDE.md` (update the seed-data drift warning)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `ROADMAP.md` (fix the stale "Last shipped" header line)

- [ ] **Step 1: Add the npm script**

In `package.json`, inside the `"scripts"` object, add this entry (keep existing scripts; mind the trailing comma on the line above):

```json
    "gen:seed-catalog": "export PATH=\"$HOME/.cargo/bin:$PATH\" && cd src-tauri && UPDATE_SEED_CATALOG=1 cargo test --lib seed_catalog_json_is_fresh"
```

- [ ] **Step 2: Verify the script regenerates and the file is unchanged (already fresh)**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run gen:seed-catalog && git status --porcelain src/generated/seed-catalog.json`
Expected: the test passes and `git status` prints **nothing** for the JSON (it's already up to date — the script is idempotent).

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, find the sentence in the "The Tauri/mock seam" section that reads:

```
**Any change to a command's behavior, signature, or args must be made in BOTH the Rust chain and the mock**, or browser-dev and the packaged app diverge.
```

Immediately after it, add:

```
**Seed data is the exception — it is no longer hand-mirrored.** The mock's account
subtypes, provider templates, and category tree are generated from the Rust source
into `src/generated/seed-catalog.json` (a `#[cfg(test)]` generator in
`src-tauri/src/lib.rs` dumps a migrated+seeded in-memory DB) and consumed by
`src/client/mock.ts` and `src/lib/providers.ts`. After editing the Rust seed
(`db/seed.rs`, or a migration that changes subtypes), run `npm run gen:seed-catalog`
and commit the regenerated JSON. The `seed_catalog_json_is_fresh` test fails CI
(via `cargo test --lib`) if the artifact is stale, so the two can't silently diverge.
```

- [ ] **Step 4: Update CHANGELOG.md**

In `CHANGELOG.md`, under the `## [Unreleased]` heading, add:

```markdown
### Changed
- Internal: the browser mock's seed data (account subtypes, provider templates,
  and the category tree) is now generated from the Rust source into
  `src/generated/seed-catalog.json` and consumed by the mock, so it can no longer
  silently drift from the packaged app. A `cargo test` (`seed_catalog_json_is_fresh`)
  fails CI if the artifact is stale; regenerate with `npm run gen:seed-catalog`
  after editing the Rust seed.
```

- [ ] **Step 5: Fix the stale ROADMAP header line**

In `ROADMAP.md`, replace the line:

```
**Last shipped:** `v0.6.0` — Transactions screen redesign ("Evolved List") ·
```

with:

```
**Last shipped:** `v0.9.0` — Category splits ·
```

- [ ] **Step 6: Verify everything is still green**

Run: `cd /Users/jimmyhew/Documents/Sens && npm run build && npm test`
Expected: PASS.

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib --locked`
Expected: PASS (all existing tests plus `seed_catalog_is_non_empty` and `seed_catalog_json_is_fresh`).

- [ ] **Step 7: Commit**

```bash
cd /Users/jimmyhew/Documents/Sens
git add package.json CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs: document the seed-catalog single-source flow + add gen script

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `src/generated/seed-catalog.json` is committed and `npm run gen:seed-catalog` regenerates it idempotently.
- `cargo test --lib` includes `seed_catalog_json_is_fresh` (gates CI) and `seed_catalog_is_non_empty`.
- `mock.ts` has no `SUBTYPE_ROWS` / `CAT_SEED` / `SUB_SEED`; all three come from the JSON.
- `providers.ts` derives its exports from the JSON; `providers.test.ts` + `logos.test.ts` pass.
- `npm run build` and `npm test` are green; CLAUDE.md / CHANGELOG / ROADMAP updated.
- Manual drift check (optional sanity): edit a category name in `src-tauri/src/db/seed.rs`, run `cargo test --lib seed_catalog_json_is_fresh` → it FAILS with the regenerate message; `npm run gen:seed-catalog` makes it pass and the mock reflects the change. Revert the edit.
```
