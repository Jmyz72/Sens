import type { ScheduleFrequency, ScheduleMonthMode, ScheduleOrdinal } from "../types";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export interface SchedulePattern {
  frequency: ScheduleFrequency;
  interval: number;
  weekdays: string[];
  monthMode: ScheduleMonthMode;
  monthDays: number[];
  ordinal: ScheduleOrdinal;
  ordinalDay: string;
  months: number[];
  dayOfMonth: number;
}

interface DateParts {
  day: number;
  month: number;
  weekday: string;
}

export function partsOf(iso: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const js = date.getDay();
  return { day, month, weekday: WEEKDAYS[js === 0 ? 6 : js - 1] };
}

export function presetPattern(frequency: ScheduleFrequency, start: string, current: SchedulePattern): SchedulePattern {
  const parts = partsOf(start);
  const next: SchedulePattern = { ...current, frequency, interval: 1 };
  if (!parts) return next;
  if (frequency === "weekly") return { ...next, weekdays: [parts.weekday] };
  if (frequency === "monthly") return { ...next, monthMode: "each", monthDays: [parts.day] };
  if (frequency === "yearly") return { ...next, monthMode: "each", months: [parts.month], dayOfMonth: parts.day };
  return next;
}

/** Time field for the schedule form. `undefined` is a new schedule; a saved null time is midnight. */
export function initialScheduleTime(stored: string | null | undefined, now: string): string {
  if (stored === undefined) return now;
  return stored ?? "00:00";
}

/** First-date edits refill a new schedule's preset. A saved schedule and Custom keep the pattern. */
export function patternAfterFirstDate(
  editing: boolean,
  repeat: ScheduleFrequency | "custom",
  start: string,
  pattern: SchedulePattern,
): SchedulePattern {
  if (editing || repeat === "custom") return pattern;
  return presetPattern(repeat, start, pattern);
}
