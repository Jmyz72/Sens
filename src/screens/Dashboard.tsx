// Dashboard: month-scoped overview. A unified hero (net worth + this-month
// KPIs), a full-width spending breakdown, an auto-fit grid of account tiles,
// and recent transactions. Income/expense/cashflow exclude transfers,
// adjustments, opening, and non-cashflow rows (the backend enforces this).

import { useEffect, useMemo, useState } from "react";
import type { DashboardSummary } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Empty, Money, SectionTitle } from "../components/ui";
import { TxnRow } from "../components/TxnRow";
import { ProviderLogo } from "../components/ProviderLogo";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { client } from "../client";
import { useAppData } from "../store";
import { balanceDisplay, toneColor } from "../lib/accounts";
import { useToast } from "../components/Toast";

function DashboardSkeleton() {
  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero */}
      <Card pad={22}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 28, alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Skeleton width="38%" height={11} radius={5} style={{ marginBottom: 14 }} />
            <Skeleton width="60%" height={30} radius={7} />
            <Skeleton width="72%" height={11} radius={4} style={{ marginTop: 12 }} />
          </div>
          <div style={{ display: "flex", gap: 26 }}>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton width={64} height={10} radius={5} style={{ marginBottom: 12 }} />
                <Skeleton width={80} height={20} radius={6} />
              </div>
            ))}
          </div>
        </div>
      </Card>
      {/* Spending */}
      <Card>
        <Skeleton width="30%" height={13} radius={5} style={{ marginBottom: 18 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 7 }}>
                <Skeleton width={20} height={20} radius={5} />
                <Skeleton width="40%" height={11} radius={5} />
                <Skeleton width={52} height={11} radius={5} style={{ marginLeft: "auto" }} />
              </div>
              <Skeleton height={6} radius={4} />
            </div>
          ))}
        </div>
      </Card>
      {/* Accounts grid */}
      <Card>
        <Skeleton width="26%" height={13} radius={5} style={{ marginBottom: 18 }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(184px, 1fr))", gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, height: 58 }}>
              <Skeleton width={36} height={36} radius={10} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
                <Skeleton width="70%" height={11} radius={5} />
                <Skeleton width="50%" height={10} radius={4} />
              </div>
            </div>
          ))}
        </div>
      </Card>
      {/* Recent transactions */}
      <Card>
        <Skeleton width="35%" height={13} radius={5} style={{ marginBottom: 18 }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, height: 48 }}>
            <Skeleton width={32} height={32} radius={9} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <Skeleton width="52%" height={11} radius={5} />
              <Skeleton width="30%" height={9} radius={4} />
            </div>
            <Skeleton width={60} height={11} radius={5} />
          </div>
        ))}
      </Card>
    </div>
  );
}

