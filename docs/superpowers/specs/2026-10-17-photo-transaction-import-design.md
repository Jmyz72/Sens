# Photo transaction import (OCR + LLM) — design

**Date:** 2026-10-17
**Status:** Approved design, not yet implemented

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
| Where the LLM is called | Rust backend (`reqwest`). Keeps the key out of the webview and avoids CORS. |

## Out of scope (v1)

- Storing the photo as a receipt attachment (stays on the roadmap's "Receipts/attachments").
- A native Anthropic API path, auto-save without review, drag-and-drop.
- Multi-currency (the app is MYR only; a non-MYR amount is flagged for the user to fix).

## Flow

1. The user opens **Import from photo**, then picks a file or pastes an image.
2. `ocr_image` runs the OS OCR and returns text.
3. `extract_transactions` builds a prompt from the OCR text, the active account names and the
   category/subcategory tree, calls the configured endpoint in JSON mode, and validates the reply.
4. The service resolves account and category names to IDs. Unmatched names stay empty and are
   flagged.
5. The review screen lists draft rows. Each row is editable and low-confidence fields are marked.
6. Confirming creates the transactions through the existing create-transaction service path, so
   postings, balances, splits and validation behave as for manual entry.

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
  flagged. A future date is flagged.
- `kind` is one of `expense | income | transfer`. A transfer requires both `account` and
  `to_account`.
- `confidence` is 0–1. Below 0.6, or any unresolved name, marks the row "needs review".
- Unknown fields are ignored. A reply that is not valid JSON, or fails the schema, gets one retry
  with the validation error appended; after that the user sees an error with the OCR text so they
  can enter transactions manually.

## Components

### Rust

- `src-tauri/src/ocr.rs`: `recognize(image_bytes) -> Result<String, AppError>`, with a
  `#[cfg(target_os)]` implementation per platform behind a `trait OcrEngine` so tests can stub it.
- `src-tauri/src/ai.rs`: OpenAI-compatible client (`POST {base_url}/chat/completions`,
  JSON response format), prompt builder, response schema validation, `trait LlmClient` for stubbing.
- `service.rs`: orchestration (`import_from_text`), name-to-ID resolution (case-insensitive, trimmed,
  exact match first, then unique prefix match; ambiguous means unresolved), cents conversion and
  draft flags. It also holds the AI settings get/set and `test_ai_connection`.
- `commands.rs`: thin commands `ocr_image`, `extract_transactions`, `get_ai_settings`,
  `set_ai_settings`, `test_ai_connection`. Confirm reuses the existing create-transaction commands.
- `Cargo.toml`: add `reqwest` (rustls, json) and the platform OCR bindings.

### Settings

`ai_base_url`, `ai_model`, `ai_api_key`, stored in the settings table. The key is not returned to the
frontend after saving (only a "set" flag). Presets prefill the base URL (Google AI Studio, Ollama,
OpenAI). A **Test connection** button sends a tiny request and reports success, auth failure or
unreachable. If a cheap OS-keychain option exists at implementation time, prefer it for the key;
otherwise the settings table, noted in the UI.

### Frontend

- `src/modals/ImportFromPhoto.tsx`: file picker, paste handler, progress states (reading, extracting),
  review table with per-row edit and remove, confirm button.
- `src/client/index.ts` wrappers; `src/client/mock.ts` gets a stub OCR and a deterministic fake
  extraction so browser dev works. Any change to command behaviour is made in both Rust and the mock.
- Colors come from `useTheme()` tokens; "needs review" uses icon + text, not color alone.

## Errors

All failures are `AppError {code, message}` with distinct codes: `ocr_unavailable`, `ocr_empty`
(no text found), `ai_not_configured`, `ai_unreachable`, `ai_auth`, `ai_bad_response`. The TS client
and mock throw the same shape. Network errors never expose the API key in messages.

## Privacy

Only OCR text plus account and category names are sent. When the base URL is not a local host
(`localhost`, `127.0.0.1`, `[::1]`), the modal shows a one-time notice that the text goes to that
provider. Logs never include OCR text or keys.

## Testing

- Rust unit tests (stubbed `OcrEngine` / `LlmClient`): schema validation, retry-on-bad-JSON,
  amount-to-cents edge cases, name resolution (exact, prefix, ambiguous, unknown), transfer
  validation, confidence flagging, confirm creating balanced postings.
- Vitest: mock extraction and draft-to-form mapping.
- Manual smoke: real OCR on macOS and Windows with sample receipts, plus Gemini and Ollama endpoints.

## Docs to update on implementation

`CHANGELOG.md`, `ROADMAP.md`, `docs/architecture/backend.md` (new commands, HTTP dependency, mock
stub) and `docs/architecture/frontend.md` (modal and settings).
