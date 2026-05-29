// Balance correction (reconciliation). Enter the account's real balance; the
// backend edits the opening balance (no transactions) or records a signed
// adjustment for the difference (transactions exist).

import { useState } from "react";
import type { Account } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, Money, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";

export function SetBalance({ account, hasTransactions, onClose, onDone }: {
  account: Account; hasTransactions: boolean; onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const [value, setValue] = useState((account.balanceCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = parseAmountToCents(value);
  const negativeAllowed = /^-/.test(value.trim());
  const targetCents = negativeAllowed && target != null ? -target : target;
  const diff = targetCents != null ? targetCents - account.balanceCents : 0;
  const valid = value.trim() !== "" && targetCents != null;

  async function submit() {
    if (!valid || targetCents == null) return;
    setBusy(true); setError(null);
    try {
      await client.setAccountBalance(account.id, targetCents);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not update balance");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Correct balance</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: t.dim }}>{account.name} — current</span>
          <Money cents={account.balanceCents} color={account.balanceCents < 0 ? t.negative : t.text} />
        </div>

        <Field label="Real balance (RM)">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: 13, fontSize: 15, color: t.faint, fontFamily: t.mono }}>RM</span>
            <input className="sens-input" value={value} inputMode="decimal" autoFocus
              onChange={(e) => setValue(e.target.value.replace(/[^0-9.-]/g, ""))}
              style={{ ...inputStyle(t), height: 46, fontSize: 20, fontWeight: 700, fontFamily: t.mono, paddingLeft: 42 }} />
          </div>
        </Field>

        <div style={{ fontSize: 12.5, color: t.dim, background: t.panel2, borderRadius: 9, padding: "10px 12px", lineHeight: 1.5 }}>
          {!hasTransactions ? (
            <>This account has no transactions, so this updates its <b style={{ color: t.text }}>opening balance</b> directly.</>
          ) : diff === 0 ? (
            <>Balance already matches — no change will be recorded.</>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="sliders" size={14} color={t.adjustment} />
              Records a <b style={{ color: t.adjustment }}>{diff > 0 ? "+" : "−"}{(Math.abs(diff) / 100).toFixed(2)}</b> adjustment dated today. Past history is untouched.
            </span>
          )}
        </div>

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!valid || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Update balance</Btn>
        </div>
      </div>
    </Modal>
  );
}
