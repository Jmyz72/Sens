# AI provider list with fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single AI endpoint in Settings with an ordered, user-reorderable list of providers that Drafts tries in turn, falling back on any failure.

**Architecture:** A new `ai_providers` table (migration 017) with SQL in `repo.rs` and rules in `drafts.rs`. A pure async `ai::extract_with_fallback` walks the enabled providers without holding the DB lock. Seven new Tauri commands replace `get_ai_settings` / `set_ai_settings` / `test_ai_connection`, mirrored in `mock.ts`. Settings gets a list card, and Drafts reads the new `ExtractResult`.

**Tech Stack:** Rust (rusqlite, reqwest, serde, Tauri v2), React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-ai-provider-fallback-design.md`

## Global Constraints

- Migrations are append-only. The new migration is `(17, MIGRATION_017)`. No data is copied from the old settings (no existing users).
- SQL only in `repo.rs`; rules only in `drafts.rs` (the AI service module); every command mirrored in `src/client/mock.ts` with the same `{code, message}` errors.
- The backend generates UUIDs and timestamps (`uuid::Uuid::new_v4()`, `crate::now()`).
- The API key never appears in a returned struct, an error message, a log or the mock's output. Structs returned to the frontend carry `hasKey` only.
- Never hardcode colors; use `useTheme()` tokens. A disabled provider shows the text "Off", not only dimming.
- Keep `dragDropEnabled: false`. Reorder uses native HTML5 drag like `src/screens/Categories.tsx:385`.
- Exact copy:
  - `ai_not_configured`: `Add an AI provider in Settings first.`
  - `ai_all_failed`: `All AI providers failed. <name>: <reason>. <name>: <reason>.` — each reason with its trailing `.` trimmed, parts joined with `". "`, ending with `.`
  - Validation: `Name cannot be empty`, `Model cannot be empty`, `An AI provider with that name already exists.`, `The base URL must start with http:// or https://`, `The order must list every AI provider exactly once.`
  - NotFound: `AI provider not found`
  - UI: `Drafts tries these in order and falls back to the next one if a call fails.` · `No AI providers yet. Add one to use photo import.` · `Delete <name>? Its key is removed too.` · `<name> answered.` · `Read by <provider>.` · `<name> failed: <reason>.`
- CI gate before finishing: `npm run build`, `npm test`, `cd src-tauri && cargo test --lib` (with `export PATH="$HOME/.cargo/bin:$PATH"`).

## Review Focus

1. **Whitespace or a different case in a name** (`" gemini "` vs `"Gemini"`) — must count as a duplicate on create and on update (excluding the row itself). Test in Task 2.
2. **Deleting the middle provider, then reordering** — positions must stay dense `0..n-1`, so a later reorder and the `↑/↓` buttons work. Test in Task 2.
3. **Editing a provider without touching the key** — a blank key field must keep the saved key, not clear it (`apiKey: null`). Test in Tasks 2 and 4.
4. **Every provider disabled** — extract must fail with `ai_not_configured`, not attempt a call, and the Drafts screen must show the "add a provider" hint rather than enabling *Choose photo*. Tests in Tasks 3 and 4.
5. **The key leaking through `ai_all_failed`** — the joined message must not contain any provider's key. Test in Task 1.

---

## File Structure

