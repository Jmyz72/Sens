import { describe, expect, it } from "vitest";
import {
  datesThrough,
  nextDue,
  ruleSummary,
  validateRule,
  type End,
  type Rule,
} from "../recurrence";

function ruleDaily(start: string, interval: number, end: End = { mode: "never" }): Rule {
  return {
    start,
    frequency: "daily",
    interval,
    weekdays: [],
    monthMode: "each",
    monthDays: [],
    ordinal: "first",
    ordinalDay: "weekday",
    months: [],
    dayOfMonth: 1,
    end,
  };
}

describe("datesThrough", () => {
  it("daily every day and every second day", () => {
    const every = datesThrough(ruleDaily("2026-10-01", 1), "2026-10-05");
    expect(every).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    const step = datesThrough(ruleDaily("2026-10-01", 2), "2026-10-05");
    expect(step).toEqual(["2026-10-01", "2026-10-03", "2026-10-05"]);
  });

  it("daily end on is inclusive and after counts dates", () => {
    const on = datesThrough(ruleDaily("2026-10-01", 1, { mode: "on", date: "2026-10-03" }), "2026-12-01");
    expect(on).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const after = datesThrough(ruleDaily("2026-10-01", 1, { mode: "after", count: 3 }), "2026-12-01");
    expect(after).toHaveLength(3);
  });

  it("weekly friday and every second week on two days", () => {
    const fri: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "weekly", weekdays: ["fri"] };
    expect(datesThrough(fri, "2026-10-16")).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);

    const both: Rule = {
      ...ruleDaily("2026-10-02", 2),
      frequency: "weekly",
      weekdays: ["mon", "fri"],
    };
    expect(datesThrough(both, "2026-10-20")).toEqual(["2026-10-02", "2026-10-12", "2026-10-16"]);

    const later: Rule = { ...ruleDaily("2026-10-07", 1), frequency: "weekly", weekdays: ["mon"] };
    expect(datesThrough(later, "2026-10-20")).toEqual(["2026-10-12", "2026-10-19"]);
  });

  it("monthly skips missing days and anchors to the start month", () => {
    const thirtyFirst: Rule = {
      ...ruleDaily("2026-01-01", 1),
      frequency: "monthly",
      monthMode: "each",
      monthDays: [31],
    };
    expect(datesThrough(thirtyFirst, "2026-04-30")).toEqual(["2026-01-31", "2026-03-31"]);

    const fifth: Rule = {
      ...ruleDaily("2026-10-15", 2),
      frequency: "monthly",
      monthDays: [5],
    };
    expect(datesThrough(fifth, "2027-02-28")).toEqual(["2026-12-05", "2027-02-05"]);
  });

  it("monthly on the fifth friday, first weekday, and last weekend", () => {
    const fifth: Rule = {
      ...ruleDaily("2026-01-01", 1),
      frequency: "monthly",
      monthMode: "onThe",
      ordinal: "fifth",
      ordinalDay: "fri",
    };
    expect(datesThrough(fifth, "2026-05-31")).toEqual(["2026-01-30", "2026-05-29"]);

    const first: Rule = {
      ...ruleDaily("2026-10-01", 1),
      frequency: "monthly",
      monthMode: "onThe",
      ordinal: "first",
      ordinalDay: "weekday",
    };
    expect(datesThrough(first, "2026-11-30")).toEqual(["2026-10-01", "2026-11-02"]);

    const last: Rule = {
      ...ruleDaily("2026-09-01", 1),
      frequency: "monthly",
      monthMode: "onThe",
      ordinal: "last",
      ordinalDay: "weekend",
    };
    expect(datesThrough(last, "2026-10-31")).toEqual(["2026-09-27", "2026-10-31"]);
  });

  it("yearly on 2 october", () => {
    const year: Rule = {
      ...ruleDaily("2026-10-02", 1),
      frequency: "yearly",
      monthMode: "each",
      months: [10],
      dayOfMonth: 2,
    };
    expect(datesThrough(year, "2028-10-02")).toEqual(["2026-10-02", "2027-10-02", "2028-10-02"]);
  });
});

