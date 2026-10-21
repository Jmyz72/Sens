# AI provider list with fallback — design

**Date:** 2026-10-21
**Status:** Implemented (unreleased). Plan: `docs/superpowers/plans/2026-10-21-ai-provider-fallback.md`
**Builds on:** `2026-10-17-photo-transaction-import-design.md` (replaces its single-provider settings).

## Goal

Photo import (Drafts) currently uses one AI endpoint stored in three settings rows. Let the user save
**as many AI providers as they need**, put them **in the order they want**, and have Drafts **fall back
automatically** to the next provider when one fails. The user never picks a provider per import; the
order is the choice.

## Decisions

| Topic | Decision |
|---|---|
| Use case | Automatic fallback down an ordered list. No per-import manual pick. |
| Order | User-defined. Drag handle plus ↑/↓ buttons in Settings. |
| What triggers fallback | **Any** failure of a provider: unreachable, timeout, rejected key (401/403), non-2xx (429, 5xx, …), or a reply that is still invalid after the existing repair retry. |
| On/off | Each provider has an enabled switch. Disabled providers are skipped and keep their position. |
| Storage | New `ai_providers` table (migration 017). The old `ai_base_url` / `ai_model` / `ai_api_key` settings are deleted by the migration and no longer used. No data is copied (no existing users). |
| Reporting | A successful extract names the provider that answered and lists any skipped ones with their reasons. When all fail, one error lists every reason in order. |
| Per-draft record | Drafts do not store which provider read them. |
| Timeout | Unchanged: 120 s per HTTP call. No live "trying X…" progress. |

## Out of scope

- Choosing a provider per import, or round-robin / load balancing.
- Encrypting keys or using the OS keychain (keys stay unencrypted in the local DB, as today).
- Retrying the same provider more than the existing JSON-mode and repair retries.
- Live per-provider progress on the Drafts screen.

## Data

New table, added by `MIGRATION_017` (append-only):

```sql
CREATE TABLE ai_providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  model      TEXT NOT NULL,
  api_key    TEXT,                       -- NULL = no key (e.g. Ollama)
  enabled    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL,           -- 0 = tried first
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
DELETE FROM app_settings WHERE key IN ('ai_base_url', 'ai_model', 'ai_api_key');
```

Rules (enforced in the service, mirrored in the mock):

