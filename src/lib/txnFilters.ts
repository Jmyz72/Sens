// src/lib/txnFilters.ts
// Maps a date-range preset to listTransactions params. toDate is ALWAYS an
// exclusive upper bound (the backend + mock filter with transactionDate < toDate).

export type DateRangePreset = "thisMonth" | "lastMonth" | "all" | "custom";

export interface DateRange {
  fromDate?: string;
  toDate?: string; // exclusive
}

export interface CustomRange {
  fromDate?: string;
  toDateInclusive?: string;
}

/** "YYYY-MM-DD" + 1 calendar day, in UTC to avoid TZ drift. */
export function nextDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function monthOf(iso: string): string {
  return iso.slice(0, 7); // "YYYY-MM"
}

function firstOfNextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

function firstOfPrevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-01`;
}

export function rangeForPreset(preset: DateRangePreset, today: string, custom?: CustomRange): DateRange {
  if (preset === "all") return {};
  if (preset === "custom") {
    const out: DateRange = {};
    if (custom?.fromDate) out.fromDate = custom.fromDate;
    if (custom?.toDateInclusive) out.toDate = nextDay(custom.toDateInclusive);
    return out;
  }
  const month = monthOf(today);
  if (preset === "thisMonth") {
    return { fromDate: `${month}-01`, toDate: firstOfNextMonth(month) };
  }
  // lastMonth
  return { fromDate: firstOfPrevMonth(month), toDate: `${month}-01` };
}
