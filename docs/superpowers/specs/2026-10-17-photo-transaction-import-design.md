# Photo transaction import (OCR + LLM) — design

**Date:** 2026-10-17
**Status:** Implemented (unreleased). Plan: `docs/superpowers/plans/2026-10-17-photo-transaction-import.md`

## Goal

Let the user log transactions from a photo or screenshot (receipts, bank/e-wallet screenshots,
statement pages). The app reads the image with the operating system's OCR, asks an LLM to turn the
text into structured transaction JSON, and shows the result on a review screen. Nothing is saved
until the user confirms.

## Decisions

| Topic | Decision |
|---|---|
| Pipeline | Local OS OCR → text → LLM → JSON. Only text is sent to the LLM, never the image. |
| Input scope | Anything, including many transactions in one image; kinds: expense, income, transfer. |
| Review | A review-and-confirm screen. No auto-save. |
| LLM provider | One OpenAI-compatible chat-completions client: base URL + model + optional API key. Covers Google AI Studio (Gemini OpenAI-compat endpoint), Ollama, LM Studio, OpenAI, OpenRouter, Groq, etc. No native Anthropic path in v1. |
| OCR engine | Native OS OCR in Rust: Apple Vision (macOS), `Windows.Media.Ocr` (Windows). |
| Image input | Native file picker and clipboard paste. Drag-and-drop stays off (`dragDropEnabled: false`). |
| UI home | A new **Drafts** screen in the left sidebar. Upload, OCR progress, review, edit and confirm all happen there; there is no modal. |
| Persistence | Extracted drafts are saved in a `import_drafts` table so unreviewed work survives closing the app. They are not transactions and do not touch balances until confirmed. |
| Where the LLM is called | Rust backend (`reqwest`). Keeps the key out of the webview and avoids CORS. |

## Out of scope (v1)

