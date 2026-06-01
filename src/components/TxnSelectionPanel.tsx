// TxnSelectionPanel: multi-select summary sidebar with adaptive action buttons.
// Action counts come from planBulk(action, selected).changeable.length.
// Disabled when 0 changeable. Skip detail is shown in the preview sheet.

import type { Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Card, Money, IconBtn } from "./ui";
import { summarizeSelection, planBulk, type BulkAction } from "../lib/txnSelection";

const ACTIONS: { action: BulkAction; label: string; danger?: boolean }[] = [
  { action: "recategorize", label: "Re-categorize" },
  { action: "move", label: "Move to account" },
  { action: "exclude", label: "Exclude from reporting" },
  { action: "include", label: "Include in reporting" },
  { action: "delete", label: "Delete", danger: true },
];

export function TxnSelectionPanel({
  selected,
  onClear,
  onAction,
}: {
  selected: Transaction[];
  onClear: () => void;
  onAction: (a: BulkAction) => void;
}) {
  const t = useTheme();
  const s = summarizeSelection(selected);
  const others = [
    s.otherCounts.transfer && `${s.otherCounts.transfer} transfer`,
    s.otherCounts.adjustment && `${s.otherCounts.adjustment} adjustment`,
    s.otherCounts.opening && `${s.otherCounts.opening} opening`,
  ]
    .filter(Boolean)
    .join(", ");
  const inCount = selected.filter((x) => x.kind === "income").length;
  const outCount = selected.filter((x) => x.kind === "expense").length;

  return (
    <Card
      pad={0}
      style={{ overflow: "hidden", alignSelf: "flex-start", position: "sticky", top: 0 }}
    >
      {/* Header: count + net + clear */}
      <div
        style={{
          padding: 16,
          borderBottom: `0.5px solid ${t.divider}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ fontSize: 21, fontWeight: 700 }}>
            {s.count}{" "}
            <span style={{ fontSize: 12, color: t.dim, fontWeight: 500 }}>selected</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <span style={{ fontSize: 12, color: t.dim }}>net </span>
            <Money cents={s.netCents} signed size={16} weight={700} />
          </div>
        </div>
        <IconBtn name="close" onClick={onClear} title="Clear selection" icon={16} />
      </div>

      {/* Income row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12.5,
          padding: "8px 16px",
          borderBottom: `0.5px solid ${t.divider}`,
        }}
      >
        <span style={{ color: t.dim }}>In · {inCount}</span>
        <Money cents={s.inCents} signed color={t.income} size={12.5} />
      </div>

      {/* Expense row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12.5,
          padding: "8px 16px",
          borderBottom: `0.5px solid ${t.divider}`,
        }}
      >
        <span style={{ color: t.dim }}>Out · {outCount}</span>
        <Money cents={-s.outCents} signed color={t.expense} size={12.5} />
      </div>

      {/* Other kinds note */}
      {others && (
        <div
          style={{
            fontSize: 11.5,
            color: t.faint,
            padding: "9px 16px",
            borderBottom: `0.5px solid ${t.divider}`,
          }}
        >
          Also selected (not in net): {others}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        {ACTIONS.map(({ action, label, danger }) => {
          const n = planBulk(action, selected).changeable.length;
          const disabled = n === 0;
          const suffix =
            action === "exclude" || action === "include" ? " to change" : "";
          return (
            <button
              key={action}
              type="button"
              disabled={disabled}
              onClick={() => onAction(action)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0 12px",
                height: 34,
                borderRadius: 9,
                border: `0.5px ${disabled ? "dashed" : "solid"} ${t.borderStrong}`,
                background: disabled ? "transparent" : t.panel2,
                color: danger ? t.expense : t.text,
                opacity: disabled ? 0.45 : 1,
                cursor: disabled ? "default" : "pointer",
                fontSize: 12.5,
                fontFamily: t.font,
              }}
            >
              <span>{label}</span>
              <span style={{ fontFamily: t.mono, fontSize: 11, color: t.dim }}>
                {n}
                {suffix}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={onClear}
          style={{
            height: 30,
            border: "none",
            background: "transparent",
            color: t.dim,
            cursor: "pointer",
            fontSize: 12.5,
            fontFamily: t.font,
          }}
        >
          Clear selection
        </button>
      </div>
    </Card>
  );
}
