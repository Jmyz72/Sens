// Calendar dates for a repeat rule. Weeks start on Monday.
// Date.UTC is only a day counter so a local timezone cannot shift the day.

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";
export type MonthMode = "each" | "onThe";
export type Ordinal = "first" | "second" | "third" | "fourth" | "fifth" | "last";
export type End =
  | { mode: "never" }
  | { mode: "after"; count: number }
  | { mode: "on"; date: string };

export interface Rule {
  start: string;
  frequency: Frequency;
  interval: number;
  weekdays: string[];
  monthMode: MonthMode;
  monthDays: number[];
  ordinal: Ordinal;
  ordinalDay: string;
  months: number[];
  dayOfMonth: number;
  end: End;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

interface Series {
  out: string[];
  after: string | null;
  time: string;
  found: string | null;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ORDINALS_BEFORE_LAST: Record<Exclude<Ordinal, "last">, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
};

/** Dates from the anchor through `through`, inclusive, in calendar order. */
export function datesThrough(rule: Rule, through: string): string[] {
  if (rule.interval < 1) return [];
  const start = parseYmd(rule.start);
  const last = parseYmd(through);
  if (!start || !last || cmp(last, start) < 0) return [];
  if (rule.end.mode === "after" && rule.end.count < 1) return [];
  const series = emptySeries(null, "00:00");
  walk(rule, last, series);
  return series.out;
}

/**
 * The next `YYYY-MM-DDTHH:MM` strictly after `after`.
 * Walks until the next real occurrence. A month with no date does not stop the walk.
 * Returns null when the end rule has no later date. `time` null means 00:00.
 */
export function nextDue(rule: Rule, after: string, time: string | null): string | null {
  if (rule.interval < 1) return null;
  if (!parseYmd(rule.start)) return null;
  if (rule.end.mode === "after" && rule.end.count < 1) return null;
  let through: Ymd | null = null;
  if (rule.end.mode === "on") {
    through = parseYmd(rule.end.date);
    if (!through) return null;
  }
  const stamp = normalizeStamp(after);
  if (!stamp) return null;
  const series = emptySeries(stamp, normalizeTime(time));
  walk(rule, through, series);
  return series.found;
}

/** The first reason the schedule form cannot store this rule, or null when it can. */
export function validateRule(rule: Rule): string | null {
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999) {
    return "Repeat interval must be from 1 to 999.";
  }
  if (rule.end.mode === "after" && rule.end.count < 1) {
    return "End count must be at least 1.";
  }
  if (rule.end.mode === "on") {
    const start = parseYmd(rule.start);
    const end = parseYmd(rule.end.date);
    if (start && end && cmp(end, start) < 0) {
      return "End date must be on or after the first date.";
    }
  }
  switch (rule.frequency) {
    case "daily":
      return null;
    case "weekly":
      return weekdayOffsets(rule.weekdays).length > 0 ? null : "Pick at least one weekday.";
    case "monthly":
      return rule.monthMode === "each" ? validateMonthDays(rule.monthDays) : validateOrdinalDay(rule.ordinalDay);
    case "yearly": {
      const months = validateMonths(rule.months);
      if (months) return months;
      return rule.monthMode === "each" ? validateDayOfMonth(rule.dayOfMonth) : validateOrdinalDay(rule.ordinalDay);
    }
  }
}

/** Readable phrase for the repeat rule, such as "Every month on the 5th". */
export function ruleSummary(rule: Rule): string {
  switch (rule.frequency) {
    case "daily":
      return every(rule.interval, "day", "days");
    case "weekly":
      return withOn(every(rule.interval, "week", "weeks"), weekdayLabels(rule.weekdays));
    case "monthly":
      return monthlySummary(rule);
    case "yearly":
      return yearlySummary(rule);
  }
}

function emptySeries(after: string | null, time: string): Series {
  return { out: [], after, time, found: null };
}

/** An empty weekday, day, or month list never emits a date. Stop instead of walking the calendar. */
function patternCanMatch(rule: Rule): boolean {
  switch (rule.frequency) {
    case "daily":
      return true;
    case "weekly":
      return weekdayOffsets(rule.weekdays).length > 0;
    case "monthly":
      if (rule.monthMode === "each") return uniqueInRange(rule.monthDays, 1, 31).length > 0;
      return validateOrdinalDay(rule.ordinalDay) === null;
    case "yearly":
      if (uniqueInRange(rule.months, 1, 12).length === 0) return false;
      if (rule.monthMode === "each") return rule.dayOfMonth >= 1 && rule.dayOfMonth <= 31;
      return validateOrdinalDay(rule.ordinalDay) === null;
  }
}

