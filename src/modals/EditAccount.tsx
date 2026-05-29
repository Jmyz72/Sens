// Edit an account's name and subtype (re-picking the subtype re-derives type/
// group). Opening-balance edits go through balance correction (SetBalance).

import { useEffect, useMemo, useState } from "react";
import type { Account, AccountSubtype } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

export function EditAccount({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<string>(account.accountType);
  const [subtype, setSubtype] = useState(account.subtype);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      await client.updateAccount({ id: account.id, name: name.trim(), subtype });
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not save");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Edit account</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Account name"><input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(t)} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Type">
            <select className="sens-input" value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {TYPE_ORDER.map((x) => <option key={x} value={x} style={{ background: t.panel2 }}>{TYPE_LABEL[x]}</option>)}
            </select>
          </Field>
          <Field label="Subtype">
            <select className="sens-input" value={subtype} onChange={(e) => setSubtype(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
              {subtypesForType.map((s) => <option key={s.key} value={s.key} style={{ background: t.panel2 }}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!name.trim() || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Save changes</Btn>
        </div>
      </div>
    </Modal>
  );
}
