// Add / edit a transaction. Supports income, expense, and transfer. The kind
// segmented control is color-coded per the UI Color System. Adjustments are
// not editable here (handled by balance correction).

import { useMemo, useState } from "react";
import type { Account, Category, Transaction, TransactionKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents, todayISO } from "../lib/format";
import { KIND_META, kindColor } from "../lib/kinds";
import { categoryPickerItems } from "../lib/categories";

const FORM_KINDS: TransactionKind[] = ["expense", "income", "transfer"];

export function AddTransaction({ accounts, categories, editing, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const active = accounts.filter((a) => !a.isArchived);
  const [kind, setKind] = useState<TransactionKind>(editing?.kind ?? "expense");
  const [amount, setAmount] = useState(editing ? (editing.amountCents / 100).toFixed(2) : "");
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [excluded, setExcluded] = useState(editing?.excludedFromReporting ?? false);
  const [date, setDate] = useState(editing?.transactionDate ?? todayISO());
  const [accountId, setAccountId] = useState(editing?.accountId ?? active[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(editing?.toAccountId ?? active.find((a) => a.id !== accountId)?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const catKind: Category["kind"] = kind === "income" ? "income" : kind === "transfer" ? "transfer" : "expense";
  const pickerItems = useMemo(() => categoryPickerItems(categories, catKind), [categories, catKind]);
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? "");
  const effectiveCat = categoryId || pickerItems[0]?.id || "";

  const cents = parseAmountToCents(amount);
  const valid = cents != null && accountId && (kind !== "transfer" ? !!effectiveCat : toAccountId && toAccountId !== accountId);

  async function submit() {
    if (!valid || cents == null) return;
    setBusy(true); setError(null);
    try {
      if (editing) {
        await client.updateTransaction({
          id: editing.id, kind, accountId,
          toAccountId: kind === "transfer" ? toAccountId : null,
          categoryId: kind === "transfer" ? null : effectiveCat,
          amountCents: cents, description: desc.trim() || null, transactionDate: date,
          excludedFromReporting: kind === "transfer" ? false : excluded,
        });
      } else if (kind === "income") {
        await client.createIncome(accountId, effectiveCat, cents, desc.trim() || null, date, excluded);
      } else if (kind === "expense") {
        await client.createExpense(accountId, effectiveCat, cents, desc.trim() || null, date, excluded);
      } else {
        await client.createTransfer(accountId, toAccountId, cents, desc.trim() || null, date);
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const accentForKind = kindColor(t, kind);
  const sel = { ...inputStyle(t), appearance: "none" as const, cursor: "pointer" };

  return (
    <Modal onClose={onClose} width={430}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{editing ? "Edit transaction" : "Add transaction"}</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* kind segmented */}
        <div style={{ display: "flex", gap: 4, background: t.panel2, borderRadius: 9, padding: 3 }}>
          {FORM_KINDS.map((k) => {
            const on = k === kind;
            const col = kindColor(t, k);
            return (
              <button key={k} className="sens-btn" onClick={() => setKind(k)}
                style={{ flex: 1, height: 32, justifyContent: "center", borderRadius: 7, fontSize: 12.5, fontWeight: 600,
                  color: on ? "#fff" : t.dim, background: on ? col : "transparent" }}>
                <Icon name={KIND_META[k].icon} size={14} color={on ? "#fff" : t.dim} stroke={2} />
                {KIND_META[k].label}
              </button>
            );
          })}
        </div>

        {/* amount */}
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 14, top: 14, fontSize: 16, color: t.faint, fontFamily: t.mono }}>RM</span>
          <input className="sens-input" value={amount} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            style={{ ...inputStyle(t), height: 50, fontSize: 24, fontWeight: 700, fontFamily: t.mono, paddingLeft: 44, color: accentForKind }} />
        </div>

        <input className="sens-input" value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder={kind === "transfer" ? "Note (optional)" : "Merchant or description"} style={inputStyle(t)} />

        {kind === "transfer" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <Field label="From">
              <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {active.map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
              </select>
            </Field>
            <div style={{ paddingBottom: 9, color: t.faint }}><Icon name="chevronRight" size={16} color={t.faint} /></div>
            <Field label="To">
              <select className="sens-input" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} style={sel}>
                {active.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
              </select>
            </Field>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Category">
              <select className="sens-input" value={effectiveCat} onChange={(e) => setCategoryId(e.target.value)} style={sel}>
                {pickerItems.map((it) => (
                  <option key={it.id} value={it.id} style={{ background: t.panel2 }}>
                    {it.depth === 1 ? " " : ""}{it.emoji} {it.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Account">
              <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {active.map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
              </select>
            </Field>
          </div>
        )}

        <Field label="Date">
          <input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} />
        </Field>

        {kind !== "transfer" && (
          <button type="button" onClick={() => setExcluded((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: `0.5px solid ${t.border}`, background: excluded ? hexA(t.opening, 0.12) : t.panel2, cursor: "pointer", textAlign: "left" }}>
            <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", background: excluded ? t.opening : "transparent", border: `1.5px solid ${excluded ? t.opening : t.faint}`, flexShrink: 0 }}>
              {excluded && <Icon name="check" size={12} color="#fff" stroke={3} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Money movement</div>
              <div style={{ fontSize: 11, color: t.faint }}>Affects balances but excluded from income/expense reports</div>
            </span>
          </button>
        )}

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!valid || busy} style={{ flex: 1, justifyContent: "center", height: 38, background: accentForKind, boxShadow: `0 1px 8px ${hexA(accentForKind, 0.35)}` }}>
            {editing ? "Save changes" : "Add transaction"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