function walk(rule: Rule, through: Ymd | null, series: Series): void {
  if (!patternCanMatch(rule)) return;
  switch (rule.frequency) {
    case "daily":
      pushDaily(rule, through, series);
      break;
    case "weekly":
      pushWeekly(rule, through, series);
      break;
    case "monthly":
      pushMonthly(rule, through, series);
      break;
    case "yearly":
      pushYearly(rule, through, series);
      break;
  }
}

/** True means stop: past the window, the end count is full, or the next datetime is found. */
function record(series: Series, rule: Rule, through: Ymd | null, date: Ymd): boolean {
  const start = parseYmd(rule.start);
  if (!start || cmp(date, start) < 0) return false;
  if (through && cmp(date, through) > 0) return true;
  if (rule.end.mode === "on") {
    const end = parseYmd(rule.end.date);
    if (!end || cmp(date, end) > 0) return true;
  }
  if (series.after !== null) {
    const due = `${fmt(date)}T${series.time}`;
    if (due > series.after) {
      series.found = due;
      return true;
    }
  }
  series.out.push(fmt(date));
  return rule.end.mode === "after" && series.out.length >= rule.end.count;
}

function pushDaily(rule: Rule, through: Ymd | null, series: Series): void {
  let date = parseYmd(rule.start);
  while (date) {
    if (record(series, rule, through, date)) return;
    date = addDays(date, rule.interval);
  }
}

function pushWeekly(rule: Rule, through: Ymd | null, series: Series): void {
  const start = parseYmd(rule.start);
  if (!start) return;
  let monday = weekMonday(start);
  const offsets = weekdayOffsets(rule.weekdays);
  const step = rule.interval * 7;
  while (monday) {
    if (pastBound(monday, through, rule)) return;
    for (const offset of offsets) {
      const date = addDays(monday, offset);
      if (!date) return;
      if (record(series, rule, through, date)) return;
    }
    monday = addDays(monday, step);
  }
}

function pushMonthly(rule: Rule, through: Ymd | null, series: Series): void {
  const start = parseYmd(rule.start);
  if (!start) return;
  let monthStart: Ymd | null = { y: start.y, m: start.m, d: 1 };
  while (monthStart) {
    if (pastBound(monthStart, through, rule)) return;
    for (const date of monthDates(monthStart, rule)) {
      if (record(series, rule, through, date)) return;
    }
    monthStart = addMonths(monthStart, rule.interval);
  }
}

function pushYearly(rule: Rule, through: Ymd | null, series: Series): void {
  const start = parseYmd(rule.start);
  if (!start) return;
  let year = start.y;
  while (year <= 275760) {
    const jan1: Ymd = { y: year, m: 1, d: 1 };
    if (pastBound(jan1, through, rule)) return;
    for (const date of yearDates(year, rule)) {
      if (record(series, rule, through, date)) return;
    }
    const next = year + rule.interval;
    if (!Number.isSafeInteger(next) || next > 275760) return;
    year = next;
  }
}

function pastBound(date: Ymd, through: Ymd | null, rule: Rule): boolean {
  if (through && cmp(date, through) > 0) return true;
  if (rule.end.mode !== "on") return false;
  const end = parseYmd(rule.end.date);
  return !end || cmp(date, end) > 0;
}

function monthDates(monthStart: Ymd, rule: Rule): Ymd[] {
  if (rule.monthMode === "onThe") {
    const date = ordinalInMonth(monthStart, rule.ordinal, rule.ordinalDay);
    return date ? [date] : [];
  }
  return uniqueInRange(rule.monthDays, 1, 31).flatMap((day) => {
    const date = dayInMonth(monthStart, day);
    return date ? [date] : [];
  });
}

function yearDates(year: number, rule: Rule): Ymd[] {
  const dates: Ymd[] = [];
  for (const month of uniqueInRange(rule.months, 1, 12)) {
    const monthStart: Ymd = { y: year, m: month, d: 1 };
    const date = rule.monthMode === "each"
      ? dayInMonth(monthStart, rule.dayOfMonth)
      : ordinalInMonth(monthStart, rule.ordinal, rule.ordinalDay);
    if (date) dates.push(date);
  }
  return dates;
}

function dayInMonth(monthStart: Ymd, day: number): Ymd | null {
  if (day < 1 || day > 31) return null;
  if (day > daysInMonth(monthStart.y, monthStart.m)) return null;
  return { y: monthStart.y, m: monthStart.m, d: day };
}

function ordinalInMonth(monthStart: Ymd, ordinal: Ordinal, day: string): Ymd | null {
  const hits: Ymd[] = [];
  const dim = daysInMonth(monthStart.y, monthStart.m);
  for (let d = 1; d <= dim; d++) {
    const date = { y: monthStart.y, m: monthStart.m, d };
    if (isOrdinalDay(date, day)) hits.push(date);
  }
  if (ordinal === "last") return hits.length === 0 ? null : hits[hits.length - 1];
  return hits[ORDINALS_BEFORE_LAST[ordinal]] ?? null;
}

