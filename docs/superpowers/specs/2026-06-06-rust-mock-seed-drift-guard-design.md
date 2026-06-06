# Rust↔mock seed drift guard — design

**Date:** 2026-06-06
**Status:** Approved (brainstorming) — pending implementation plan
**Roadmap item:** Technical health & hardening → *Rust↔mock drift guard*

## Problem

Sens ships a real Rust+SQLite backend and a dev-only in-memory mock
(`src/client/mock.ts`) behind the `invoke.ts` dispatch seam. Three blocks of
**seed data** are hand-maintained in **both** places and must stay byte-identical
or browser-dev and the packaged app diverge:

| Data | Rust (authoritative) | Mock mirror |
|---|---|---|
| Account subtypes (16 → type/group) | migration 002 `account_subtypes` INSERTs (`db/migrations.rs`) | `SUBTYPE_ROWS` (`mock.ts`) |
| Categories + subcategories (~125 rows) | `CATEGORIES` / `SUBCATEGORIES` (`db/seed.rs`) | `CAT_SEED` / `SUB_SEED` (`mock.ts`) |
| Provider templates | `templates()` (`db/seed.rs`) | `PROVIDER_GROUPS` (`src/lib/providers.ts`, consumed by `mock.ts`) |

Today these are kept in sync by convention and a CLAUDE.md warning only. A silent
divergence (a default category added on one side, a renamed subtype) is invisible
until someone notices the mock behaving differently from the app — a standing
drift hazard.

`src/lib/providers.ts` is **mock-only**: the packaged UI gets its provider grid
from the `list_templates` Rust command, not from this file. `PROVIDER_GROUPS` is
imported only by `mock.ts` and two unit tests. So all three blocks are effectively
mock-side mirrors of Rust-side truth.

**Scope (decided):** *data only*. Validation-logic parity
(`validateSplits` / `isHHMM` / category-kind rules re-implemented in the mock vs.
`validate_splits` / `validate_hhmm` / `validate_category_for` in `service.rs`) is
**out of scope** here — it is behavioral, not structural, and changes rarely. It
can become a later "golden test vectors" phase.

## Goal

Make the mock's seed data **physically incapable** of drifting from the Rust
source, and **fail CI** if the shared artifact goes stale.

## Approach (decided)

**Generate a JSON artifact from Rust; the mock consumes it.** Rust stays the
authoring home. A committed, generated JSON file is the single shared
representation. The mock imports it instead of hand-maintaining arrays — so the
mock side can no longer drift at all. A Rust test fails CI when the committed JSON
no longer matches the Rust source.

Alternatives considered and rejected:

- **Equality test, both hand-maintained.** Keeps the double-authoring problem
  (you still edit twice; the test only yells when you forget) and needs awkward
  cross-language extraction. Rejected — doesn't eliminate the bug class.
- **JSON is the single source both read.** Purest end-state (Rust reads JSON via
  `serde` at seed time), but requires rewriting `seed.rs` to parse JSON and
  carefully handling the *frozen* migration-002 subtypes. Heavy for little gain
  over the chosen approach. Rejected.

## The shared artifact

A committed, generated file: **`src/generated/seed-catalog.json`**.

It holds three arrays of **stable fields only** — no UUIDs, no timestamps, so the
output is deterministic:

```jsonc
{
  "subtypes":   [{ "key", "label", "type", "group", "sortOrder" }],
  "templates":  [{ "key", "name", "groupName", "defaultSubtype", "sortOrder" }],
  "categories": [{ "name", "kind", "emoji", "color", "parentName", "isSystem", "sortOrder" }]
}
```

- `categories` is **flat**; a subcategory references its parent by
  `parentName` (top-level rows have `parentName: null`). Parent identity is
  `(parentName, kind)`, matching how the mock already resolves parents. This maps
  directly onto the mock's existing flat `CAT_SEED` + `SUB_SEED` builder.
- The two protected `Adjustment` system categories appear here with
  `isSystem: true`.
- JSON is pretty-printed with **sorted object keys**; arrays are emitted in a
  deterministic SQL `ORDER BY` (by `sort_order`, then a tiebreak) so regeneration
  is byte-stable.

## Generation — from the real seeded DB

The canonical JSON is generated from the **actual migrated + seeded database**,
not from the Rust source arrays. A Rust helper:

1. opens an in-memory DB (`db::open_in_memory`, already used by the lib tests),
2. runs migrations + seed (the same path a fresh install takes),
3. `SELECT`s `account_subtypes`, `account_templates`, and `categories` with
   deterministic ordering (categories `LEFT JOIN` themselves to resolve
   `parentName`),
4. serializes the three arrays to the pretty, key-sorted JSON string.

This is the truest source of truth: it captures the **frozen migration-002
subtypes**, the seeded **templates**, and the **`Adjustment` system categories**
uniformly — with no new Rust constant to keep in sync, and reflecting exactly
what a fresh install produces.

## Freshness guard — one Rust test, compare-or-write

