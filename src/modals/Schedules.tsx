// Every saved schedule. Add and edit open the form. Delete does not ask again.

import { useEffect, useState } from "react";
import type { Account, Category, Schedule } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Modal, Money } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { ruleSummary } from "../lib/recurrence";
import { kindColor, signedFor } from "../lib/kinds";
import { ScheduleForm, ruleFromSchedule } from "./ScheduleForm";

export function Schedules({ accounts, categories, onClose, commitSchedule }: {
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  commitSchedule: (write: () => Promise<void>) => Promise<void>;
}) {
  const t = useTheme();
  const [rows, setRows] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Schedule | "new" | null>(null);

  async function refresh() {
    try {
      setRows(await client.listSchedules());
      setError(null);
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't load schedules");
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function saved(write: () => Promise<void>) {
    await commitSchedule(write);
    setForm(null);
    await refresh();
  }

  async function remove(id: string) {
    try {
      await commitSchedule(() => client.deleteSchedule(id));
      await refresh();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't delete the schedule");
    }
  }

  return (
    <>
      <Modal onClose={onClose} width={520}>
        <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Schedules</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Btn size="sm" variant="primary" onClick={() => setForm("new")}>Add</Btn>
            <button type="button" className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
          </div>
        </div>
        <div style={{ padding: "8px 16px 16px" }}>
          {error && <div style={{ fontSize: 12.5, color: t.expense, padding: "8px 4px" }}>{error}</div>}
          {rows.length === 0 && !error && <div style={{ padding: "28px 8px", textAlign: "center", color: t.dim, fontSize: 13 }}>No schedules yet</div>}
          {rows.map((row) => {
            const summary = ruleSummary(ruleFromSchedule(row));
            const color = kindColor(t, row.kind);
            const movement = row.kind === "transfer" || row.kind === "payment";
            return (
              <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 4px", borderBottom: `0.5px solid ${t.divider}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{summary}</div>
                  <div style={{ fontSize: 12, color: t.dim, marginTop: 2 }}>{row.mode === "auto" ? "Auto" : "Tap to post"}</div>
                  {row.blockReason && <div style={{ fontSize: 12, color: t.expense, marginTop: 4 }}>{row.blockReason}</div>}
                </div>
                <Money cents={movement ? row.amountCents : signedFor(row.kind, row.amountCents)} signed={!movement} color={color} />
                <Btn size="sm" variant="outline" onClick={() => setForm(row)}>Edit</Btn>
                <Btn size="sm" variant="danger" onClick={() => remove(row.id)}>Delete</Btn>
              </div>
            );
          })}
        </div>
      </Modal>
      {form && (
        <ScheduleForm
          key={form === "new" ? "new" : form.id}
          accounts={accounts}
          categories={categories}
          schedule={form === "new" ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}
