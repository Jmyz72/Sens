// Post one due tap-to-post date. The amount can change; everything else stays on the schedule.

import { useState } from "react";
import type { UpcomingOccurrence } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";
import { kindColor } from "../lib/kinds";

export function PostOccurrence({ row, onClose, onDone }: {
  row: UpcomingOccurrence;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const accent = kindColor(t, row.kind);
  const [amount, setAmount] = useState((row.amountCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parseAmountToCents(amount);
    if (cents == null) {
      setError("Enter an amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.postScheduleOccurrence(row.scheduleId, row.occurrenceDate, cents);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Couldn't post");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Post {row.label}</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Amount (RM)">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: 13, fontSize: 15, color: t.faint, fontFamily: t.mono }}>RM</span>
            <input className="sens-input" aria-label="Amount" value={amount} inputMode="decimal" autoFocus
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              style={{ ...inputStyle(t), height: 46, fontSize: 20, fontWeight: 700, fontFamily: t.mono, paddingLeft: 42, color: accent }} />
          </div>
        </Field>
        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={busy} style={{ flex: 1, justifyContent: "center", height: 38, background: accent }}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}
