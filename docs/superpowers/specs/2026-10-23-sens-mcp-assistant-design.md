# MCP assistant ("AI CFO") over Tailscale — design

**Date:** 2026-10-23
**Status:** Draft, awaiting review
**Builds on:** `2026-05-30-sens-desktop-finance-tracker-design.md` (service/repo layering),
`2026-10-21-ai-provider-fallback-design.md` (settings-card and secrets conventions).

## Goal

Let an AI agent on the user's cloud computer act as their CFO: read the whole Sens ledger and manage
it (record transactions, budgets, goals, schedules). The agent talks to Sens through an **MCP server
embedded in the desktop app**, reached privately over **Tailscale Serve**.

## Decisions

| Topic | Decision |
|---|---|
| Client | An MCP-speaking agent (Claude Code, Claude Desktop, custom) on a machine joined to the user's tailnet. No chat UI is built. |
| Authority | **Full read and write.** No approval queue. Guardrails below replace it. |
| Where it runs | Embedded in the Tauri app, one process, one DB connection. Unreachable while the app is closed. |
| Transport | MCP Streamable HTTP via the Rust `rmcp` SDK, bound to `127.0.0.1:<port>` only. |
| Exposure | `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. Tailnet-only. Funnel is out of scope. |
| Default | **Off.** Enabled from Settings → "Assistant (MCP)". |
| Tool shape | ~30 curated, agent-named tools, not a 1:1 dump of Tauri commands. |
| Business rules | Every tool calls `service.rs`. No SQL or rules in the MCP module. |

## Architecture

New module `src-tauri/src/mcp/`:

- `server.rs`: rmcp Streamable HTTP service on an axum listener; start/stop handle.
- `tools.rs`: tool definitions, argument structs, and the mapping to `service.rs` functions.
- `auth.rs`: bearer-token middleware.
- `audit.rs`: audit-log writer and rate limiter.

The server is started from Tauri `setup` (when enabled) on a background task and shares the app's
`DbState`. Toggling in Settings starts or stops it without an app restart.

Settings → "Assistant (MCP)" card: on/off switch, port, token generate/rotate (shown once), the
ready-to-copy `tailscale serve` command, and the recent-activity list.

New Tauri commands (Rust **and** mirrored as stubs in `src/client/mock.ts`):
`get_mcp_status`, `set_mcp_enabled`, `rotate_mcp_token`, `list_mcp_audit`. The MCP server itself is
Rust-only; the mock has no equivalent and never emits `data-changed`.

## Tool surface

**Read**

- `get_financial_overview`: net worth, current-month summary, upcoming bills, budget status, in one call.
- `list_accounts`, `get_account_balances`, `list_categories`
- `list_transactions` (filters), `get_dashboard_summary(month)`, `get_plan(month)`
- `list_schedules`, `list_upcoming`, `get_awaiting_reimbursement`

**Write**

- Transactions: create income, expense, transfer, payment, reimbursement; update; delete.
- `set_budgets`; goals create/update/delete.
- Schedules create/update/delete; `post_occurrence`, `skip_occurrence`.
- Accounts and categories create/update/archive/restore; `update_net_worth`; `set_account_balance`.

**Not exposed:** `reset_app`, `get_setting`/`set_setting`, all AI-provider commands, and photo import
(`ocr_image`, `extract_drafts`, draft commands). The agent has no image, and import would send data to
a third-party AI.

**Conventions**

- Money is integer MYR cents in and out (hard rule 1). Read results also include a formatted
  `"RM 12.34"` string so the agent need not do the arithmetic.
- Account and category arguments accept a UUID or a name. An ambiguous or missing name is a
  `ValidationError` / `NotFound`, never a guess.
- The backend generates UUIDs and timestamps (hard rule 5). Tools never accept them for creation.
- Errors are `AppError {code, message}`, identical to the UI's.

## Auth, audit and safety

- **Per request, before MCP parsing:** require `Authorization: Bearer <token>`; compare the SHA-256
  hash in constant time against the stored hash; require a loopback peer. Failure returns `401`.
- The `Tailscale-User-Login` header that Serve injects is recorded as the caller identity. It is
  informational, not a gate, because a local process could forge it; the token is the gate.
- Only the token's SHA-256 hash is stored (settings row). The token is shown once at generation.
  Neither the token nor request headers appear in logs or errors.
- **Audit:** migration **018** (append-only) adds `mcp_audit_log(id, at, tailscale_user, tool,
  args_json, ok, error_code)`. Every write tool records a row; reads are not logged. Settings shows
  the last 50 entries with a link to the affected transaction. No one-click undo in v1.
- **Rate limit:** 60 write calls per minute; excess returns `rate_limited` and is audited.

## UI sync

After each successful write the backend emits a `data-changed` Tauri event. A small client-layer
hook refetches the active screen. The app shell shows an "Agent active" indicator while the server is
running.

## Testing

- Rust unit tests: tool → service mapping, name resolution (ambiguous/missing), one audit row per
  write, rate limiter.
- Auth tests: no token, wrong token, rotated (old) token, non-loopback peer.
- One end-to-end test: start the server on an ephemeral port against an in-memory DB; call
  `tools/list` and one write through a real MCP client. No Tailscale needed.
- Mock tests for the four new settings commands.
- Manual: on the cloud machine, `claude mcp add --transport http sens https://<machine>.<tailnet>.ts.net/mcp`
  with the token header, then ask for the overview and log one expense.

## Docs to update with the code

`docs/architecture/mcp.md` (new), `docs/architecture/backend.md` (migration 018, new commands),
`CHANGELOG.md`, `ROADMAP.md`.

## Out of scope (v1)

Tailscale Funnel / public exposure, OAuth, multi-user access, MCP prompts or resources, one-click
undo, a headless mode that runs with the window closed, and a chat front-end.

## Risks

- **Full write with no approval.** A wrong inference or a leaked token can alter the books. Mitigated
  by tailnet-only reach, token auth, rate limit and the audit log; not eliminated. Revisit a propose-
  and-approve mode if this proves risky.
- **App must be open.** The CFO is offline when Sens is closed. Accepted for v1.
- **`rmcp` API churn.** Pin the version; the tool layer is thin so a swap is contained.