function isOrdinalDay(date: Ymd, day: string): boolean {
  const index = mondayIndex(date);
  if (day === "weekday") return index <= 4;
  if (day === "weekend") return index >= 5;
  const wanted = weekdayOffset(day);
  return wanted !== null && wanted === index;
}

function weekMonday(date: Ymd): Ymd | null {
  return addDays(date, -mondayIndex(date));
}

function weekdayOffsets(names: string[]): number[] {
  return uniqueInRange(
    names.flatMap((name) => {
      const offset = weekdayOffset(name);
      return offset === null ? [] : [offset];
    }),
    0,
    6,
  );
}

function weekdayOffset(name: string): number | null {
  const index = WEEKDAYS.findIndex((day) => day === name);
  return index < 0 ? null : index;
}

function mondayIndex(date: Ymd): number {
  const day = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
  return (day + 6) % 7;
}

function validateMonthDays(days: number[]): string | null {
  return days.some((day) => day >= 1 && day <= 31) ? null : "Pick at least one day of the month.";
}

function validateMonths(months: number[]): string | null {
  return months.some((month) => month >= 1 && month <= 12) ? null : "Pick at least one month.";
}

function validateDayOfMonth(day: number): string | null {
  return day >= 1 && day <= 31 ? null : "Pick at least one day of the month.";
}

function validateOrdinalDay(day: string): string | null {
  if (day === "weekday" || day === "weekend" || weekdayOffset(day) !== null) return null;
  return "Pick at least one weekday.";
}

function monthlySummary(rule: Rule): string {
  const base = every(rule.interval, "month", "months");
  if (rule.monthMode === "onThe") {
    return `${base} on the ${rule.ordinal} ${ordinalDayLabel(rule.ordinalDay)}`;
  }
  const days = uniqueInRange(rule.monthDays, 1, 31).map(daySuffix);
  return days.length === 0 ? base : `${base} on the ${joinAnd(days)}`;
}

function yearlySummary(rule: Rule): string {
  const base = every(rule.interval, "year", "years");
  const months = uniqueInRange(rule.months, 1, 12);
  if (rule.monthMode === "onThe") {
    const phrase = `the ${rule.ordinal} ${ordinalDayLabel(rule.ordinalDay)}`;
    const names = months.map(monthLabel);
    return names.length === 0 ? `${base} on ${phrase}` : `${base} on ${phrase} of ${joinAnd(names)}`;
  }
  const parts = months.map((month) => `${rule.dayOfMonth} ${monthLabel(month)}`);
  return parts.length === 0 ? base : `${base} on ${joinAnd(parts)}`;
}

function withOn(base: string, parts: string[]): string {
  return parts.length === 0 ? base : `${base} on ${joinAnd(parts)}`;
}

function every(interval: number, singular: string, plural: string): string {
  return interval === 1 ? `Every ${singular}` : `Every ${interval} ${plural}`;
}

function weekdayLabels(names: string[]): string[] {
  return weekdayOffsets(names).map((offset) => WEEKDAY_LABELS[offset]);
}

function ordinalDayLabel(day: string): string {
  if (day === "weekday" || day === "weekend") return day;
  const offset = weekdayOffset(day);
  return offset === null ? day : WEEKDAY_LABELS[offset];
}

function monthLabel(month: number): string {
  return MONTH_LABELS[month - 1] ?? "";
}

function daySuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function uniqueInRange(values: number[], min: number, max: number): number[] {
  const kept = values.filter((value) => value >= min && value <= max);
  kept.sort((a, b) => a - b);
  return kept.filter((value, index) => index === 0 || value !== kept[index - 1]);
}

function normalizeTime(time: string | null): string {
  if (time === null) return "00:00";
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return "00:00";
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return "00:00";
  return `${pad(hh)}:${pad(mm)}`;
}

function normalizeStamp(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hh = Number(match[2]);
  const mm = Number(match[3]);
  if (hh > 23 || mm > 59) return null;
  return `${match[1]}T${pad(hh)}:${pad(mm)}`;
}

function parseYmd(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function fmt(date: Ymd): string {
  return `${pad(date.y, 4)}-${pad(date.m)}-${pad(date.d)}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function cmp(a: Ymd, b: Ymd): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

function addDays(date: Ymd, days: number): Ymd | null {
  const ms = Date.UTC(date.y, date.m - 1, date.d + days);
  if (!Number.isFinite(ms)) return null;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  if (!Number.isFinite(y)) return null;
  return { y, m, d };
}

function addMonths(date: Ymd, months: number): Ymd | null {
  const idx = date.y * 12 + (date.m - 1) + months;
  if (!Number.isSafeInteger(idx)) return null;
  const y = Math.floor(idx / 12);
  const m = idx % 12;
  if (y < 1 || y > 275760 || m < 0) return null;
  return { y, m: m + 1, d: 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