| File | Change |
|---|---|
| `src-tauri/src/ai.rs` | Add `NamedConfig`, `FallbackOutcome`, `extract_with_fallback`. |
| `src-tauri/src/models.rs` | Add `AiProvider`, `AiProviderInput`, `SkippedProvider`, `ExtractResult`. Remove `AiSettings`, `AiSettingsInput`. |
| `src-tauri/src/db/migrations.rs` | Add `MIGRATION_017`. |
| `src-tauri/src/db/mod.rs` | `reset_to_defaults` deletes `ai_providers`; migration test. |
| `src-tauri/src/repo.rs` | `AiProviderRow` + provider SQL. |
| `src-tauri/src/drafts.rs` | Provider service; new `prepare`; remove old settings functions and `KEY_*` constants. |
| `src-tauri/src/service.rs` | Remove the `KEY_API_KEY` guard in `get_setting`. |
| `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` | Swap commands; `extract_drafts` returns `ExtractResult`. |
| `src/types.ts`, `src/client/index.ts`, `src/client/mock.ts` | Mirror types, wrappers and mock. |
| `src/__tests__/mock-ai-providers.test.ts` (new), `src/__tests__/mock-drafts.test.ts` | Mock tests. |
| `src/screens/Drafts.tsx` | Use the provider list and `ExtractResult`. |
| `src/screens/Settings.tsx` | Replace `AiImportCard` with the provider list card. |
| Docs | `CHANGELOG.md`, `ROADMAP.md`, `docs/architecture/backend.md`, the 2026-10-17 photo-import spec. |

---

### Task 1: Fallback loop in `ai.rs`

**Files:**
- Modify: `src-tauri/src/ai.rs` (after `extract`, ~line 219; tests in the existing `mod tests`)
- Modify: `src-tauri/src/models.rs` (add `SkippedProvider` near `AiSettings`, ~line 413)
- Modify: `src-tauri/src/error.rs:24-27` (doc comment: add `ai_all_failed` to the code list)

**Interfaces:**
- Produces:
  - `models::SkippedProvider { pub name: String, pub message: String }` — `Serialize`, `#[serde(rename_all = "camelCase")]`, `Debug, Clone`.
  - `ai::NamedConfig { pub name: String, pub cfg: AiConfig }` — `Debug, Clone`.
  - `ai::FallbackOutcome { pub rows: Vec<RawDraft>, pub provider: String, pub skipped: Vec<SkippedProvider> }`.
  - `pub async fn extract_with_fallback(providers: &[NamedConfig], messages: Vec<Value>) -> AppResult<FallbackOutcome>`

- [ ] **Step 1: Write the failing tests** in `ai.rs` `mod tests`, using the existing `serve`, `chat_ok`, `cfg`, `code_of`, `msgs` helpers. Add a helper `fn named(name: &str, url: &str) -> NamedConfig { NamedConfig { name: name.into(), cfg: cfg(url) } }` (the key is `"secret"`).

```rust
const GOOD: &str = "{\"transactions\":[{\"amount\":\"5\",\"kind\":\"expense\"}]}";

#[test]
fn fallback_uses_the_first_provider_that_answers() {
    let (a, _sa) = serve(vec![(401, "{}".into())]);
    let (b, _sb) = serve(vec![chat_ok(GOOD)]);
    let out = tauri::async_runtime::block_on(extract_with_fallback(&[named("A", &a), named("B", &b)], msgs())).unwrap();
    assert_eq!(out.provider, "B");
    assert_eq!(out.rows.len(), 1);
    assert_eq!(out.skipped.len(), 1);
    assert_eq!(out.skipped[0].name, "A");
    assert_eq!(out.skipped[0].message, "The AI provider rejected the API key.");
}

#[test]
fn fallback_moves_on_after_429_500_unreachable_and_a_reply_invalid_twice() {
    let (r429, _1) = serve(vec![(429, "{}".into())]);
    let (r500, _2) = serve(vec![(500, "{}".into())]);
    let (bad, _3) = serve(vec![chat_ok("nope"), chat_ok("still nope")]);
    let (ok, _4) = serve(vec![chat_ok(GOOD)]);
    let list = [named("429", &r429), named("500", &r500), named("down", "http://127.0.0.1:9"), named("bad", &bad), named("ok", &ok)];
    let out = tauri::async_runtime::block_on(extract_with_fallback(&list, msgs())).unwrap();
    assert_eq!(out.provider, "ok");
    assert_eq!(out.skipped.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["429", "500", "down", "bad"]);
}

#[test]
fn fallback_reports_every_reason_in_order_when_all_fail_without_the_key() {
    let (a, _sa) = serve(vec![(401, "{}".into())]);
    let list = [named("A", &a), named("B", "http://127.0.0.1:9")];
    let err = tauri::async_runtime::block_on(extract_with_fallback(&list, msgs())).unwrap_err();
    assert_eq!(code_of(&err), "ai_all_failed");
    let m = err.to_string();
    assert!(m.starts_with("All AI providers failed. A: The AI provider rejected the API key. B: Could not reach the AI provider"));
    assert!(m.ends_with('.') && !m.ends_with(".."));
    assert!(!m.contains("secret"));
}

#[test]
fn fallback_with_no_providers_is_not_configured() {
    let err = tauri::async_runtime::block_on(extract_with_fallback(&[], msgs())).unwrap_err();
    assert_eq!(code_of(&err), "ai_not_configured");
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd src-tauri && cargo test --lib fallback_`
Expected: compile error, `extract_with_fallback` not found.

