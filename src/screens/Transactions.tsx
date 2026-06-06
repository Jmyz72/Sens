// Transactions: searchable, filterable log grouped by date, with a detail
// panel for edit/delete. Adjustments can be deleted but not edited.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Transaction, TransactionKind, UpdateTransactionInput } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Empty, IconBtn, Money, Pill } from "../components/ui";
import { Icon } from "../components/Icon";
import { TxnRow } from "../components/TxnRow";
import { TxnDetailPanel } from "../components/TxnDetailPanel";
import { TxnSelectionPanel } from "../components/TxnSelectionPanel";
import { BulkPreviewSheet, type BulkTarget } from "../components/BulkPreviewSheet";
import { TargetPicker } from "../components/TargetPicker";
import { client } from "../client";
import { useAppData, accountName } from "../store";
import { dateGroupLabel, nowTimeHHMM, todayISO } from "../lib/format";
import { KIND_META, kindColor, txnSortKey } from "../lib/kinds";
import { AddTransaction } from "../modals/AddTransaction";
import { rangeForPreset, type DateRangePreset, type CustomRange } from "../lib/txnFilters";
import { planBulk, type BulkAction } from "../lib/txnSelection";
import { useToast } from "../components/Toast";
import { useTimeSetting } from "../lib/useTimeSetting";

const KIND_FILTERS: TransactionKind[] = ["income", "expense", "transfer", "adjustment", "opening"];

