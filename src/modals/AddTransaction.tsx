// Add / edit a transaction. Supports income, expense, and transfer. The kind
// segmented control is color-coded per the UI Color System. Adjustments are
// not editable here (handled by balance correction).
//
// Income/expense use an itemized builder: type an amount, tap a category tile,
// "Add item" to stack it; a live Total auto-sums items. One item = an ordinary
// single-category transaction; two or more = a split (header category derived
// from splits[0] by the backend). The transfer path is unchanged.

import { useMemo, useState } from "react";
import type { Account, Category, Transaction, TransactionKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents, todayISO, nowTimeHHMM, fmtMoney } from "../lib/format";
import { KIND_META, kindColor } from "../lib/kinds";
import { categoryPickerItems } from "../lib/categories";
import { addItem, removeItem, itemsTotal, isSplit, finalize, isPendingValid, type BuilderItem } from "../lib/txnBuilder";
import { useTimeSetting } from "../lib/useTimeSetting";

const FORM_KINDS: TransactionKind[] = ["expense", "income", "transfer"];

export function AddTransaction({ accounts, categories, editing, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const active = accounts.filter((a) => !a.isArchived);
  const [kind, setKind] = useState<TransactionKind>(editing?.kind ?? "expense");
  // The amount field is the PENDING item amount for income/expense, and the
  // whole amount for transfer. Prefill it only when editing a transfer (a
  // single-item income/expense and splits are rebuilt as items below).
  const [amount, setAmount] = useState(editing?.kind === "transfer" ? (editing.amountCents / 100).toFixed(2) : "");
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [excluded, setExcluded] = useState(editing?.excludedFromReporting ?? false);
  const [date, setDate] = useState(editing?.transactionDate ?? todayISO());
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(editing?.transactionTime ?? nowTimeHHMM());
  const [accountId, setAccountId] = useState(editing?.accountId ?? active[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(editing?.toAccountId ?? active.find((a) => a.id !== accountId)?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const catKind: Category["kind"] = kind === "income" ? "income" : kind === "transfer" ? "transfer" : "expense";
  const pickerItems = useMemo(() => categoryPickerItems(categories, catKind), [categories, catKind]);

  // Itemized builder state (income/expense only).
  const [items, setItems] = useState<BuilderItem[]>(
    editing && editing.splits.length
      ? editing.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents }))
      : editing && editing.categoryId && editing.kind !== "transfer"
        ? [{ categoryId: editing.categoryId, amountCents: editing.amountCents }]
        : [],
  );
  const [pendingCat, setPendingCat] = useState<string>("");
  const [catFilter, setCatFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);

  const cents = parseAmountToCents(amount);
  const pendingItem: BuilderItem = { categoryId: pendingCat, amountCents: cents ?? 0 };
  const totalCents = itemsTotal(items) + (isPendingValid(pendingItem) ? pendingItem.amountCents : 0);
  const finalItems = finalize(items, pendingItem);

  const valid = kind === "transfer"
    ? !!(cents != null && accountId && toAccountId && toAccountId !== accountId && (!timeEnabled || !!time))
    : !!(accountId && finalItems.length >= 1 && (!timeEnabled || !!time));

  function changeKind(k: TransactionKind) {
    if (k === kind) return;
    setKind(k);
    setItems([]);
    setPendingCat("");
    setAmount("");
    setCatFilter("");
  }

  async function submit() {
    if (!valid) return;
    setBusy(true); setError(null);
    const txTime = timeEnabled ? time : null;
    try {
      if (kind === "transfer") {
        if (cents == null) return;
        if (editing) {
          await client.updateTransaction({
            id: editing.id, kind, accountId, toAccountId,
            categoryId: null, amountCents: cents, description: desc.trim() || null,
            transactionDate: date, transactionTime: txTime, excludedFromReporting: false, splits: null,
          });
        } else {
          await client.createTransfer(accountId, toAccountId, cents, desc.trim() || null, date, txTime);
        }
        onDone();
        return;
      }

      // income / expense
      const list = finalize(items, pendingItem);
      if (list.length === 0) return;
      const total = itemsTotal(list);
      const split = list.length >= 2;
      const splits = split ? list.map((it) => ({ categoryId: it.categoryId, amountCents: it.amountCents })) : null;
      const singleCat = !split ? list[0].categoryId : null;

      if (editing) {
        await client.updateTransaction({
          id: editing.id, kind, accountId, toAccountId: null,
          categoryId: split ? null : singleCat,
          amountCents: total, description: desc.trim() || null, transactionDate: date,
          transactionTime: txTime, excludedFromReporting: excluded, splits,
        });
      } else if (kind === "income") {
        await client.createIncome(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
      } else {
        await client.createExpense(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
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
              <button key={k} className="sens-btn" onClick={() => changeKind(k)}
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
          <>
            <Field label="Account">
              <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {active.map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
              </select>
            </Field>

            {/* Category grid */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim }}>Category</span>
                <button type="button" className="sens-btn" onClick={() => setShowFilter((v) => !v)} style={{ fontSize: 11, color: t.dim }}>Filter</button>
              </div>
              {showFilter && (
                <input className="sens-input" autoFocus value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
                  placeholder="Type to filter…" style={{ ...inputStyle(t), marginBottom: 8 }} />
              )}
              <div style={{ maxHeight: 180, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7 }}>
                {pickerItems
                  .filter((it) => !catFilter || it.label.toLowerCase().includes(catFilter.toLowerCase()))
                  .map((it) => {
                    const on = pendingCat === it.id;
                    return (
                      <button type="button" key={it.id} className="sens-btn" onClick={() => setPendingCat(it.id)}
                        style={{ flexDirection: "column", gap: 3, padding: "9px 4px", borderRadius: 11, fontSize: 10,
                          border: `1.5px solid ${on ? accentForKind : t.border}`, background: on ? hexA(accentForKind, 0.18) : t.panel2,
                          color: on ? t.text : t.dim }}>
                        <span style={{ fontSize: 18 }}>{it.emoji}</span>{it.label}
                      </button>
                    );
                  })}
              </div>
              <Btn variant="outline" disabled={!isPendingValid(pendingItem)}
                onClick={() => { setItems((xs) => addItem(xs, pendingItem)); setAmount(""); setPendingCat(""); }}
                style={{ width: "100%", justifyContent: "center", marginTop: 10 }}>+ Add item</Btn>
            </div>

            {/* Items list + total */}
            {items.length > 0 && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.dim, marginBottom: 4 }}>
                  <span>Items</span><span>{items.length}{isSplit(items) ? " · split" : ""}</span>
                </div>
                {items.map((it, i) => {
                  const c = categories.find((x) => x.id === it.categoryId);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `0.5px solid ${t.divider}` }}>
                      <span>{c?.emoji}</span><span style={{ flex: 1 }}>{c?.name}</span>
                      <span style={{ fontFamily: t.mono }}>{fmtMoney(it.amountCents, { cents: true })}</span>
                      <button type="button" className="sens-icon-btn" onClick={() => setItems((xs) => removeItem(xs, i))} style={{ color: t.dim }}>✕</button>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontWeight: 700 }}>
                  <span style={{ color: t.dim }}>Total</span>
                  <span style={{ fontFamily: t.mono }}>{fmtMoney(totalCents, { cents: true })}</span>
                </div>
              </div>
            )}
          </>
        )}

        {timeEnabled ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date">
              <input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} />
            </Field>
            <Field label="Time">
              <input className="sens-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} />
            </Field>
          </div>
        ) : (
          <Field label="Date">
            <input className="sens-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle(t)} />
          </Field>
        )}

        {kind !== "transfer" && (
          <button type="button" onClick={() => setExcluded((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: `0.5px solid ${t.border}`, background: excluded ? hexA(t.opening, 0.12) : t.panel2, cursor: "pointer", textAlign: "left" }}>
            <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", background: excluded ? t.opening : "transparent", border: `1.5px solid ${excluded ? t.opening : t.faint}`, flexShrink: 0 }}>
              {excluded && <Icon name="check" size={12} color="#fff" stroke={3} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
                {kind === "income" ? "Excluded from income" : "Excluded from expense"}
              </div>
              <div style={{ fontSize: 11, color: t.faint }}>Still updates the balance, but won't count in reports</div>
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