- [ ] **Step 3: Implement** `NamedConfig`, `FallbackOutcome`, `SkippedProvider` and `extract_with_fallback` as in Interfaces. For each provider in order, call `extract(&p.cfg, messages.clone())`. On `Ok`, return; on `Err(e)`, push `SkippedProvider { name, message: e.to_string() }`. With an empty slice, return `AppError::Ai("ai_not_configured", "Add an AI provider in Settings first.".into())`. When all fail, build the `ai_all_failed` message per Global Constraints. Update the doc comment on `AppError::Ai` to list `ai_all_failed`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd src-tauri && cargo test --lib ai::`
Expected: all `ai::tests` pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai.rs src-tauri/src/models.rs src-tauri/src/error.rs
git commit -m "feat(ai): fall back through an ordered provider list"
```

---

### Task 2: `ai_providers` table, repo and service

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append `MIGRATION_017`, add `(17, MIGRATION_017)` to `MIGRATIONS`)
- Modify: `src-tauri/src/db/mod.rs` (`reset_to_defaults`: `DELETE FROM ai_providers` next to `import_drafts`, ~line 189; add a migration test)
- Modify: `src-tauri/src/models.rs` (add `AiProvider`, `AiProviderInput`)
- Modify: `src-tauri/src/repo.rs` (new section after `// ── Import drafts`)
- Modify: `src-tauri/src/drafts.rs` (new `// ── AI providers` section replacing `// ── AI settings`; keep the old functions until Task 3)

**Interfaces:**
- Consumes: `ai::NamedConfig`, `ai::AiConfig` (Task 1).
- Produces:
  - `models::AiProvider { id: String, name: String, base_url: String, model: String, has_key: bool, enabled: bool, position: i64 }` — `Serialize`, camelCase.
  - `models::AiProviderInput { name: String, base_url: String, model: String, api_key: Option<String> }` — `Deserialize`, camelCase.
  - `repo::AiProviderRow { id, name, base_url, model, api_key: Option<String>, enabled: bool, position: i64 }` (not serializable).
  - `repo::list_ai_providers(conn) -> AppResult<Vec<AiProviderRow>>` (by `position`), `repo::get_ai_provider(conn, id) -> AppResult<AiProviderRow>` (`NotFound("AI provider not found")`), `repo::insert_ai_provider(conn, row: &AiProviderRow, now: &str)`, `repo::update_ai_provider(conn, row: &AiProviderRow, now: &str)` (writes every column except `id` / `created_at`), `repo::delete_ai_provider(conn, id)`, `repo::set_ai_provider_positions(conn, ids: &[String], now: &str)` (position = index).
  - `drafts::list_ai_providers(conn) -> AppResult<Vec<AiProvider>>`
  - `drafts::create_ai_provider(conn, input: AiProviderInput) -> AppResult<AiProvider>`
  - `drafts::update_ai_provider(conn, id: &str, input: AiProviderInput) -> AppResult<AiProvider>`
  - `drafts::set_ai_provider_enabled(conn, id: &str, enabled: bool) -> AppResult<AiProvider>`
  - `drafts::delete_ai_provider(conn, id: &str) -> AppResult<()>`
  - `drafts::reorder_ai_providers(conn, ids: &[String]) -> AppResult<()>`
  - `drafts::provider_config(conn, id: &str) -> AppResult<ai::NamedConfig>` (ignores `enabled`; used by Test)
  - `drafts::enabled_provider_configs(conn) -> AppResult<Vec<ai::NamedConfig>>` (enabled only, position order)

