// Top bar: screen title/subtitle, the dashboard month picker, and the Add
// button (Transaction only — account creation lives on the Accounts screen).

import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./Icon";
import { Btn } from "./ui";
import { fmtMonth } from "../lib/format";

export function TopBar({
  title, sub, isDashboard, month, onShiftMonth, onAddTransaction,
}: {
  title: string;
  sub: string;
  isDashboard: boolean;
  month: string;
  onShiftMonth: (delta: number) => void;
  onAddTransaction: () => void;
}) {
  const t = useTheme();
  return (
    <div data-tauri-drag-region style={{ height: 60, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: `0.5px solid ${t.divider}` }}>
      <div style={{ minWidth: 88, flex: "1 1 auto" }}>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: 12, color: t.faint, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
      <div style={{ flex: 1 }} />
      {isDashboard && (
        <div style={{ display: "flex", alignItems: "center", gap: 2, background: t.panel, borderRadius: 8, border: `0.5px solid ${t.border}`, padding: 2 }}>
          <button className="sens-icon-btn" onClick={() => onShiftMonth(-1)} style={{ width: 26, height: 26, color: t.dim }}><Icon name="chevronLeft" size={15} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 92, textAlign: "center" }}>{fmtMonth(month)}</span>
          <button className="sens-icon-btn" onClick={() => onShiftMonth(1)} style={{ width: 26, height: 26, color: t.dim }}><Icon name="chevronRight" size={15} /></button>
        </div>
      )}
      <Btn icon="plus" onClick={onAddTransaction}>Add</Btn>
    </div>
  );
}
