// MYR + date formatting. Money is always integer cents at the boundary.

const myr0 = new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR", maximumFractionDigits: 0 });
const myr2 = new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Format cents as MYR. `cents: true` shows sen (2 decimals). */
export function fmtMoney(cents: number, opts: { cents?: boolean } = {}): string {
  const v = Math.abs(cents) / 100;
  return (opts.cents ? myr2 : myr0).format(v);
}

/** Parse a user-typed amount string ("1,234.56") into integer cents. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** Format a `YYYY-MM-DD` date as a friendly relative/short label. */
export function fmtDate(iso: string): string {
  const today = new Date();
  const t = new Date(iso + "T00:00:00");
  const days = Math.round((startOfDay(today).getTime() - startOfDay(t).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days === -1) return "Tomorrow";
  return t.toLocaleDateString("en-MY", { day: "numeric", month: "short", ...(t.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Group label for a date, used for the transactions list headers. */
export function dateGroupLabel(iso: string): string {
  return fmtDate(iso);
}

/** Current month as `YYYY-MM` in local time. */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Human label for a `YYYY-MM` month. */
export function fmtMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-MY", { month: "long", year: "numeric" });
}

/** Shift a `YYYY-MM` month by a delta. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a 24-hour "HH:MM" string as 12-hour "h:mm am/pm". "" for null/blank. */
export function fmtTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  if (Number.isNaN(h)) return "";
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}

/** Current local time as a 24-hour "HH:MM" string. */
export function nowTimeHHMM(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
