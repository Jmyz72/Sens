// One-line summary of an MCP audit row for the Assistant card.
import type { McpAuditEntry } from "../types";
import { fmtMoney } from "./format";

export interface AuditSummary {
  /** Compact `key: value` list of the most informative args, at most 120 chars. */
  summary: string;
  /** The row the call touched (or the id the caller sent), if any. */
  affectedId: string | null;
  /** First 8 chars of `affectedId`. */
  affectedShort: string | null;
}

const MAX_SUMMARY = 120;
const TRUNCATION_MARKER = "...[truncated]";
// Shown first, in this order; other scalar fields follow, then list counts.
const PRIORITY = [
  "description", "name",
  "amountCents", "targetCents", "realBalanceCents", "balanceCents", "expectedCents",
  "openingBalanceCents", "creditLimitCents",
  "date", "transactionDate", "startDate", "targetDate",
  "kind", "mode", "frequency",
  "accountId", "fromAccountId", "toAccountId", "categoryId",
];
// Shown separately as the affected id.
const SKIP = new Set(["id"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scalar(key: string, v: unknown): string | null {
  if (v === null) return "cleared";
  if (typeof v === "number") {
    if (key.endsWith("Cents") && Number.isInteger(v)) return `${v < 0 ? "-" : ""}${fmtMoney(v, { cents: true })}`;
    return String(v);
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return null;
}

function clip(s: string): string {
  return s.length <= MAX_SUMMARY ? s : `${s.slice(0, MAX_SUMMARY - 1)}…`;
}

function summarizeArgs(args: unknown): string {
  if (!isObject(args)) return "";
  const keys = Object.keys(args).filter((k) => !SKIP.has(k));
  const ordered = [
    ...PRIORITY.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PRIORITY.includes(k)),
  ];
  const parts: string[] = [];
  for (const k of ordered) {
    const s = scalar(k, args[k]);
    if (s !== null) parts.push(`${k}: ${s}`);
  }
  for (const k of ordered) {
    const v = args[k];
    if (Array.isArray(v)) parts.push(`${k}: ${v.length} ${v.length === 1 ? "item" : "items"}`);
  }
  return parts.join(", ");
}

function withShort(summary: string, affectedId: string | null): AuditSummary {
  return { summary: clip(summary), affectedId, affectedShort: affectedId ? affectedId.slice(0, 8) : null };
}

export function summarizeAudit(entry: McpAuditEntry): AuditSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.argsJson);
  } catch {
    // A cut value is not valid JSON, but `affectedId` sorts before `args`, so
    // it usually survives the cut.
    const truncated = entry.argsJson.endsWith(TRUNCATION_MARKER);
    const m = truncated ? /^\{"affectedId":"((?:[^"\\]|\\.)*)"/.exec(entry.argsJson) : null;
    return withShort(truncated ? "(arguments truncated)" : "(arguments unreadable)", m ? m[1] : null);
  }
  if (!isObject(parsed)) return withShort("", null);
  const affectedId = typeof parsed.affectedId === "string" ? parsed.affectedId : null;
  return withShort(summarizeArgs("args" in parsed ? parsed.args : parsed), affectedId);
}
