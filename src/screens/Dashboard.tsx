// Dashboard: month-scoped overview. KPI tiles, spending breakdown, account
// balances, and recent transactions. Income/expense/cashflow exclude transfers
// and adjustments (the backend enforces this).

import { useEffect, useState } from "react";
import type { DashboardSummary } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Card, Empty, Money, SectionTitle } from "../components/ui";
import { TxnRow } from "../components/TxnRow";
import { client } from "../client";
import { useAppData } from "../store";
import { accountTone } from "../lib/brand";

export function Dashboard({ month, go }: { month: string; go: (screen: string) => void }) {
  const t = useTheme();
  const { accounts, categories, version } = useAppData();
  const [data, setData] = useState<DashboardSummary | null>(null);

  useEffect(() => { client.getDashboardSummary(month).then(setData).catch(() => {}); }, [month, version]);

  if (!data) return null;
  const empty = accounts.length === 0;

  const kpis = [
    { label: "Total Balance", cents: data.totalBalanceCents, color: t.text, signed: false },
    { label: "Income", cents: data.incomeCents, color: t.income, signed: false },
    { label: "Expenses", cents: data.expenseCents, color: t.expense, signed: false },
    { label: "Net Cashflow", cents: data.netCashflowCents, color: data.netCashflowCents >= 0 ? t.income : t.expense, signed: true },
  ];
  const maxCat = Math.max(1, ...data.spendingBreakdown.map((s) => s.totalCents));

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {empty && (
        <Card><Empty icon="wallet" title="Welcome to Sens" hint="Add your first account to start tracking your money." /></Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        {kpis.map((k) => (
          <Card key={k.label}>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>{k.label}</div>
            <div style={{ marginTop: 10 }}>
              <Money cents={k.cents} signed={k.signed} color={k.color} size={24} weight={700} showCents={false} />
            </div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14, alignItems: "start" }}>
        <Card>
          <SectionTitle sub="This month, by category">Spending</SectionTitle>
          {data.spendingBreakdown.length === 0 ? (
            <Empty icon="filter" title="No spending yet" hint="Expenses this month will break down here." />
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

        <Card>
          <SectionTitle right={<span className="sens-link" style={{ fontSize: 12.5, fontWeight: 600 }} onClick={() => go("accounts")}>View all</span>}>Accounts</SectionTitle>
          {data.accountBalances.length === 0 ? (
            <Empty icon="wallet" title="No accounts" />
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {data.accountBalances.map((a) => {
                const tone = accountTone({ fallbackSeed: a.accountId }, t.accent);
                return (
                <div key={a.accountId} className="sens-row" style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 8px", margin: "0 -8px", height: 44, borderRadius: 9 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 9, background: hexA(tone, 0.16), color: tone, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{a.name[0]}</div>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
                  <Money cents={a.balanceCents} size={13} color={a.balanceCents < 0 ? t.negative : t.text} />
                </div>
              );
              })}
            </div>
          )}
        </Card>
      </div>

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
