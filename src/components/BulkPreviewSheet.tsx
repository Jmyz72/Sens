// src/components/BulkPreviewSheet.tsx
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Account, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Modal, Btn, Money } from "./ui";
import type { BulkAction, BulkPlan } from "../lib/txnSelection";

export interface BulkTarget {
  categoryId?: string;
  categoryName?: string;
  accountId?: string;
  accountName?: string;
}

const VERB: Record<BulkAction, string> = {
  recategorize: "Re-categorize", move: "Move to account",
  exclude: "Exclude from reporting", include: "Include in reporting", delete: "Delete",
};

export function BulkPreviewSheet({ plan, target, accounts, onCancel, onApply, onChangeTarget }: {
  plan: BulkPlan; target?: BulkTarget; accounts: Account[];
  onCancel: () => void; onApply: (ids: string[]) => void; onChangeTarget?: () => void;
}) {
  const t = useTheme();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const isDelete = plan.action === "delete";

  const changing = useMemo(() => plan.changeable.filter((x) => !removed.has(x.id)), [plan.changeable, removed]);
  const skippedTotal = plan.lockedSkipped.length + removed.size;
  const targetLabel = target?.categoryName ?? target?.accountName;

  const row = (tx: Transaction, trailing: ReactNode, dim = false) => (
    <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 12.5, opacity: dim ? 0.6 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tx.description || VERB[plan.action]}</div>
        <div style={{ fontSize: 11, color: t.faint }}>{(accounts.find((a) => a.id === tx.accountId)?.name) ?? "—"} · {tx.transactionDate.slice(5)}</div>
      </div>
      {trailing}
    </div>
  );

  return (
    <Modal onClose={onCancel} width={480}>
      <div style={{ padding: "16px 18px", borderBottom: `0.5px solid ${t.divider}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {VERB[plan.action]}
          {targetLabel && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: t.panel2, border: `0.5px solid ${t.borderStrong}`, borderRadius: 8, padding: "3px 9px", fontSize: 12.5 }}>
              {targetLabel}
              {onChangeTarget && <span onClick={onChangeTarget} style={{ color: t.accent, cursor: "pointer", fontWeight: 500 }}>Change</span>}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: t.dim, marginTop: 7 }}>
          Applying to <b style={{ color: t.text }}>{changing.length}</b>
          {skippedTotal > 0 && ` · ${skippedTotal} skipped`}
        </div>
      </div>

      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.faint }}>Will change · {changing.length}</div>
        {changing.map((tx) => row(tx,
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {plan.action === "recategorize" && targetLabel && <span style={{ fontSize: 11, color: t.accent }}>→ {targetLabel}</span>}
            <Money cents={tx.kind === "income" ? tx.amountCents : -tx.amountCents} signed size={12} />
            <span onClick={() => setRemoved((p) => new Set(p).add(tx.id))} style={{ fontSize: 11, color: t.dim, border: `0.5px solid ${t.borderStrong}`, borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}>✕ Skip</span>
          </div>))}

        {removed.size > 0 && <>
          <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.accent }}>Removed by you · {removed.size}</div>
          {plan.changeable.filter((x) => removed.has(x.id)).map((tx) => row(tx,
            <span onClick={() => setRemoved((p) => { const n = new Set(p); n.delete(tx.id); return n; })} style={{ fontSize: 11, color: t.accent, border: `0.5px solid ${t.accent}`, borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}>＋ Add back</span>, true))}
        </>}

        {plan.lockedSkipped.length > 0 && <>
          <div style={{ padding: "11px 18px 6px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: t.opening }}>Can't change · {plan.lockedSkipped.length}</div>
          {plan.lockedSkipped.map(({ tx, reason }) => row(tx, <span style={{ fontSize: 11, color: t.opening, fontStyle: "italic" }}>{reason}</span>, true))}
        </>}
      </div>

      <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: `0.5px solid ${t.divider}` }}>
        <Btn variant="outline" size="sm" onClick={onCancel}>Cancel</Btn>
        <Btn variant={isDelete ? "danger" : "primary"} size="sm" disabled={changing.length === 0}
          onClick={() => onApply(changing.map((x) => x.id))} style={{ flex: 1, justifyContent: "center" }}>
          {isDelete ? `Delete ${changing.length}` : `Apply to ${changing.length}`}
        </Btn>
      </div>
      {isDelete && <div style={{ padding: "0 18px 14px", fontSize: 11.5, color: t.faint }}>This can't be undone.</div>}
    </Modal>
  );
}
