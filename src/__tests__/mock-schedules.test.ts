import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../client";
import { mockOccurrences, setMockNow } from "../client/mock";
import type { ScheduleWrite } from "../types";

beforeEach(async () => {
  await client.resetApp();
  setMockNow(null);
});

function salary(accountId: string, categoryId: string): ScheduleWrite {
  return {
    mode: "auto",
    kind: "income",
    amountCents: 500_000,
    accountId,
    toAccountId: null,
    categoryId,
    description: "Salary",
    startDate: "2026-10-25",
    time: "09:00",
    frequency: "monthly",
    interval: 1,
    weekdays: [],
    monthMode: "each",
    monthDays: [25],
    ordinal: null,
    ordinalDay: null,
    months: [],
    dayOfMonth: null,
    endMode: "never",
    endCount: null,
    endDate: null,
  };
}

async function account(name: string) {
  return client.createAccount(name, "savings", 0, null);
}

async function categoryId(kind: "income" | "expense"): Promise<string> {
  const cats = await client.listCategories(kind);
  const cat = cats.find((row) => !row.isSystem && row.parentId == null);
  if (!cat) throw new Error(`No ${kind} category`);
  return cat.id;
}

describe("mock schedules", () => {
  it("auto-posts at 09:00 and a second pass posts nothing", async () => {
    setMockNow("2026-10-25T08:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    await client.createSchedule(salary(acc.id, cat));

    const early = await client.runSchedulePass();
    expect(early.posted).toEqual([]);
    expect(early.nextWakeAt).toBe("2026-10-25T09:00");
    expect(await client.listUpcoming()).toEqual([]);

    setMockNow("2026-10-25T09:00");
    const pass = await client.runSchedulePass();
    expect(pass.posted).toHaveLength(1);
    expect(pass.posted[0].transactionDate).toBe("2026-10-25");
    expect(pass.posted[0].transactionTime).toBe("09:00");
    expect(pass.posted[0].amountCents).toBe(500_000);
    expect(pass.nextWakeAt).toBe("2026-11-25T09:00");

    const again = await client.runSchedulePass();
    expect(again.posted).toEqual([]);
  });

  it("lists a tap occurrence, posts a changed amount, and keeps the date settled after delete", async () => {
    setMockNow("2026-10-25T09:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const saved = await client.createSchedule({ ...salary(acc.id, cat), mode: "tap" });

    expect((await client.runSchedulePass()).posted).toEqual([]);
    const upcoming = await client.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].occurrenceDate).toBe("2026-10-25");
    expect(upcoming[0].label).toBe("Salary");
    expect(upcoming[0].accountName).toBe("Salary");
    expect(upcoming[0].amountCents).toBe(500_000);

    const posted = await client.postScheduleOccurrence(saved.id, "2026-10-25", 125_000);
    expect(posted.amountCents).toBe(125_000);
    expect(posted.kind).toBe("income");
    expect((await client.listSchedules())[0].amountCents).toBe(500_000);

    await client.deleteTransaction(posted.id);
    expect(await client.listUpcoming()).toEqual([]);
    expect((await client.runSchedulePass()).posted).toEqual([]);
    await expect(client.postScheduleOccurrence(saved.id, "2026-10-25", 125_000)).rejects.toMatchObject({
      code: "ValidationError",
      message: "That date was already posted or skipped.",
    });
    const income = await client.listTransactions({ accountId: acc.id, kind: "income" });
    expect(income.some((row) => row.id === posted.id)).toBe(false);
  });

  it("posts three missed months oldest first", async () => {
    setMockNow("2025-12-01T12:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const input: ScheduleWrite = {
      ...salary(acc.id, cat),
      startDate: "2026-01-01",
      monthDays: [1],
      description: "Pay",
    };
    await client.createSchedule(input);

    setMockNow("2026-03-15T12:00");
    const pass = await client.runSchedulePass();
    expect(pass.posted.map((row) => row.transactionDate)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect((await client.runSchedulePass()).posted).toEqual([]);

    const rent = await client.createSchedule({ ...input, mode: "tap", description: "Rent" });
    for (const label of ["Alpha", "Beta"]) {
      await client.createSchedule({
        ...input,
        mode: "tap",
        description: label,
        startDate: "2026-03-01",
        frequency: "daily",
        monthMode: null,
        monthDays: [],
        endMode: "after",
        endCount: 1,
      });
    }
    const upcoming = (await client.listUpcoming()).filter((row) => row.scheduleId === rent.id || row.label === "Alpha" || row.label === "Beta" || row.label === "Rent");
    expect(upcoming.map((row) => row.occurrenceDate)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-03-01",
      "2026-03-01",
    ]);
    expect(upcoming.map((row) => row.label)).toEqual(["Rent", "Rent", "Alpha", "Beta", "Rent"]);
  });

  it("keeps a skipped date settled when the amount changes", async () => {
    setMockNow("2026-02-01T12:00");
    const acc = await account("Checking");
    const cat = await categoryId("expense");
    const input: ScheduleWrite = {
      ...salary(acc.id, cat),
      mode: "tap",
      kind: "expense",
      amountCents: 80_000,
      description: "Rent",
      startDate: "2026-03-01",
      monthDays: [1],
    };
    const saved = await client.createSchedule(input);

    setMockNow("2026-04-15T12:00");
    await client.skipScheduleOccurrence(saved.id, "2026-03-01");
    await client.updateSchedule(saved.id, { ...input, amountCents: 90_000 });

    const upcoming = (await client.listUpcoming()).filter((row) => row.scheduleId === saved.id);
    expect(upcoming.every((row) => row.occurrenceDate !== "2026-03-01")).toBe(true);
    expect(upcoming.find((row) => row.occurrenceDate === "2026-04-01")?.amountCents).toBe(90_000);
    const expenses = await client.listTransactions({ accountId: acc.id, kind: "expense" });
    expect(expenses.every((row) => row.transactionDate !== "2026-03-01")).toBe(true);
  });

  it("moves waiting dates from the 1st to the 5th and leaves a posted date alone", async () => {
    setMockNow("2026-02-01T12:00");
    const acc = await account("Checking");
    const cat = await categoryId("expense");
    const base: ScheduleWrite = {
      ...salary(acc.id, cat),
      mode: "tap",
      kind: "expense",
      amountCents: 80_000,
      description: "Waiting",
      startDate: "2026-03-01",
      monthDays: [1],
    };
    const waiting = await client.createSchedule(base);

    setMockNow("2026-04-15T12:00");
    await client.updateSchedule(waiting.id, { ...base, monthDays: [5] });
    const moved = (await client.listUpcoming())
      .filter((row) => row.scheduleId === waiting.id)
      .map((row) => row.occurrenceDate);
    expect(moved).toEqual(["2026-03-05", "2026-04-05"]);

    const postedInput: ScheduleWrite = { ...base, description: "Posted" };
    const postedSchedule = await client.createSchedule(postedInput);
    const posted = await client.postScheduleOccurrence(postedSchedule.id, "2026-03-01", 80_000);
    await client.updateSchedule(postedSchedule.id, { ...postedInput, monthDays: [5] });
    const still = (await client.listTransactions({ accountId: acc.id, kind: "expense" })).find((row) => row.id === posted.id);
    expect(still?.transactionDate).toBe("2026-03-01");
    expect(still?.amountCents).toBe(80_000);
    const added = (await client.listUpcoming())
      .filter((row) => row.scheduleId === postedSchedule.id)
      .map((row) => row.occurrenceDate);
    expect(added).toEqual(["2026-03-05", "2026-04-05"]);
  });

  it("blocks a post from an archived account and still allows a skip", async () => {
    setMockNow("2026-10-25T10:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const saved = await client.createSchedule({ ...salary(acc.id, cat), mode: "tap" });
    await client.archiveAccount(acc.id);

    const pass = await client.runSchedulePass();
    expect(pass.posted).toEqual([]);
    expect(pass.nextWakeAt).toBe("2026-11-25T09:00");
    const upcoming = await client.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].blockReason).toBe("The selected account is archived");
    expect((await client.listSchedules())[0].blockReason).toBe("The selected account is archived");

    await expect(client.postScheduleOccurrence(saved.id, "2026-10-25", 500_000)).rejects.toMatchObject({
      code: "Conflict",
      message: "The selected account is archived",
    });
    await client.skipScheduleOccurrence(saved.id, "2026-10-25");
    expect(await client.listUpcoming()).toEqual([]);
  });

  it("stores a time only while the time setting is on", async () => {
    setMockNow("2026-10-25T08:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    await expect(client.createSchedule({ ...salary(acc.id, cat), time: null })).rejects.toMatchObject({
      code: "ValidationError",
      message: "A time is required",
    });

    setMockNow("2026-10-24T12:00");
    const saved = await client.createSchedule(salary(acc.id, cat));
    expect(saved.time).toBe("09:00");

    await client.setSetting("transaction_time_enabled", "0");
    const other = await account("Other");
    setMockNow("2026-10-25T08:00");
    const stored = await client.createSchedule({ ...salary(other.id, cat), time: "09:00" });
    await client.runSchedulePass();
    expect(stored.time).toBeNull();
    const income = await client.listTransactions({ accountId: other.id, kind: "income" });
    expect(income).toHaveLength(1);
    expect(income[0].transactionDate).toBe("2026-10-25");
    expect(income[0].transactionTime).toBeNull();
  });

  it("keeps the posted transaction when the schedule is deleted", async () => {
    setMockNow("2025-12-01T12:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const saved = await client.createSchedule({
      ...salary(acc.id, cat),
      mode: "tap",
      startDate: "2026-01-01",
      monthDays: [1],
    });
    setMockNow("2026-03-15T12:00");
    const posted = await client.postScheduleOccurrence(saved.id, "2026-01-01", 500_000);
    expect(await client.listUpcoming()).toHaveLength(2);
    await client.deleteSchedule(saved.id);
    const income = await client.listTransactions({ accountId: acc.id, kind: "income" });
    expect(income.some((row) => row.id === posted.id)).toBe(true);
    expect(await client.listUpcoming()).toEqual([]);
    expect(await client.listSchedules()).toEqual([]);
  });

  it("moves 1000 sen from one account to the other when a transfer posts", async () => {
    setMockNow("2026-01-15T12:00");
    const from = await account("Checking");
    const to = await account("Savings");
    const cat = await categoryId("income");
    const beforeFrom = await client.getAccountBalance(from.id);
    const beforeTo = await client.getAccountBalance(to.id);
    await client.createSchedule({
      ...salary(from.id, cat),
      kind: "transfer",
      categoryId: null,
      toAccountId: to.id,
      amountCents: 1000,
      description: null,
      startDate: "2026-01-15",
      frequency: "daily",
      monthMode: null,
      monthDays: [],
      endMode: "after",
      endCount: 1,
    });
    await client.runSchedulePass();
    expect((await client.getAccountBalance(from.id)) - beforeFrom).toBe(-1000);
    expect((await client.getAccountBalance(to.id)) - beforeTo).toBe(1000);
  });

  it("rejects a future, off-schedule, or already settled date", async () => {
    setMockNow("2025-12-01T12:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const saved = await client.createSchedule({
      ...salary(acc.id, cat),
      mode: "tap",
      startDate: "2026-01-01",
      monthDays: [1],
    });
    setMockNow("2026-03-15T12:00");
    const notDue = { code: "ValidationError", message: "That date is not due." };
    const notOn = { code: "ValidationError", message: "That date is not on this schedule." };
    const settled = { code: "ValidationError", message: "That date was already posted or skipped." };
    await expect(client.postScheduleOccurrence(saved.id, "2026-04-01", 100)).rejects.toMatchObject(notDue);
    await expect(client.skipScheduleOccurrence(saved.id, "2026-04-01")).rejects.toMatchObject(notDue);
    await expect(client.postScheduleOccurrence(saved.id, "2026-03-02", 100)).rejects.toMatchObject(notOn);
    await expect(client.skipScheduleOccurrence(saved.id, "2026-03-02")).rejects.toMatchObject(notOn);
    await client.skipScheduleOccurrence(saved.id, "2026-03-01");
    await expect(client.postScheduleOccurrence(saved.id, "2026-03-01", 100)).rejects.toMatchObject(settled);
    await expect(client.skipScheduleOccurrence(saved.id, "2026-03-01")).rejects.toMatchObject(settled);
    await client.postScheduleOccurrence(saved.id, "2026-02-01", 100);
    await expect(client.postScheduleOccurrence(saved.id, "2026-02-01", 100)).rejects.toMatchObject(settled);
    await expect(client.skipScheduleOccurrence(saved.id, "2026-02-01")).rejects.toMatchObject(settled);
  });

  it("clears schedules on reset and leaves the time setting missing", async () => {
    setMockNow("2026-10-24T12:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    await client.createSchedule(salary(acc.id, cat));
    await client.resetApp();
    expect(await client.getSetting("transaction_time_enabled")).toBeNull();
    expect(await client.listSchedules()).toEqual([]);
    expect(await client.listUpcoming()).toEqual([]);
  });

  it("posts at 00:00 and does not block a schedule saved while times were off", async () => {
    setMockNow("2026-10-25T08:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    await client.setSetting("transaction_time_enabled", "0");
    const auto = await client.createSchedule(salary(acc.id, cat));
    await client.createSchedule({ ...salary(acc.id, cat), mode: "tap", description: "Tap" });
    expect(auto.time).toBeNull();
    await client.setSetting("transaction_time_enabled", "1");
    setMockNow("2026-10-25T12:00");
    const upcoming = await client.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].blockReason).toBeNull();
    expect(upcoming[0].time).toBe("00:00");
    const pass = await client.runSchedulePass();
    expect(pass.posted).toHaveLength(1);
    expect(pass.posted[0].transactionTime).toBe("00:00");
  });

  it("create and update write no transactions until the pass runs", async () => {
    setMockNow("2026-10-25T09:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const before = (await client.listTransactions({ accountId: acc.id })).length;
    const saved = await client.createSchedule(salary(acc.id, cat));
    await client.updateSchedule(saved.id, { ...salary(acc.id, cat), amountCents: 600_000 });
    expect((await client.listTransactions({ accountId: acc.id })).length).toBe(before);
    expect(mockOccurrences()).toEqual([]);
    expect((await client.runSchedulePass()).posted).toHaveLength(1);
  });

  it("keeps a posted occurrence with a null transaction id after the transaction is deleted", async () => {
    setMockNow("2026-10-25T09:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    const saved = await client.createSchedule({ ...salary(acc.id, cat), mode: "tap" });
    const posted = await client.postScheduleOccurrence(saved.id, "2026-10-25", 125_000);
    expect(mockOccurrences()).toEqual([
      { scheduleId: saved.id, occurrenceDate: "2026-10-25", status: "posted", transactionId: posted.id },
    ]);
    await client.deleteTransaction(posted.id);
    expect(mockOccurrences()).toEqual([
      { scheduleId: saved.id, occurrenceDate: "2026-10-25", status: "posted", transactionId: null },
    ]);
  });

  it("rejects a bad time and a bad end count even when times are off", async () => {
    setMockNow("2026-10-25T09:00");
    const acc = await account("Salary");
    const cat = await categoryId("income");
    await client.setSetting("transaction_time_enabled", "0");
    await expect(client.createSchedule({ ...salary(acc.id, cat), time: "9am" })).rejects.toMatchObject({
      message: "Time must be in HH:MM 24-hour format",
    });
    await expect(
      client.createSchedule({ ...salary(acc.id, cat), endMode: "after", endCount: 1.5 }),
    ).rejects.toMatchObject({ message: "End count must be at least 1." });
  });
});
