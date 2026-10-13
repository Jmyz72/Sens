// Add or edit one parent budget and its slices. One setBudgets call writes the
// parent and every field shown. A blank slice sends null; a typed 0 sends 0.

import { useState } from "react";
import type { BudgetWrite, Category, PlanBudget } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";

/** Parse a typed amount into non-negative cents (allows 0). Null if blank/invalid. */
function parseMagnitude(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function centsToField(cents: number): string {
  return (cents / 100).toFixed(2);
}

function thrownMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function eligibleParents(categories: Category[], budgets: PlanBudget[]): Category[] {
  const budgeted = new Set(budgets.map((b) => b.categoryId));
  return categories
    .filter((c) => c.kind === "expense" && !c.isSystem && !c.parentId && !c.isArchived && !budgeted.has(c.id))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

interface SliceField {
  id: string;
  name: string;
  emoji: string;
  isArchived: boolean;
  sortOrder: number;
}

function shownChildren(parentId: string, categories: Category[], budgets: PlanBudget[]): SliceField[] {
  const fromCategories: SliceField[] = categories
    .filter((c) => c.parentId === parentId && (!c.isArchived || budgets.some((b) => b.categoryId === c.id)))
    .map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, isArchived: c.isArchived, sortOrder: c.sortOrder }));
  const seen = new Set(fromCategories.map((c) => c.id));
  const fromBudgets: SliceField[] = budgets
    .filter((b) => b.parentId === parentId && b.isArchived && !seen.has(b.categoryId))
    .map((b) => ({ id: b.categoryId, name: b.name, emoji: b.emoji, isArchived: true, sortOrder: b.sortOrder }));
  return [...fromCategories, ...fromBudgets].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function childFields(parentId: string, categories: Category[], budgets: PlanBudget[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const child of shownChildren(parentId, categories, budgets)) {
    const row = budgets.find((b) => b.categoryId === child.id);
    next[child.id] = row ? centsToField(row.amountCents) : "";
  }
  return next;
}

export function BudgetForm({
  budgets, categories, editing, onClose,
}: {
  budgets: PlanBudget[];
  categories: Category[];
  editing: PlanBudget | null;
  onClose: () => void;
}) {
  const t = useTheme();
  const { reload } = useAppData();
  const eligible = eligibleParents(categories, budgets);
  const [picked, setPicked] = useState(editing?.categoryId ?? eligible[0]?.id ?? "");
  const selectedId = editing?.categoryId ?? picked;
  const children = shownChildren(selectedId, categories, budgets);
  const [parentAmount, setParentAmount] = useState(() => (editing ? centsToField(editing.amountCents) : ""));
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    childFields(editing?.categoryId ?? eligible[0]?.id ?? "", categories, budgets),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentCents = parseMagnitude(parentAmount);
  const canSave = selectedId !== "" && parentCents != null && !busy;

  function chooseParent(id: string) {
    setPicked(id);
    setParentAmount("");
    setAmounts(childFields(id, categories, budgets));
    setError(null);
  }

  async function save() {
    if (!canSave || parentCents == null) return;
    setBusy(true);
    setError(null);
    const items: BudgetWrite[] = [
      { categoryId: selectedId, amountCents: parentCents },
      ...children.map((child) => ({
        categoryId: child.id,
        amountCents: parseMagnitude(amounts[child.id] ?? ""),
      })),
    ];
    try {
      await client.setBudgets(items);
      await reload();
      onClose();
    } catch (e) {
      setError(thrownMessage(e, "Could not save the budget"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    const items: BudgetWrite[] = [
      { categoryId: editing.categoryId, amountCents: null },
      ...children.map((child) => ({ categoryId: child.id, amountCents: null })),
    ];
    try {
      await client.setBudgets(items);
      await reload();
      onClose();
    } catch (e) {
      setError(thrownMessage(e, "Could not clear the budget"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={440}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{editing ? "Edit budget" : "Add a budget"}</span>
        <button type="button" className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}
      >
        {editing ? (
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {editing.emoji} {editing.name}
            {editing.isArchived && <span style={{ fontWeight: 500, color: t.faint }}> Archived</span>}
          </div>
        ) : eligible.length === 0 ? (
          <div style={{ fontSize: 12.5, color: t.dim }}>Every active expense category already has a budget.</div>
        ) : (
          <Field label="Category">
            <select
              className="sens-input"
              value={picked}
              onChange={(e) => chooseParent(e.target.value)}
              style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}
            >
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>
              ))}
            </select>
          </Field>
        )}

        {selectedId !== "" && (
          <AmountField label="Amount (RM)" value={parentAmount} onChange={setParentAmount} autoFocus />
        )}

        {children.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 11, color: t.dim, fontWeight: 600, letterSpacing: 0.3 }}>SUBCATEGORIES</div>
            <div style={{ fontSize: 12, color: t.faint, marginTop: -6 }}>Leave a field blank to leave it unset. Zero is a real cap.</div>
            {children.map((child) => (
              <AmountField
                key={child.id}
                label={child.isArchived ? `${child.emoji} ${child.name} Archived` : `${child.emoji} ${child.name}`}
                value={amounts[child.id] ?? ""}
                onChange={(value) => setAmounts((prev) => ({ ...prev, [child.id]: value }))}
              />
            ))}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          {editing && (
            <Btn variant="danger" onClick={() => void clear()} disabled={busy}>Clear</Btn>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="outline" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn type="submit" disabled={!canSave}>Save</Btn>
        </div>
      </form>
    </Modal>
  );
}

function AmountField({
  label, value, onChange, autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const t = useTheme();
  return (
    <Field label={label}>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 12, top: 10, fontSize: 13, color: t.faint, fontFamily: t.mono }}>RM</span>
        <input
          className="sens-input"
          value={value}
          inputMode="decimal"
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          style={{ ...inputStyle(t), fontFamily: t.mono, paddingLeft: 36 }}
        />
      </div>
    </Field>
  );
}
