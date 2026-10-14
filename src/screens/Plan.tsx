// Plan: this month's category budgets and savings goals. Spent and the monthly
// goal amount come from getPlan; the screen does not recompute them. A month
// other than the current one is closed: it can be read, not edited.

import { useEffect, useState } from "react";
import type { Plan as PlanData, PlanBudget, PlanGoal } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Card, Empty, Money, SectionTitle } from "../components/ui";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";
import { currentMonth, fmtDate, fmtMonth } from "../lib/format";
import { BudgetForm } from "../modals/BudgetForm";
import { GoalForm } from "../modals/GoalForm";

function fillPercent(spent: number, amount: number): number {
  if (amount === 0) return spent > 0 ? 100 : 0;
  return Math.min(100, (spent / amount) * 100);
}

function goalPercent(balance: number, target: number): number {
  if (balance <= 0) return 0;
  if (balance >= target) return 100;
  return (balance / target) * 100;
}

function PlanSkeleton() {
  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {[0, 1].map((i) => (
        <Card key={i}>
          <Skeleton width="28%" height={14} radius={5} />
          <Skeleton height={12} radius={4} style={{ marginTop: 16 }} />
          <Skeleton height={44} radius={8} style={{ marginTop: 14 }} />
        </Card>
      ))}
    </div>
  );
}

