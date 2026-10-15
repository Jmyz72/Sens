import { describe, expect, it } from "vitest";
import {
  initialScheduleTime,
  patternAfterFirstDate,
  presetPattern,
  type SchedulePattern,
} from "../scheduleForm";

function blank(): SchedulePattern {
  return {
    frequency: "monthly",
    interval: 1,
    weekdays: [],
    monthMode: "each",
    monthDays: [],
    ordinal: "first",
    ordinalDay: "weekday",
    months: [],
    dayOfMonth: 1,
  };
}

describe("initialScheduleTime", () => {
  it("starts a new schedule at the current minute and a null saved time at midnight", () => {
    expect(initialScheduleTime(undefined, "09:41")).toBe("09:41");
    expect(initialScheduleTime(null, "09:41")).toBe("00:00");
    expect(initialScheduleTime("08:15", "09:41")).toBe("08:15");
  });
});

describe("patternAfterFirstDate", () => {
  it("refills a new schedule's preset from the first date and leaves a saved or custom pattern", () => {
    const monthly = presetPattern("monthly", "2026-10-15", blank());
    expect(monthly.monthDays).toEqual([15]);
    expect(presetPattern("weekly", "2026-10-15", blank()).weekdays).toEqual(["thu"]);
    expect(presetPattern("yearly", "2026-10-15", blank())).toMatchObject({ months: [10], dayOfMonth: 15 });

    const moved = patternAfterFirstDate(false, "monthly", "2026-10-01", monthly);
    expect(moved.monthDays).toEqual([1]);
    expect(moved.frequency).toBe("monthly");

    const weekly = patternAfterFirstDate(false, "weekly", "2026-10-04", presetPattern("weekly", "2026-10-15", blank()));
    expect(weekly.weekdays).toEqual(["sun"]);

    const yearly = patternAfterFirstDate(false, "yearly", "2026-01-15", presetPattern("yearly", "2026-10-15", blank()));
    expect(yearly.months).toEqual([1]);
    expect(yearly.dayOfMonth).toBe(15);

    const daily = patternAfterFirstDate(false, "daily", "2026-10-01", { ...monthly, frequency: "daily" });
    expect(daily.frequency).toBe("daily");
    expect(daily.interval).toBe(1);

    expect(patternAfterFirstDate(false, "custom", "2026-10-01", monthly)).toEqual(monthly);
    expect(patternAfterFirstDate(true, "monthly", "2026-10-01", monthly)).toEqual(monthly);
  });
});