- [ ] **Step 1: Write the failing tests.** In `db/mod.rs`, add `migration_017_creates_ai_providers_and_drops_old_settings`. Apply migrations 1–16 (the `apply` closure pattern from `migration_013_…`), insert `app_settings` rows `ai_base_url`, `ai_model`, `ai_api_key` and `transaction_time_enabled`, apply `MIGRATIONS[16].1`, then assert:
  - the three `ai_*` rows are gone and `transaction_time_enabled` remains;
  - an `ai_providers` insert with every column succeeds;
  - `reset_to_defaults` leaves `ai_providers` empty.

In `drafts.rs` tests, using `db()`, add:

```rust
fn input(name: &str, key: Option<&str>) -> AiProviderInput {
    AiProviderInput { name: name.into(), base_url: " https://x.test/v1/ ".into(), model: " m ".into(), api_key: key.map(Into::into) }
}

#[test]
fn providers_round_trip_in_order_and_never_expose_the_key() {
    let c = db();
    let a = create_ai_provider(&c, input(" Gemini ", Some("k1"))).unwrap();
    let b = create_ai_provider(&c, input("Ollama", Some(""))).unwrap();
    assert_eq!((a.name.as_str(), a.base_url.as_str(), a.model.as_str(), a.has_key, a.enabled, a.position), ("Gemini", "https://x.test/v1", "m", true, true, 0));
    assert_eq!((b.has_key, b.position), (false, 1));
    assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Gemini", "Ollama"]);
    let json = serde_json::to_string(&list_ai_providers(&c).unwrap()).unwrap();
    assert!(!json.contains("k1"));
}

#[test]
fn update_keeps_the_key_on_null_and_clears_it_on_empty() {
    let c = db();
    let a = create_ai_provider(&c, input("Gemini", Some("k1"))).unwrap();
    assert!(update_ai_provider(&c, &a.id, input("Gemini 2", None)).unwrap().has_key);
    assert_eq!(provider_config(&c, &a.id).unwrap().cfg.api_key.as_deref(), Some("k1"));
    assert!(!update_ai_provider(&c, &a.id, input("Gemini 2", Some(""))).unwrap().has_key);
    assert_eq!(provider_config(&c, &a.id).unwrap().cfg.api_key, None);
}

#[test]
fn names_are_unique_ignoring_case_and_spaces() {
    let c = db();
    let a = create_ai_provider(&c, input("Gemini", None)).unwrap();
    assert!(matches!(create_ai_provider(&c, input(" gemini ", None)), Err(AppError::Validation(m)) if m == "An AI provider with that name already exists."));
    let b = create_ai_provider(&c, input("OpenAI", None)).unwrap();
    assert!(update_ai_provider(&c, &b.id, input("GEMINI", None)).is_err());
    assert!(update_ai_provider(&c, &a.id, input("gemini", None)).is_ok(), "renaming itself is fine");
}

#[test]
fn provider_validation_messages() {
    let c = db();
    let bad = |n: &str, u: &str, m: &str| create_ai_provider(&c, AiProviderInput { name: n.into(), base_url: u.into(), model: m.into(), api_key: None }).unwrap_err().to_string();
    assert_eq!(bad(" ", "https://x", "m"), "Name cannot be empty");
    assert_eq!(bad("A", "ftp://x", "m"), "The base URL must start with http:// or https://");
    assert_eq!(bad("A", "https://x", " "), "Model cannot be empty");
    assert!(matches!(update_ai_provider(&c, "nope", input("A", None)), Err(AppError::NotFound(_))));
    assert!(matches!(set_ai_provider_enabled(&c, "nope", false), Err(AppError::NotFound(_))));
    assert!(matches!(delete_ai_provider(&c, "nope"), Err(AppError::NotFound(_))));
}

#[test]
fn delete_closes_the_gap_and_reorder_needs_every_id_once() {
    let c = db();
    let ids: Vec<String> = ["A", "B", "C"].iter().map(|n| create_ai_provider(&c, input(n, None)).unwrap().id).collect();
    delete_ai_provider(&c, &ids[1]).unwrap();
    assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.position).collect::<Vec<_>>(), [0, 1]);
    reorder_ai_providers(&c, &[ids[2].clone(), ids[0].clone()]).unwrap();
    assert_eq!(list_ai_providers(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["C", "A"]);
    let msg = "The order must list every AI provider exactly once.";
    for bad in [vec![ids[2].clone()], vec![ids[2].clone(), ids[2].clone()], vec![ids[2].clone(), ids[0].clone(), "x".into()], vec![ids[2].clone(), "x".into()]] {
        assert_eq!(reorder_ai_providers(&c, &bad).unwrap_err().to_string(), msg);
    }
}

#[test]
fn enabled_configs_skip_disabled_providers_and_keep_order() {
    let c = db();
    let a = create_ai_provider(&c, input("A", None)).unwrap();
    create_ai_provider(&c, input("B", None)).unwrap();
    let off = set_ai_provider_enabled(&c, &a.id, false).unwrap();
    assert_eq!((off.enabled, off.position), (false, 0));
    assert_eq!(enabled_provider_configs(&c).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["B"]);
    assert_eq!(provider_config(&c, &a.id).unwrap().name, "A", "Test ignores the switch");
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd src-tauri && cargo test --lib provider migration_017`
Expected: compile errors for the missing functions and types.