A `#[cfg(test)]` test in `src-tauri/src/lib.rs`, e.g.
`seed_catalog_json_is_fresh`:

- builds the canonical JSON string in-memory (the generator above),
- resolves the committed file via
  `concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated/seed-catalog.json")`,
- **default:** asserts the file equals the freshly generated string; on mismatch
  it panics with an actionable message:
  *"seed catalog is stale — run `npm run gen:seed-catalog` and commit the result."*
- **when env `UPDATE_SEED_CATALOG=1` is set:** it **writes** the file instead of
  asserting (the regenerate path).

Because CI already runs `cargo test --lib --locked` (`.github/workflows/ci.yml`),
this gates every PR **with no workflow change**:

- Edit `seed.rs` (or a future migration changing the catalog) without
  regenerating → CI fails with the actionable message.
- Hand-edit the JSON → also caught (it won't match the DB dump).

## Mock consumes the JSON (drift becomes impossible)

- `src/client/mock.ts` imports `seed-catalog.json` and builds its `SUBTYPES`,
  seeded `categories`, and `templates` from it. The hand-maintained
  `SUBTYPE_ROWS`, `CAT_SEED`, and `SUB_SEED` arrays are **deleted**. The existing
  `seedCategories()` builder is repointed at the JSON `categories` array
  (top-level rows first, then children resolved by `(parentName, kind)`),
  preserving the current per-parent `sortOrder` behavior. System `Adjustment`
  rows come straight from the JSON (`isSystem: true`) rather than being appended
  in code.
- `src/lib/providers.ts` is **kept but derived**: `PROVIDER_GROUPS` and
  `PROVIDER_KEYS` become a thin computed view over the JSON `templates` array
  (grouped by `groupName`, preserving order, carrying `defaultSubtype`). Existing
  importers (`mock.ts`, `logos.test.ts`, `providers.test.ts`) keep working with
  **zero hand-maintained provider data**.
- Mock **validation logic** is untouched (out of scope).

JSON import is already supported in the project (`resolveJsonModule: true`;
`emoji-data.json` is imported today), so no tsconfig/Vite change is needed.

## Ergonomics

- `package.json` script:
  `"gen:seed-catalog": "export PATH=\"$HOME/.cargo/bin:$PATH\" && cd src-tauri && UPDATE_SEED_CATALOG=1 cargo test --lib seed_catalog_json_is_fresh"`
- New-data workflow becomes: **edit Rust seed → `npm run gen:seed-catalog` →
  commit.** The mock auto-follows; no second hand-edit.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `canonical_seed_catalog()` (Rust helper) | Migrate+seed an in-memory DB, dump the 3 tables to a deterministic JSON string | `db::open_in_memory`, migrations, seed, `serde_json` |
| `seed_catalog_json_is_fresh` (Rust test) | Compare committed JSON to the generated string; write when `UPDATE_SEED_CATALOG=1` | the helper, the committed file |
| `src/generated/seed-catalog.json` | The shared, generated artifact (committed) | — |
| `mock.ts` seed builders | Build `SUBTYPES` / `categories` / `templates` from the JSON | the JSON |
| `providers.ts` | Derive `PROVIDER_GROUPS` / `PROVIDER_KEYS` from the JSON | the JSON |

## Error handling

- The freshness test's failure message names the exact remediation command, so a
  contributor who forgets to regenerate gets a one-line fix, not a diff hunt.
- `serde_json` is already a transitive dependency via Tauri; if it isn't a direct
  dependency of the crate it is added to `Cargo.toml` (dev-dependency is
  sufficient since the generator runs only under `#[cfg(test)]`).

## Testing

- The freshness test **is** the guard; it runs in the existing `cargo test --lib`
  CI step.
- Existing `providers.test.ts` / `logos.test.ts` continue to pass against the
  JSON-derived `providers.ts`, confirming the TS side reads the artifact correctly.
- A sanity assertion in the generator (or an accompanying test) confirms the JSON
  is non-empty and the three arrays have the expected cardinalities, so an
  accidentally-empty dump can't pass silently.

## Out of scope / non-goals

- Validation-logic parity (mock vs. service) — deliberately deferred.
- Other seams (AppError shapes, command signatures) — not part of this phase.
- No change to runtime behavior of the packaged app: the JSON is a build/test-time
  artifact and a mock dependency only; Rust seeding is unchanged.

## Docs to update on implementation

- CLAUDE.md: replace the "must change in both places" warning for *seed data* with
  the new single-source flow (Rust authors; `npm run gen:seed-catalog`; mock
  follows). Keep the broader command-behavior warning intact.
- `src/lib/providers.ts` header comment: note it is now derived from the generated
  catalog, not hand-maintained.
- ROADMAP.md: move the *Rust↔mock drift guard* item to Shipped on release (and fix
  the stale "Last shipped: v0.6.0 / Next up" header line while there).
- CHANGELOG `[Unreleased]`.