export function Transactions({ initialAccountId }: { initialAccountId?: string | null }) {
  const t = useTheme();
  const { notify } = useToast();
  const { accounts, categories, reload, version } = useAppData();
  const [timeEnabled] = useTimeSetting();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<TransactionKind>>(new Set());
  const [acctFilter, setAcctFilter] = useState<string | null>(initialAccountId ?? null);
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [preset, setPreset] = useState<DateRangePreset>("thisMonth");
  const [custom, setCustom] = useState<CustomRange>({});
  const [sort, setSort] = useState<"date-desc" | "date-asc" | "amount-desc" | "amount-asc">("date-desc");
  const [density, setDensity] = useState<"comfortable" | "compact">(
    () => (localStorage.getItem("sens.txn.density") as "comfortable" | "compact") || "comfortable",
  );
  useEffect(() => { localStorage.setItem("sens.txn.density", density); }, [density]);

  useEffect(() => {
    const r = rangeForPreset(preset, todayISO(), custom);
    client.listTransactions({ limit: 1000, ...r }).then(setTxns).catch(() => {});
  }, [version, preset, custom]);
  useEffect(() => { setAcctFilter(initialAccountId ?? null); }, [initialAccountId]);
  useEffect(() => { setSelectedIds(new Set()); }, [preset, custom]);

  const toggleKind = (k: TransactionKind) => setKinds((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return txns.filter((tx) => {
      if (acctFilter && tx.accountId !== acctFilter && tx.toAccountId !== acctFilter) return false;
      if (kinds.size && !kinds.has(tx.kind)) return false;
      if (!q) return true;
      const cat = categories.find((c) => c.id === tx.categoryId)?.name ?? "";
      return (tx.description ?? "").toLowerCase().includes(q) || cat.toLowerCase().includes(q) || accountName(accounts, tx.accountId).toLowerCase().includes(q);
    });
  }, [txns, kinds, query, categories, accounts, acctFilter]);

  const totalIn = filtered.filter((x) => x.kind === "income" && !x.excludedFromReporting).reduce((s, x) => s + x.amountCents, 0);
  const totalOut = filtered.filter((x) => x.kind === "expense" && !x.excludedFromReporting).reduce((s, x) => s + x.amountCents, 0);

  const groups = useMemo(() => {
    const byDate = new Map<string, Transaction[]>();
    for (const tx of filtered) {
      const arr = byDate.get(tx.transactionDate) ?? [];
      arr.push(tx);
      byDate.set(tx.transactionDate, arr);
    }
    const cmp = (a: Transaction, b: Transaction) => {
      if (sort === "amount-desc") { const d = b.amountCents - a.amountCents; if (d) return d; }
      else if (sort === "amount-asc") { const d = a.amountCents - b.amountCents; if (d) return d; }
      const ka = txnSortKey(a), kb = txnSortKey(b);
      return sort === "date-asc" ? (ka < kb ? -1 : ka > kb ? 1 : 0) : (ka < kb ? 1 : ka > kb ? -1 : 0);
    };
    const dates = [...byDate.keys()].sort((a, b) =>
      sort === "date-asc" ? (a < b ? -1 : a > b ? 1 : 0) : (a < b ? 1 : a > b ? -1 : 0),
    );
    return dates.map((date) => ({ date, items: byDate.get(date)!.sort(cmp) }));
  }, [filtered, sort]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((id: string) => setSelectedIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);

  // Prune selection to rows still in view, so bulk actions never touch rows
  // the user has filtered/searched out of sight.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map((x) => x.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (visible.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
  }, [filtered]);

  // Bulk action state
  const [pending, setPending] = useState<{ action: BulkAction; target?: BulkTarget } | null>(null);
  const [pickFor, setPickFor] = useState<BulkAction | null>(null);
  const selectedTxns = useMemo(() => txns.filter((x) => selectedIds.has(x.id)), [txns, selectedIds]);

  function dayNet(items: Transaction[]): number {
    return items.reduce((s, x) =>
      s + (x.kind === "income" && !x.excludedFromReporting ? x.amountCents
         : x.kind === "expense" && !x.excludedFromReporting ? -x.amountCents
         : 0), 0);
  }

  const sel = txns.find((x) => x.id === selId) ?? null;

  const onDelete = useCallback(async (id: string) => {
    if (!window.confirm("Delete this transaction? This can't be undone.")) return;
    await client.deleteTransaction(id);
    setSelId(null);
    await reload();
  }, [reload]);

  // Read the preview preference fresh at action time so a Settings change takes
  // effect without remounting this screen.
  async function isPreviewOn(): Promise<boolean> {
    try { return (await client.getSetting("bulk_action_preview")) !== "0"; }
    catch { return true; }
  }

  async function applyBulk(action: BulkAction, ids: string[], target?: BulkTarget) {
    const toApply = txns.filter((x) => ids.includes(x.id));
    const skipped = selectedTxns.length - toApply.length;
    // Resilient: each row applies independently so one failure doesn't abort the
    // rest, and the toast reports the true success/failure split.
    let failed = 0;
    for (const tx of toApply) {
      try {
        if (action === "delete") { await client.deleteTransaction(tx.id); continue; }
        const input: UpdateTransactionInput = {
          id: tx.id, kind: tx.kind, accountId: tx.accountId, toAccountId: tx.toAccountId,
          categoryId: tx.categoryId, amountCents: tx.amountCents, description: tx.description,
          transactionDate: tx.transactionDate, transactionTime: tx.transactionTime,
          excludedFromReporting: tx.excludedFromReporting,
          splits: tx.splits.length >= 2 ? tx.splits : null,
        };
        if (action === "recategorize") {
          const cat = tx.kind === "income" ? target?.incomeCategory : tx.kind === "expense" ? target?.expenseCategory : undefined;
          if (!cat) continue; // defensive — ids are pre-filtered to rows whose kind has a target
          input.categoryId = cat.id;
        }
        if (action === "move" && target?.accountId) input.accountId = target.accountId;
        if (action === "exclude") input.excludedFromReporting = true;
        if (action === "include") input.excludedFromReporting = false;
        await client.updateTransaction(input);
      } catch { failed++; }
    }
    const succeeded = toApply.length - failed;
    setSelectedIds(new Set());
    setPending(null);
    await reload();
    if (failed > 0) {
      notify(`${failed} couldn't be updated${succeeded > 0 ? ` · ${succeeded} done` : ""}`, "error");
      return;
    }
    const verb = { recategorize: "Re-categorized", move: "Moved", exclude: "Excluded", include: "Included", delete: "Deleted" }[action];
    notify(`${verb} ${succeeded}${skipped > 0 ? ` · ${skipped} skipped` : ""}`);
  }

  async function startBulk(action: BulkAction) {
    if (action === "recategorize" || action === "move") {
      setPickFor(action);
      return;
    }
    const plan = planBulk(action, selectedTxns);
    if (await isPreviewOn()) {
      setPending({ action });
      return;
    }
    if (action === "delete") {
      if (!window.confirm(`Delete ${plan.changeable.length} transaction(s)? This can't be undone.`)) return;
    }
    applyBulk(action, plan.changeable.map((x) => x.id));
  }

  async function chooseTarget(action: BulkAction, target: BulkTarget) {
    setPickFor(null);
    const plan = planBulk(action, selectedTxns, target);
    if (await isPreviewOn()) { setPending({ action, target }); return; }
    applyBulk(action, plan.changeable.map((x) => x.id), target);
  }

  async function onDuplicate(tx: Transaction) {
    const dupTime = tx.transactionTime ?? (timeEnabled ? nowTimeHHMM() : null);
    const splits = tx.splits.length >= 2 ? tx.splits : null;
    try {
      if (tx.kind === "income" && (tx.categoryId || splits))
        await client.createIncome(tx.accountId, splits ? null : tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, dupTime, tx.excludedFromReporting, splits);
      else if (tx.kind === "expense" && (tx.categoryId || splits))
        await client.createExpense(tx.accountId, splits ? null : tx.categoryId, tx.amountCents, tx.description, tx.transactionDate, dupTime, tx.excludedFromReporting, splits);
      else if (tx.kind === "transfer" && tx.toAccountId)
        await client.createTransfer(tx.accountId, tx.toAccountId, tx.amountCents, tx.description, tx.transactionDate, dupTime);
      else return;
      await reload();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Couldn't duplicate transaction", "error");
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const flat = groups.flatMap((g) => g.items);
      const idx = flat.findIndex((x) => x.id === selId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const n = flat[Math.min(idx + 1, flat.length - 1)];
        if (n) setSelId(n.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const n = flat[Math.max(idx - 1, 0)];
        if (n) setSelId(n.id);
      } else if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSelectedIds(new Set(flat.map((x) => x.id)));
      } else if (e.key === "Escape") {
        if (selectedIds.size) setSelectedIds(new Set());
        else setSelId(null);
      } else if (e.key === " " && selId) {
        e.preventDefault();
        toggleSelect(selId);
      } else if ((e.key === "e" || e.key === "E") && sel && sel.kind !== "adjustment" && sel.kind !== "opening") {
        setEditing(sel);
      } else if ((e.key === "Backspace" || e.key === "Delete") && sel && sel.kind !== "opening") {
        onDelete(sel.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, selId, sel, selectedIds, toggleSelect, onDelete]);

  return (
    <div className="sens-screen" style={{ display: "grid", gridTemplateColumns: ((sel && selectedIds.size === 0) || selectedIds.size > 0) ? "1fr minmax(0, 300px)" : "1fr", gap: 14, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        {/* Row 1: search + date presets + density toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px", background: t.panel, border: `0.5px solid ${t.border}`, borderRadius: 9, flex: 1, minWidth: 180 }}>
            <Icon name="search" size={15} color={t.faint} />
            <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions"
              style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {(["thisMonth", "lastMonth", "custom", "all"] as DateRangePreset[]).map((p) => (
              <button key={p} type="button" onClick={() => setPreset(p)}
                style={{ height: 34, padding: "0 12px", fontSize: 12.5, border: `0.5px solid ${t.border}`,
                  background: preset === p ? t.panel3 : t.panel, color: preset === p ? t.text : t.dim,
                  borderRadius: 9, cursor: "pointer", fontFamily: t.font }}>
                {p === "thisMonth" ? "This month" : p === "lastMonth" ? "Last month" : p === "custom" ? "Custom" : "All"}
              </button>
            ))}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Sort transactions"
            style={{ height: 34, padding: "0 10px", fontSize: 12.5, border: `0.5px solid ${t.border}`,
              background: t.panel, color: t.dim, borderRadius: 9, cursor: "pointer", fontFamily: t.font }}>
            <option value="date-desc">Date ↓</option>
            <option value="date-asc">Date ↑</option>
            <option value="amount-desc">Amount ↓</option>
            <option value="amount-asc">Amount ↑</option>
          </select>
          <button type="button" onClick={() => setDensity((d) => d === "compact" ? "comfortable" : "compact")}
            title="Toggle density" style={{ height: 34, padding: "0 12px", border: `0.5px solid ${t.border}`,
              background: t.panel, color: t.dim, borderRadius: 9, cursor: "pointer", fontFamily: t.font, fontSize: 12.5 }}>
            {density === "compact" ? "Comfortable" : "Compact"}
          </button>
        </div>

        {/* Custom date range inputs */}
        {preset === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: t.dim }}>From</span>
            <input type="date" value={custom.fromDate ?? ""} onChange={(e) => setCustom((c) => ({ ...c, fromDate: e.target.value || undefined }))}
              style={{ height: 34, padding: "0 10px", fontSize: 12.5, border: `0.5px solid ${t.borderStrong}`,
                background: t.panel2, color: t.text, borderRadius: 8, fontFamily: t.font, cursor: "pointer" }} />
            <span style={{ fontSize: 12.5, color: t.dim }}>To</span>
            <input type="date" value={custom.toDateInclusive ?? ""} onChange={(e) => setCustom((c) => ({ ...c, toDateInclusive: e.target.value || undefined }))}
              style={{ height: 34, padding: "0 10px", fontSize: 12.5, border: `0.5px solid ${t.borderStrong}`,
                background: t.panel2, color: t.text, borderRadius: 8, fontFamily: t.font, cursor: "pointer" }} />
          </div>
        )}

        {/* Row 2: kind chips + account pill + live totals */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {acctFilter && <Pill on onClick={() => setAcctFilter(null)}>Account: {accountName(accounts, acctFilter)} ✕</Pill>}
          {KIND_FILTERS.map((k) => <Pill key={k} on={kinds.has(k)} dot={kindColor(t, k)} onClick={() => toggleKind(k)}>{KIND_META[k].label}</Pill>)}
          {kinds.size > 0 && <Pill onClick={() => setKinds(new Set())}>Clear</Pill>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 12.5, flexShrink: 0 }}>
            <span style={{ color: t.dim }}>In <b style={{ color: t.income, fontFamily: t.mono }}>{(totalIn / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</b></span>
            <span style={{ color: t.dim }}>Out <b style={{ color: t.expense, fontFamily: t.mono }}>{(totalOut / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</b></span>
          </div>
        </div>

        <Card pad={0} style={{ overflow: "visible" }}>
          {groups.length === 0 && <Empty icon="list" title="No transactions match" hint="Try clearing filters or add a transaction." />}
          {groups.map((g) => (
            <div key={g.date}>
              <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "9px 18px", fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4,
                background: t.panel2, borderBottom: `0.5px solid ${t.divider}` }}>
                <span>{dateGroupLabel(g.date)}</span>
                <Money cents={dayNet(g.items)} signed size={11} weight={700} />
              </div>
              <div style={{ padding: "4px 16px" }}>
                {g.items.map((tx) => (
                  <TxnRow key={tx.id} tx={tx} accounts={accounts} categories={categories} showDate={false}
                    density={density} selected={selectedIds.has(tx.id)} onToggleSelect={() => toggleSelect(tx.id)}
                    onClick={() => setSelId(tx.id)}
                    quickActions={<>
                      {tx.kind !== "adjustment" && tx.kind !== "opening" && <IconBtn name="pencil" icon={13} onClick={() => setEditing(tx)} title="Edit" />}
                      {tx.kind !== "adjustment" && tx.kind !== "opening" && <IconBtn name="copy" icon={13} onClick={() => onDuplicate(tx)} title="Duplicate" />}
                      {tx.kind !== "opening" && <IconBtn name="trash" icon={13} onClick={() => onDelete(tx.id)} title="Delete" />}
                    </>} />
                ))}
              </div>
            </div>
          ))}
        </Card>
      </div>

      {sel && selectedIds.size === 0 && (
        <TxnDetailPanel key={sel.id} tx={sel} accounts={accounts} categories={categories} allTxns={txns}
          onClose={() => setSelId(null)} onDuplicate={() => onDuplicate(sel)} onDelete={() => onDelete(sel.id)}
          onSaved={() => { reload(); }} />
      )}

      {selectedIds.size > 0 && (
        <TxnSelectionPanel
          selected={selectedTxns}
          onClear={() => setSelectedIds(new Set())}
          onAction={startBulk}
        />
      )}

      {pending && (
        <BulkPreviewSheet
          plan={planBulk(pending.action, selectedTxns, pending.target)}
          target={pending.target}
          accounts={accounts}
          onCancel={() => setPending(null)}
          onApply={(ids) => applyBulk(pending.action, ids, pending.target)}
          onChangeTarget={
            pending.action === "recategorize" || pending.action === "move"
              ? () => { setPending(null); setPickFor(pending.action); }
              : undefined
          }
        />
      )}

      {pickFor && (
        <TargetPicker
          action={pickFor}
          accounts={accounts}
          categories={categories}
          selected={selectedTxns}
          onCancel={() => setPickFor(null)}
          onChoose={(target) => chooseTarget(pickFor, target)}
        />
      )}

      {editing && <AddTransaction accounts={accounts} categories={categories} editing={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
