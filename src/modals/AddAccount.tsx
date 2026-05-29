// Create an account: pick from the MYR provider template catalog (grouped,
// searchable) or add a custom account. Opening balance entered in RM.

import { useEffect, useMemo, useState } from "react";
import type { AccountTemplate } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";

const CUSTOM_TYPES = ["bank", "digital_bank", "ewallet", "bnpl", "investment", "custom"];

export function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [custom, setCustom] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AccountTemplate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("bank");
  const [subtype, setSubtype] = useState("savings");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountTemplates().then(setTemplates).catch(() => {}); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, AccountTemplate[]>();
    templates.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
      if (!map.has(x.groupName)) map.set(x.groupName, []);
      map.get(x.groupName)!.push(x);
    });
    return [...map.entries()];
  }, [templates, query]);

  const openingCents = opening ? parseAmountToCents(opening) ?? 0 : 0;
  const canCreate = custom ? name.trim().length > 0 : !!picked && name.trim().length > 0;

  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      if (custom) await client.createCustomAccount(name.trim(), type, subtype, openingCents);
      else await client.createAccountFromTemplate(picked!.key, name.trim(), openingCents);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not create account");
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={460}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>New account</span>
        <button className="sens-btn sens-btn-ghost" onClick={() => { setCustom((c) => !c); setPicked(null); }}
          style={{ height: 28, padding: "0 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, color: t.accent }}>
          {custom ? "Pick a provider" : "Custom account"}
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {!custom && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 9 }}>
              <Icon name="search" size={15} color={t.faint} />
              <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search banks, e-wallets, brokers…"
                style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
            </div>
            <div style={{ maxHeight: 260, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, margin: "0 -4px", padding: "0 4px" }}>
              {groups.map(([group, items]) => (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {items.map((tpl) => {
                      const on = picked?.key === tpl.key;
                      return (
                        <button key={tpl.key} className="sens-btn" onClick={() => { setPicked(tpl); if (!name) setName(tpl.name); }}
                          style={{ height: 40, justifyContent: "flex-start", gap: 9, padding: "0 10px", borderRadius: 9, fontSize: 12.5, fontWeight: 600,
                            color: t.text, background: on ? t.accentSoft : t.panel2, border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}` }}>
                          <GlyphTile tone={tpl.brandColor ?? t.accent} size={24} emoji={tpl.name[0]} radius={7} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <Field label="Account name">
          <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Everyday Savings" style={inputStyle(t)} />
        </Field>

        {custom && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Type">
              <select className="sens-input" value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
                {CUSTOM_TYPES.map((x) => <option key={x} value={x} style={{ background: t.panel2 }}>{x.replace("_", " ")}</option>)}
              </select>
            </Field>
            <Field label="Subtype">
              <input className="sens-input" value={subtype} onChange={(e) => setSubtype(e.target.value)} style={inputStyle(t)} />
            </Field>
          </div>
        )}

        <Field label="Opening balance (RM)">
          <input className="sens-input" value={opening} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...inputStyle(t), fontFamily: t.mono }} />
        </Field>

        {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!canCreate || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Create account</Btn>
        </div>
      </div>
    </Modal>
  );
}
