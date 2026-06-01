// TargetPicker: modal to select a re-categorize target (per-kind) or
// move-to-account target. Used by the bulk action flow.

import { useState } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Modal } from "./ui";
import { categoryPickerItems } from "../lib/categories";
import type { BulkAction, BulkTarget } from "../lib/txnSelection";

export function TargetPicker({
  action,
  accounts,
  categories,
  selected,
  onCancel,
  onChoose,
}: {
  action: BulkAction;
  accounts: Account[];
  categories: Category[];
  selected: Transaction[];
  onCancel: () => void;
  onChoose: (target: BulkTarget) => void;
}) {
  const t = useTheme();
  const isMove = action === "move";

  const expenseItems = isMove ? [] : categoryPickerItems(categories, "expense");
  const incomeItems = isMove ? [] : categoryPickerItems(categories, "income");

  const hasExpense = selected.some((tx) => tx.kind === "expense");
  const hasIncome = selected.some((tx) => tx.kind === "income");
  const expenseCount = selected.filter((tx) => tx.kind === "expense").length;
  const incomeCount = selected.filter((tx) => tx.kind === "income").length;

  const [expenseCatId, setExpenseCatId] = useState("");
  const [incomeCatId, setIncomeCatId] = useState("");

  const catLabel = (id: string): string => {
    const all = [...expenseItems, ...incomeItems];
    return all.find((c) => c.id === id)?.label ?? categories.find((c) => c.id === id)?.name ?? id;
  };

  const handleContinue = () => {
    onChoose({
      expenseCategory: expenseCatId ? { id: expenseCatId, name: catLabel(expenseCatId) } : undefined,
      incomeCategory: incomeCatId ? { id: incomeCatId, name: catLabel(incomeCatId) } : undefined,
    });
  };

  const canContinue = expenseCatId !== "" || incomeCatId !== "";

  const selectStyle: React.CSSProperties = {
    background: t.panel2,
    color: t.text,
    border: `0.5px solid ${t.borderStrong}`,
    borderRadius: 7,
    padding: "4px 8px",
    fontSize: 12,
    fontFamily: t.font,
    width: "100%",
  };

  return (
    <Modal onClose={onCancel} width={360}>
      <div
        style={{
          padding: "15px 18px",
          borderBottom: `0.5px solid ${t.divider}`,
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        {isMove ? "Move to account" : "Re-categorize to"}
      </div>

      <div style={{ maxHeight: 380, overflowY: "auto", padding: 8 }}>
        {isMove
          ? accounts.filter((a) => !a.isArchived).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onChoose({ accountId: a.id, accountName: a.name })}
                style={{
                  display: "flex",
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 11px",
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  color: t.text,
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: t.font,
                }}
              >
                {a.name}
              </button>
            ))
          : (
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 16 }}>
              {hasExpense && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Expense · {expenseCount}
                  </label>
                  <select
                    value={expenseCatId}
                    onChange={(e) => setExpenseCatId(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="">— No change —</option>
                    {expenseItems.map((c) => (
                      <option key={c.id} value={c.id} style={{ paddingLeft: c.depth ? 16 : 0 }}>
                        {c.depth ? `  ${c.label}` : c.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {hasIncome && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Income · {incomeCount}
                  </label>
                  <select
                    value={incomeCatId}
                    onChange={(e) => setIncomeCatId(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="">— No change —</option>
                    {incomeItems.map((c) => (
                      <option key={c.id} value={c.id} style={{ paddingLeft: c.depth ? 16 : 0 }}>
                        {c.depth ? `  ${c.label}` : c.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={onCancel}
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    fontSize: 12.5,
                    fontFamily: t.font,
                    border: `0.5px solid ${t.borderStrong}`,
                    borderRadius: 8,
                    background: "transparent",
                    color: t.dim,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!canContinue}
                  style={{
                    flex: 2,
                    padding: "7px 12px",
                    fontSize: 12.5,
                    fontFamily: t.font,
                    border: "none",
                    borderRadius: 8,
                    background: canContinue ? t.accent : t.panel3,
                    color: canContinue ? "#fff" : t.faint,
                    cursor: canContinue ? "pointer" : "not-allowed",
                    fontWeight: 600,
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          )}
      </div>
    </Modal>
  );
}
