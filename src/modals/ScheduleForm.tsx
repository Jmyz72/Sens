// Add or edit a schedule. Presets fill the repeat from the first date.
// Custom edits the pattern and leaves that date where it is.

import { useMemo, useState, type ReactNode } from "react";
import type { Account, Category, Schedule, ScheduleEndMode, ScheduleFrequency, ScheduleKind, ScheduleMonthMode, ScheduleOrdinal, ScheduleWrite } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { nowTimeHHMM, parseAmountToCents, todayISO } from "../lib/format";
import { KIND_META, kindColor } from "../lib/kinds";
import { isPaymentSource, movementKind } from "../lib/payments";
import { appendMissingSelection, categoryPickerItems } from "../lib/categories";
import { useTimeSetting } from "../lib/useTimeSetting";
import { ruleSummary, validateRule, type End, type Rule } from "../lib/recurrence";

const KINDS: ScheduleKind[] = ["expense", "income", "transfer", "payment"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDINALS: ScheduleOrdinal[] = ["first", "second", "third", "fourth", "fifth", "last"];
const ORDINAL_DAYS: [string, string][] = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
  ["weekday", "Weekday"], ["weekend", "Weekend day"],
];
const REPEAT: { id: ScheduleFrequency | "custom"; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week" },
  { id: "monthly", label: "Every month" },
  { id: "yearly", label: "Every year" },
  { id: "custom", label: "Custom" },
];

