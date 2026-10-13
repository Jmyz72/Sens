// Record (or edit) money that came back for expenses you already booked: an
// employer claim, a friend's share of a bill, a shop refund. The amount must be
// fully allocated across one or more expenses. Rendered inside AddTransaction's
// Reimbursement segment; it owns its own state and its own Save/Cancel.

import { useEffect, useMemo, useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { fmtDate, fmtMoney, nowTimeHHMM, parseAmountToCents, todayISO } from "../lib/format";
import { kindColor } from "../lib/kinds";
import { candidateExpenses, defaultAllocationCents, outstandingCents, remainingCents } from "../lib/reimbursements";
import { useTimeSetting } from "../lib/useTimeSetting";

interface Pick { expenseId: string; amount: string }

const cents2 = (c: number) => (c / 100).toFixed(2);

export function ReimbursementForm({ accounts, categories, editing, presetExpenseId, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; presetExpenseId?: string;
  onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const accent = kindColor(t, "reimbursement");
  const [timeEnabled] = useTimeSetting();
  const active = accounts.filter((a) => !a.isArchived || a.id === editing?.accountId);

  const [expenses, setExpenses] = useState<Transaction[]>([]);
  const [amount, setAmount] = useState(editing ? cents2(editing.amountCents) : "");
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [accountId, setAccountId] = useState(editing?.accountId ?? active[0]?.id ?? "");
  const [date, setDate] = useState(editing?.transactionDate ?? todayISO());
  const [time, setTime] = useState(editing?.transactionTime ?? nowTimeHHMM());
  const [picks, setPicks] = useState<Pick[]>(
    editing ? editing.allocations.map((a) => ({ expenseId: a.expenseId, amount: cents2(a.amountCents) })) : [],
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ownAllocations = useMemo(() => editing?.allocations ?? [], [editing]);
  const ownOf = (expenseId: string) => ownAllocations.find((a) => a.expenseId === expenseId)?.amountCents ?? 0;

  useEffect(() => {
    client.listTransactions({ kind: "expense", limit: 1000 }).then(setExpenses).catch(() => {});
  }, []);

  // Quick entry from an expense: pick it and fill in what is still owed on it.
  useEffect(() => {
    if (!presetExpenseId || editing || picks.length > 0) return;
    const e = expenses.find((x) => x.id === presetExpenseId);
    if (!e) return;
    const cents = defaultAllocationCents(e);
    setPicks([{ expenseId: e.id, amount: cents2(cents) }]);
    if (!amount) setAmount(cents2(cents));
  }, [expenses]);

  const byId = useMemo(() => new Map(expenses.map((e) => [e.id, e])), [expenses]);
  const candidates = useMemo(
    () => candidateExpenses(expenses, categories, ownAllocations),
    [expenses, categories, ownAllocations],
  );
  const q = query.trim().toLowerCase();
  const shown = candidates.filter((e) => {
    if (!q) return true;
    const cat = categories.find((c) => c.id === e.categoryId)?.name ?? "";
    const acc = accounts.find((a) => a.id === e.accountId)?.name ?? "";
    return (e.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || acc.toLowerCase().includes(q);
  });

  const amountCents = parseAmountToCents(amount);
  const pickCents = picks.map((p) => parseAmountToCents(p.amount));
  const allocatedCents = pickCents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const picksValid = picks.length > 0 && picks.every((p, i) => {
    const e = byId.get(p.expenseId);
    const c = pickCents[i];
    return !!e && c != null && c <= remainingCents(e, ownOf(p.expenseId));
  });
  const balanced = amountCents != null && allocatedCents === amountCents;
  const valid = !!accountId && balanced && picksValid && (!timeEnabled || !!time);

  function toggle(e: Transaction) {
    const cents = defaultAllocationCents(e, ownOf(e.id));
    if (picks.length === 0 && !amount) setAmount(cents2(cents));
    setPicks((ps) =>
      ps.some((p) => p.expenseId === e.id)
        ? ps.filter((p) => p.expenseId !== e.id)
        : [...ps, { expenseId: e.id, amount: cents2(cents) }],
    );
  }

  async function submit() {
    if (!valid || amountCents == null) return;
    setBusy(true); setError(null);
    const allocations = picks.map((p, i) => ({ expenseId: p.expenseId, amountCents: pickCents[i] as number }));
    const txTime = timeEnabled ? time : null;
    try {
      if (editing) {
        await client.updateReimbursement(editing.id, accountId, amountCents, allocations, desc.trim() || null, date, txTime);
      } else {
        await client.createReimbursement(accountId, amountCents, allocations, desc.trim() || null, date, txTime);
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const sel = { ...inputStyle(t), appearance: "none" as const, cursor: "pointer" };

  return (
    <>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 14, top: 14, fontSize: 16, color: t.faint, fontFamily: t.mono }}>RM</span>
        <input className="sens-input" value={amount} inputMode="decimal" placeholder="0.00" aria-label="Amount received"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          style={{ ...inputStyle(t), height: 50, fontSize: 24, fontWeight: 700, fontFamily: t.mono, paddingLeft: 44, color: accent }} />
      </div>

      <input className="sens-input" value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder="Who paid you back? (optional)" style={inputStyle(t)} />

      <Field label="Received in">
        <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
          {active.map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
        </select>
      </Field>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim }}>Applies to</span>
          <span style={{ fontSize: 11, color: t.faint }}>{picks.length} selected</span>
        </div>
        <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search expenses" aria-label="Search expenses" style={{ ...inputStyle(t), marginBottom: 6 }} />
        <div style={{ maxHeight: 200, overflowY: "auto", border: `0.5px solid ${t.border}`, borderRadius: 9, padding: "0 10px" }}>
          {shown.length === 0 && (
            <div style={{ fontSize: 12.5, color: t.faint, padding: "12px 0" }}>No expenses with anything left to reimburse.</div>
          )}
          {shown.map((e) => {
            const pick = picks.find((p) => p.expenseId === e.id);
            const cat = categories.find((c) => c.id === e.categoryId);
            const out = outstandingCents(e);
            const label = e.description || cat?.name || "Expense";
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `0.5px solid ${t.divider}` }}>
                <button type="button" role="checkbox" aria-checked={!!pick} aria-label={`Select ${label}`} onClick={() => toggle(e)}
                  style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 6, padding: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1.5px solid ${pick ? accent : t.borderStrong}`, background: pick ? accent : "transparent" }}>
                  {pick && <Icon name="check" size={11} color={t.onAccent} stroke={3} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                  <div style={{ fontSize: 11, color: t.faint }}>
                    {fmtDate(e.transactionDate)} · {fmtMoney(remainingCents(e, ownOf(e.id)), { cents: true })} left
                    {out > 0 ? ` · ${fmtMoney(out, { cents: true })} expected` : ""}
                  </div>
                </div>
                {pick && (
                  <input className="sens-input" aria-label={`Amount for ${label}`} value={pick.amount} inputMode="decimal"
                    onChange={(ev) => setPicks((ps) => ps.map((p) => p.expenseId === e.id ? { ...p, amount: ev.target.value.replace(/[^0-9.]/g, "") } : p))}
                    style={{ ...inputStyle(t), width: 92, height: 30, fontFamily: t.mono, textAlign: "right" }} />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, fontSize: 12.5 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: balanced ? t.dim : amountCents != null && allocatedCents > amountCents ? t.expense : t.dim }}>
            {balanced && <Icon name="check" size={13} color={t.income} stroke={2.4} />}
            Allocated <b style={{ fontFamily: t.mono }}>{fmtMoney(allocatedCents, { cents: true })}</b> of <b style={{ fontFamily: t.mono }}>{fmtMoney(amountCents ?? 0, { cents: true })}</b>
          </span>
        </div>
      </div>

      {timeEnabled ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Date"><input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} /></Field>
          <Field label="Time"><input className="sens-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} /></Field>
        </div>
      ) : (
        <Field label="Date"><input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} /></Field>
      )}

      {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={!valid || busy}
          style={{ flex: 1, justifyContent: "center", height: 38, background: accent, boxShadow: `0 1px 8px ${hexA(accent, 0.35)}` }}>
          {editing ? "Save changes" : "Add reimbursement"}
        </Btn>
      </div>
    </>
  );
}
