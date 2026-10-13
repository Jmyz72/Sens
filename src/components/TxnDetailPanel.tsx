// src/components/TxnDetailPanel.tsx
import { useEffect, useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Btn, Money, GlyphTile, IconBtn } from "./ui";
import { Icon } from "./Icon";
import { client } from "../client";
import { accountName } from "../store";
import { fmtDate, fmtMoney, fmtTime, nowTimeHHMM } from "../lib/format";
import { hexA } from "../theme/tokens";
import { KIND_META, kindColor, signedFor, computeRunningBalances } from "../lib/kinds";
import { isPaymentSource, movementKind } from "../lib/payments";
import { categoryPickerItems } from "../lib/categories";
import { useTimeSetting } from "../lib/useTimeSetting";
import { canReimburse as canReimburseExpense, outstandingCents } from "../lib/reimbursements";

export function TxnDetailPanel({ tx, accounts, categories, allTxns, onClose, onDuplicate, onDelete, onSaved, onEdit, onReimburse }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; allTxns: Transaction[];
  onClose: () => void; onDuplicate: () => void; onDelete: () => void; onSaved: () => void;
  onEdit?: () => void; onReimburse?: () => void;
}) {
  const t = useTheme();
  const color = kindColor(t, tx.kind);
  const meta = KIND_META[tx.kind];
  const movement = tx.kind === "transfer" || tx.kind === "payment";
  const editable = tx.kind === "income" || tx.kind === "expense" || movement;
  const split = tx.splits.length >= 2;
  const canReimburse = canReimburseExpense(tx, categories) && !!onReimburse;
  // A reimbursement can repay expenses outside the loaded date range, so any
  // allocated expense missing from `allTxns` is fetched to be named.
  const [fetched, setFetched] = useState<Transaction[]>([]);
  const missingAlloc = tx.kind === "reimbursement" && tx.allocations.some((a) => !allTxns.some((x) => x.id === a.expenseId));
  useEffect(() => {
    if (!missingAlloc) return;
    let cancelled = false;
    (async () => {
      const want = new Set(tx.allocations.map((a) => a.expenseId).filter((id) => !allTxns.some((x) => x.id === id)));
      const found: Transaction[] = [];
      for (let offset = 0; want.size > 0; offset += 1000) {
        const page = await client.listTransactions({ kind: "expense", limit: 1000, offset });
        for (const x of page) if (want.delete(x.id)) found.push(x);
        if (page.length < 1000) break;
      }
      if (!cancelled) setFetched(found);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [missingAlloc]);
  const expenseOf = (id: string) => allTxns.find((x) => x.id === id) ?? fetched.find((x) => x.id === id);

  const [categoryId, setCategoryId] = useState(tx.categoryId);
  const [accountId, setAccountId] = useState(tx.accountId);
  const [toAccountId, setToAccountId] = useState(tx.toAccountId);
  const [date, setDate] = useState(tx.transactionDate);
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(tx.transactionTime ?? nowTimeHHMM());
  const [desc, setDesc] = useState(tx.description ?? "");
  const [excluded, setExcluded] = useState(tx.excludedFromReporting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountOptions = accounts.filter((a) => !a.isArchived || a.id === tx.accountId || a.id === tx.toAccountId);

  const acctTxns = allTxns.filter((x) => x.accountId === accountId || x.toAccountId === accountId);
  const after = computeRunningBalances(acctTxns, accountId).get(tx.id);
  const before = after != null ? after - signedFor(tx.kind, tx.amountCents, tx.toAccountId === accountId) : undefined;

  async function save() {
    setBusy(true); setError(null);
    try {
        const dest = accounts.find((a) => a.id === toAccountId);
        const kind = movement ? movementKind(dest?.subtype) : tx.kind;
        await client.updateTransaction({
          id: tx.id, kind, accountId,
          toAccountId: movement ? toAccountId : null,
          categoryId: movement ? null : (split ? null : categoryId),
          amountCents: tx.amountCents, description: desc.trim() || null, transactionDate: date,
          transactionTime: timeEnabled ? time : tx.transactionTime,
          excludedFromReporting: movement ? false : excluded,
          splits: movement ? null : (split ? tx.splits : null),
        });
      onSaved();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Something went wrong");
    } finally { setBusy(false); }
  }

  const signedCents = signedFor(tx.kind, tx.amountCents, false);
  const catItems = categoryPickerItems(categories, tx.kind === "income" ? "income" : "expense");
  const fieldStyle = { background: t.panel2, color: t.text, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "4px 8px", fontSize: 12, fontFamily: t.font } as const;

  return (
    <Card className="sens-pop" pad={0} style={{ overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 0 }}>
      <div style={{ padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <GlyphTile tone={color} size={40} icon={meta.icon} />
          <IconBtn name="close" onClick={onClose} title="Close" icon={16} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 12 }}>{tx.description || meta.label}</div>
        <div style={{ marginTop: 6 }}>
          <Money cents={movement ? tx.amountCents : signedCents} signed={!movement}
            color={movement || tx.kind === "adjustment" || tx.kind === "opening" || tx.kind === "reimbursement" ? color : undefined} size={26} weight={700} />
        </div>
        {before != null && after != null && (
          <div style={{ fontSize: 11.5, color: t.faint, marginTop: 6 }}>
            {accountName(accounts, accountId)} balance {fmtMoney(before)} → <b style={{ color: t.text }}>{fmtMoney(after)}</b>
          </div>
        )}
      </div>

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {editable ? (
          <>
            {split && (
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim, marginBottom: 6 }}>
                  Split across {tx.splits.length} categories
                </div>
                {tx.splits.map((s) => {
                  const c = categories.find((x) => x.id === s.categoryId);
                  return (
                    <div key={s.categoryId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: `0.5px solid ${t.divider}`, fontSize: 13 }}>
                      <span>{c?.emoji}</span>
                      <span style={{ flex: 1 }}>{c?.name ?? "—"}</span>
                      <span style={{ fontFamily: t.mono }}>{fmtMoney(s.amountCents, { cents: true })}</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 11, color: t.faint, marginTop: 6 }}>Edit individual items from the Edit dialog.</div>
              </div>
            )}
            {!movement && !split && (
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>Category</span>
                <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)} style={fieldStyle}>
                  {catItems.map((c) => <option key={c.id} value={c.id}>{c.depth ? "— " : ""}{c.emoji} {c.label}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <span style={{ color: t.dim }}>{movement ? "From" : "Account"}</span>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={fieldStyle}>
                {(movement && movementKind(accounts.find((a) => a.id === toAccountId)?.subtype) === "payment"
                  ? accountOptions.filter((a) => isPaymentSource(a.subtype) || a.id === accountId)
                  : accountOptions).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {movement && (
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>To</span>
                <select value={toAccountId ?? ""} onChange={(e) => setToAccountId(e.target.value || null)} style={fieldStyle}>
                  {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
            </label>
            {timeEnabled && (
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={fieldStyle} />
              </label>
            )}
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, gap: 10 }}>
              <span style={{ color: t.dim }}>Note</span>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="—" style={{ ...fieldStyle, flex: 1 }} />
            </label>
            {!movement && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: t.dim }}>Exclude from reporting</span>
                <button type="button" role="switch" aria-checked={excluded} aria-label="Exclude from reporting" onClick={() => setExcluded((v) => !v)}
                  style={{ width: 38, height: 22, borderRadius: 99, border: "none", background: excluded ? t.opening : t.panel3, position: "relative", cursor: "pointer" }}>
                  <span style={{ position: "absolute", top: 2, left: excluded ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: excluded ? t.onAccent : t.dim, transition: "left .15s" }} />
                </button>
              </div>
            )}
            {tx.kind === "expense" && (tx.reimbursedCents > 0 || tx.expectedReimbursementCents != null) && (
              <div style={{ fontSize: 12.5, background: t.panel2, borderRadius: 8, padding: "9px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: t.dim }}>Reimbursed</span>
                  <span style={{ fontFamily: t.mono }}>{fmtMoney(tx.reimbursedCents, { cents: true })} of {fmtMoney(tx.amountCents, { cents: true })}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: t.dim }}>Net cost</span>
                  <b style={{ fontFamily: t.mono }}>{fmtMoney(tx.amountCents - tx.reimbursedCents, { cents: true })}</b>
                </div>
                {outstandingCents(tx) > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: t.dim }}>Still expected</span>
                    <span style={{ fontFamily: t.mono, color: t.transfer }}>{fmtMoney(outstandingCents(tx), { cents: true })}</span>
                  </div>
                )}
              </div>
            )}
            {canReimburse && <Btn variant="outline" icon="reimburse" size="sm" onClick={onReimburse} style={{ justifyContent: "center" }}>Record reimbursement</Btn>}
            {error && <div style={{ fontSize: 12, color: t.expense, background: hexA(t.expense, 0.12), padding: "7px 10px", borderRadius: 7 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <Btn size="sm" onClick={save} disabled={busy || (timeEnabled && !time)} style={{ flex: 1, justifyContent: "center" }}>Save</Btn>
              <Btn variant="outline" icon="copy" size="sm" onClick={onDuplicate} style={{ flex: 1, justifyContent: "center" }}>Duplicate</Btn>
            </div>
            <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ justifyContent: "center" }}>Delete</Btn>
          </>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Date</span><span style={{ fontWeight: 600 }}>{fmtDate(tx.transactionDate)}{tx.transactionTime ? ` · ${fmtTime(tx.transactionTime)}` : ""}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: t.dim }}>Account</span><span style={{ fontWeight: 600 }}>{accountName(accounts, tx.accountId)}</span>
            </div>
            {tx.kind === "reimbursement" && (
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: t.dim, marginBottom: 6 }}>
                  Repays {tx.allocations.length} expense{tx.allocations.length === 1 ? "" : "s"}
                </div>
                {tx.allocations.map((a) => {
                  const e = expenseOf(a.expenseId);
                  return (
                    <div key={a.expenseId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: `0.5px solid ${t.divider}`, fontSize: 13 }}>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e?.description || "Expense"}</span>
                      <span style={{ fontFamily: t.mono }}>{fmtMoney(a.amountCents, { cents: true })}</span>
                    </div>
                  );
                })}
                {onEdit && <Btn variant="outline" icon="pencil" size="sm" onClick={onEdit} style={{ justifyContent: "center", marginTop: 10, width: "100%" }}>Edit reimbursement</Btn>}
              </div>
            )}
            <div style={{ fontSize: 12, color: t.dim, background: t.panel2, padding: "8px 12px", borderRadius: 8, display: "flex", gap: 7, alignItems: "center" }}>
              <Icon name={meta.icon} size={14} color={color} />
              {tx.kind === "opening" ? "The opening balance is set from the account."
                : tx.kind === "reimbursement" ? "Money back for expenses you already booked. It never counts as income."
                : "Adjustments can be deleted but not edited."}
            </div>
            {tx.kind !== "opening" && <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ justifyContent: "center" }}>Delete</Btn>}
          </>
        )}
      </div>
    </Card>
  );
}
