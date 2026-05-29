// Transactions: searchable, filterable log grouped by date, with a detail
// panel for edit/delete. Adjustments can be deleted but not edited.

import { useEffect, useMemo, useState } from "react";
import type { Transaction, TransactionKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Card, Empty, GlyphTile, IconBtn, Money, Pill } from "../components/ui";
import { Icon } from "../components/Icon";
import { TxnRow } from "../components/TxnRow";
import { client } from "../client";
import { useAppData, accountName } from "../store";
import { fmtDate, dateGroupLabel } from "../lib/format";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { AddTransaction } from "../modals/AddTransaction";

const KIND_FILTERS: TransactionKind[] = ["income", "expense", "transfer", "adjustment"];

export function Transactions() {
  const t = useTheme();
  const { accounts, categories, reload, version } = useAppData();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<TransactionKind>>(new Set());
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);

  useEffect(() => { client.listTransactions({ limit: 500 }).then(setTxns).catch(() => {}); }, [version]);

  const toggleKind = (k: TransactionKind) => setKinds((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return txns.filter((tx) => {
      if (kinds.size && !kinds.has(tx.kind)) return false;
      if (!q) return true;
      const cat = categories.find((c) => c.id === tx.categoryId)?.name ?? "";
      return (tx.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || accountName(accounts, tx.accountId).toLowerCase().includes(q);
    });
  }, [txns, kinds, query, categories, accounts]);

  const totalIn = filtered.filter((x) => x.kind === "income").reduce((s, x) => s + x.amountCents, 0);
  const totalOut = filtered.filter((x) => x.kind === "expense").reduce((s, x) => s + x.amountCents, 0);

  const groups: { date: string; items: Transaction[] }[] = [];
  filtered.forEach((tx) => {
    let g = groups.find((x) => x.date === tx.transactionDate);
    if (!g) { g = { date: tx.transactionDate, items: [] }; groups.push(g); }
    g.items.push(tx);
  });

  const sel = txns.find((x) => x.id === selId) ?? null;

  async function onDelete(id: string) {
    await client.deleteTransaction(id);
    setSelId(null);
    await reload();
  }

  return (
    <div className="sens-screen" style={{ display: "grid", gridTemplateColumns: sel ? "1fr 320px" : "1fr", gap: 14, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px", background: t.panel, border: `0.5px solid ${t.border}`, borderRadius: 9, flex: 1, minWidth: 200 }}>
            <Icon name="search" size={15} color={t.faint} />
            <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions"
              style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
            <span style={{ color: t.dim }}>In <b style={{ color: t.income, fontFamily: t.mono }}>{(totalIn / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</b></span>
            <span style={{ color: t.dim }}>Out <b style={{ color: t.expense, fontFamily: t.mono }}>{(totalOut / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</b></span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {KIND_FILTERS.map((k) => <Pill key={k} on={kinds.has(k)} dot={kindColor(t, k)} onClick={() => toggleKind(k)}>{KIND_META[k].label}</Pill>)}
          {kinds.size > 0 && <Pill onClick={() => setKinds(new Set())}>Clear</Pill>}
        </div>

        <Card pad={0} style={{ overflow: "hidden" }}>
          {groups.length === 0 && <Empty icon="list" title="No transactions match" hint="Try clearing filters or add a transaction." />}
          {groups.map((g) => (
            <div key={g.date}>
              <div style={{ padding: "9px 18px", fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4, background: t.panel2, borderBottom: `0.5px solid ${t.divider}` }}>{dateGroupLabel(g.date)}</div>
              <div style={{ padding: "4px 16px" }}>
                {g.items.map((tx) => (
                  <div key={tx.id} style={{ borderRadius: 9, background: selId === tx.id ? hexA(t.accent, 0.08) : "transparent" }}>
                    <TxnRow tx={tx} accounts={accounts} categories={categories} showDate={false} onClick={() => setSelId(tx.id)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Card>
      </div>

      {sel && <DetailPanel tx={sel} onClose={() => setSelId(null)} onEdit={() => setEditing(sel)} onDelete={() => onDelete(sel.id)} />}

      {editing && <AddTransaction accounts={accounts} categories={categories} editing={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function DetailPanel({ tx, onClose, onEdit, onDelete }: { tx: Transaction; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const t = useTheme();
  const { accounts, categories } = useAppData();
  const cat = categories.find((c) => c.id === tx.categoryId);
  const meta = KIND_META[tx.kind];
  const color = kindColor(t, tx.kind);
  const isAdjustment = tx.kind === "adjustment";
  const signedCents = signedFor(tx.kind, tx.amountCents, false);
  const rows: [string, string][] = [
    ["Type", meta.label],
    ["Date", fmtDate(tx.transactionDate)],
  ];
  if (tx.kind === "transfer") {
    rows.push(["From", accountName(accounts, tx.accountId)], ["To", accountName(accounts, tx.toAccountId)]);
  } else {
    rows.push(["Account", accountName(accounts, tx.accountId)]);
    if (cat) rows.push(["Category", `${cat.emoji} ${cat.name}`]);
  }

  return (
    <Card className="sens-pop" pad={0} style={{ overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 0 }}>
      <div style={{ padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          {cat ? <GlyphTile tone={cat.color ?? color} size={40} emoji={cat.emoji} /> : <GlyphTile tone={color} size={40} icon={meta.icon} />}
          <IconBtn name="close" onClick={onClose} title="Close" icon={16} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{tx.description || cat?.name || meta.label}</div>
        <div style={{ marginTop: 6 }}>
          <Money cents={tx.kind === "transfer" ? tx.amountCents : signedCents} signed={tx.kind !== "transfer"} color={tx.kind === "transfer" ? color : undefined} size={26} weight={700} />
        </div>
      </div>
      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: t.dim }}>{k}</span><span style={{ fontWeight: 600, textAlign: "right" }}>{v}</span>
          </div>
        ))}
        {isAdjustment && (
          <div style={{ fontSize: 12, color: t.dim, background: t.panel2, padding: "8px 12px", borderRadius: 8, display: "flex", gap: 7, alignItems: "center" }}>
            <Icon name="sliders" size={14} color={t.adjustment} /> Adjustments can be deleted but not edited.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          {!isAdjustment && <Btn variant="outline" icon="pencil" size="sm" onClick={onEdit} style={{ flex: 1, justifyContent: "center" }}>Edit</Btn>}
          <Btn variant="danger" icon="trash" size="sm" onClick={onDelete} style={{ flex: 1, justifyContent: "center" }}>Delete</Btn>
        </div>
      </div>
    </Card>
  );
}