- [ ] **Step 3: Implement.**
  - `MIGRATION_017` is exactly the SQL block in the spec's *Data* section.
  - Service rules are as in the spec:
    - trim the name and model;
    - normalise the base URL with today's rule (trim, `trim_end_matches('/')`, http/https check);
    - store a trimmed empty key as `NULL`; on update, `api_key: None` keeps the stored key;
    - check uniqueness against `list_ai_providers` with `trim().to_lowercase()`, excluding the row being updated.
  - Create inserts at `position = count`.
  - Delete: `get_ai_provider` (for `NotFound`), then delete and renumber the remaining rows inside `in_transaction`.
  - Reorder: compare the given ids, as a set and by length, with the stored ids. Any mismatch is the reorder `Validation` message. Then `set_ai_provider_positions` inside `in_transaction`.
  - `to_provider(row) -> AiProvider` maps `has_key = row.api_key.is_some()`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd src-tauri && cargo test --lib`
Expected: every test passes (the old `ai_settings_*` tests still pass; they're removed in Task 3).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(ai): store an ordered list of AI providers"
```

---

### Task 3: Commands and `extract_drafts` wiring; remove the single-provider settings

**Files:**
- Modify: `src-tauri/src/commands.rs:355-397` (extract + AI settings commands)
- Modify: `src-tauri/src/lib.rs:97-104` (handler registration)
- Modify: `src-tauri/src/drafts.rs` (`prepare`; delete `KEY_*`, `get_ai_settings`, `set_ai_settings`, `load_ai_config` and their two tests at ~808-842)
- Modify: `src-tauri/src/service.rs:1121-1123` (delete the `KEY_API_KEY` guard)
- Modify: `src-tauri/src/models.rs` (delete `AiSettings`, `AiSettingsInput`; add `ExtractResult`)

