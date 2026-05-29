import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fmtMoney,
  parseAmountToCents,
  fmtDate,
  shiftMonth,
  fmtMonth,
  currentMonth,
  todayISO,
} from "../lib/format";

// ── fmtMoney ─────────────────────────────────────────────────────────────────
// Intl.NumberFormat("en-MY") emits a non-breaking space (U+00A0) between
// "RM" and the number. We use the explicit escape so tests don't silently
// contain invisible whitespace characters.

const NBSP = " "; // non-breaking space used by en-MY locale

describe("fmtMoney", () => {
  it("formats 123456 cents with cents option", () => {
    expect(fmtMoney(123456, { cents: true })).toBe(`RM${NBSP}1,234.56`);
  });

  it("formats 123456 cents without cents option (rounds 1234.56 → 1235)", () => {
    expect(fmtMoney(123456)).toBe(`RM${NBSP}1,235`);
  });

  it("formats negative input using absolute value (sign is handled elsewhere)", () => {
    expect(fmtMoney(-123456, { cents: true })).toBe(`RM${NBSP}1,234.56`);
    expect(fmtMoney(-123456)).toBe(`RM${NBSP}1,235`);
  });

  it("formats 0 with cents option → RM 0.00", () => {
    expect(fmtMoney(0, { cents: true })).toBe(`RM${NBSP}0.00`);
  });

  it("formats 0 without cents option → RM 0", () => {
    expect(fmtMoney(0)).toBe(`RM${NBSP}0`);
  });

  it("formats 99 cents with cents option → RM 0.99", () => {
    expect(fmtMoney(99, { cents: true })).toBe(`RM${NBSP}0.99`);
  });

  it("formats 99 cents without cents option (rounds 0.99 → 1)", () => {
    expect(fmtMoney(99)).toBe(`RM${NBSP}1`);
  });

  it("output always starts with 'RM'", () => {
    expect(fmtMoney(100000, { cents: true })).toMatch(/^RM/);
    expect(fmtMoney(100000)).toMatch(/^RM/);
  });
});

// ── parseAmountToCents ────────────────────────────────────────────────────────

describe("parseAmountToCents", () => {
  it("parses '1,234.56' → 123456", () => {
    expect(parseAmountToCents("1,234.56")).toBe(123456);
  });

  it("parses '10' → 1000", () => {
    expect(parseAmountToCents("10")).toBe(1000);
  });

  it("parses '10.999' → 1100 (Math.round(10.999 * 100) = Math.round(1099.9) = 1100)", () => {
    expect(parseAmountToCents("10.999")).toBe(1100);
  });

  it("parses '' → null (empty string)", () => {
    expect(parseAmountToCents("")).toBeNull();
  });

  it("parses 'abc' → null (only letters, no digits remain after cleaning)", () => {
    expect(parseAmountToCents("abc")).toBeNull();
  });

  it("parses '0' → null (n <= 0, not a valid positive amount)", () => {
    expect(parseAmountToCents("0")).toBeNull();
  });

  it("parses '-5' → 500 (minus sign stripped by regex, leaving '5' → 500)", () => {
    // The regex replaces all non-digit/non-dot characters, so '-' is stripped.
    // "-5" → cleaned "5" → 500 (NOT null, despite being entered as negative).
    expect(parseAmountToCents("-5")).toBe(500);
  });
});

// ── fmtDate ───────────────────────────────────────────────────────────────────

describe("fmtDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for the current date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(fmtDate("2026-05-30")).toBe("Today");
  });

  it("returns 'Yesterday' for one day ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(fmtDate("2026-05-29")).toBe("Yesterday");
  });

  it("returns 'Tomorrow' for one day ahead", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(fmtDate("2026-05-31")).toBe("Tomorrow");
  });

  it("returns short date without year for same-year date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    // en-MY locale: day numeric + month short, no year
    expect(fmtDate("2026-05-20")).toBe("20 May");
  });

  it("returns short date with year for a prior-year date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(fmtDate("2025-05-20")).toBe("20 May 2025");
  });

  it("returns short date with year for January 1 of a prior year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(fmtDate("2025-01-01")).toBe("1 Jan 2025");
  });
});

// ── shiftMonth / fmtMonth / currentMonth / todayISO ──────────────────────────

describe("shiftMonth", () => {
  it("wraps December +1 → January of the next year", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("wraps January -1 → December of the prior year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("shifts forward within a year", () => {
    expect(shiftMonth("2026-05", 3)).toBe("2026-08");
  });

  it("shifts backward within a year", () => {
    expect(shiftMonth("2026-05", -2)).toBe("2026-03");
  });
});

describe("fmtMonth", () => {
  it("contains 'May' and '2026' for '2026-05'", () => {
    const result = fmtMonth("2026-05");
    expect(result).toContain("May");
    expect(result).toContain("2026");
  });

  it("contains 'December' and '2025' for '2025-12'", () => {
    const result = fmtMonth("2025-12");
    expect(result).toContain("December");
    expect(result).toContain("2025");
  });
});

describe("currentMonth and todayISO with faked time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("currentMonth() returns 'YYYY-MM' matching the faked date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(currentMonth()).toBe("2026-05");
  });

  it("todayISO() returns 'YYYY-MM-DD' matching the faked date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00"));
    expect(todayISO()).toBe("2026-05-30");
  });
});
