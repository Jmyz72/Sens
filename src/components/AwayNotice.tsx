// Dialog for auto transactions a pass wrote while Sens was not posting them live.

import type { Account, Category, Transaction } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Modal, Money } from "./ui";
import { Icon } from "./Icon";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { fmtDate, fmtTime } from "../lib/format";
import { accountName } from "../store";

function labelFor(tx: Transaction, categories: Category[]): string {
  const text = tx.description?.trim();
  if (text) return text;
  if (tx.categoryId) {
    const category = categories.find((row) => row.id === tx.categoryId);
    if (category) return category.name;
  }
  return KIND_META[tx.kind].label;
}

export function AwayNotice({ transactions, accounts, categories, onDismiss }: {
  transactions: Transaction[];
  accounts: Account[];
  categories: Category[];
  onDismiss: () => void;
}) {
  const t = useTheme();
  return (
    <Modal onClose={onDismiss} width={440}>
      <div role="dialog" aria-labelledby="away-notice-title" style={{ padding: "16px 20px 20px" }}>
        <div id="away-notice-title" style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>While you were away</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {transactions.map((tx) => {
            const meta = KIND_META[tx.kind];
            const color = kindColor(t, tx.kind);
            const movement = tx.kind === "transfer" || tx.kind === "payment";
            const when = [fmtDate(tx.transactionDate), fmtTime(tx.transactionTime)].filter(Boolean).join(" · ");
            return (
              <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Icon name={meta.icon} size={16} color={color} stroke={2} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{labelFor(tx, categories)}</div>
                  <div style={{ fontSize: 12, color: t.dim, marginTop: 2 }}>{when} · {accountName(accounts, tx.accountId)}</div>
                </div>
                <Money cents={movement ? tx.amountCents : signedFor(tx.kind, tx.amountCents)} signed={!movement} color={color} />
              </div>
            );
          })}
        </div>
        <Btn variant="primary" onClick={onDismiss} style={{ width: "100%", justifyContent: "center", height: 38, marginTop: 16 }}>Dismiss</Btn>
      </div>
    </Modal>
  );
}