describe("validateRule", () => {
  it("rejects empty patterns and a bad end", () => {
    const weekly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "weekly" };
    expect(validateRule(weekly)).toBe("Pick at least one weekday.");

    const monthly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "monthly", monthDays: [] };
    expect(validateRule(monthly)).toBe("Pick at least one day of the month.");

    const yearly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "yearly", months: [] };
    expect(validateRule(yearly)).toBe("Pick at least one month.");

    expect(validateRule(ruleDaily("2026-10-02", 0))).toBe("Repeat interval must be from 1 to 999.");
    expect(validateRule(ruleDaily("2026-10-02", 1000))).toBe("Repeat interval must be from 1 to 999.");
    expect(validateRule(ruleDaily("2026-10-02", 1, { mode: "on", date: "2026-10-01" }))).toBe(
      "End date must be on or after the first date.",
    );
    expect(validateRule(ruleDaily("2026-10-02", 1, { mode: "after", count: 0 }))).toBe(
      "End count must be at least 1.",
    );
    expect(validateRule(ruleDaily("2026-10-02", 1))).toBeNull();
  });

  it("rejects a bad end count, any bad list token, and a yearly day no month has", () => {
    const bad = "End count must be at least 1.";
    expect(validateRule(ruleDaily("2026-10-02", 1, { mode: "after", count: 1.5 }))).toBe(bad);
    expect(validateRule(ruleDaily("2026-10-02", 1, { mode: "after", count: 2 ** 31 }))).toBe(bad);
    expect(validateRule(ruleDaily("2026-10-02", 1, { mode: "after", count: 3 }))).toBeNull();

    const weekly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "weekly", weekdays: ["mon", "funday"] };
    expect(validateRule(weekly)).toBe("Pick at least one weekday.");
    const monthly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "monthly", monthDays: [5, 32] };
    expect(validateRule(monthly)).toBe("Pick at least one day of the month.");
    expect(validateRule({ ...monthly, monthDays: [5, 0] })).toBe("Pick at least one day of the month.");
    const yearly: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "yearly", months: [10, 13], dayOfMonth: 2 };
    expect(validateRule(yearly)).toBe("Pick at least one month.");

    const feb30: Rule = { ...ruleDaily("2026-10-02", 1), frequency: "yearly", months: [2], dayOfMonth: 30 };
    expect(validateRule(feb30)).toBe("Pick at least one day of the month.");
    expect(validateRule({ ...feb30, months: [2, 4] })).toBeNull();
    expect(validateRule({ ...feb30, months: [2], dayOfMonth: 29 })).toBeNull();
  });

  it("nextDue returns null for a time that does not parse", () => {
    const rule = ruleDaily("2026-10-01", 1);
    expect(nextDue(rule, "2026-10-01T08:00", "9am")).toBeNull();
    expect(nextDue(rule, "2026-10-01T08:00", "09:00")).toBe("2026-10-01T09:00");
    expect(nextDue(rule, "2026-10-01T08:00", null)).toBe("2026-10-02T00:00");
  });
});

describe("nextDue", () => {
  it("waits for the time then moves to the next date", () => {
    const rule = ruleDaily("2026-10-01", 1);
    expect(nextDue(rule, "2026-10-25T08:00", "09:00")).toBe("2026-10-25T09:00");
    expect(nextDue(rule, "2026-10-25T09:00", "09:00")).toBe("2026-10-26T09:00");
    expect(nextDue(rule, "2026-10-01T00:00", null)).toBe("2026-10-02T00:00");
  });

  it("walks past empty periods until a real date or the end", () => {
    const monthEnd: Rule = {
      ...ruleDaily("2026-01-01", 1),
      frequency: "monthly",
      monthMode: "each",
      monthDays: [31],
    };
    expect(nextDue(monthEnd, "2026-01-31T09:00", "09:00")).toBe("2026-03-31T09:00");

    const fifth: Rule = {
      ...ruleDaily("2026-01-01", 1),
      frequency: "monthly",
      monthMode: "onThe",
      ordinal: "fifth",
      ordinalDay: "fri",
    };
    expect(nextDue(fifth, "2026-01-30T09:00", "09:00")).toBe("2026-05-29T09:00");

    const once = ruleDaily("2026-10-01", 1, { mode: "after", count: 1 });
    expect(nextDue(once, "2026-10-01T09:00", "09:00")).toBeNull();
  });
});

describe("ruleSummary", () => {
  it("uses the monthly, weekly, and daily phrases", () => {
    const monthly: Rule = {
      ...ruleDaily("2026-10-05", 1),
      frequency: "monthly",
      monthMode: "each",
      monthDays: [5],
    };
    expect(ruleSummary(monthly)).toBe("Every month on the 5th");

    const weekdays: Rule = {
      ...ruleDaily("2026-10-02", 1),
      frequency: "weekly",
      weekdays: ["mon", "fri"],
    };
    expect(ruleSummary(weekdays)).toBe("Every week on Monday and Friday");

    const fortnight: Rule = {
      ...ruleDaily("2026-10-02", 2),
      frequency: "weekly",
      weekdays: ["fri"],
    };
    expect(ruleSummary(fortnight)).toBe("Every 2 weeks on Friday");

    expect(ruleSummary(ruleDaily("2026-10-01", 1))).toBe("Every day");
  });

  it("uses the same shape for yearly", () => {
    const each: Rule = {
      ...ruleDaily("2026-10-02", 1),
      frequency: "yearly",
      monthMode: "each",
      months: [10],
      dayOfMonth: 2,
    };
    expect(ruleSummary(each)).toBe("Every year on 2 October");

    const onThe: Rule = {
      ...ruleDaily("2026-10-02", 1),
      frequency: "yearly",
      monthMode: "onThe",
      ordinal: "first",
      ordinalDay: "fri",
      months: [10],
    };
    expect(ruleSummary(onThe)).toBe("Every year on the first Friday of October");
  });
});