- `name`: trimmed, non-empty, unique case-insensitively.
- `base_url`: trimmed, trailing `/` removed, must start with `http://` or `https://` (today's rule).
- `model`: trimmed, non-empty.
- `api_key`: trimmed; empty is stored as `NULL`.
- `position`: dense `0..n-1`. Create appends at the end; delete closes the gap.

Factory reset (`db::reset_to_defaults`) adds `DELETE FROM ai_providers`.

## Commands

These replace `get_ai_settings`, `set_ai_settings` and `test_ai_connection`, which are removed from Rust,
the client and the mock. The rules live in `drafts.rs` (the AI service module) and the SQL in `repo.rs`.

| Command | Args | Returns | Behavior |
|---|---|---|---|
| `list_ai_providers` | none | `AiProvider[]` | Position order. |
| `create_ai_provider` | `input: AiProviderInput` | `AiProvider` | Appended at the end, enabled. |
| `update_ai_provider` | `id, input: AiProviderInput` | `AiProvider` | `apiKey: null` keeps the saved key; `""` clears it; a value replaces it. |
| `set_ai_provider_enabled` | `id, enabled` | `AiProvider` | Position unchanged. |
| `delete_ai_provider` | `id` | `void` | Removes the row (and its key); renumbers positions. |
| `reorder_ai_providers` | `ids: string[]` | `void` | Same contract as `reorder_categories`: the full id list in the new order. A missing, extra, duplicate or unknown id is a `ValidationError`. |
| `test_ai_provider` | `id` | `void` | Tests that provider only, without fallback, and ignores its enabled flag. |

```ts
interface AiProvider {
  id: string; name: string; baseUrl: string; model: string;
  hasKey: boolean;            // the key itself is never returned
  enabled: boolean; position: number;
}
interface AiProviderInput { name: string; baseUrl: string; model: string; apiKey: string | null }
```

On create, `apiKey: null` and `""` both mean "no key".

## Fallback flow (`extract_drafts`)

1. **Prepare, under the DB lock:** load the enabled providers in position order plus the prompt context.
   If there are none, fail with `ai_not_configured`: "Add an AI provider in Settings first."
2. **Without the lock:** `ai::extract_with_fallback(providers, messages)` calls today's `ai::extract`
   for each provider in turn (one call, plus the existing JSON-mode and repair retries).
   - Success: stop, returning the rows, the provider's name, and the list of skipped providers.
   - Any `AppError`: record `{ name, message }` and continue.
   - All failed: `AppError::Ai("ai_all_failed", …)` whose message is
     `All AI providers failed. <name>: <reason>. <name>: <reason>.` in position order.
3. **Under the lock:** store the drafts, as today.

`extract_drafts` now returns:

```ts
interface ExtractResult {
  drafts: ImportDraft[];
  provider: string;                              // name of the provider that answered
  skipped: { name: string; message: string }[];  // earlier providers that failed, in order
}
```

`extract_with_fallback` is a pure async function in `ai.rs` (no DB), so it can be tested against the
existing fake HTTP server.

## Errors

| Code | When |
|---|---|
| `ValidationError` | Bad name (empty or duplicate), bad base URL, empty model, bad reorder list |
| `NotFound` | Unknown id for update, enable, delete, test or reorder |
| `ai_not_configured` | Extract with no enabled provider |
| `ai_all_failed` (new) | Every enabled provider failed |
| `ai_auth`, `ai_unreachable`, `ai_bad_response` | Unchanged. Returned directly by `test_ai_provider`; collected into `skipped` / `ai_all_failed` during extract. |

The API key never appears in an error, a log, or the mock (hard rule 11). The existing per-call
messages already exclude the key and the URL.

## UI

### Settings → AI import

The card becomes an ordered list plus an inline add/edit form. It uses existing atoms (`Card`, `Btn`,
`SectionTitle`) and `useTheme()` tokens, with no new dependencies.

```
AI import
Drafts tries these in order and falls back to the next one if a call fails.

  ⋮⋮ 1  Gemini free     gemini-2.0-flash · key saved   [on]  ↑ ↓  Test  Edit  ✕
  ⋮⋮ 2  OpenAI          gpt-4o-mini · key saved        [on]  ↑ ↓  Test  Edit  ✕
  ⋮⋮ 3  Ollama          llama3.1 · no key              [off] ↑ ↓  Test  Edit  ✕

  [+ Add provider]
  The key is stored unencrypted in Sens's local database and is never shown again. …
```

- **Reorder:** native HTML5 drag on the `⋮⋮` handle (the same pattern as Categories; relies on
  `dragDropEnabled: false`), plus ↑/↓ buttons with `aria-label`s for the keyboard. ↑ is disabled on the
  first row and ↓ on the last. Both send the full order through `reorder_ai_providers`.
- **On/off switch:** a disabled row is dimmed **and** shows the text "Off" (color is never the only cue).
- **Add / Edit:** an inline form below the list with Name, Base URL, Model, API key and the existing
  preset buttons (Gemini, Ollama, OpenAI). A preset also fills the name. In Edit, a blank key field keeps
  the saved key, and **Remove key** clears it. Buttons: **Save** and **Save & test**.
- **Test:** tests that row. Success toast: "<name> answered." Failure toast: that provider's error.
- **Delete:** confirm "Delete <name>? Its key is removed too.", then delete.
- **Empty state:** "No AI providers yet. Add one to use photo import."

### Drafts screen

- Success toast: "Read by <provider>." plus, when `skipped` is not empty,
  "<name> failed: <reason>." for each skipped provider.
- `ai_all_failed` and `ai_not_configured` show their message as today's AI errors do.

## Mock

`mock.ts` mirrors every command, rule and error above, including key handling (`hasKey` only, `null`
keeps, `""` clears) and factory reset. It still never calls a network: `extract_drafts` returns its canned
drafts with `provider` set to the first enabled provider's name and `skipped: []`, or
`ai_not_configured` when none is enabled.

## Testing

**Rust (`cargo test --lib`):**

- `repo` / `drafts`:
  - Create, list, update and delete round trip.
  - Key rules: `null` keeps, `""` clears, and `hasKey` never exposes the key.
  - Delete renumbers positions; reorder rejects a partial, duplicate or unknown id list; enable/disable
    keeps position.
  - Validation errors; factory reset empties the table; migration 017 removes the three old settings.
  - `prepare` returns only enabled providers, in position order, so disabled ones are never called.
- `ai` (existing fake HTTP server):
  - The first provider fails (401, 429, 500, unreachable, invalid JSON twice) and the second succeeds.
    The result names the second, and `skipped` holds the first with its reason.
  - All fail: `ai_all_failed` lists every reason in order and does not contain any key.

**Frontend (Vitest):**

- New `src/__tests__/mock-ai-providers.test.ts`: CRUD, key rules, reorder, enable, validation,
  `NotFound`, and reset, all against the mock.
- `src/__tests__/mock-drafts.test.ts`: the new `ExtractResult` shape, and `ai_not_configured` with no
  providers or all of them disabled.

## Docs

- `docs/architecture/backend.md` (photo import section: commands, settings, fallback).
- `2026-10-17-photo-transaction-import-design.md`: a note that the provider settings are superseded by
  this spec.
- `CHANGELOG.md` under `[Unreleased]`; `ROADMAP.md` under *Data integrity & ownership*.
