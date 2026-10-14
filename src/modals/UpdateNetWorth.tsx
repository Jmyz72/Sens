// Set what a fixed deposit, investment, unit trust, or crypto account is worth
// now. A rise is income and a drop is expense. A matching balance just closes.

import { useEffect, useState } from "react";
import type { Account, Category } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, Money, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { balanceDisplay, toneColor } from "../lib/accounts";
import { categoryPickerItems } from "../lib/categories";
import { fmtMoney, nowTimeHHMM } from "../lib/format";
import { useTimeSetting } from "../lib/useTimeSetting";

/** Parse a typed amount into non-negative cents (allows 0). Null if blank/invalid. */
function parseMagnitude(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function UpdateNetWorth({ account, onClose, onDone }: {
  account: Account; onClose: () => void; onDone: () => void;
}) {
  const t = useTheme();
  const cur = balanceDisplay(account.group, account.balanceCents);
  const [categories, setCategories] = useState<Category[]>([]);
  const [timeEnabled] = useTimeSetting();
  const [time, setTime] = useState(nowTimeHHMM());
  const [value, setValue] = useState((Math.max(account.balanceCents, 0) / 100).toFixed(2));
  const [pickedId, setPickedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listCategories(undefined, true).then(setCategories).catch(() => {}); }, []);

  const targetCents = parseMagnitude(value.trim());
  const diff = targetCents != null ? targetCents - account.balanceCents : null;
  const savedId = diff != null && diff !== 0
    ? (diff > 0 ? account.gainCategoryId : account.lossCategoryId)
    : null;
  const chosenId = savedId || pickedId || null;
  const categoryName = chosenId ? categories.find((c) => c.id === chosenId)?.name ?? null : null;
  const pickerKind = diff != null && diff < 0 ? "expense" : "income";
  const showPicker = diff != null && diff !== 0 && !savedId;
  const canSave = targetCents != null && (diff === 0 || !!chosenId) && !busy;

  let preview: string | null = null;
  if (diff === 0) {
    preview = "Already at this balance";
  } else if (diff != null) {
    const money = fmtMoney(Math.abs(diff), { cents: true });
    const word = diff > 0 ? "income" : "expense";
    preview = categoryName ? `Records ${money} as ${word} in ${categoryName}` : `Records ${money} as ${word}`;
  }

  function onWorthChange(next: string) {
    const cleaned = next.replace(/[^0-9.]/g, "");
    const nextCents = parseMagnitude(cleaned.trim());
    const nextDiff = nextCents != null ? nextCents - account.balanceCents : null;
    const nextRise = nextDiff != null && nextDiff > 0;
    const wasRise = diff != null && diff > 0;
    if (nextRise !== wasRise) setPickedId("");
    setValue(cleaned);
  }

  async function submit() {
    if (targetCents == null || diff == null) return;
    if (diff === 0) {
      onDone();
      return;
    }
    if (!chosenId) return;
    setBusy(true); setError(null);
    try {
      await client.updateNetWorth(account.id, targetCents, savedId ? null : pickedId, timeEnabled ? time : null);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not update net worth");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Update Net Worth</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: t.dim }}>{account.name} — current{cur.label ? ` (${cur.label.toLowerCase()})` : ""}</span>
          <Money cents={cur.magnitude} color={toneColor(cur.tone, t)} />
        </div>

        <Field label="Worth now (RM)">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: 13, fontSize: 15, color: t.faint, fontFamily: t.mono }}>RM</span>
            <input className="sens-input" value={value} inputMode="decimal" autoFocus
              onChange={(e) => onWorthChange(e.target.value)}
              style={{ ...inputStyle(t), height: 46, fontSize: 20, fontWeight: 700, fontFamily: t.mono, paddingLeft: 42 }} />
          </div>
        </Field>

        {preview && (
          <div style={{ fontSize: 12.5, color: t.dim, background: t.panel2, borderRadius: 9, padding: "10px 12px", lineHeight: 1.5 }}>
            {preview}
          </div>
        )}

        {showPicker && (
          <Field label="Category">
            <select className="sens-input" value={pickedId} onChange={(e) => setPickedId(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              <option value="" style={{ background: t.panel2 }}>Select a category</option>
              {categoryPickerItems(categories, pickerKind).map((item) => (
                <option key={item.id} value={item.id} style={{ background: t.panel2 }}>
                  {item.depth === 1 ? `  ${item.label}` : item.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {timeEnabled && diff != null && diff !== 0 && (
          <Field label="Time">
            <input className="sens-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle(t)} />
          </Field>
        )}

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!canSave} style={{ flex: 1, justifyContent: "center", height: 38 }}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}