**Interfaces:**
- Consumes: Task 1 `extract_with_fallback`, `FallbackOutcome`, `SkippedProvider`; Task 2 `drafts::*` provider functions.
- Produces:
  - `models::ExtractResult { drafts: Vec<ImportDraft>, provider: String, skipped: Vec<SkippedProvider> }` — `Serialize`, camelCase.
  - `drafts::prepare(conn) -> AppResult<(Vec<ai::NamedConfig>, PromptContext, String)>`, erroring with `ai_not_configured` / `Add an AI provider in Settings first.` when there's no enabled provider.
  - Tauri commands (camelCase args from the frontend):
    - `list_ai_providers() -> Vec<AiProvider>`
    - `create_ai_provider(input: AiProviderInput) -> AiProvider`
    - `update_ai_provider(id: String, input: AiProviderInput) -> AiProvider`
    - `set_ai_provider_enabled(id: String, enabled: bool) -> AiProvider`
    - `delete_ai_provider(id: String) -> ()`
    - `reorder_ai_providers(ids: Vec<String>) -> ()`
    - `async test_ai_provider(id: String) -> ()` — load `provider_config` under the lock, then `ai::test_connection(&named.cfg)` without it.
    - `async extract_drafts(source_name, text) -> ExtractResult` — `prepare` under the lock, then `extract_with_fallback` without it, then `store_drafts` under the lock.

- [ ] **Step 1: Write the failing test** in `drafts.rs` tests:

```rust
#[test]
fn prepare_needs_an_enabled_provider() {
    let c = db();
    let code = |r: AppResult<_>| match r { Err(AppError::Ai(code, m)) => (code, m), _ => panic!("expected Ai error") };
    assert_eq!(code(prepare(&c).map(|_| ())), ("ai_not_configured", "Add an AI provider in Settings first.".into()));
    let a = create_ai_provider(&c, input("A", None)).unwrap();
    set_ai_provider_enabled(&c, &a.id, false).unwrap();
    assert_eq!(code(prepare(&c).map(|_| ())).0, "ai_not_configured");
    set_ai_provider_enabled(&c, &a.id, true).unwrap();
    assert_eq!(prepare(&c).unwrap().0[0].name, "A");
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd src-tauri && cargo test --lib prepare_needs`
Expected: a type mismatch, because `prepare` still returns a single `AiConfig`.

- [ ] **Step 3: Implement** the Interfaces above. Change `prepare` to use `enabled_provider_configs`. Delete the old settings code, its tests and the `get_setting` guard. Swap the registrations in `lib.rs` (remove the three old commands, add the seven new ones).

- [ ] **Step 4: Run the Rust gate**

Run: `cd src-tauri && cargo test --lib && cargo build`
Expected: all tests pass, and the build succeeds with no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(ai): provider commands and fallback in extract_drafts"
```

---

### Task 4: Types, client, mock, and the Drafts screen

**Files:**
- Modify: `src/types.ts:291-302` (replace `AiSettings` / `AiSettingsInput`)
- Modify: `src/client/index.ts:113-122`
- Modify: `src/client/mock.ts`:
  - ~249: add an `aiProviders` array;
  - 315-320: delete `aiSettings()`;
  - 1417-1443: `extract_drafts`;
  - 1498-1515: provider cases; drop the `ai_api_key` `get_setting` guard;
  - ~1561: reset clears `aiProviders`.
- Create: `src/__tests__/mock-ai-providers.test.ts`
- Modify: `src/__tests__/mock-drafts.test.ts` (`configureAi`, extract assertions, delete the "keeps the API key write-only" test)
- Modify: `src/screens/Drafts.tsx:5,61,73,85-108,168-209`

**Interfaces:**
- Consumes: the Task 3 command names and arg names.
- Produces (TS):
  - `interface AiProvider { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; enabled: boolean; position: number }`
  - `interface AiProviderInput { name: string; baseUrl: string; model: string; apiKey: string | null }` (doc: `null` keeps the saved key, `""` clears it, and on create both mean no key)
  - `interface SkippedProvider { name: string; message: string }`
  - `interface ExtractResult { drafts: ImportDraft[]; provider: string; skipped: SkippedProvider[] }`
  - `client` functions:
    - `listAiProviders()`
    - `createAiProvider(input)`
    - `updateAiProvider(id, input)`
    - `setAiProviderEnabled(id, enabled)`
    - `deleteAiProvider(id)`
    - `reorderAiProviders(ids)`
    - `testAiProvider(id)`
    - `extractDrafts(sourceName, text): Promise<ExtractResult>`

- [ ] **Step 1: Write the failing tests.**

`mock-ai-providers.test.ts` (with `beforeEach(() => client.resetApp())`):

```ts
const input = (name: string, apiKey: string | null = null) => ({ name, baseUrl: " https://x.test/v1/ ", model: " m ", apiKey });

