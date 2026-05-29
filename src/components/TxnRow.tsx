// A single transaction row, reused across Dashboard, Transactions, and the
// per-account activity list. Renders the kind glyph, labels, and a signed,
// color-coded amount per the UI Color System.

import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { GlyphTile, Money } from "./ui";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { fmtDate } from "../lib/format";

export function TxnRow({ tx, accounts, categories, perspectiveAccountId, onClick, showDate = true, balanceAfterCents }: {
  tx: Transaction; accounts: Account[]; categories: Category[]; perspectiveAccountId?: string; onClick?: () => void; showDate?: boolean; balanceAfterCents?: number;
}) {
  const t = useTheme();
  const cat = tx.categoryId ? categories.find((c) => c.id === tx.categoryId) : undefined;
  const meta = KIND_META[tx.kind];
  const color = kindColor(t, tx.kind);

  const title = tx.description
    || cat?.name
    || (tx.kind === "transfer" ? "Transfer" : tx.kind === "adjustment" ? "Balance adjustment" : meta.label);

  const accName = (id: string | null) => (id && accounts.find((a) => a.id === id)?.name) || "—";
  let subtitle: string;
  if (tx.kind === "transfer") subtitle = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`;
  else if (tx.kind === "adjustment") subtitle = accName(tx.accountId);
  else subtitle = `${cat?.name ?? ""} · ${accName(tx.accountId)}`;

  const isDest = perspectiveAccountId != null && tx.toAccountId === perspectiveAccountId;
  const signedCents = signedFor(tx.kind, tx.amountCents, isDest);
  // Income/expense/adjustment carry an inherent sign; transfers are signed only
  // from an account perspective, otherwise shown neutral in transfer color.
  const signed = tx.kind !== "transfer" || perspectiveAccountId != null;

  return (
    <div className={`sens-row${onClick ? " click" : ""}`} onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 8px", margin: "0 -8px", height: 50, borderRadius: 9 }}>
      {cat ? <GlyphTile tone={cat.color ?? color} size={32} emoji={cat.emoji} />
        : <GlyphTile tone={color} size={32} icon={meta.icon} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: 11.5, color: t.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {subtitle}{showDate ? ` · ${fmtDate(tx.transactionDate)}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
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
