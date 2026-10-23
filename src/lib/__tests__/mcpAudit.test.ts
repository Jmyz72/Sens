import { describe, expect, it } from "vitest";
import { summarizeAudit } from "../mcpAudit";
import { fmtMoney } from "../format";
import type { McpAuditEntry } from "../../types";

const entry = (argsJson: string): McpAuditEntry => ({
  id: "row-1",
  at: "2026-10-24T10:00:00Z",
  tailscaleUser: null,
  tool: "create_expense",
  argsJson,
  ok: true,
  errorCode: null,
});

describe("summarizeAudit", () => {
  it("summarizes the informative fields and formats cents as RM", () => {
    const s = summarizeAudit(entry(JSON.stringify({
      affectedId: "0f3c9a1e-1111-2222-3333-444455556666",
      args: { accountId: "Maybank", amountCents: 1250, date: "2026-10-23", description: "Nasi lemak", time: "12:00" },
    })));
    expect(s.summary).toBe(`description: Nasi lemak, amountCents: ${fmtMoney(1250, { cents: true })}, date: 2026-10-23, accountId: Maybank, time: 12:00`);
    expect(s.affectedId).toBe("0f3c9a1e-1111-2222-3333-444455556666");
    expect(s.affectedShort).toBe("0f3c9a1e");
  });

  it("shows negative cents with a sign, null as cleared and lists as counts", () => {
    const s = summarizeAudit(entry(JSON.stringify({
      affectedId: null,
      args: { realBalanceCents: -2500, description: null, splits: [{}, {}], id: "tx-9" },
    })));
    expect(s.summary).toBe(`description: cleared, realBalanceCents: -${fmtMoney(2500, { cents: true })}, splits: 2 items`);
    expect(s.affectedId).toBeNull();
    expect(s.affectedShort).toBeNull();
  });

  it("truncates the summary to 120 characters", () => {
    const s = summarizeAudit(entry(JSON.stringify({ affectedId: "abc", args: { description: "x".repeat(300) } })));
    expect(s.summary.length).toBe(120);
    expect(s.summary.endsWith("…")).toBe(true);
    expect(s.affectedShort).toBe("abc");
  });

  it("survives malformed JSON", () => {
    const s = summarizeAudit(entry("{not json"));
    expect(s.summary).toBe("(arguments unreadable)");
    expect(s.affectedId).toBeNull();
  });

  it("recovers the affected id from a truncated value", () => {
    const full = JSON.stringify({ affectedId: "tx-12345678-abcd", args: { description: "y".repeat(9000) } });
    const cut = full.slice(0, 8000) + "...[truncated]";
    const s = summarizeAudit(entry(cut));
    expect(s.summary).toBe("(arguments truncated)");
    expect(s.affectedId).toBe("tx-12345678-abcd");
    expect(s.affectedShort).toBe("tx-12345");
  });

  it("handles a non-object args payload", () => {
    expect(summarizeAudit(entry("null")).summary).toBe("");
    expect(summarizeAudit(entry(JSON.stringify({ affectedId: 5, args: 3 }))).affectedId).toBeNull();
  });
});
