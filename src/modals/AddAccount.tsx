// Create an account: optionally pick a provider (branding), then choose a type
// and subtype (which determine own/owe), then name + balance. For owe accounts
// the balance field is "Amount owed" and is stored negative.

import { useEffect, useMemo, useState } from "react";
import type { AccountSubtype, AccountTemplate } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";
import { templateTone } from "../lib/brand";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

export function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [custom, setCustom] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AccountTemplate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("fund");
  const [subtype, setSubtype] = useState<string>("savings");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountTemplates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, AccountTemplate[]>();
    templates.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
      if (!map.has(x.groupName)) map.set(x.groupName, []);
      map.get(x.groupName)!.push(x);
    });
    return [...map.entries()];
  }, [templates, query]);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  const currentSubtype = subtypes.find((s) => s.key === subtype);
  const isOwe = currentSubtype?.group === "owe";

  // When the chosen type changes, keep subtype valid.
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  // Picking a provider pre-selects its default subtype + that subtype's type.
  function pick(tpl: AccountTemplate) {
    setPicked(tpl);
    if (!name) setName(tpl.name);
    const s = subtypes.find((x) => x.key === tpl.defaultSubtype);
    if (s) { setType(s.type); setSubtype(s.key); }
  }

  const openingCents = opening ? parseAmountToCents(opening) ?? 0 : 0;
  const signedOpening = isOwe ? -openingCents : openingCents;
  const canCreate = name.trim().length > 0 && (custom || !!picked) && !!currentSubtype;

  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await client.createAccount(name.trim(), subtype, signedOpening, custom ? null : picked!.key);
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
            <div style={{ maxHeight: 220, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, margin: "0 -4px", padding: "0 4px" }}>
              {groups.map(([group, items]) => (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {items.map((tpl) => {
                      const on = picked?.key === tpl.key;
                      return (
                        <button key={tpl.key} className="sens-btn" onClick={() => pick(tpl)}
                          style={{ height: 40, justifyContent: "flex-start", gap: 9, padding: "0 10px", borderRadius: 9, fontSize: 12.5, fontWeight: 600,
                            color: t.text, background: on ? t.accentSoft : t.panel2, border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}` }}>
                          <GlyphTile tone={templateTone(tpl.key, t.accent)} size={24} emoji={tpl.name[0]} radius={7} />
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

        <Field label={isOwe ? "Amount owed (RM)" : "Opening balance (RM)"}>
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
