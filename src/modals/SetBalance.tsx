// Balance correction (reconciliation). Enter the account's real balance; the
// backend edits the opening balance (no transactions) or records a signed
// adjustment for the difference (transactions exist). For owe (liability)
// accounts the field is "Amount owed" — a positive number stored as negative —
// with an "in credit" toggle for an overpaid/refunded account (stored positive).

import { useState } from "react";
import type { Account } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, Money, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { balanceDisplay, toneColor } from "../lib/accounts";

/** Parse a typed amount into non-negative cents (allows 0). Null if blank/invalid. */
function parseMagnitude(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function SetBalance({ account, hasTransactions, onClose, onDone }: {
  account: Account; hasTransactions: boolean; onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const isOwe = account.group === "owe";
  const cur = balanceDisplay(account.group, account.balanceCents);
  const [value, setValue] = useState(
    ((isOwe ? Math.abs(account.balanceCents) : account.balanceCents) / 100).toFixed(2),
  );
  // owe only: an overpaid/refunded account is "in credit" (stored positive).
  const [inCredit, setInCredit] = useState(isOwe && account.balanceCents > 0);
  const [recordAsIE, setRecordAsIE] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // own: allow a leading "-" (overdraft). owe: positive magnitude — "amount owed"
  // is stored negative, "in credit" stored positive. Magnitude 0 is allowed
  // (a fully paid-off card, or an emptied account).
  const trimmed = value.trim();
  const negative = !isOwe && /^-/.test(trimmed);
  const magnitude = parseMagnitude(trimmed);
  const targetCents =
    magnitude == null ? null : isOwe ? (inCredit ? magnitude : -magnitude) : negative ? -magnitude : magnitude;
  const diff = targetCents != null ? targetCents - account.balanceCents : 0;
  const valid = trimmed !== "" && targetCents != null;

  const fieldLabel = isOwe ? (inCredit ? "Amount in credit (RM)" : "Amount owed (RM)") : "Real balance (RM)";

  async function submit() {
    if (!valid || targetCents == null) return;
    setBusy(true); setError(null);
    try {
      await client.setAccountBalance(account.id, targetCents, hasTransactions && recordAsIE);
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
          <span style={{ color: t.dim }}>{account.name} — current{cur.label ? ` (${cur.label.toLowerCase()})` : ""}</span>
          <Money cents={cur.magnitude} color={toneColor(cur.tone, t)} />
        </div>

        <Field label={fieldLabel}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: 13, fontSize: 15, color: t.faint, fontFamily: t.mono }}>RM</span>
            <input className="sens-input" value={value} inputMode="decimal" autoFocus
              onChange={(e) => setValue(e.target.value.replace(isOwe ? /[^0-9.]/g : /[^0-9.-]/g, ""))}
              style={{ ...inputStyle(t), height: 46, fontSize: 20, fontWeight: 700, fontFamily: t.mono, paddingLeft: 42 }} />
          </div>
        </Field>

        {isOwe && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, cursor: "pointer", marginTop: -4 }}>
            <input type="checkbox" checked={inCredit} onChange={(e) => setInCredit(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: t.accent, cursor: "pointer" }} />
            Account is in credit (overpaid — the provider owes you)
          </label>
        )}

        {hasTransactions && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, cursor: "pointer" }}>
            <input type="checkbox" checked={recordAsIE} onChange={(e) => setRecordAsIE(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: t.accent, cursor: "pointer" }} />
            Record as income/expense (count it in reporting)
          </label>
        )}

        <div style={{ fontSize: 12.5, color: t.dim, background: t.panel2, borderRadius: 9, padding: "10px 12px", lineHeight: 1.5 }}>
          {!hasTransactions ? (
            <>This account has no transactions, so this updates its <b style={{ color: t.text }}>opening balance</b> directly.</>
          ) : diff === 0 ? (
            <>Balance already matches — no change will be recorded.</>
          ) : recordAsIE ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name={diff > 0 ? "in" : "out"} size={14} color={diff > 0 ? t.income : t.expense} />
              Records <b style={{ color: diff > 0 ? t.income : t.expense }}>{(Math.abs(diff) / 100).toFixed(2)}</b> as {diff > 0 ? "income" : "expense"} dated today, counted in reporting.
            </span>
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