interface Pattern {
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

function partsOf(iso: string): DateParts | null {
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

function presetPattern(frequency: ScheduleFrequency, start: string, current: Pattern): Pattern {
  const parts = partsOf(start);
  const next: Pattern = { ...current, frequency, interval: 1 };
  if (!parts) return next;
  if (frequency === "weekly") return { ...next, weekdays: [parts.weekday] };
  if (frequency === "monthly") return { ...next, monthMode: "each", monthDays: [parts.day] };
  if (frequency === "yearly") return { ...next, monthMode: "each", months: [parts.month], dayOfMonth: parts.day };
  return next;
}

function patternFrom(schedule: Schedule): Pattern {
  return {
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: [...schedule.weekdays],
    monthMode: schedule.monthMode === "onThe" ? "onThe" : "each",
    monthDays: [...schedule.monthDays],
    ordinal: schedule.ordinal ?? "first",
    ordinalDay: schedule.ordinalDay ?? "weekday",
    months: [...schedule.months],
    dayOfMonth: schedule.dayOfMonth ?? partsOf(schedule.startDate)?.day ?? 1,
  };
}

function repeatChoice(schedule: Schedule): ScheduleFrequency | "custom" {
  if (schedule.interval !== 1) return "custom";
  const parts = partsOf(schedule.startDate);
  if (!parts) return "custom";
  if (schedule.frequency === "daily") return "daily";
  if (schedule.frequency === "weekly") {
    return schedule.weekdays.length === 1 && schedule.weekdays[0] === parts.weekday ? "weekly" : "custom";
  }
  if (schedule.frequency === "monthly") {
    const simple = schedule.monthMode !== "onThe" && schedule.monthDays.length === 1 && schedule.monthDays[0] === parts.day;
    return simple ? "monthly" : "custom";
  }
  const simple = schedule.monthMode !== "onThe" && schedule.months.length === 1 && schedule.months[0] === parts.month && schedule.dayOfMonth === parts.day;
  return simple ? "yearly" : "custom";
}

export function ruleFromSchedule(schedule: Schedule): Rule {
  const end: End = schedule.endMode === "after"
    ? { mode: "after", count: schedule.endCount ?? 0 }
    : schedule.endMode === "on"
      ? { mode: "on", date: schedule.endDate ?? "" }
      : { mode: "never" };
  return {
    start: schedule.startDate,
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.weekdays,
    monthMode: schedule.monthMode === "onThe" ? "onThe" : "each",
    monthDays: schedule.monthDays,
    ordinal: schedule.ordinal ?? "first",
    ordinalDay: schedule.ordinalDay ?? "weekday",
    months: schedule.months,
    dayOfMonth: schedule.dayOfMonth ?? 1,
    end,
  };
}

function toggleNumber(list: number[], value: number): number[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  next.sort((a, b) => a - b);
  return next;
}

function toggleWeekday(list: string[], day: string): string[] {
  const next = list.includes(day) ? list.filter((item) => item !== day) : [...list, day];
  return WEEKDAYS.filter((item) => next.includes(item));
}

export function ScheduleForm({ accounts, categories, schedule, onClose, onSaved }: {
  accounts: Account[];
  categories: Category[];
  schedule?: Schedule;
  onClose: () => void;
  onSaved: (write: () => Promise<void>) => Promise<void>;
}) {
  const t = useTheme();
  const [timeEnabled] = useTimeSetting();
  const active = accounts.filter((account) => !account.isArchived);
  const initialStart = schedule?.startDate ?? todayISO();
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? "expense");
  const [amount, setAmount] = useState(schedule ? (schedule.amountCents / 100).toFixed(2) : "");
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [mode, setMode] = useState(schedule?.mode ?? "tap");
  const [startDate, setStartDate] = useState(initialStart);
  const [repeat, setRepeat] = useState<ScheduleFrequency | "custom">(schedule ? repeatChoice(schedule) : "monthly");
  const [pattern, setPattern] = useState<Pattern>(() => schedule ? patternFrom(schedule) : presetPattern("monthly", initialStart, {
    frequency: "monthly", interval: 1, weekdays: [], monthMode: "each", monthDays: [], ordinal: "first", ordinalDay: "weekday", months: [], dayOfMonth: 1,
  }));
  const [endMode, setEndMode] = useState<ScheduleEndMode>(schedule?.endMode ?? "never");
  const [endCount, setEndCount] = useState(schedule?.endCount ?? 1);
  const [endDate, setEndDate] = useState(schedule?.endDate ?? initialStart);
  const [time, setTime] = useState(schedule?.time ?? nowTimeHHMM());
  const [accountId, setAccountId] = useState(schedule?.accountId ?? active[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(schedule?.toAccountId ?? "");
  const [categoryId, setCategoryId] = useState(
    schedule?.categoryId ?? categoryPickerItems(categories, schedule?.kind === "income" ? "income" : "expense")[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catKind = kind === "income" ? "income" : "expense";
  const pickerItems = useMemo(
    () => appendMissingSelection(categoryPickerItems(categories, catKind), categories, categoryId),
    [categories, catKind, categoryId],
  );
  const accent = kindColor(t, kind);
  const sel = { ...inputStyle(t), appearance: "none" as const, cursor: "pointer" };
  const movement = kind === "transfer" || kind === "payment";

  const end: End = endMode === "after"
    ? { mode: "after", count: endCount }
    : endMode === "on"
      ? { mode: "on", date: endDate }
      : { mode: "never" };
  const rule: Rule = {
    start: startDate,
    frequency: pattern.frequency,
    interval: pattern.interval,
    weekdays: pattern.frequency === "weekly" ? pattern.weekdays : [],
    monthMode: pattern.monthMode,
    monthDays: pattern.frequency === "monthly" && pattern.monthMode === "each" ? pattern.monthDays : [],
    ordinal: pattern.ordinal,
    ordinalDay: pattern.ordinalDay,
    months: pattern.frequency === "yearly" ? pattern.months : [],
    dayOfMonth: pattern.dayOfMonth,
    end,
  };
  const summary = ruleSummary(rule);
  const ruleError = validateRule(rule);

  function chooseRepeat(next: ScheduleFrequency | "custom") {
    setRepeat(next);
    if (next === "custom") return;
    setPattern((current) => presetPattern(next, startDate, current));
  }

  function chooseKind(next: ScheduleKind) {
    setKind(next);
    if (next === "income" || next === "expense") {
      const items = categoryPickerItems(categories, next);
      setCategoryId((current) => items.some((item) => item.id === current) ? current : (items[0]?.id ?? ""));
      return;
    }
    setToAccountId((current) => {
      const dest = accounts.find((account) => account.id === current);
      const ok = dest && !dest.isArchived && dest.id !== accountId && (next === "payment" ? movementKind(dest.subtype) === "payment" : movementKind(dest.subtype) === "transfer");
      if (ok) return current;
      const found = active.find((account) => account.id !== accountId && (next === "payment" ? movementKind(account.subtype) === "payment" : movementKind(account.subtype) === "transfer"));
      return found?.id ?? "";
    });
    if (next === "payment") {
      setAccountId((current) => {
        const source = accounts.find((account) => account.id === current);
        if (source && !source.isArchived && isPaymentSource(source.subtype)) return current;
        return active.find((account) => isPaymentSource(account.subtype))?.id ?? "";
      });
    }
  }

  function chooseEnd(next: ScheduleEndMode) {
    setEndMode(next);
    if (next === "on" && !endDate) setEndDate(startDate);
    if (next === "after" && endCount < 1) setEndCount(1);
  }

  async function save() {
    const cents = parseAmountToCents(amount);
    if (cents == null) {
      setError("Enter an amount.");
      return;
    }
    const input: ScheduleWrite = {
      mode,
      kind,
      amountCents: cents,
      accountId,
      toAccountId: movement ? toAccountId || null : null,
      categoryId: movement ? null : categoryId || null,
      description: description.trim() || null,
      startDate,
      time: timeEnabled ? time : null,
      frequency: rule.frequency,
      interval: rule.interval,
      weekdays: rule.weekdays,
      monthMode: rule.frequency === "monthly" || rule.frequency === "yearly" ? rule.monthMode : null,
      monthDays: rule.monthDays,
      ordinal: (rule.frequency === "monthly" || rule.frequency === "yearly") && rule.monthMode === "onThe" ? rule.ordinal : null,
      ordinalDay: (rule.frequency === "monthly" || rule.frequency === "yearly") && rule.monthMode === "onThe" ? rule.ordinalDay : null,
      months: rule.months,
      dayOfMonth: rule.frequency === "yearly" && rule.monthMode === "each" ? rule.dayOfMonth : null,
      endMode,
      endCount: endMode === "after" ? endCount : null,
      endDate: endMode === "on" ? endDate : null,
    };
    setBusy(true);
    setError(null);
    try {
      await onSaved(async () => {
        if (schedule) await client.updateSchedule(schedule.id, input);
        else await client.createSchedule(input);
      });
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't save the schedule");
      setBusy(false);
    }
  }

  const sources = (kind === "payment" ? active.filter((account) => isPaymentSource(account.subtype)) : active);
  const destinations = active.filter((account) => account.id !== accountId && (kind === "payment" ? movementKind(account.subtype) === "payment" : movementKind(account.subtype) === "transfer"));
  const sourceOptions = withMissing(sources, accountId, accounts);
  const destOptions = withMissing(destinations, toAccountId, accounts);

  return (
    <Modal onClose={onClose} width={480}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{schedule ? "Edit schedule" : "Add schedule"}</span>
        <button type="button" className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 4, background: t.panel2, borderRadius: 9, padding: 3 }}>
          {KINDS.map((item) => {
            const on = item === kind;
            const col = kindColor(t, item);
            return (
              <button key={item} type="button" className="sens-btn" onClick={() => chooseKind(item)}
                style={{ flex: 1, height: 32, justifyContent: "center", borderRadius: 7, fontSize: 12, fontWeight: 600, color: on ? t.onAccent : t.dim, background: on ? col : "transparent" }}>
                <Icon name={KIND_META[item].icon} size={14} color={on ? t.onAccent : t.dim} stroke={2} />
                {KIND_META[item].label}
              </button>
            );
          })}
        </div>

        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 14, top: 14, fontSize: 16, color: t.faint, fontFamily: t.mono }}>RM</span>
          <input className="sens-input" aria-label="Amount" value={amount} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            style={{ ...inputStyle(t), height: 50, fontSize: 24, fontWeight: 700, fontFamily: t.mono, paddingLeft: 44, color: accent }} />
        </div>

        <input className="sens-input" aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)" style={inputStyle(t)} />

        {movement ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <Field label="From">
              <select className="sens-input" aria-label="From" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {sourceOptions.map((account) => <option key={account.id} value={account.id} style={{ background: t.panel2 }}>{accountLabel(account)}</option>)}
              </select>
            </Field>
            <div style={{ paddingBottom: 9, color: t.faint }}><Icon name="chevronRight" size={16} color={t.faint} /></div>
            <Field label="To">
              <select className="sens-input" aria-label="To" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} style={sel}>
                {destOptions.map((account) => <option key={account.id} value={account.id} style={{ background: t.panel2 }}>{accountLabel(account)}</option>)}
              </select>
            </Field>
          </div>
        ) : (
          <>
            <Field label="Account">
              <select className="sens-input" aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {sourceOptions.map((account) => <option key={account.id} value={account.id} style={{ background: t.panel2 }}>{accountLabel(account)}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select className="sens-input" aria-label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={sel}>
                <option value="" style={{ background: t.panel2 }}>Select a category</option>
                {pickerItems.map((item) => (
                  <option key={item.id} value={item.id} style={{ background: t.panel2 }}>{item.depth === 1 ? `  ${item.label}` : item.label}</option>
                ))}
              </select>
            </Field>
          </>
        )}

        <div style={{ display: "flex", gap: 4, background: t.panel2, borderRadius: 9, padding: 3 }}>
          {(["tap", "auto"] as const).map((item) => {
            const on = mode === item;
            return (
              <button key={item} type="button" className="sens-btn" onClick={() => setMode(item)}
                style={{ flex: 1, height: 32, justifyContent: "center", borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: on ? t.onAccent : t.dim, background: on ? t.accent : "transparent" }}>
                {item === "tap" ? "Tap to post" : "Auto"}
              </button>
            );
          })}
        </div>

        <Field label="First date">
          <input className="sens-input" aria-label="First date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle(t)} />
        </Field>

        <div>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 6, fontWeight: 500 }}>Repeat</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {REPEAT.map((item) => (
              <Chip key={item.id} on={repeat === item.id} onClick={() => chooseRepeat(item.id)}>{item.label}</Chip>
            ))}
          </div>
        </div>

        {repeat === "custom" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Interval">
                <input className="sens-input" aria-label="Interval" type="number" min={1} max={999} value={pattern.interval}
                  onChange={(e) => setPattern((current) => ({ ...current, interval: Number(e.target.value) }))}
                  style={inputStyle(t)} />
              </Field>
              <Field label="Frequency">
                <select className="sens-input" aria-label="Frequency" value={pattern.frequency}
                  onChange={(e) => setPattern((current) => ({ ...current, frequency: e.target.value as ScheduleFrequency }))}
                  style={sel}>
                  <option value="daily" style={{ background: t.panel2 }}>Daily</option>
                  <option value="weekly" style={{ background: t.panel2 }}>Weekly</option>
                  <option value="monthly" style={{ background: t.panel2 }}>Monthly</option>
                  <option value="yearly" style={{ background: t.panel2 }}>Yearly</option>
                </select>
              </Field>
            </div>
            {pattern.frequency === "weekly" && (
              <ToggleRow label="On">
                {WEEKDAYS.map((day, index) => (
                  <Chip key={day} on={pattern.weekdays.includes(day)} onClick={() => setPattern((current) => ({ ...current, weekdays: toggleWeekday(current.weekdays, day) }))}>{WEEKDAY_LABELS[index]}</Chip>
                ))}
              </ToggleRow>
            )}
            {(pattern.frequency === "monthly" || pattern.frequency === "yearly") && (
              <div style={{ display: "flex", gap: 6 }}>
                <Chip on={pattern.monthMode === "each"} onClick={() => setPattern((current) => ({ ...current, monthMode: "each" }))}>Each</Chip>
                <Chip on={pattern.monthMode === "onThe"} onClick={() => setPattern((current) => ({ ...current, monthMode: "onThe" }))}>On the</Chip>
              </div>
            )}
            {pattern.frequency === "monthly" && pattern.monthMode === "each" && (
              <ToggleRow label="Days">
                {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                  <Chip key={day} on={pattern.monthDays.includes(day)} onClick={() => setPattern((current) => ({ ...current, monthDays: toggleNumber(current.monthDays, day) }))}>{day}</Chip>
                ))}
              </ToggleRow>
            )}
            {pattern.frequency === "yearly" && pattern.monthMode === "each" && (
              <>
                <ToggleRow label="Months">
                  {MONTH_LABELS.map((label, index) => (
                    <Chip key={label} on={pattern.months.includes(index + 1)} onClick={() => setPattern((current) => ({ ...current, months: toggleNumber(current.months, index + 1) }))}>{label}</Chip>
                  ))}
                </ToggleRow>
                <Field label="Day of the month">
                  <input className="sens-input" aria-label="Day of the month" type="number" min={1} max={31} value={pattern.dayOfMonth}
                    onChange={(e) => setPattern((current) => ({ ...current, dayOfMonth: Number(e.target.value) }))}
                    style={inputStyle(t)} />
                </Field>
              </>
            )}
            {(pattern.frequency === "monthly" || pattern.frequency === "yearly") && pattern.monthMode === "onThe" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Position">
                  <select className="sens-input" aria-label="Position" value={pattern.ordinal}
                    onChange={(e) => setPattern((current) => ({ ...current, ordinal: e.target.value as ScheduleOrdinal }))}
                    style={sel}>
                    {ORDINALS.map((item) => <option key={item} value={item} style={{ background: t.panel2 }}>{item}</option>)}
                  </select>
                </Field>
                <Field label="Day">
                  <select className="sens-input" aria-label="Day" value={pattern.ordinalDay}
                    onChange={(e) => setPattern((current) => ({ ...current, ordinalDay: e.target.value }))}
                    style={sel}>
                    {ORDINAL_DAYS.map(([value, label]) => <option key={value} value={value} style={{ background: t.panel2 }}>{label}</option>)}
                  </select>
                </Field>
              </div>
            )}
            {pattern.frequency === "yearly" && pattern.monthMode === "onThe" && (
              <ToggleRow label="Months">
                {MONTH_LABELS.map((label, index) => (
                  <Chip key={label} on={pattern.months.includes(index + 1)} onClick={() => setPattern((current) => ({ ...current, months: toggleNumber(current.months, index + 1) }))}>{label}</Chip>
                ))}
              </ToggleRow>
            )}
          </>
        )}

        <div>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 6, fontWeight: 500 }}>End</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Chip on={endMode === "never"} onClick={() => chooseEnd("never")}>Never</Chip>
            <Chip on={endMode === "after"} onClick={() => chooseEnd("after")}>After a count</Chip>
            <Chip on={endMode === "on"} onClick={() => chooseEnd("on")}>On a date</Chip>
          </div>
        </div>
        {endMode === "after" && (
          <Field label="Count">
            <input className="sens-input" aria-label="Count" type="number" min={1} value={endCount}
              onChange={(e) => setEndCount(Number(e.target.value))} style={inputStyle(t)} />
          </Field>
        )}
        {endMode === "on" && (
          <Field label="End date">
            <input className="sens-input" aria-label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle(t)} />
          </Field>
        )}

        {timeEnabled && (
          <Field label="Time">
            <input className="sens-input" aria-label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} />
          </Field>
        )}

        <div style={{ fontSize: 12.5, color: t.text, background: t.panel2, borderRadius: 9, padding: "10px 12px" }}>{summary}</div>
        {ruleError && <div style={{ fontSize: 12.5, color: t.expense, marginTop: -6 }}>{ruleError}</div>}
        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={busy || !!ruleError} style={{ flex: 1, justifyContent: "center", height: 38, background: accent }}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}

function accountLabel(account: Account): string {
  return account.isArchived ? `${account.name} (archived)` : account.name;
}

function withMissing(list: Account[], id: string, all: Account[]): Account[] {
  if (!id || list.some((account) => account.id === id)) return list;
  const found = all.find((account) => account.id === id);
  return found ? [...list, found] : list;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string | number }) {
  const t = useTheme();
  return (
    <button type="button" className="sens-btn" onClick={onClick}
      style={{ height: 28, padding: "0 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, color: on ? t.accent : t.dim, background: on ? t.accentSoft : t.panel, border: `0.5px solid ${on ? "transparent" : t.border}` }}>
      {children}
    </button>
  );
}

function ToggleRow({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <div>
      <div style={{ fontSize: 11, color: t.dim, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>
    </div>
  );
}