export function Dashboard({ month, go }: { month: string; go: (screen: string) => void }) {
  const t = useTheme();
  const { accounts, categories, version } = useAppData();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const { notify } = useToast();

  // accountId → templateKey, so dashboard account tiles can show provider logos
  // (the summary's AccountBalance rows don't carry the provider key).
  const templateKeyOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of accounts) m.set(a.id, a.templateKey);
    return m;
  }, [accounts]);

  useEffect(() => {
    client.getDashboardSummary(month).then(setData).catch((err: unknown) => {
      notify((err instanceof Error ? err.message : null) ?? "Could not load dashboard", "error");
    });
  }, [month, version, notify]);

  if (!data) return <DashboardSkeleton />;
  const empty = accounts.length === 0;

  const kpis = [
    { label: "Income", cents: data.incomeCents, color: t.income, signed: false },
    { label: "Expenses", cents: data.expenseCents, color: t.expense, signed: false },
    { label: "Net Cashflow", cents: data.netCashflowCents, color: data.netCashflowCents >= 0 ? t.income : t.expense, signed: true },
  ];
  const maxCat = Math.max(1, ...data.spendingBreakdown.map((s) => s.totalCents));

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {empty && (
        <Card><Empty icon="wallet" title="Welcome to Sens" hint="Add your first account to start tracking your money." /></Card>
      )}

      {/* Hero: net worth anchor + this-month KPIs */}
      <Card pad={22}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "22px 40px", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>Net worth</div>
            <div style={{ marginTop: 8 }}>
              <Money cents={data.netWorthCents} color={data.netWorthCents < 0 ? t.negative : t.text} size={32} weight={700} showCents={false} />
            </div>
            <div style={{ fontSize: 12.5, color: t.dim, marginTop: 9, display: "flex", gap: 8, alignItems: "center" }}>
              <span>Assets <Money cents={data.assetsCents} size={12.5} color={t.dim} /></span>
              <span style={{ color: t.faint }}>·</span>
              <span>Owe <Money cents={Math.abs(data.liabilitiesCents)} size={12.5} color={t.dim} /></span>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 11, textAlign: "right" }}>This month</div>
            <div style={{ display: "flex", alignItems: "stretch" }}>
              {kpis.map((k, i) => (
                <div key={k.label} style={{ paddingLeft: i === 0 ? 0 : 22, marginLeft: i === 0 ? 0 : 22, borderLeft: i === 0 ? "none" : `0.5px solid ${t.divider}` }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>{k.label}</div>
                  <div style={{ marginTop: 7 }}>
                    <Money cents={k.cents} signed={k.signed} color={k.color} size={20} weight={700} showCents={false} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Spending — full width */}
      <Card>
        <SectionTitle sub="This month, by category" right={data.spendingBreakdown.length > 0 ? <Money cents={data.expenseCents} size={14} weight={700} color={t.text} showCents={false} /> : undefined}>Spending</SectionTitle>
        {data.spendingBreakdown.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 0 2px", color: t.faint }}>
            <Icon name="filter" size={16} color={t.faint} />
            <span style={{ fontSize: 12.5 }}>No spending yet — expenses this month will break down here.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {data.spendingBreakdown.map((s) => (
              <div key={s.categoryId}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
                  <span style={{ fontSize: 15 }}>{s.emoji}</span>
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{s.categoryName}</span>
                  <Money cents={s.totalCents} size={12.5} />
                </div>
                <div style={{ height: 6, borderRadius: 4, background: t.panel2, overflow: "hidden" }}>
                  <div className="sens-bar" style={{ width: `${(s.totalCents / maxCat) * 100}%`, height: "100%", borderRadius: 4, background: s.color ?? t.expense }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Accounts — auto-fit tile grid */}
      <Card>
        <SectionTitle right={<span className="sens-link" style={{ fontSize: 12.5, fontWeight: 600 }} onClick={() => go("accounts")}>View all</span>}>Accounts</SectionTitle>
        {data.accountBalances.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 0 2px", color: t.faint }}>
            <Icon name="wallet" size={16} color={t.faint} />
            <span style={{ fontSize: 12.5 }}>No accounts yet.</span>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(184px, 1fr))", gap: 12 }}>
            {data.accountBalances.map((a) => {
              const v = balanceDisplay(a.group, a.balanceCents);
              return (
                <div key={a.accountId} className="sens-row" style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, borderRadius: 11, background: t.panel2, border: `0.5px solid ${t.border}` }}>
                  <ProviderLogo templateKey={templateKeyOf.get(a.accountId) ?? null} name={a.name} seed={a.accountId} size={36} radius={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                    <div style={{ marginTop: 3 }}>
                      <Money cents={v.magnitude} size={13} weight={600} color={toneColor(v.tone, t)} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Recent transactions — full width */}
      <Card>
        <SectionTitle right={<span className="sens-link" style={{ fontSize: 12.5, fontWeight: 600 }} onClick={() => go("transactions")}>View all</span>}>Recent Transactions</SectionTitle>
        {data.recentTransactions.length === 0 ? (
          <Empty icon="list" title="No transactions yet" hint="Use the Add button to record income, expenses, or transfers." />
        ) : (
          <div>
            {data.recentTransactions.map((tx) => (
              <TxnRow key={tx.id} tx={tx} accounts={accounts} categories={categories} />
            ))}
          </div>
        )}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `0.5px solid ${t.divider}`, display: "flex", justifyContent: "space-between", fontSize: 12, color: t.dim }}>
          <span>Net cashflow this month</span>
          <Money cents={data.netCashflowCents} signed color={data.netCashflowCents >= 0 ? t.income : t.expense} />
        </div>
      </Card>
    </div>
  );
}
