// Accounts: total balance summary, accounts grouped by type, each expandable
// to show recent activity, with per-account actions (correct balance, edit,
// archive/restore). Archived accounts are excluded from the total.

import { useEffect, useState } from "react";
import type { Account, AccountTypeName, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Card, Empty, GlyphTile, Money } from "../components/ui";
import { Icon } from "../components/Icon";
import { TxnRow } from "../components/TxnRow";
import { client } from "../client";
import { useAppData } from "../store";
import { SetBalance } from "../modals/SetBalance";
import { EditAccount } from "../modals/EditAccount";
import { accountTone } from "../lib/brand";
import { balanceDisplay, toneColor, TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";
import { useToast } from "../components/Toast";
import { computeRunningBalances } from "../lib/kinds";

const ACTIVITY_DISPLAY_LIMIT = 8;
const ACTIVITY_FETCH_LIMIT = 500;


export function Accounts() {
  const t = useTheme();
  const { accounts, categories, reload, version } = useAppData();
  const { notify } = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [all, setAll] = useState<Account[]>(accounts);
  const [open, setOpen] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, Transaction[]>>({});
  const [correcting, setCorrecting] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);

  useEffect(() => { client.listAccounts(true).then(setAll).catch(() => {}); }, [version]);

  const visible = all.filter((a) => showArchived || !a.isArchived);
  const active = all.filter((a) => !a.isArchived);
  const assets = active.filter((a) => a.group === "own").reduce((s, a) => s + a.balanceCents, 0);
  const liabilities = active.filter((a) => a.group === "owe").reduce((s, a) => s + a.balanceCents, 0);
  const netWorth = assets + liabilities;

  const groups = new Map<AccountTypeName, Account[]>();
  visible.forEach((a) => {
    if (!groups.has(a.accountType)) groups.set(a.accountType, []);
    groups.get(a.accountType)!.push(a);
  });
  const orderedGroups = TYPE_ORDER.filter((ty) => groups.has(ty)).map((ty) => [ty, groups.get(ty)!] as const);

  async function toggle(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!activity[id]) {
      const txns = await client.listTransactions({ accountId: id, limit: ACTIVITY_FETCH_LIMIT });
      setActivity((m) => ({ ...m, [id]: txns }));
    }
  }
  const refreshActivity = async (id: string) => {
    const txns = await client.listTransactions({ accountId: id, limit: ACTIVITY_FETCH_LIMIT });
    setActivity((m) => ({ ...m, [id]: txns }));
  };
  const afterMutation = async (id?: string) => { await reload(); if (id) await refreshActivity(id); };

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 880 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, color: t.dim, marginBottom: 5 }}>Net worth</div>
            <Money cents={netWorth} size={28} weight={700} color={netWorth < 0 ? t.negative : t.text} />
            <div style={{ fontSize: 12, color: t.dim, marginTop: 6 }}>
              Assets <Money cents={assets} size={12} color={t.dim} /> &nbsp;·&nbsp; Owe <Money cents={Math.abs(liabilities)} size={12} color={t.dim} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="outline" size="md" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "Hide archived" : "Show archived"}</Btn>
          </div>
        </div>
      </Card>

      {visible.length === 0 && <Card><Empty icon="wallet" title="No accounts yet" hint="Create one from the Add menu." /></Card>}

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
                const acts = activity[a.id] ?? [];
                return (
                  <div key={a.id} style={{ borderTop: i ? `0.5px solid ${t.divider}` : "none", opacity: a.isArchived ? 0.55 : 1 }}>
                    <div className="sens-row click" onClick={() => toggle(a.id)} style={{ display: "flex", alignItems: "center", gap: 13, padding: "0 18px", height: 62 }}>
                      <GlyphTile tone={accountTone({ templateKey: a.templateKey, fallbackSeed: a.id }, t.accent)} size={36} emoji={a.name[0]} radius={10} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                          {a.name}
                          {a.isArchived && <span style={{ fontSize: 10, fontWeight: 700, color: t.faint, border: `0.5px solid ${t.border}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>Archived</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: t.faint, textTransform: "capitalize" }}>{a.subtype.replace(/-/g, " ")}</div>
                      </div>
                      {(() => {
                        const v = balanceDisplay(a.group, a.balanceCents);
                        return (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                            {v.label && <span style={{ fontSize: 10, color: t.faint }}>{v.label}</span>}
                            <Money cents={v.magnitude} size={15} color={toneColor(v.tone, t)} />
                          </div>
                        );
                      })()}
                      <Icon name="chevronDown" size={15} color={t.faint} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                    </div>
                    {isOpen && (() => {
                      // Compute running balances over the full fetched history (ascending order),
                      // then display only the most recent ACTIVITY_DISPLAY_LIMIT rows (newest-first).
                      const runningBalances = acts.length > 0
                        ? computeRunningBalances(acts, a.id, a.openingBalanceCents)
                        : new Map<string, number>();
                      const displayActs = acts.slice(0, ACTIVITY_DISPLAY_LIMIT);
                      const hiddenCount = acts.length - displayActs.length;
                      return (
                        <div className="sens-pop" style={{ background: t.panel2, padding: "8px 18px 16px" }}>
                          <div style={{ display: "flex", gap: 8, padding: "4px 0 12px" }}>
                            <Btn variant="outline" size="sm" icon="scale" onClick={() => setCorrecting(a)}>Correct balance</Btn>
                            <Btn variant="outline" size="sm" icon="pencil" onClick={() => setEditing(a)}>Edit</Btn>
                            {a.isArchived
                              ? <Btn variant="outline" size="sm" icon="restore" onClick={() => client.restoreAccount(a.id).then(() => afterMutation(a.id)).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to restore account", "error"))}>Restore</Btn>
                              : <Btn variant="outline" size="sm" icon="archive" onClick={() => client.archiveAccount(a.id).then(() => afterMutation(a.id)).catch((e: unknown) => notify((e as { message?: string })?.message ?? "Failed to archive account", "error"))}>Archive</Btn>}
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 4 }}>Recent activity</div>
                          {acts.length === 0
                            ? <div style={{ fontSize: 12.5, color: t.faint, padding: "6px 0" }}>No transactions on this account yet.</div>
                            : displayActs.map((tx) => (
                                <TxnRow
                                  key={tx.id}
                                  tx={tx}
                                  accounts={all}
                                  categories={categories}
                                  perspectiveAccountId={a.id}
                                  balanceAfterCents={runningBalances.get(tx.id)}
                                />
                              ))}
                          {hiddenCount > 0 && (
                            <div style={{ fontSize: 11.5, color: t.faint, paddingTop: 6, textAlign: "center" }}>
                              +{hiddenCount} older transaction{hiddenCount !== 1 ? "s" : ""}
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

      {correcting && <SetBalance account={correcting} hasTransactions={(activity[correcting.id]?.length ?? 0) > 0 || correcting.balanceCents !== correcting.openingBalanceCents} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); afterMutation(open ?? undefined); }} />}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); afterMutation(open ?? undefined); }} />}
    </div>
  );
}
