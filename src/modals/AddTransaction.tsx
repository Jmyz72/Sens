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
import { isPaymentSource, movementKind, payAmountField } from "../lib/payments";
import { categoryPickerItems } from "../lib/categories";
import { addItem, removeItem, itemsTotal, isSplit, finalize, isPendingValid, type BuilderItem } from "../lib/txnBuilder";
import { useTimeSetting } from "../lib/useTimeSetting";
import { ReimbursementForm } from "./ReimbursementForm";

const FORM_KINDS: TransactionKind[] = ["expense", "income", "transfer", "reimbursement"];

export function AddTransaction({ accounts, categories, editing, payAccountId, reimburseExpenseId, onClose, onDone }: {
  accounts: Account[]; categories: Category[]; editing?: Transaction; payAccountId?: string; reimburseExpenseId?: string;
  onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const active = accounts.filter((a) => !a.isArchived);
  const payTarget = accounts.find((a) => a.id === payAccountId);
  const initialTo = editing?.toAccountId
    ?? payTarget?.id
    ?? active.find((a) => a.id !== (editing?.accountId ?? active[0]?.id))?.id
    ?? "";
  const initialKind: TransactionKind = editing?.kind === "reimbursement" || (!editing && reimburseExpenseId)
    ? "reimbursement"
    : editing?.kind === "payment" || (!editing && payTarget && movementKind(payTarget.subtype) === "payment")
      ? "payment"
      : (editing?.kind ?? "expense");
  const [kind, setKind] = useState<TransactionKind>(initialKind);
  // The amount field is the PENDING item amount for income/expense, and the
  // whole amount for transfer or payment.
  const [amount, setAmount] = useState(
    editing && (editing.kind === "transfer" || editing.kind === "payment")
      ? (editing.amountCents / 100).toFixed(2)
      : payTarget ? payAmountField(payTarget.balanceCents) : "",
  );
  const [desc, setDesc] = useState(editing?.description ?? "");
  const [excluded, setExcluded] = useState(editing?.excludedFromReporting ?? false);
  const [expecting, setExpecting] = useState(editing?.expectedReimbursementCents != null);
  const [expectedStr, setExpectedStr] = useState(
    editing?.expectedReimbursementCents != null ? (editing.expectedReimbursementCents / 100).toFixed(2) : "",
  );
  const [date, setDate] = useState(editing?.transactionDate ?? todayISO());
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(editing?.transactionTime ?? nowTimeHHMM());
  const [accountId, setAccountId] = useState(() => {
    if (editing) return editing.accountId;
    if (initialKind === "payment") {
      return active.find((a) => isPaymentSource(a.subtype) && a.id !== initialTo)?.id ?? "";
    }
    return active[0]?.id ?? "";
  });
  const [toAccountId, setToAccountId] = useState(initialTo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once a NEW expense has been created but the expected-reimbursement step
  // failed. From then on the modal behaves as an edit of that saved expense, so
  // a retry updates it (never duplicates it) and persists exactly what is shown.
  const [saved, setSaved] = useState<Transaction | null>(null);
  const target = saved ?? editing;

  const catKind: Category["kind"] = kind === "income" ? "income" : kind === "expense" ? "expense" : "transfer";
  const pickerItems = useMemo(() => categoryPickerItems(categories, catKind), [categories, catKind]);

  // Itemized builder state (income/expense only).
  const [items, setItems] = useState<BuilderItem[]>(
    editing && editing.splits.length
      ? editing.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents }))
      : editing && editing.categoryId && editing.kind !== "transfer" && editing.kind !== "payment"
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

  const expectedCents = parseAmountToCents(expectedStr);
  const expectedOk = kind !== "expense" || !expecting || (expectedCents != null && expectedCents <= totalCents);
  const movement = kind === "transfer" || kind === "payment";
  const destAccount = accounts.find((a) => a.id === toAccountId);
  const destKind = movementKind(destAccount?.subtype);
  const valid = movement
    ? !!(cents != null && accountId && toAccountId && toAccountId !== accountId && (!timeEnabled || !!time))
    : !!(accountId && finalItems.length >= 1 && (!timeEnabled || !!time) && expectedOk);

  function changeKind(k: TransactionKind) {
    if (k === kind) return;
    setKind(k);
    setItems([]);
    setPendingCat("");
    setAmount("");
    setCatFilter("");
  }

  function chooseDestination(id: string) {
    setToAccountId(id);
    if (kind !== "transfer" && kind !== "payment") return;
    const next = movementKind(accounts.find((a) => a.id === id)?.subtype);
    setKind(next);
    if (next === "payment") {
      const src = accounts.find((a) => a.id === accountId);
      if (!src || !isPaymentSource(src.subtype) || src.id === id) {
        setAccountId(active.find((a) => isPaymentSource(a.subtype) && a.id !== id)?.id ?? "");
      }
    }
  }

  async function submit() {
    if (!valid) return;
    setBusy(true); setError(null);
    const txTime = timeEnabled ? time : null;
    try {
      if (kind === "transfer" || kind === "payment") {
        if (cents == null) return;
        if (target) {
          await client.updateTransaction({
            id: target.id, kind, accountId, toAccountId,
            categoryId: null, amountCents: cents, description: desc.trim() || null,
            transactionDate: date, transactionTime: txTime, excludedFromReporting: false, splits: null,
          });
        } else if (kind === "payment") {
          await client.createPayment(accountId, toAccountId, cents, desc.trim() || null, date, txTime);
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

      let savedId: string | null = null;
      let createdTxn: Transaction | null = null;
      if (target) {
        await client.updateTransaction({
          id: target.id, kind, accountId, toAccountId: null,
          categoryId: split ? null : singleCat,
          amountCents: total, description: desc.trim() || null, transactionDate: date,
          transactionTime: txTime, excludedFromReporting: excluded, splits,
        });
        savedId = target.id;
      } else if (kind === "income") {
        await client.createIncome(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
      } else {
        const created = await client.createExpense(accountId, singleCat, total, desc.trim() || null, date, txTime, excluded, splits);
        savedId = created.id;
        createdTxn = created;
      }
      if (kind === "expense" && savedId && (expecting || target?.expectedReimbursementCents != null)) {
        try {
          await client.setExpectedReimbursement(savedId, expecting ? expectedCents : null);
        } catch (e) {
          if (createdTxn) setSaved(createdTxn);
          const why = (e as { message?: string })?.message ?? "Something went wrong";
          setError(`The expense was saved, but the expected reimbursement could not be set: ${why}`);
          return;
        }
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // After the expense exists, closing must still refresh the lists.
  const close = saved ? onDone : onClose;
  const accentForKind = kindColor(t, kind);
  const sel = { ...inputStyle(t), appearance: "none" as const, cursor: "pointer" };

  return (
    <Modal onClose={close} width={430}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{target ? "Edit transaction" : "Add transaction"}</span>
        <button className="sens-icon-btn" onClick={close} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* kind segmented */}
        <div style={{ display: "flex", gap: 4, background: t.panel2, borderRadius: 9, padding: 3 }}>
          {FORM_KINDS.map((k) => {
            const segmentKind: TransactionKind = k === "transfer" && destKind === "payment" ? "payment" : k;
            const on = k === "transfer" ? (kind === "transfer" || kind === "payment") : k === kind;
            const col = kindColor(t, on && segmentKind === "payment" ? "payment" : k);
            // A reimbursement is its own record type: it can't become another
            // kind, and nothing else can become one.
            const disabledReason = target
              ? (target.kind === "reimbursement"
                ? (k !== "reimbursement" ? "A reimbursement can't be changed to another type" : null)
                : (k === "reimbursement" ? "Reimbursements are created separately" : null))
              : null;
            const segDisabled = disabledReason != null;
            return (
              <button key={k} type="button" className="sens-btn" disabled={segDisabled} aria-disabled={segDisabled}
                title={disabledReason ?? undefined} onClick={() => {
                if (segDisabled) return;
                if (k === "transfer") {
                  if (kind === "transfer" || kind === "payment") return;
                  changeKind(destKind);
                  return;
                }
                changeKind(k);
              }}
                style={{ flex: 1, height: 32, justifyContent: "center", borderRadius: 7, fontSize: 12.5, fontWeight: 600,
                  color: on ? "#fff" : t.dim, background: on ? col : "transparent",
                  opacity: segDisabled ? 0.45 : 1, cursor: segDisabled ? "not-allowed" : undefined }}>
                <Icon name={KIND_META[segmentKind].icon} size={14} color={on ? "#fff" : t.dim} stroke={2} />
                {KIND_META[segmentKind].label}
              </button>
            );
          })}
        </div>
        {target && (
          <div style={{ fontSize: 11, color: t.faint, marginTop: -6 }}>
            {target.kind === "reimbursement"
              ? "A reimbursement can't be changed to another type"
              : "Reimbursements are created separately"}
          </div>
        )}

        {kind === "reimbursement" ? (
          <ReimbursementForm accounts={accounts} categories={categories}
            editing={editing?.kind === "reimbursement" ? editing : undefined}
            presetExpenseId={reimburseExpenseId} onClose={close} onDone={onDone} />
        ) : (
        <>
        {/* amount */}
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 14, top: 14, fontSize: 16, color: t.faint, fontFamily: t.mono }}>RM</span>
          <input className="sens-input" value={amount} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            style={{ ...inputStyle(t), height: 50, fontSize: 24, fontWeight: 700, fontFamily: t.mono, paddingLeft: 44, color: accentForKind }} />
        </div>

        <input className="sens-input" value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder={movement ? "Note (optional)" : "Merchant or description"} style={inputStyle(t)} />

        {movement ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
            <Field label="From">
              <select className="sens-input" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={sel}>
                {(kind === "payment" ? active.filter((a) => isPaymentSource(a.subtype) && a.id !== toAccountId) : active).map((a) => <option key={a.id} value={a.id} style={{ background: t.panel2 }}>{a.name}</option>)}
              </select>
            </Field>
            <div style={{ paddingBottom: 9, color: t.faint }}><Icon name="chevronRight" size={16} color={t.faint} /></div>
            <Field label="To">
              <select className="sens-input" value={toAccountId} onChange={(e) => chooseDestination(e.target.value)} style={sel}>
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

        {!movement && (
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

        {kind === "expense" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" role="switch" aria-checked={expecting}
              onClick={() => { setExpecting((v) => !v); if (!expecting && !expectedStr && totalCents > 0) setExpectedStr((totalCents / 100).toFixed(2)); }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: `0.5px solid ${t.border}`, background: expecting ? hexA(t.transfer, 0.12) : t.panel2, cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", background: expecting ? t.transfer : "transparent", border: `1.5px solid ${expecting ? t.transfer : t.faint}`, flexShrink: 0 }}>
                {expecting && <Icon name="check" size={12} color={t.onAccent} stroke={3} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>Expecting reimbursement</div>
                <div style={{ fontSize: 11, color: t.faint }}>Track what's still owed back to you</div>
              </span>
            </button>
            {expecting && (
              <Field label="Expected back">
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 12, top: 9, fontSize: 13, color: t.faint, fontFamily: t.mono }}>RM</span>
                  <input className="sens-input" value={expectedStr} inputMode="decimal" placeholder="0.00" aria-label="Expected reimbursement"
                    onChange={(e) => setExpectedStr(e.target.value.replace(/[^0-9.]/g, ""))}
                    style={{ ...inputStyle(t), paddingLeft: 38, fontFamily: t.mono, borderColor: expectedOk ? undefined : t.expense }} />
                </div>
                {!expectedOk && <div style={{ fontSize: 11, color: t.expense, marginTop: 4 }}>Can't be more than the expense total</div>}
              </Field>
            )}
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
          <Btn variant="outline" onClick={close} style={{ flex: 1, justifyContent: "center", height: 38 }}>{saved ? "Close" : "Cancel"}</Btn>
          <Btn variant="primary" onClick={submit} disabled={!valid || busy} style={{ flex: 1, justifyContent: "center", height: 38, background: accentForKind, boxShadow: `0 1px 8px ${hexA(accentForKind, 0.35)}` }}>
            {target ? "Save changes" : "Add transaction"}
          </Btn>
        </div>
        </>
        )}
      </div>
    </Modal>
  );
}