- Storing the photo as a receipt attachment (stays on the roadmap's "Receipts/attachments").
- A native Anthropic API path, auto-save without review, drag-and-drop.
- Multi-currency (the app is MYR only; a non-MYR amount is flagged for the user to fix).

## Flow

1. The user opens the **Drafts** screen (sidebar, "Money" section), then picks a file or pastes an image.
2. `ocr_image` runs the OS OCR and returns text.
3. `extract_drafts` builds a prompt from the OCR text, the active account names and the
   category/subcategory tree, calls the configured endpoint in JSON mode, and validates the reply.
4. The service resolves account and category names to IDs. Unmatched names stay empty and are
   flagged.
5. The service stores the rows as drafts (status `pending`) and the Drafts screen lists them. Each
   row is editable and low-confidence fields are marked.
6. Confirming a row (or "Confirm all ready") creates the transaction through the existing
   create-transaction service path, so postings, balances, splits and validation behave as for
   manual entry, then deletes the draft. Discarding deletes the draft with no other effect. A row
   that fails validation stays a draft with the error shown.

## Draft shape (LLM output, validated)

```json
{ "transactions": [
  { "date": "2026-10-15", "time": "13:42", "amount": "12.50",
    "kind": "expense", "account": "Maybank Savings",
    "to_account": null, "category": "Food", "subcategory": "Lunch",
    "note": "Kopitiam", "confidence": 0.8 }
] }
```

- `amount` is a decimal string in MYR. **The service converts it to integer cents**; the model never
  does arithmetic that is stored. Zero, negative or unparseable amounts are rejected as drafts
  needing fixing.
- `date` is `YYYY-MM-DD`; `time` is optional `HH:MM`. A missing date defaults to today and is
  flagged. A future date is flagged. When "Record transaction times" is on, a missing time becomes
  `00:00` with a `time_assumed` hint instead of blocking the row.
- `kind` is one of `expense | income | transfer`. A transfer requires both `account` and
  `to_account`.
- `confidence` is 0–1. Below 0.6, or any unresolved name, marks the row "needs review".
- Unknown fields are ignored. A reply that is not valid JSON, or fails the schema, gets one retry
  with the validation error appended; after that the user sees an error with the OCR text so they
  can enter transactions manually.

## Components

### Rust

- `src-tauri/src/ocr.rs`: `recognize(image_bytes) -> Result<String, AppError>`, with a
  `#[cfg(target_os)]` implementation per platform (no trait; the draft logic takes text, so tests
  do not need an OCR stub).
- `src-tauri/src/ai.rs`: OpenAI-compatible client (`POST {base_url}/chat/completions`,
  JSON response format), prompt builder, response schema validation. No trait: tests run the client
  against a local stub HTTP server.
- `src-tauri/src/drafts.rs` (not `service.rs`, following `schedules.rs`): name-to-ID resolution
  (case-insensitive, trimmed, exact match first, then unique prefix match; ambiguous means
  unresolved), cents conversion, draft hints and problems, draft storage and confirm, and the AI
  settings get/set. `service.rs` only blocks `get_setting` from reading the API key.
- `commands.rs`: thin commands `ocr_image` (raw IPC body), `extract_drafts`, `get_ai_settings`,
  `set_ai_settings`, `test_ai_connection`, plus the draft commands below. Confirm reuses the existing
  create-transaction service functions.
- `Cargo.toml`: add `reqwest` (rustls, json) and the platform OCR bindings.

### Drafts storage

A new append-only migration adds `import_drafts` (`id` UUID, `created_at`, `source_name` for the
file name or "pasted image", and `payload` JSON holding one draft transaction in the shape above
plus its flags; an `updated_at` column too). This is migration 016. The backend generates the id and
timestamps. Commands: `list_import_drafts`, `update_import_draft`, `discard_import_drafts(ids)`,
`confirm_import_drafts(ids)`. The OCR text and image
are not stored. Per the repo's no-existing-users rule there is no backfill.

### Settings

`ai_base_url`, `ai_model`, `ai_api_key`, stored in the settings table; the key is write-only from the
frontend. It is not returned after saving (only a `hasKey` flag), and the generic `get_setting`
refuses it. No OS keychain is used; the UI says the key is stored unencrypted in the local database.
Presets prefill the base URL and model (Google AI Studio, Ollama, OpenAI). **Save & test** saves, then
sends a tiny request and reports success, auth failure or unreachable.

### Frontend

- `src/nav.ts`: add `"drafts"` to `ScreenId`, a `NAV` entry (label "Drafts", a suitable existing
  icon, sub "Review photo imports before they post"), and put it in the "Money" section after
  Transactions. The sidebar `navCount` shows the number of pending drafts as a badge.
- `src/App.tsx`: route the screen.
- `src/screens/Drafts.tsx` (new): the whole feature lives here.
  - Top: **Choose photo** button and a paste target ("Paste a screenshot with Cmd/Ctrl+V"), with
    progress states (reading text, extracting).
  - Below: the pending drafts table. Each row is editable inline (date, amount, kind, account,
    category, note), shows a "needs review" marker (icon + text) when flagged, and has Confirm and
    Discard. Bulk actions: Confirm all ready, Discard all.
  - Empty state explains what to upload; if AI is not configured it links to Settings.
- `src/screens/Settings.tsx`: new "AI import" `<Card>` for base URL, model, key and Test connection.
- `src/client/index.ts` wrappers; `src/client/mock.ts` gets a stub OCR, fake extraction and an
  in-memory drafts list so browser dev works. Any behavior change is made in both Rust and the mock.
- Colors come from `useTheme()` tokens.

## Errors

All failures are `AppError {code, message}` with distinct codes: `ocr_unavailable`, `ocr_empty`
(no text found), `ai_not_configured`, `ai_unreachable`, `ai_auth`, `ai_bad_response`. The TS client
and mock throw the same shape. Network errors never expose the API key in messages.

## Privacy

Only OCR text plus account and category names are sent. When the base URL is not a local host
(`localhost`, `127.0.0.1`, `[::1]`), the Drafts screen shows a one-time notice that the text goes to that
provider (shown whenever such a base URL is set, not only once). Logs never include OCR text or keys.

## Testing

- Rust unit tests (draft logic on plain text; the HTTP client against a local stub server): schema validation, retry-on-bad-JSON,
  amount-to-cents edge cases, name resolution (exact, prefix, ambiguous, unknown), transfer
  validation, confidence flagging, confirm creating balanced postings.
- Rust: draft persistence (list, update, discard) and confirm creating transactions and removing drafts.
- Vitest: mock extraction and draft-to-form mapping.
- Manual smoke: real OCR on macOS and Windows with sample receipts, plus Gemini and Ollama endpoints.

## Docs to update on implementation

`CHANGELOG.md`, `ROADMAP.md`, `docs/architecture/backend.md` (new commands, `import_drafts` migration, HTTP dependency, mock stub) and `docs/architecture/frontend.md` (Drafts screen and settings).