export function Plan({ month }: { month: string }) {
  const t = useTheme();
  const { categories, version } = useAppData();
  const { notify } = useToast();
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [failedMonth, setFailedMonth] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [budgetEdit, setBudgetEdit] = useState<PlanBudget | null | undefined>(undefined);
  const [goalEdit, setGoalEdit] = useState<PlanGoal | null | undefined>(undefined);

  const closed = month !== currentMonth();

  useEffect(() => {
    setBudgetEdit(undefined);
    setGoalEdit(undefined);
  }, [month]);

  useEffect(() => {
    let alive = true;
    client.getPlan(month).then((next) => {
      if (!alive) return;
      setPlan(next);
      setFailedMonth(null);
    }).catch((error: unknown) => {
      if (!alive) return;
      setFailedMonth(month);
      notify((error instanceof Error ? error.message : (error as { message?: string } | null)?.message) ?? "Could not load plan", "error");
    });
    return () => { alive = false; };
  }, [month, version, notify]);

  const ready = plan?.month === month ? plan : null;
  if (!ready && failedMonth !== month) return <PlanSkeleton />;

  const budgets = ready?.budgets ?? [];
  const goals = ready?.goals ?? [];
  const parents = budgets.filter((b) => b.parentId == null);
  const spentTotal = parents.reduce((sum, row) => sum + row.spentCents, 0);
  const amountTotal = parents.reduce((sum, row) => sum + row.amountCents, 0);

  function toggle(id: string) {
    setOpenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {closed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, background: t.panel, border: `0.5px solid ${t.border}`, borderRadius: 10, padding: "10px 14px" }}>
          <Icon name="info" size={15} color={t.dim} />
          <span>{fmtMonth(month)} is closed and kept as it was.</span>
        </div>
      )}

      {!ready ? (
        <Card><Empty icon="alertCircle" title="Could not load this plan" /></Card>
      ) : (
        <>
          <Card>
            <SectionTitle
              sub={parents.length > 0 ? "Budgeted categories only" : undefined}
              right={!closed && parents.length > 0 ? <Btn size="sm" icon="plus" onClick={() => setBudgetEdit(null)}>Add</Btn> : undefined}
            >
              Budgets
            </SectionTitle>
            {parents.length === 0 ? (
              <div>
                <Empty icon="plan" title="No budgets yet" />
                {!closed && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: -28 }}>
                    <Btn icon="plus" onClick={() => setBudgetEdit(null)}>Add a budget</Btn>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 6 }}>
                  <Money cents={spentTotal} size={14} weight={700} />
                  <span style={{ color: t.faint, fontSize: 12 }}>/</span>
                  <Money cents={amountTotal} size={14} weight={700} color={t.dim} />
                </div>
                {parents.map((row) => (
                  <BudgetRow
                    key={row.categoryId}
                    row={row}
                    budgets={budgets}
                    open={openIds.includes(row.categoryId)}
                    closed={closed}
                    onToggle={() => toggle(row.categoryId)}
                    onEdit={() => setBudgetEdit(row)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle
              right={!closed && goals.length > 0 ? <Btn size="sm" icon="plus" onClick={() => setGoalEdit(null)}>Add</Btn> : undefined}
            >
              Savings goals
            </SectionTitle>
            {goals.length === 0 ? (
              <div>
                <Empty icon="flag" title="No goals yet" />
                {!closed && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: -28 }}>
                    <Btn icon="plus" onClick={() => setGoalEdit(null)}>Add a goal</Btn>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {goals.map((goal) => (
                  <GoalRow key={goal.id} goal={goal} closed={closed} onEdit={() => setGoalEdit(goal)} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {budgetEdit !== undefined && ready && (
        <BudgetForm
          budgets={budgets}
          categories={categories}
          editing={budgetEdit}
          onClose={() => setBudgetEdit(undefined)}
        />
      )}
      {goalEdit !== undefined && ready && (
        <GoalForm
          goals={goals}
          editing={goalEdit}
          onClose={() => setGoalEdit(undefined)}
        />
      )}
    </div>
  );
}

function BudgetRow({
  row, budgets, open, closed, onToggle, onEdit,
}: {
  row: PlanBudget;
  budgets: PlanBudget[];
  open: boolean;
  closed: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const t = useTheme();
  const { categories } = useAppData();
  const children = budgets.filter((b) => b.parentId === row.categoryId);
  const hasSlices = categories.some((c) =>
    c.parentId === row.categoryId && (!c.isArchived || budgets.some((b) => b.categoryId === c.id)),
  ) || children.some((b) => b.isArchived);
  const expandable = children.length > 0 || hasSlices;
  const over = row.spentCents > row.amountCents;
  const assigned = children.reduce((sum, child) => sum + child.amountCents, 0);
  const unassigned = row.amountCents - assigned;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {expandable ? (
          <button type="button" className="sens-icon-btn" onClick={onToggle} aria-expanded={open} style={{ width: 22, height: 22, color: t.dim }}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
          </button>
        ) : (
          <span style={{ width: 22 }} />
        )}
        <span style={{ fontSize: 15 }}>{row.emoji}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600 }}>
          {row.name}
          {row.isArchived && <span style={{ fontWeight: 500, color: t.faint }}> Archived</span>}
        </span>
        <Money cents={row.spentCents} size={12.5} />
        <span style={{ color: t.faint, fontSize: 12 }}>/</span>
        <Money cents={row.amountCents} size={12.5} color={t.dim} />
        <Remainder spent={row.spentCents} amount={row.amountCents} />
        {!closed && <Btn size="sm" variant="ghost" onClick={onEdit}>Edit</Btn>}
      </div>
      <div style={{ marginLeft: 30, marginTop: 6 }}>
        <Track width={fillPercent(row.spentCents, row.amountCents)} over={over} />
      </div>
      {open && expandable && (
        <div style={{ marginLeft: 30, marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {children.map((child) => (
            <ChildRow key={child.categoryId} row={child} />
          ))}
          {hasSlices && (
            <div style={{ fontSize: 12, color: t.dim }}>
              <Money cents={unassigned} size={12} color={t.dim} /> not assigned
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChildRow({ row }: { row: PlanBudget }) {
  const t = useTheme();
  const over = row.spentCents > row.amountCents;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14 }}>{row.emoji}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
          {row.name}
          {row.isArchived && <span style={{ color: t.faint }}> Archived</span>}
        </span>
        <Money cents={row.spentCents} size={12} />
        <span style={{ color: t.faint, fontSize: 12 }}>/</span>
        <Money cents={row.amountCents} size={12} color={t.dim} />
        <Remainder spent={row.spentCents} amount={row.amountCents} />
      </div>
      <div style={{ marginTop: 5 }}>
        <Track width={fillPercent(row.spentCents, row.amountCents)} over={over} />
      </div>
    </div>
  );
}

function Remainder({ spent, amount }: { spent: number; amount: number }) {
  const t = useTheme();
  if (spent > amount) {
    return (
      <span style={{ fontSize: 12, color: t.expense, whiteSpace: "nowrap" }}>
        <Money cents={spent - amount} size={12} color={t.expense} /> Over
      </span>
    );
  }
  return (
    <span style={{ fontSize: 12, color: t.dim, whiteSpace: "nowrap" }}>
      <Money cents={amount - spent} size={12} color={t.dim} /> left
    </span>
  );
}

function Track({ width, over }: { width: number; over: boolean }) {
  const t = useTheme();
  return (
    <div style={{ height: 6, borderRadius: 4, background: t.panel2, overflow: "hidden" }}>
      <div className="sens-bar" style={{ width: `${width}%`, height: "100%", borderRadius: 4, background: over ? t.expense : t.accent }} />
    </div>
  );
}

function GoalRow({ goal, closed, onEdit }: { goal: PlanGoal; closed: boolean; onEdit: () => void }) {
  const t = useTheme();
  const reached = goal.balanceCents >= goal.targetCents;
  const datePassed = goal.targetDate != null && goal.monthlyCents == null && goal.balanceCents < goal.targetCents;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{goal.name}</span>
        {reached && <span style={{ fontSize: 12, fontWeight: 600, color: t.income }}>Reached</span>}
        {!reached && goal.monthlyCents != null && (
          <span style={{ fontSize: 12, color: t.dim, whiteSpace: "nowrap" }}>
            <Money cents={goal.monthlyCents} size={12} color={t.dim} />
            {goal.targetDate ? ` · ${fmtDate(goal.targetDate)}` : ""}
          </span>
        )}
        {datePassed && (
          <span style={{ fontSize: 12, color: t.expense, whiteSpace: "nowrap" }}>
            Date passed · <Money cents={goal.targetCents - goal.balanceCents} size={12} color={t.expense} />
          </span>
        )}
        {!closed && <Btn size="sm" variant="ghost" onClick={onEdit}>Edit</Btn>}
      </div>
      <div style={{ fontSize: 12, color: t.faint, marginTop: 3 }}>{goal.accountName}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 8 }}>
        <span style={{ fontSize: 12, color: t.dim }}>Balance <Money cents={goal.balanceCents} size={12} /></span>
        <span style={{ fontSize: 12, color: t.dim }}>Target <Money cents={goal.targetCents} size={12} /></span>
      </div>
      <div style={{ marginTop: 6 }}>
        <Track width={goalPercent(goal.balanceCents, goal.targetCents)} over={false} />
      </div>
    </div>
  );
}
