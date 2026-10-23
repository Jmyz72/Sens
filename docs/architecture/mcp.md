# MCP assistant (agent access over Tailscale)

An opt-in MCP server embedded in the desktop app. An AI agent you trust (for example one on your cloud
machine) can read your ledger and manage it through 37 tools, reached privately over Tailscale Serve.
Read this before adding or changing an agent tool, the auth layers, or the audit log.

Spec: `docs/superpowers/specs/2026-10-23-sens-mcp-assistant-design.md`.

**Key files:** `src-tauri/src/mcp/{mod,server,auth,audit,resolve,tools,tools_manage}.rs` ·
`src-tauri/src/commands.rs` (four `*_mcp_*` commands) · `src-tauri/src/db/migrations.rs` (018) ·
`src/screens/Settings.tsx` (`AssistantCard`) · `src/lib/dataChanged.ts` · `src/App.tsx` (live refresh)

## Contents

- [Architecture and request flow](#architecture-and-request-flow)
- [Tools](#tools)
- [Auth and caller identity](#auth-and-caller-identity)
- [Audit log and rate limit](#audit-log-and-rate-limit)
- [UI sync](#ui-sync)
- [Settings and commands](#settings-and-commands)
- [Setup with Tailscale](#setup-with-tailscale)
- [Limitations](#limitations)
- [Before you change this](#before-you-change-this)

## Architecture and request flow

Off by default. Turn it on in Settings → Assistant. The server binds **`127.0.0.1` only** (default port
`8765`, setting `mcp_port`) and speaks MCP **Streamable HTTP** at the path `/mcp` (stateful sessions:
`initialize`, then the `Mcp-Session-Id` header). It is never exposed directly; the user publishes it to
their tailnet with `tailscale serve`, which forwards to loopback.

```
agent ──(tailnet, HTTPS 443)──▶ tailscale serve ──▶ 127.0.0.1:<port>/mcp
  1. require_token         Authorization: Bearer <token>, loopback peer, else empty 401
  2. require_allowed_host  Host: localhost / 127.0.0.1 / [::1] / *.ts.net, else empty 403
  3. rmcp StreamableHttpService  (mcp/server.rs, SensHandler)
       → tools::call (mcp/tools.rs, tools_manage.rs)
         → service.rs  (ALL business rules)  → repo.rs (ALL SQL)
```

Middleware order is token auth first, then the Host check, then the MCP service, so an unauthenticated
caller only ever learns `401`. The MCP tools are a thin layer over `service.rs`: they do not run SQL and
do not restate business rules. The server shares the app's single SQLite connection (`DbState`) behind
its mutex.

`McpHandle` (`mcp/mod.rs`, Tauri managed state) owns the running server, the live token hash and the last
start error. `apply` starts or stops the server to match the settings and is idempotent. A bind failure
(for example the port is in use) shows up as `error` in the status; the app keeps running.

## Tools

37 tools, defined in `tools.rs` (reads, transactions) and `tools_manage.rs` (budgets, goals, schedules,
accounts, categories). Each is a read or a write; the write flag drives the audit log and rate limit.

- **Read (10):** `get_financial_overview`, `list_accounts`, `get_account_balances`, `list_categories`,
  `list_transactions` (`toDate` is inclusive), `get_dashboard_summary`, `get_plan`, `list_schedules`,
  `list_upcoming`, `get_awaiting_reimbursement`.
- **Transactions (8 writes):** `create_income`, `create_expense`, `create_transfer`, `create_payment`,
  `create_reimbursement`, `update_transaction`, `delete_transaction`, `set_expected_reimbursement`.
- **Budgets and goals (4 writes):** `set_budgets`, `create_goal`, `update_goal`, `delete_goal`.
- **Schedules (5 writes):** `create_schedule`, `update_schedule`, `delete_schedule`, `post_occurrence`,
  `skip_occurrence`.
- **Accounts (6 writes):** `create_account`, `update_account`, `archive_account`, `restore_account`,
  `set_account_balance`, `update_net_worth`.
- **Categories (4 writes):** `create_category`, `update_category`, `archive_category`, `restore_category`.

**Never exposed:** `reset_app`, settings (`get_setting` / `set_setting` and the `mcp_` keys), the AI
provider commands, and photo import (OCR, drafts). The test `definitions_exclude_forbidden_tools`
guards the tool list.

Conventions the tools follow:

- Money is **integer MYR cents** in and out. Results carry `...Formatted` siblings so the agent does not
  format money itself.
- Account and category arguments accept a **UUID or a name** (`resolve.rs`). An ambiguous name is an
  error, never a guess.
- Errors are the app's `AppError` codes in the tool result. Argument mistakes become `ValidationError`
  with plain-word messages.

## Auth and caller identity

- **Token:** 32 random bytes, 64 hex chars, shown **once** after Settings → Assistant → Generate/Rotate.
  Only its **SHA-256 hash** is stored (`mcp_token_hash`); it is compared in constant time against the
  live hash held in memory. An empty hash never verifies. Rotating swaps the live hash immediately, so
  the old token stops working at once without restarting the server. `get_setting` / `set_setting`
  reject every `mcp_` key.
- **Loopback peer:** `require_token` also rejects any non-loopback peer. This is not a DNS-rebinding
  defense, because rebinding requests and all Tailscale Serve traffic arrive from loopback; the token is
  the real control.
- **Host allow-list:** `localhost`, `127.0.0.1`, `[::1]` and `*.ts.net`, each with an optional port.
  rmcp's own allow-list is disabled because it only knows loopback names and Tailscale Serve forwards the
  tailnet hostname. This layer is defense in depth.
- **Caller identity:** Tailscale Serve adds `Tailscale-User-Login` for user devices; that value is the
  audit identity (truncated to 256 chars). **Tagged devices** (for example `tag:grokbot`) send no user
  header and are audited as the label `tagged device`.
- **Tailscale ACL (yours to configure):** the outer lock is an ACL grant from the agent's tag to this
  machine on port 443 only, set in the Tailscale admin console. Sens cannot set it. Do not leave the
  default allow-all rule in place.

## Audit log and rate limit

- Migration **018** creates `mcp_audit_log` (`id`, `at`, `tailscale_user`, `tool`, `args_json`, `ok`,
  `error_code`; index on `at`). There is **one row per write call**, including failed and rate-limited
  ones, and **none for reads**. Tool args are stored; the token never is.
- The audit row is written after the write commits. It is **not atomic** with the write: a crash in
  between loses the row. An audit-write failure does not turn a committed write into an error (the client
  would retry and duplicate it).
- **Rate limit:** 60 write calls per minute, a fixed window shared by all sessions of one running server.
  The 61st returns `AppError::RateLimited` (code `rate_limited`) and is itself audited. Reads are not
  limited.
- **Panic safety:** a panic inside a tool is caught and returned as a `DatabaseError`; any open
  transaction is rolled back and the shared connection's mutex is un-poisoned so the desktop UI keeps
  working.
- **Factory reset** (`McpHandle::reset_with`) wipes the data and the audit table, stops the server,
  disables the feature and clears the token.

## UI sync

After every successful agent write the server calls its `on_write` hook, which emits the Tauri event
`data-changed`. `src/lib/dataChanged.ts` (`onDataChanged`) subscribes to it; `App.tsx` debounces about
250 ms (trailing) and reloads, so a burst of writes causes one reload. The sidebar also listens. The
browser mock never emits it. Settings → Assistant changes fire a window event
(`notifyMcpStatusChanged`) so the sidebar status refreshes.

## Settings and commands

Settings keys: `mcp_enabled` (`"1"`/`"0"`), `mcp_port` (default `8765`; a missing, garbage or
out-of-range value means the default), `mcp_token_hash`.

Tauri commands (stubbed in `mock.ts`; the server itself is Rust-only and never runs in the browser):

| Command | Does |
|---|---|
| `get_mcp_status` | `{ enabled, port, running, hasToken, error }` |
| `set_mcp_enabled` | Saves enabled (and an optional port), then starts or stops the server. Enabling without a token is a `ValidationError` ("Generate a token first."); port 0 is rejected |
| `rotate_mcp_token` | Returns a new plaintext token once; the old one stops working at once |
| `list_mcp_audit` | The audit rows, newest first |

## Setup with Tailscale

1. In Sens: Settings → Assistant → generate a token (copy it now; it is not shown again), then turn the
   assistant on.
2. In a terminal on the same machine, run the command the card shows:
   `tailscale serve --bg --https=443 http://127.0.0.1:<port>`
3. In the Tailscale admin console, add a grant that lets only the agent's tag (or device) reach this
   machine on port 443. Remove any allow-all rule.
4. On the agent's machine, register the server:
   `claude mcp add --transport http sens https://<machine>.<tailnet>.ts.net/mcp --header "Authorization: Bearer <token>"`
5. Ask the agent for the overview, then log one expense. The row should appear in the app without a
   manual refresh, and in the Assistant card's audit list.

## Limitations

- **App must be open.** The server lives inside the desktop app; the agent is offline when Sens is closed.
- **Full write access, no approval step.** A wrong inference or a leaked token can change the books. The
  mitigations are tailnet-only reach, the token, the rate limit and the audit log. They reduce the risk;
  they do not remove it.
- **Not verified end to end here.** The tests drive the server over real HTTP on loopback with an rmcp
  client. A live Tailscale Serve setup and a real third-party connector (for example Grokbot) have not
  been verified in this repo. The real Tauri `data-changed` event path is unit-tested only.
- The audit row can be lost on a crash between the write and the audit insert (see above).

## Before you change this

- A new tool goes through `service.rs`. Mark it as a write in its definition so it is audited and rate
  limited, and update the tool count and lists here. The mock only stubs the four commands, so there is
  nothing to mirror there.
- Never register `reset_app`, settings, AI provider commands or photo import as tools.
- Keep the middleware order (token, Host, MCP) and the rule that the token is stored only as a hash.
- Changing the audit table is a new append-only migration after 018.