it("creates in order, trims, and never returns the key", async () => {
  const a = await client.createAiProvider(input(" Gemini ", "k1"));
  const b = await client.createAiProvider(input("Ollama", ""));
  expect(a).toMatchObject({ name: "Gemini", baseUrl: "https://x.test/v1", model: "m", hasKey: true, enabled: true, position: 0 });
  expect(b).toMatchObject({ hasKey: false, position: 1 });
  expect(JSON.stringify(await client.listAiProviders())).not.toContain("k1");
});
it("keeps the key on null and clears it on empty", async () => { /* update with null → hasKey true; with "" → false */ });
it("rejects duplicate names ignoring case and spaces, but allows renaming itself", async () => { /* code ValidationError, message "An AI provider with that name already exists." */ });
it("validates name, base URL and model", async () => { /* the three exact messages from Global Constraints */ });
it("returns NotFound for unknown ids", async () => { /* update, setEnabled, delete, test → code NotFound */ });
it("closes the gap on delete and requires every id once to reorder", async () => { /* mirrors the Rust test, including the exact message */ });
it("disabling keeps the position", async () => { /* position unchanged, enabled false */ });
it("factory reset removes every provider", async () => { /* resetApp → list empty */ });
```

`mock-drafts.test.ts`:
- `configureAi()` becomes `client.createAiProvider({ name: "Local", baseUrl: "http://localhost:11434/v1", model: "llava", apiKey: null })`.
- Each `extractDrafts(...)` result is read as `.drafts`.
- Add:

```ts
it("names the first enabled provider and refuses when all are off", async () => {
  await client.createAccount("Maybank Savings", "savings", 0, null);
  const off = await client.createAiProvider({ name: "Off one", baseUrl: "https://a.test/v1", model: "m", apiKey: null });
  await client.setAiProviderEnabled(off.id, false);
  await expect(client.extractDrafts("a.png", "t")).rejects.toMatchObject({ code: "ai_not_configured", message: "Add an AI provider in Settings first." });
  await configureAi();
  const res = await client.extractDrafts("a.png", "t");
  expect(res.provider).toBe("Local");
  expect(res.skipped).toEqual([]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/__tests__/mock-ai-providers.test.ts src/__tests__/mock-drafts.test.ts`
Expected: FAIL, `client.createAiProvider is not a function`.

- [ ] **Step 3: Implement the types, client and mock.** The mock mirrors the Task 2 and 3 rules with the same messages. It stores `apiKey: string | null` internally and returns `hasKey` only. `test_ai_provider` checks the id exists and returns `undefined` (no network). `extract_drafts` uses the first enabled provider's name as `provider`, with `skipped: []`.

- [ ] **Step 4: Update `Drafts.tsx`.**
  - Replace the `ai` state with `providers: AiProvider[] | null`, loaded with `client.listAiProviders()`, and set `const enabled = (providers ?? []).filter((p) => p.enabled)`.
  - `configured` is `enabled.length > 0`.
  - The precheck in `handleFile` and the hint use `configured`. The hint text becomes `Add an AI provider in Settings → AI import to use this.`
  - The cloud notice shows when any enabled provider is not `isLocalUrl`, and reads `Text from your photos is sent to <comma-joined names of enabled non-local providers>.`
  - On success, read `res.drafts`. The toast keeps today's count text, followed by `Read by <provider>.` and one `<name> failed: <reason>.` per skipped provider, each reason with its trailing `.` trimmed.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test`
Expected: all pass. (`npm run build` stays red until Task 5 replaces `AiImportCard`, which still calls the removed client functions.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/client src/__tests__ src/screens/Drafts.tsx
git commit -m "feat(ai): provider list in the client, mock and Drafts screen"
```

---

### Task 5: Settings → AI import provider list

**Files:**
- Modify: `src/screens/Settings.tsx:12,189-287` (replace `AiImportCard`; keep `AI_PRESETS` and give each preset a `name`: `Gemini`, `Ollama`, `OpenAI`)

**Interfaces:**
- Consumes: the Task 4 `client` provider functions and the `AiProvider` / `AiProviderInput` types.
- Produces: `AiImportCard` (same export position in the Settings screen, ~line 451).

- [ ] **Step 1: Implement the card** to the spec's *UI → Settings* section. Use the copy from Global Constraints.
  - **State:** `providers`, `editing: AiProvider | "new" | null`, form fields `name`, `baseUrl`, `model`, `apiKey`, and `busyId`.
  - **Rows:** `⋮⋮` handle (`draggable`; `onDragStart` sets the id; `onDrop` on a row computes the new id order and calls `reorderAiProviders`), then position number, name, `model · key saved` or `model · no key`, the on/off switch with the text `On`/`Off`, `↑` and `↓` (`aria-label="Move <name> up"` / `"Move <name> down"`, disabled at the ends), `Test`, `Edit`, and `✕` (`aria-label="Delete <name>"`, `window.confirm` with the delete copy).
  - **Disabled rows:** `opacity: 0.55`.
  - **Form:** preset buttons fill name, base URL and model. In Edit, a blank key sends `apiKey: null`; **Remove key** sends `""`. **Save & test** saves, then `testAiProvider(id)` and toasts `<name> answered.`
  - **After every mutation:** re-fetch with `listAiProviders()`. Errors go to `notify(message, "error")`.
  - **Empty state:** the copy above, shown when the list is empty.
  - Keep the existing unencrypted-key note.

- [ ] **Step 2: Typecheck and test**

Run: `npm run build && npm test`
Expected: both clean.

- [ ] **Step 3: Check it in the browser mock.** Start the `sens-dev` preview. In Settings, add three providers via presets, drag the third to the top, use ↓ on the first, switch one off, edit one without touching the key (it still shows "key saved"), delete one, and confirm the order shown matches after each step. Check the "Off" text and the light and dark themes. In Drafts, confirm *Choose photo* is disabled once every provider is switched off. Take a screenshot as proof.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Settings.tsx
git commit -m "feat(ai): Settings list of AI providers with reorder and on/off"
```

---

### Task 6: Docs and full gate

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `ROADMAP.md` (the *Data integrity & ownership* checklist: add and tick `AI import: several providers tried in order, with fallback`)
- Modify: `docs/architecture/backend.md:119-170` (the Photo import commands and key handling: the new commands, `ExtractResult`, fallback, `ai_all_failed`, the key stored per provider, the `get_setting` guard removed)
- Modify: `docs/superpowers/specs/2026-10-17-photo-transaction-import-design.md` (under the header: `Provider settings superseded by 2026-10-21-ai-provider-fallback-design.md.`)
- Modify: `docs/superpowers/specs/2026-10-21-ai-provider-fallback-design.md` (Status: `Implemented (unreleased). Plan: docs/superpowers/plans/2026-10-21-ai-provider-fallback.md`)

- [ ] **Step 1: Write the docs.** The CHANGELOG entry, in the file's plain user-facing style:

  `**Several AI providers for photo import.** Settings → AI import keeps a list of providers in the order you choose (drag, or the arrow buttons). Drafts tries them in turn and moves to the next one when a call fails, then says which provider read the photo and which were skipped. Each provider can be switched off without deleting it. Your earlier AI settings are not carried over; add the provider again.`

- [ ] **Step 2: Run the full CI gate**

Run: `npm run build && npm test && (cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib)`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md ROADMAP.md docs
git commit -m "docs: AI provider fallback in changelog, roadmap and backend notes"
```
