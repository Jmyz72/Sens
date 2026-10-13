/** Blank slice field → unset (null on save). Valid amounts include 0. Non-blank garbage → invalid. */
export type SliceBudgetFieldParse =
  | { kind: "unset" }
  | { kind: "amount"; cents: number }
  | { kind: "invalid" };

export function parseSliceBudgetField(input: string): SliceBudgetFieldParse {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "unset" };
  const cleaned = trimmed.replace(/[^0-9.]/g, "");
  if (cleaned === "") return { kind: "invalid" };
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid" };
  return { kind: "amount", cents: Math.round(n * 100) };
}
