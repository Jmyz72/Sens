// Accounts: net-worth header (with monthly delta + trend sparkline), accounts
// grouped by type with dense insight rows (sparkline + monthly change + stats),
// each expandable into a period-selectable balance chart, In/Out/Net tiles,
// actions, and recent activity. All stats are computed on the frontend from a
// one-time bulk fetch of transactions (src/lib/accountStats.ts). Archived
// accounts are excluded from net worth.

import { useEffect, useMemo, useState } from "react";
import type { Account, AccountTypeName, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import type { Theme } from "../theme/tokens";
import { Btn, Card, Empty, Money } from "../components/ui";
import { Icon } from "../components/Icon";
import { TxnRow } from "../components/TxnRow";
import { Sparkline } from "../components/Sparkline";
import { client } from "../client";
import { useAppData } from "../store";
import { SetBalance } from "../modals/SetBalance";
import { EditAccount } from "../modals/EditAccount";
import { AddAccount } from "../modals/AddAccount";
import { ProviderLogo } from "../components/ProviderLogo";
import { balanceDisplay, toneColor, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
import { useToast } from "../components/Toast";
import { computeRunningBalances, txnSortKey } from "../lib/kinds";
import { fmtDate, fmtMoney, todayISO } from "../lib/format";
import {
  accountTxns, balanceSeries, computeAccountStats, netWorthStats, periodFromDate,
  type AccountStats, type ChartPeriod,
} from "../lib/accountStats";

const ACTIVITY_DISPLAY_LIMIT = 8;
const PERIODS: ChartPeriod[] = ["1M", "3M", "6M", "1Y", "All"];

function Delta({ cents, t, size = 11 }: { cents: number; t: Theme; size?: number }) {
  if (cents === 0) return <span style={{ fontSize: size, color: t.faint, fontFamily: t.mono }}>—</span>;
  const up = cents > 0;
  return (
    <span style={{ fontSize: size, color: up ? t.income : t.negative, fontFamily: t.mono, whiteSpace: "nowrap" }}>
      {up ? "▲" : "▼"} {fmtMoney(Math.abs(cents))}
    </span>
  );
}

export function Accounts({ go }: { go: (id: string, opts?: { accountId?: string }) => void }) {
  const t = useTheme();
  const { categories, reload, version } = useAppData();
  const { notify } = useToast();
  const today = useMemo(() => todayISO(), []);
  const [showArchived, setShowArchived] = useState(false);
  const [all, setAll] = useState<Account[]>([]);
  const [allTxns, setAllTxns] = useState<Transaction[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [period, setPeriod] = useState<ChartPeriod>("3M");
  const [correcting, setCorrecting] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => { client.listAccounts(true).then(setAll).catch(() => {}); }, [version]);
  useEffect(() => {
    const PAGE = 1000; // backend clamps limit to 1000; page through to load full history
    (async () => {
      try {
        const out: Transaction[] = [];
        for (let offset = 0; ; offset += PAGE) {
          const batch = await client.listTransactions({ limit: PAGE, offset });
          out.push(...batch);
          if (batch.length < PAGE) break;
        }
        setAllTxns(out);
      } catch (e: unknown) {
        notify((e as { message?: string })?.message ?? "Failed to load activity", "error");
      }
    })();
  }, [version, notify]);

  const { stats, txnsByAccount } = useMemo(() => {
    const stats = new Map<string, AccountStats>();
    const txnsByAccount = new Map<string, Transaction[]>();
    for (const a of all) {
      txnsByAccount.set(a.id, accountTxns(allTxns, a.id));
      stats.set(a.id, computeAccountStats(a, allTxns, today));
    }
    return { stats, txnsByAccount };
  }, [all, allTxns, today]);
  const nw = useMemo(() => netWorthStats(all, allTxns, today), [all, allTxns, today]);

  const visible = all.filter((a) => showArchived || !a.isArchived);
  const active = all.filter((a) => !a.isArchived);
  const assets = active.filter((a) => a.group === "own").reduce((s, a) => s + a.balanceCents, 0);
  const liabilities = active.filter((a) => a.group === "owe").reduce((s, a) => s + a.balanceCents, 0);
  const netWorth = assets + liabilities;

  const groups = new Map<AccountTypeName, Account[]>();
  visible.forEach((a) => { if (!groups.has(a.accountType)) groups.set(a.accountType, []); groups.get(a.accountType)!.push(a); });
  const orderedGroups = TYPE_ORDER.filter((ty) => groups.has(ty)).map((ty) => [ty, groups.get(ty)!] as const);

  function toggle(id: string) {
    setOpen((cur) => (cur === id ? null : id));
    setPeriod("3M");
  }
  const afterMutation = async () => { await reload(); };

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ===== Net-worth header ===== */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: t.dim, marginBottom: 5 }}>Net worth</div>
            <Money cents={netWorth} size={28} weight={700} color={netWorth < 0 ? t.negative : t.text} />
            <div style={{ fontSize: 12, color: t.dim, marginTop: 6 }}>
              <Delta cents={nw.deltaCents} t={t} size={12} />
              {nw.pct !== null && <span style={{ color: t.faint }}> ({(nw.pct * 100).toFixed(1)}%)</span>}
              <span style={{ color: t.faint }}> this month</span>
            </div>
            <div style={{ fontSize: 12, color: t.dim, marginTop: 5 }}>
              Assets <Money cents={assets} size={12} color={t.dim} /> &nbsp;·&nbsp; Owe <Money cents={Math.abs(liabilities)} size={12} color={t.dim} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <Sparkline points={nw.series} color={t.accent} fill width={120} height={46} />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
              <Btn size="sm" icon="plus" onClick={() => setShowAdd(true)}>Add account</Btn>
            </div>
          </div>
        </div>
      </Card>

      {visible.length === 0 && <Card><Empty icon="wallet" title="No accounts yet" hint="Create one with the Add account button." /></Card>}

      {/* ===== Grouped accounts ===== */}
      {orderedGroups.map(([ty, accs]) => {
        const subtotal = accs.filter((a) => !a.isArchived).reduce((s, a) => s + a.balanceCents, 0);
        return (
          <div key={ty}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 4px 10px" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>{TYPE_LABEL[ty]}</span>
              <Money cents={subtotal} size={13} color={subtotal < 0 ? t.negative : t.dim} />
            </div>
            <Card pad={0} style={{ overflow: "hidden" }}>
              {accs.map((a, i) => {
                const isOpen = open === a.id;
                const st = stats.get(a.id);
                const txns = txnsByAccount.get(a.id) ?? [];
                const v = balanceDisplay(a.group, a.balanceCents);
                const sparkPoints = st?.sparkline ?? [];
                const trendUp = sparkPoints.length < 2 || sparkPoints[sparkPoints.length - 1] >= sparkPoints[0];
                const trendColor = trendUp ? t.income : t.negative;
                return (
                  <div key={a.id} style={{ borderTop: i ? `0.5px solid ${t.divider}` : "none", opacity: a.isArchived ? 0.55 : 1 }}>
                    {/* collapsed dense row */}
                    <div className="sens-row click" onClick={() => toggle(a.id)} style={{ display: "flex", alignItems: "center", gap: 13, padding: "0 18px", minHeight: 78 }}>
                      <ProviderLogo templateKey={a.templateKey} name={a.name} seed={a.id} size={36} radius={10} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                          {a.name}
                          {a.isArchived && <span style={{ fontSize: 10, fontWeight: 700, color: t.faint, border: `0.5px solid ${t.border}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>Archived</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: t.faint }}>
                          <span style={{ textTransform: "capitalize" }}>{a.subtype.replace(/-/g, " ")}</span>
                          {st?.lastActivityDate && <span> · last activity {fmtDate(st.lastActivityDate).toLowerCase()}</span>}
                        </div>
                        {st && st.txnCount > 0 && (
                          <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                            <span style={{ fontSize: 10, color: t.dim, background: t.panel2, borderRadius: 4, padding: "1px 5px", fontFamily: t.mono }}>{st.txnCount} txns</span>
                            <span style={{ fontSize: 10, color: t.dim, background: t.panel2, borderRadius: 4, padding: "1px 5px", fontFamily: t.mono }}>avg {fmtMoney(st.avgMonthlyOutCents)}/mo</span>
                          </div>
                        )}
                      </div>
                      {sparkPoints.length >= 2 && <Sparkline points={sparkPoints} color={trendColor} fill width={64} height={28} />}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        {v.label && <span style={{ fontSize: 10, color: t.faint }}>{v.label}</span>}
                        <Money cents={v.magnitude} size={15} color={toneColor(v.tone, t)} />
                        {st && <Delta cents={st.monthChangeCents} t={t} />}
                      </div>
                      <Icon name="chevronDown" size={15} color={t.faint} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                    </div>

                    {/* expanded panel */}
                    {isOpen && (() => {
                      const running = txns.length > 0 ? computeRunningBalances(txns, a.id) : new Map<string, number>();
                      const recent = [...txns].sort((x, y) => { const kx = txnSortKey(x), ky = txnSortKey(y); return ky < kx ? -1 : ky > kx ? 1 : 0; }).slice(0, ACTIVITY_DISPLAY_LIMIT);
                      const hidden = txns.length - recent.length;
                      const chart = balanceSeries(a, txns, periodFromDate(period, today), 64);
                      return (
                        <div className="sens-pop" style={{ background: t.panel2, padding: "12px 18px 16px" }}>
                          {/* period tabs */}
                          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                            {PERIODS.map((p) => (
                              <button key={p} onClick={() => setPeriod(p)} style={{
                                border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 6,
                                fontFamily: t.font, color: period === p ? t.accent : t.dim, background: period === p ? t.accentSoft : "transparent",
                              }}>{p}</button>
                            ))}
                          </div>
                          {/* balance chart */}
                          <div style={{ marginBottom: 12 }}>
                            <Sparkline points={chart} color={t.accent} fill width={820} height={72} />
                          </div>
                          {/* stat tiles */}
                          {st && (
                            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                              {([
                                ["In · this month", st.inThisMonthCents, t.income],
                                ["Out · this month", st.outThisMonthCents, t.negative],
                                ["Net", st.monthChangeCents, st.monthChangeCents >= 0 ? t.income : t.negative],
                              ] as const).map(([label, cents, color]) => (
                                <div key={label} style={{ flex: 1, background: t.panel3, borderRadius: 9, padding: "9px 11px" }}>
                                  <div style={{ fontSize: 10, color: t.faint, marginBottom: 3 }}>{label}</div>
                                  <Money cents={Math.abs(cents)} size={13} color={color} />
                                </div>
                              ))}
                            </div>
                          )}
                          {/* actions */}
                          <div style={{ display: "flex", gap: 8, padding: "0 0 12px" }}>
                            <Btn variant="outline" size="sm" icon="scale" onClick={() => setCorrecting(a)}>Correct balance</Btn>
                            <Btn variant="outline" size="sm" icon="pencil" onClick={() => setEditing(a)}>Edit</Btn>
                            {a.isArchived
                              ? <Btn variant="outline" size="sm" icon="restore" onClick={() => client.restoreAccount(a.id).then(afterMutation).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to restore account", "error"))}>Restore</Btn>
                              : <Btn variant="outline" size="sm" icon="archive" onClick={() => client.archiveAccount(a.id).then(afterMutation).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to archive account", "error"))}>Archive</Btn>}
                          </div>
                          {/* recent activity */}
                          <div style={{ fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 4 }}>Recent activity</div>
                          {txns.length === 0
                            ? <div style={{ fontSize: 12.5, color: t.faint, padding: "6px 0" }}>No transactions on this account yet.</div>
                            : recent.map((tx) => (
                                <TxnRow key={tx.id} tx={tx} accounts={all} categories={categories} perspectiveAccountId={a.id} balanceAfterCents={running.get(tx.id)} />
                              ))}
                          {hidden > 0 && (
                            <div className="sens-link" onClick={() => go("transactions", { accountId: a.id })} style={{ fontSize: 11.5, color: t.accent, paddingTop: 8, textAlign: "center", cursor: "pointer", fontWeight: 600 }}>
                              View all {txns.length} transactions →
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </Card>
          </div>
        );
      })}

      {correcting && <SetBalance account={correcting} hasTransactions={(txnsByAccount.get(correcting.id)?.some((t) => t.kind !== "opening") ?? false) || correcting.balanceCents !== correcting.openingBalanceCents} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); afterMutation(); }} />}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); afterMutation(); }} />}
      {showAdd && <AddAccount onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); afterMutation(); }} />}
    </div>
  );
}
