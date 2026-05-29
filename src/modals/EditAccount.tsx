// Edit an account's name and subtype. Opening-balance edits go through balance
// correction (SetBalance), which is the safe path once transactions exist.

import { useState } from "react";
import type { Account } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";

export function EditAccount({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [name, setName] = useState(account.name);
  const [subtype, setSubtype] = useState(account.subtype);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      await client.updateAccount({ id: account.id, name: name.trim(), subtype: subtype.trim() });
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not save");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={380}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Edit account</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}><Icon name="close" size={16} /></button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Account name"><input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(t)} /></Field>
        <Field label="Subtype"><input className="sens-input" value={subtype} onChange={(e) => setSubtype(e.target.value)} style={inputStyle(t)} /></Field>
        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!name.trim() || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Save changes</Btn>
        </div>
      </div>
    </Modal>
  );
}
