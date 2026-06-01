// A single transaction row, reused across Dashboard, Transactions, and the
// per-account activity list. Renders the kind glyph, labels, and a signed,
// color-coded amount per the UI Color System.

import type { ReactNode } from "react";
import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { GlyphTile, Money } from "./ui";
import { Icon } from "./Icon";
import { hexA } from "../theme/tokens";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { fmtDate } from "../lib/format";

export function TxnRow({ tx, accounts, categories, perspectiveAccountId, onClick, showDate = true, balanceAfterCents, density = "comfortable", selected, onToggleSelect, quickActions }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; perspectiveAccountId?: string; onClick?: () => void; showDate?: boolean; balanceAfterCents?: number;
  density?: "comfortable" | "compact";
  selected?: boolean;
  onToggleSelect?: () => void;
  quickActions?: ReactNode;
}) {
  const t = useTheme();
  const cat = tx.categoryId ? categories.find((c) => c.id === tx.categoryId) : undefined;
  const meta = KIND_META[tx.kind];
  const color = kindColor(t, tx.kind);

  const rowH = density === "compact" ? 42 : 50;
  const glyph = density === "compact" ? 28 : 32;

  const title = tx.description
    || cat?.name
    || (tx.kind === "transfer" ? "Transfer" : tx.kind === "adjustment" ? "Balance adjustment" : meta.label);

  const accName = (id: string | null) => (id && accounts.find((a) => a.id === id)?.name) || "—";
  let subtitle: string;
  if (tx.kind === "transfer") subtitle = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`;
  else if (tx.kind === "adjustment" || tx.kind === "opening") subtitle = accName(tx.accountId);
  else subtitle = `${cat?.name ?? ""} · ${accName(tx.accountId)}`;

  const isDest = perspectiveAccountId != null && tx.toAccountId === perspectiveAccountId;
  const signedCents = signedFor(tx.kind, tx.amountCents, isDest);
  // Income/expense/adjustment carry an inherent sign; transfers are signed only
  // from an account perspective, otherwise shown neutral in transfer color.
  const signed = tx.kind !== "transfer" || perspectiveAccountId != null;

  return (
    <div className={`sens-row${onClick ? " click" : ""}`} onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 8px", margin: "0 -8px", height: rowH, borderRadius: 9, position: "relative", background: selected ? hexA(t.accent, 0.08) : undefined }}>
      {onToggleSelect && (
        <button onClick={(e) => { e.stopPropagation(); onToggleSelect(); }} aria-label="Select transaction"
          style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 6, border: `1.5px solid ${selected ? t.accent : t.borderStrong}`, background: selected ? t.accent : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          {selected && <Icon name="check" size={11} color={t.onAccent} stroke={3} />}
        </button>
      )}
      <div style={{ position: "relative", flexShrink: 0 }}>
        {cat ? <GlyphTile tone={cat.color ?? color} size={glyph} emoji={cat.emoji} />
          : <GlyphTile tone={color} size={glyph} icon={meta.icon} />}
        <span style={{ position: "absolute", left: -3, top: -3, width: 9, height: 9, borderRadius: 99, background: cat?.color ?? color, border: `2px solid ${t.panel}` }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
          {tx.excludedFromReporting && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: t.opening, background: hexA(t.opening, 0.14), padding: "1px 5px", borderRadius: 5 }}>
              <Icon name="flag" size={9} color={t.opening} stroke={2.4} /> Excluded
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: t.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {subtitle}{showDate ? ` · ${fmtDate(tx.transactionDate)}` : ""}
        </div>
      </div>
      {quickActions && <div className="sens-row-quick" style={{ display: "flex", gap: 4, flexShrink: 0 }}>{quickActions}</div>}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, width: 110, flexShrink: 0 }}>
        <Money cents={signed ? signedCents : tx.amountCents} signed={signed} color={tx.kind === "transfer" && !signed ? color : undefined} size={13} />
        {balanceAfterCents !== undefined && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9.5, fontWeight: 600, color: t.faint, textTransform: "uppercase", letterSpacing: 0.4, lineHeight: 1 }}>BAL</span>
            <Money cents={balanceAfterCents} size={11} weight={500} color={t.dim} />
          </div>
        )}
      </div>
    </div>
  );
}
